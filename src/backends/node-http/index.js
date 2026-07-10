import { createServer } from 'node:http'
import Router from './router.js'
import NodeHttpRequest from './request.js'
import NodeHttpResponse from './response.js'
import WsLayer from './ws/ws-layer.js'

// Route methods are canonical lowercase HTTP verbs; only `del` needs remapping
// (uWS/Server name), the rest already match `req.method` lowercased.
const METHOD_TO_ROUTE = { del: 'delete' }

/**
 * @param {typeof createServer} [createHttpServer]
 * @returns {object}
 */
export function App(createHttpServer = createServer) {
  const router = new Router()
  const state = { server: null, listening: false, wsLayer: null, errorHandler: null }

  /**
   *
   */
  function stopAccepting() {
    if (state.server && state.listening) {
      state.listening = false

      try {
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

    ws(pattern, behavior) {
      state.wsLayer = new WsLayer(behavior)
      return app
    },

    onError(handler) {
      state.errorHandler = typeof handler === 'function' ? handler : null
      return app
    },

    publish(topic, message, isBinary) {
      return state.wsLayer ? state.wsLayer.publish(topic, message, isBinary) : false
    },

    numSubscribers(topic) {
      return state.wsLayer ? state.wsLayer.numSubscribers(topic) : 0
    },

    listen(port, cb) {
      const server = createHttpServer({ noDelay: true }, onRequest)

      state.server = server

      if (state.wsLayer) {
        server.on('upgrade', (req, socket, head) => state.wsLayer.handleUpgrade(req, socket, head))
      }

      let settled = false

      server.on('error', (err) => {
        if (!settled) {
          settled = true
          cb(null)
          return
        }

        try {
          state.errorHandler?.(err)
        } catch {
          // Transport error handlers must never turn an EventEmitter error
          // into an uncaught exception.
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

      if (state.wsLayer) {
        state.wsLayer.close()
      }

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
