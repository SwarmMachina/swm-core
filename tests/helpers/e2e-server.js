import Server from '../../src/index.js'
import { getFreePort } from './ports.js'

/**
 * @param {object} opt
 * @param {(ctx: import('../../src/http-context.js').default) => any|Promise<any>} [opt.router]
 * @param {Array<{method: string, path: string, handler: (ctx: import('../../src/http-context.js').default) => any|Promise<any>}>} [opt.routes]
 * @param {number} [opt.maxBodySize]
 * @returns {Promise<{server: Server, port: number, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startHttpServer({ router, routes, maxBodySize }) {
  const port = await getFreePort()
  const server = new Server({ router, routes, port, maxBodySize })

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
 * @param {(ctx: import('../../src/http-context.js').default) => any|Promise<any>} [opt.router]
 * @param {Array<{method: string, path: string, handler: (ctx: import('../../src/http-context.js').default) => any|Promise<any>}>} [opt.routes]
 * @param {number} [opt.maxBodySize]
 * @returns {Promise<{server: Server, port: number, httpBaseUrl: string, wsBaseUrl: string, close: () => Promise<void>}>}
 */
export async function startWsServer({ ws, router, routes, maxBodySize } = {}) {
  const port = await getFreePort()
  const server = new Server({
    port,
    maxBodySize: maxBodySize ?? 16,
    router: router ?? ((ctx) => 'ok'),
    routes,
    ws
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
