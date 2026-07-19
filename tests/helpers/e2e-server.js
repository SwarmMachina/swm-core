import Server from '../../src/index.js'
import { getFreePort } from '../../helpers/ports.js'

/**
 * @param {object} opt
 * @param {(ctx: import('../../src/http-context.js').default) => unknown|Promise<unknown>} [opt.onRequest]
 * @param {Array<{method: string, path: string, handler: (ctx: import('../../src/http-context.js').default) => unknown|Promise<unknown>}>} [opt.routes]
 * @param {number} [opt.maxBodySize]
 * @param {number} [opt.maxBodyBudget]
 * @param {number} [opt.requestTimeoutMs]
 * @param {boolean} [opt.prefetch]
 * @returns {Promise<{server: Server, port: number, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startHttpServer({ onRequest, routes, maxBodySize, maxBodyBudget, requestTimeoutMs, prefetch }) {
  const port = await getFreePort()
  const server = new Server({
    http: { onRequest, routes, maxBodySize, maxBodyBudget, requestTimeoutMs },
    port,
    prefetch
  })

  await server.listen()

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => server.shutdown(1000)
  }
}

/**
 * @param {object} [opt]
 * @param {import('../../src/index.js').WSOptions} [opt.ws]
 * @param {(ctx: import('../../src/http-context.js').default) => unknown|Promise<unknown>} [opt.onRequest]
 * @param {Array<{method: string, path: string, handler: (ctx: import('../../src/http-context.js').default) => unknown|Promise<unknown>}>} [opt.routes]
 * @param {number} [opt.maxBodySize]
 * @returns {Promise<{server: Server, port: number, httpBaseUrl: string, wsBaseUrl: string, close: () => Promise<void>}>}
 */
export async function startWsServer({ ws, onRequest, routes, maxBodySize } = {}) {
  const port = await getFreePort()
  const http = onRequest !== undefined || routes !== undefined ? { onRequest, routes } : null
  const server = new Server({
    port,
    http,
    ws: ws && { maxBodySize: maxBodySize ?? 16, ...ws }
  })

  await server.listen()

  return {
    server,
    port,
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await server.shutdown(1000)
    }
  }
}
