import { Agent, get } from 'node:http'
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import { makeMarker } from '../helpers/leak-harness.js'

/**
 * @typedef {object} HttpLeakScenario
 * @property {string} name
 * @property {number} iterations
 * @property {(collect: (obj: object) => void) => object} serverOptions
 * @property {(handle: {baseUrl: string, port: number, server: import('../../../src/index.js').default}, collect: (obj: object) => void, i: number) => Promise<void>} run
 * @property {() => Promise<void>|void} [teardown]
 */

/**
 * @returns {HttpLeakScenario[]}
 */
export function makeHttpScenarios() {
  let nextId = 0

  return [
    {
      name: 'get-simple',
      iterations: 300,
      serverOptions(collect) {
        return {
          routes: [
            {
              method: 'get',
              path: '/ping',
              handler: () => {
                const marker = makeMarker(nextId++)

                collect(marker)

                // The marker itself goes through the full send path.
                return marker
              }
            }
          ]
        }
      },
      async run({ baseUrl }) {
        const res = await fetch(`${baseUrl}/ping`)

        await res.arrayBuffer()
      }
    },
    {
      name: 'post-json',
      iterations: 300,
      serverOptions(collect) {
        return {
          routes: [
            {
              method: 'post',
              path: '/echo',
              handler: async (ctx) => {
                const body = await ctx.json()

                collect(body)

                return { ok: true, id: body.id }
              }
            }
          ]
        }
      },
      async run({ baseUrl }, collect, i) {
        const res = await fetch(`${baseUrl}/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: i, blob: 'x'.repeat(1024) })
        })

        await res.arrayBuffer()
      }
    },
    {
      name: 'throw-in-handler',
      iterations: 300,
      serverOptions(collect) {
        const makeError = () => {
          const marker = makeMarker(nextId++)

          collect(marker)

          const err = new Error('leak-scenario boom')

          err.marker = marker

          return err
        }

        return {
          routes: [
            {
              method: 'get',
              path: '/boom-sync',
              handler: () => {
                throw makeError()
              }
            },
            {
              method: 'get',
              path: '/boom-async',
              handler: async () => {
                await new Promise((resolve) => setImmediate(resolve))
                throw makeError()
              }
            }
          ]
        }
      },
      async run({ baseUrl }, collect, i) {
        const path = i % 2 === 0 ? '/boom-sync' : '/boom-async'
        const res = await fetch(`${baseUrl}${path}`)

        await res.arrayBuffer()
      }
    },
    {
      name: 'not-found',
      iterations: 300,
      serverOptions() {
        return {
          routes: [{ method: 'get', path: '/exists', handler: () => 'ok' }]
        }
      },
      async run({ baseUrl }, collect, i) {
        const res = await fetch(`${baseUrl}/missing-${i}`)

        await res.arrayBuffer()
      }
    },
    {
      name: 'prehandler-short-circuit',
      iterations: 300,
      serverOptions(collect) {
        return {
          routes: [
            {
              method: 'get',
              path: '/guard',
              preHandler: (ctx) => {
                const marker = makeMarker(nextId++)

                collect(marker)
                ctx.sendJson({ denied: true, id: marker.id }, 403)
              },
              handler: () => {
                throw new Error('handler must not run after short-circuit')
              }
            }
          ]
        }
      },
      async run({ baseUrl }) {
        const res = await fetch(`${baseUrl}/guard`)

        await res.arrayBuffer()
      }
    },
    {
      name: 'keep-alive-reuse',
      iterations: 300,
      agent: null,
      serverOptions(collect) {
        return {
          routes: [
            {
              method: 'get',
              path: '/ping',
              handler: () => {
                const marker = makeMarker(nextId++)

                collect(marker)

                return marker
              }
            }
          ]
        }
      },
      async run({ port }) {
        this.agent ??= new Agent({ keepAlive: true, maxSockets: 1 })

        await new Promise((resolve, reject) => {
          const req = get({ host: '127.0.0.1', port, path: '/ping', agent: this.agent }, (res) => {
            res.resume()
            res.on('end', resolve)
          })

          req.on('error', reject)
        })
      },
      teardown() {
        this.agent?.destroy()
        this.agent = null
      }
    },
    {
      name: 'abort-mid-body',
      iterations: 100,
      serverOptions(collect) {
        return {
          routes: [
            {
              method: 'post',
              path: '/upload',
              handler: async (ctx) => {
                const marker = makeMarker(nextId++)

                collect(marker)

                try {
                  await ctx.buffer()
                } catch {
                  // Aborted upload: the body promise is expected to reject.
                }
              }
            }
          ]
        }
      },
      async run({ port }) {
        await new Promise((resolve) => {
          const sock = connect(port, '127.0.0.1', () => {
            sock.write('POST /upload HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 1048576\r\n\r\n')
            sock.write(Buffer.alloc(4096, 1))
            setTimeout(() => sock.destroy(), 5)
          })

          sock.on('error', () => {})
          sock.on('close', resolve)
        })
      }
    },
    {
      name: 'abort-mid-stream',
      iterations: 100,
      serverOptions(collect) {
        return {
          routes: [
            {
              method: 'get',
              path: '/stream',
              handler: (ctx) => {
                const marker = makeMarker(nextId++)

                collect(marker)

                // Endless source: the framework must destroy it on abort,
                // otherwise the marker stays reachable through the stream.
                const readable = new Readable({
                  read() {
                    this.push(marker.blob)
                  }
                })

                return ctx.stream(readable)
              }
            }
          ]
        }
      },
      async run({ port }) {
        await new Promise((resolve) => {
          const req = get({ host: '127.0.0.1', port, path: '/stream' }, (res) => {
            res.once('data', () => {
              req.destroy()
            })
          })

          req.on('error', () => {})
          req.on('close', resolve)
        })
      }
    }
  ]
}
