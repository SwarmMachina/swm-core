// tests/leak/scenarios/ws.js
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import { makeMarker } from '../helpers/leak-harness.js'

const HELPER_TIMEOUT_MS = 5000

/**
 * @typedef {object} WsLeakScenario
 * @property {string} name
 * @property {number} iterations
 * @property {(collect: (obj: object) => void) => object} serverOptions
 * @property {(handle: {wsBaseUrl: string, port: number, server: import('../../../src/index.js').default}, collect: (obj: object) => void, i: number) => Promise<void>} run
 * @property {(handle: {server: import('../../../src/index.js').default}) => Promise<void>|void} [verify]
 */

/**
 * @param {WebSocket} sock
 * @returns {Promise<void>}
 */
function opened(sock) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sock.off('open', onOpen)
      sock.off('error', onError)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }

    sock.once('open', onOpen)
    sock.once('error', onError)
  })
}

/**
 * @param {WebSocket} sock
 * @returns {Promise<void>}
 */
function closed(sock) {
  return new Promise((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      sock.off('close', onClose)
      reject(new Error(`ws close timed out after ${HELPER_TIMEOUT_MS}ms`))
    }, HELPER_TIMEOUT_MS)

    sock.once('close', onClose)
  })
}

/**
 * @param {WebSocket} sock
 * @param {string} label
 * @param {() => void} trigger
 * @returns {Promise<{data: Buffer, isBinary: boolean}>}
 */
