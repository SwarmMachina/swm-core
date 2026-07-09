import { createServer } from 'node:http'
import Router from './router.js'
import NodeHttpRequest from './request.js'
import NodeHttpResponse from './response.js'

// Route methods are canonical lowercase HTTP verbs; only `del` needs remapping
// (uWS/Server name), the rest already match `req.method` lowercased.
const METHOD_TO_ROUTE = { del: 'delete' }

/**
 * @returns {object}
 */
export function App() {
  const router = new Router()
  const state = { server: null, listening: false }

  function stopAccepting() {
    if (state.server && state.listening) {
      state.listening = false

      try {
        // Stops accepting new connections; existing ones drain (uWS
        // us_listen_socket_close semantics).
        state.server.close()
      } catch {
        // Already closing/closed.
      }
    }
  }

  const token = { stopAccepting }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function onRequest(req, res) {
    const request = new NodeHttpRequest(req, null)
    const matched = router.match(request.getMethod(), request.getUrl())
    const response = new NodeHttpResponse(req, res)

    if (!matched) {
      response.cork(() => {
        response.writeStatus('404 Not Found')
        response.end('Not Found')
      })

      return
    }

    request.params = matched.params
    matched.handler(response, request)
  }

  /**
   * @param {string} method
   * @returns {(path: string, handler: Function) => object}
   */
  function register(method) {
    const routeMethod = METHOD_TO_ROUTE[method] ?? method

    return (path, handler) => {
      router.add(routeMethod, path, handler)
      return app
    }
  }

  const app = {
    get: register('get'),
    post: register('post'),
    put: register('put'),
    del: register('del'),
    patch: register('patch'),
    options: register('options'),
    head: register('head'),
    any: register('any'),

    ws() {
      throw new Error('WebSocket support on the node backend is not implemented yet')
    },

    publish() {
      return false
    },

    numSubscribers() {
      return 0
    },

    listen(port, cb) {
      const server = createServer({ noDelay: true }, onRequest)

      state.server = server

      let settled = false

      server.once('error', () => {
        if (!settled) {
          settled = true
          cb(null)
        }
      })

      server.listen(port, () => {
        if (!settled) {
          settled = true
          state.listening = true
          cb(token)
        }
      })

      return app
    },

    close() {
      stopAccepting()

      if (state.server) {
        try {
          state.server.closeAllConnections()
        } catch {
          // Older node or already closed.
        }
      }

      return app
    }
  }

  return app
}

/**
 * @param {{stopAccepting: () => void}} token
 * @returns {void}
 */
export function us_listen_socket_close(token) {
  token?.stopAccepting?.()
}
