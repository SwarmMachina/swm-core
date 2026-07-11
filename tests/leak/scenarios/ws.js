// tests/leak/scenarios/ws.js
import { WebSocket } from 'ws'
import { makeMarker } from '../helpers/leak-harness.js'

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
    sock.on('open', resolve)
    sock.on('error', reject)
  })
}

/**
 * @param {WebSocket} sock
 * @returns {Promise<void>}
 */
function closed(sock) {
  return new Promise((resolve) => {
    sock.on('close', resolve)
  })
}

/**
 * @param {WebSocket} sock
 * @param {string | Buffer} payload
 * @returns {Promise<unknown>}
 */
function roundtrip(sock, payload) {
  return new Promise((resolve) => {
    sock.once('message', resolve)
    sock.send(payload)
  })
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
    }
  ]
}