function waitForMessage(sock, label, trigger) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      sock.off('message', onMessage)
      sock.off('error', onError)
    }
    const onMessage = (data, isBinary) => {
      cleanup()
      resolve({ data, isBinary })
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} timed out after ${HELPER_TIMEOUT_MS}ms`))
    }, HELPER_TIMEOUT_MS)

    sock.once('message', onMessage)
    sock.once('error', onError)

    try {
      trigger()
    } catch (err) {
      cleanup()
      reject(err)
    }
  })
}

/**
 * @param {WebSocket} sock
 * @param {string | Buffer} payload
 * @param {import('ws').SendOptions} [options]
 * @returns {Promise<{data: Buffer, isBinary: boolean}>}
 */
function roundtrip(sock, payload, options) {
  return waitForMessage(sock, 'ws echo', () => sock.send(payload, options))
}

/**
 * @returns {WsLeakScenario[]}
 */
export function makeWsScenarios() {
  let nextId = 0

  const echoServerOptions = (collect) => ({
    ws: {
      enabled: true,
      onUpgrade: () => ({ isAllowed: true, userData: { marker: makeMarker(nextId++) } }),
      onOpen: (ctx) => {
        collect(ctx)
        collect(ctx.data.marker)
      },
      onMessage: (ctx, msg, isBinary) => ctx.send(msg, isBinary)
    }
  })

  return [
    {
      name: 'echo-clean-close',
      iterations: 150,
      serverOptions: echoServerOptions,
      async run({ wsBaseUrl }) {
        const sock = new WebSocket(wsBaseUrl, { perMessageDeflate: false })

        await opened(sock)
        await roundtrip(sock, 'ping')

        const done = closed(sock)

        sock.close()
        await done
      }
    },
    {
      name: 'abrupt-terminate',
      iterations: 150,
      serverOptions: echoServerOptions,
      async run({ wsBaseUrl }) {
        const sock = new WebSocket(wsBaseUrl, { perMessageDeflate: false })

        await opened(sock)
        await roundtrip(sock, 'ping')

        const done = closed(sock)

        // No close handshake: raw TCP teardown.
        sock.terminate()
        await done
      }
    },
    {
      name: 'large-messages',
      iterations: 100,
      serverOptions(collect) {
        return {
          ws: {
            enabled: true,
            onOpen: (ctx) => {
              collect(ctx)
            },
            onMessage: (ctx, msg, isBinary) => {
              const copy = Buffer.from(msg)

              collect(copy)
              ctx.send(copy, isBinary)
            }
          }
        }
      },
      async run({ wsBaseUrl }, collect, i) {
        const sock = new WebSocket(wsBaseUrl, { perMessageDeflate: false })

        await opened(sock)
        await roundtrip(sock, Buffer.alloc(256 * 1024, i & 0xff))

        const done = closed(sock)

        sock.close()
        await done
      }
    },
    {
      name: 'fragmented-messages',
      iterations: 100,
      serverOptions(collect) {
        return {
          ws: {
            enabled: true,
            onOpen: (ctx) => {
              collect(ctx)
            },
            onMessage: (ctx, msg, isBinary) => {
              // Track the parser-owned Buffer assembled from #messageChunks.
              collect(msg)
              ctx.send(msg, isBinary)
            }
          }
        }
      },
      async run({ wsBaseUrl }, collect, i) {
        const sock = new WebSocket(wsBaseUrl, { perMessageDeflate: false })

        await opened(sock)

        const isBinary = (i & 1) === 0
        const first = Buffer.alloc(48 * 1024, isBinary ? i & 0xff : 0x41 + (i % 26))
        const second = Buffer.alloc(32 * 1024, isBinary ? (i + 1) & 0xff : 0x61 + (i % 26))

        sock.send(first, { binary: isBinary, fin: false })

        const echoed = await roundtrip(sock, second, { binary: isBinary, fin: true })

        assert.strictEqual(echoed.isBinary, isBinary)
        assert.deepStrictEqual(echoed.data, Buffer.concat([first, second]))

        // Leave a fragment in #messageChunks; close must release its tail.
        sock.send(first, { binary: isBinary, fin: false })

        const done = closed(sock)

        sock.close()
        await done
      }
    },
    {
      name: 'pubsub-cycle',
      iterations: 100,
      serverOptions(collect) {
        return {
          ws: {
            enabled: true,
            onOpen: (ctx) => {
              collect(ctx)
            },
            onMessage: (ctx, msg) => {
              const text = ctx.decode(msg)

              if (text.startsWith('sub:')) {
                ctx.subscribe(text.slice(4))
                ctx.send('subscribed')
              }
            }
          }
        }
      },
      async run({ wsBaseUrl, server }, collect, i) {
        const topic = `topic-${i}`
        const sock = new WebSocket(wsBaseUrl, { perMessageDeflate: false })

        await opened(sock)

        const ack = await roundtrip(sock, `sub:${topic}`)

        assert.strictEqual(ack.data.toString(), 'subscribed')

        const message = JSON.stringify({ topic, i })
        const delivery = await waitForMessage(sock, 'ws publish', () => {
          assert.strictEqual(server.publish(topic, message), true)
        })

        assert.strictEqual(delivery.data.toString(), message)

        const done = closed(sock)

        sock.close()
        await done
      },
      verify({ server }) {
        assert.strictEqual(server.getSubscribersCount('topic-0'), 0)
        assert.strictEqual(server.getSubscribersCount('topic-99'), 0)
      }
    },
    {
      name: 'backpressure-close',
      iterations: 50,
      serverOptions(collect) {
        return {
          ws: {
            enabled: true,
            onOpen: (ctx) => {
              collect(ctx)
            },
            onMessage: (ctx) => {
              for (let k = 0; k < 64; k++) {
                const chunk = Buffer.alloc(64 * 1024, k)

                collect(chunk)
                ctx.send(chunk, true)
              }
            }
          }
        }
      },
      async run({ wsBaseUrl }) {
        const sock = new WebSocket(wsBaseUrl, { perMessageDeflate: false })

        await opened(sock)

        sock.pause()
        sock.send('flood')
        await new Promise((resolve) => setTimeout(resolve, 20))

        const done = closed(sock)

        sock.terminate()
        await done
      }
    },
    {
      name: 'connection-registry',
      iterations: 100,
      serverOptions(collect) {
        return {
          ws: {
            enabled: true,
            onUpgrade: (meta) => ({
              isAllowed: true,
              userData: { userId: Number(meta.getQuery('uid')), marker: makeMarker(nextId++) }
            }),
            connectionKey: (ctx) => ctx.data.userId,
            onOpen: (ctx) => {
              collect(ctx)
              collect(ctx.data.marker)
            },
            onMessage: (ctx, msg, isBinary) => ctx.send(msg, isBinary)
          }
        }
      },
      async run({ wsBaseUrl, server }, collect, i) {
        const sock = new WebSocket(`${wsBaseUrl}/?uid=${i}`, { perMessageDeflate: false })

        await opened(sock)
        await roundtrip(sock, 'hi')

        assert.strictEqual(server.hasConnection(i), true)

        const done = closed(sock)

        sock.close()
        await done
      },
      async verify({ server }) {
        const deadline = performance.now() + 500

        while (server.connectionCount > 0 && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        assert.strictEqual(server.connectionCount, 0, 'connection registry is not empty after all sockets closed')
      }
    }
  ]
}
