import { Agent, get } from 'node:http'
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
    }
  ]
}
