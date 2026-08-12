// tests/leak/scenarios/ws.js
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import { makeMarker } from '../helpers/leak-harness.js'
import type WSContext from '../../../src/ws/context.js'
import type { WsServerHandle, WsServerOptions } from '../../helpers/e2e-server.js'

const HELPER_TIMEOUT_MS = 5000
const ALLOW_ANONYMOUS_UPGRADE = () => ({})

interface WsMessage {
  data: Buffer
  isBinary: boolean
}

type Collector = (value: object) => void
type ClientSendOptions = { binary?: boolean; fin?: boolean }

interface WsLeakScenario {
  name: string
  iterations: number
  serverOptions(collect: Collector): WsServerOptions
  run(handle: WsServerHandle, collect: Collector, index: number): Promise<void>
  verify?(handle: WsServerHandle): Promise<void> | void
}

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
function opened(sock: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sock.off('open', onOpen)
      sock.off('error', onError)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (err: Error) => {
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
function closed(sock: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
function waitForMessage(sock: WebSocket, label: string, trigger: () => void): Promise<WsMessage> {
  return new Promise<WsMessage>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      sock.off('message', onMessage)
      sock.off('error', onError)
    }
    const onMessage = (data: Buffer, isBinary: boolean) => {
      cleanup()
      resolve({ data: Buffer.from(data), isBinary })
    }
    const onError = (err: Error) => {
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
function roundtrip(sock: WebSocket, payload: string | Buffer, options?: ClientSendOptions): Promise<WsMessage> {
  return options === undefined
    ? waitForMessage(sock, 'ws echo', () => sock.send(payload))
    : waitForMessage(sock, 'ws echo', () => sock.send(payload, options))
}

/**
 * @returns {WsLeakScenario[]}
 */
export function makeWsScenarios(): WsLeakScenario[] {
  let nextId = 0

  const echoServerOptions: WsLeakScenario['serverOptions'] = (collect) => ({
    ws: {
      onUpgrade: () => ({ marker: makeMarker(nextId++) }),
      onOpen: (ctx) => {
        collect(ctx)
        collect(wsData<{ marker: object }>(ctx).marker)
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
            onUpgrade: ALLOW_ANONYMOUS_UPGRADE,
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
      async run({ wsBaseUrl }, _collect, i) {
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
            onUpgrade: ALLOW_ANONYMOUS_UPGRADE,
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
      async run({ wsBaseUrl }, _collect, i) {
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
            onUpgrade: ALLOW_ANONYMOUS_UPGRADE,
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
      async run({ wsBaseUrl, server }, _collect, i) {
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
            onUpgrade: ALLOW_ANONYMOUS_UPGRADE,
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
            onUpgrade: (meta) => ({ userId: Number(meta.getQuery('uid')), marker: makeMarker(nextId++) }),
            connectionKey: (ctx) => wsData<{ userId: number }>(ctx).userId,
            onOpen: (ctx) => {
              collect(ctx)
              collect(wsData<{ marker: object }>(ctx).marker)
            },
            onMessage: (ctx, msg, isBinary) => ctx.send(msg, isBinary)
          }
        }
      },
      async run({ wsBaseUrl, server }, _collect, i) {
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

function wsData<T extends object>(ctx: WSContext): T {
  if (!ctx.data) {
    throw new Error('Expected WebSocket user data')
  }

  return ctx.data as T
}
