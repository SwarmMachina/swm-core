import HttpContext from './http-context.js'

import WSContext from './ws-context.js'
import ContextPool from './context-pool.js'
import { STATUS_TEXT } from './constants.js'

export { default as cors } from './cors.js'
export { default as serveStatic } from './serve-static.js'

const isPromise = (v) => v != null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function'

/**
 * Resolve a backend module to the uWS-shaped surface `{ App, us_listen_socket_close }`.
 * @param {'uws'|'node'} name
 * @returns {Promise<{App: Function, us_listen_socket_close: Function}>}
 */
async function loadBackend(name) {
  if (name === 'node') {
    return import('./backends/node-http/index.js')
  }

  const mod = await import('./backends/uws.js')

  return mod.load()
}

/**
 * @typedef {object} WSOptions
 * @property {boolean} [enabled]
 * @property {number} [wsIdleTimeoutSec]
 * @property {(ctx: WSContext) => any} [onOpen]
 * @property {(ctx: WSContext) => any} [onDrain]
 * @property {(meta: object) => Promise<{isAllowed: boolean, userData?: object}>} [onUpgrade]
 * @property {(ctx: WSContext|null, err: Error) => any} [onError]
 * @property {(ctx: WSContext, code: number, reason: ArrayBuffer) => any} [onClose]
 * @property {(ctx: WSContext, msg: ArrayBuffer, isBinary: boolean) => any} [onMessage]
 * @property {(ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number) => any} [onSubscription]
 * @property {(ctx: WSContext) => (string|number|null|undefined)} [connectionKey] - Opt-in. Derive a stable key for the connection (e.g. a user id) so it can be addressed via server.sendTo(). Computed once in onOpen.
 */

/**
 * @typedef {object} Route
 * @property {'get'|'post'|'put'|'delete'|'del'|'patch'|'options'|'head'|'any'} method
 * @property {string} path - '/users/:id','/*'
 * @property {(ctx: HttpContext) => any|Promise<any>} handler
 * @property {((ctx: HttpContext) => any|Promise<any>)|((ctx: HttpContext) => any|Promise<any>)[]} [preHandler]
 */

export default class Server {
  #listenPromise = null
  #shutdownPromise = null
  #shutdownResolver = null
  #shutdownTimeout = null
  #draining = false

  #activeHttp = 0
  #activeWs = 0

  // Per-connection WS context, keyed by the uWS `ws` wrapper (stable across
  // open/message/close callbacks). Keeps ws.getUserData() off the message hot
  // path.
  #wsContexts = new WeakMap()

  // Opt-in connection registry: user-supplied key -> raw uWS `ws` handle.
  // Populated in onOpen and cleaned in onClose (never on the message hot path)
  // only when `ws.connectionKey` is configured. Backs server.sendTo().
  #connections = new Map()

  // Resolved backend module `{ App, us_listen_socket_close }`, loaded lazily on
  // first listen(). Null until then.
  #backend = null

  /**
   * @param {object} opt
   * @param {(ctx: HttpContext) => any|Promise<any>} [opt.router] - Universal router function (micro like API)
   * @param {Route[]} [opt.routes] - Array of route definitions (native routing API)
   * @param {(ctx: HttpContext, err: Error) => any|Promise<any>} [opt.onHttpError]
   * @param {number} [opt.port]
   * @param {number} [opt.maxBodySize] - in mb
   * @param {WSOptions} [opt.ws]
   * @param {'uws'|'node'} [opt.backend] - Transport backend. 'uws' (default) is the native turbo engine (requires the optional uwebsockets.js peer dependency); 'node' is the zero-dependency node:http backend.
   */
  constructor({ router, routes, onHttpError, port = 6000, maxBodySize = 1, ws, backend = 'uws' }) {
    if (router && routes) {
      throw new TypeError('Cannot use both "router" and "routes" options. Choose one.')
    }

    if (!router && !routes) {
      throw new TypeError('Either "router" or "routes" option must be provided')
    }

    if (router && typeof router !== 'function') {
      throw new TypeError('Router must be a function')
    }

    if (routes && !Array.isArray(routes)) {
      throw new TypeError('Routes must be an array')
    }

    if (!(Number.isFinite(port) && port > 0 && port <= 65535)) {
      throw new TypeError('Http port must be in range 1 - 65535')
    }

    if (!(Number.isFinite(maxBodySize) && maxBodySize >= 1 && maxBodySize <= 64)) {
      throw new TypeError('Max body size must be in range 1 - 64')
    }

    if (ws?.connectionKey != null && typeof ws.connectionKey !== 'function') {
      throw new TypeError('ws.connectionKey must be a function')
    }

    if (backend !== 'uws' && backend !== 'node') {
      throw new TypeError("backend must be 'uws' or 'node'")
    }

    this.backend = backend
    this.port = port
    this.router = router || null
    this.routes = routes || null
    this.useNativeRouting = !!routes
    this.maxBodyBytes = Math.floor(maxBodySize * 1024 * 1024)

    this.onHttpError = typeof onHttpError === 'function' ? onHttpError : () => {}
    this.onWsOpen = () => {}
    this.onWsClose = () => {}
    this.onWsError = () => {}
    this.onWsMessage = () => {}
    this.onWsDrain = () => {}
    this.onWsSubscription = () => {}
    this.onWsUpgrade = () => Promise.resolve({ isAllowed: true })
    this.wsConnectionKey = null

    const hasHandlers =
      typeof ws?.onMessage === 'function' ||
      typeof ws?.onClose === 'function' ||
      typeof ws?.onOpen === 'function' ||
      typeof ws?.onError === 'function' ||
      typeof ws?.onDrain === 'function' ||
      typeof ws?.onUpgrade === 'function' ||
      typeof ws?.onSubscription === 'function' ||
      typeof ws?.connectionKey === 'function'

    this.wsEnabled = !!(ws && (ws?.enabled ?? hasHandlers))

    if (ws && this.wsEnabled) {
      const timeout = ws?.wsIdleTimeoutSec ?? 15

      if (!(Number.isFinite(timeout) && timeout >= 5)) {
        throw new TypeError('wsIdleTimeoutSec must be >= 5')
      }

      this.wsIdleTimeoutSec = Math.floor(timeout)

      this.onWsOpen = typeof ws.onOpen === 'function' ? ws.onOpen : () => {}
      this.onWsClose = typeof ws.onClose === 'function' ? ws.onClose : () => {}
      this.onWsError = typeof ws.onError === 'function' ? ws.onError : () => {}
      this.onWsMessage = typeof ws.onMessage === 'function' ? ws.onMessage : () => {}
      this.onWsDrain = typeof ws.onDrain === 'function' ? ws.onDrain : () => {}
      this.onWsSubscription = typeof ws.onSubscription === 'function' ? ws.onSubscription : () => {}
      this.onWsUpgrade = typeof ws.onUpgrade === 'function' ? ws.onUpgrade : () => Promise.resolve({ isAllowed: true })
      this.wsConnectionKey = ws.connectionKey ?? null
    }

    this.app = null
    this.socket = null

    this.httpContextPool = new ContextPool((pool) => new HttpContext(pool), 1000)
    // maxSize 0 is deliberate: WSContext instances are never reused across
    // connections, which guarantees a retained post-close reference fails
    // loudly instead of silently acting on another connection's socket.
    this.wsContextPool = new ContextPool((pool) => new WSContext(pool), 0)
  }

  listen() {
    if (this.socket) {
      return Promise.resolve(this)
    }

    if (this.#listenPromise) {
      return this.#listenPromise
    }

    const promise = this.#doListen()

    this.#listenPromise = promise

    promise.catch(() => {
      if (this.#listenPromise === promise) {
        this.#listenPromise = null
      }
    })

    return promise
  }

  /**
   * @returns {Promise<Server>}
   */
  async #doListen() {
    if (!this.app) {
      this.#backend = await loadBackend(this.backend)
      this.app = this.#backend.App()

      if (this.useNativeRouting) {
        for (const route of this.routes) {
          const { method, path, handler, preHandler } = route
          const methodName = method === 'delete' ? 'del' : method

          if (typeof this.app[methodName] !== 'function') {
            throw new TypeError(`Invalid HTTP method: ${method}`)
          }

          if (typeof path !== 'string' || !path.startsWith('/')) {
            throw new TypeError(`Invalid Path in route, method: ${method}, path: ${path}`)
          }

          const routeHandler = this.#composeRouteHandler(handler, preHandler)
          const paramNames = path.match(/:[^/]+/g)?.map((name) => name.slice(1)) ?? []

          this.app[methodName](path, (res, req) => this.handleWithContext(res, req, routeHandler, paramNames))
        }
      } else {
        this.app.any('/*', (res, req) => this.handleWithContext(res, req, this.router))
      }

      if (this.wsEnabled) {
        this.app.ws('/*', {
          idleTimeout: this.wsIdleTimeoutSec,
          sendPingsAutomatically: true,
          maxPayloadLength: this.maxBodyBytes,
          open: this.onOpen.bind(this),
          message: this.onMessage.bind(this),
          close: this.onClose.bind(this),
          drain: this.onDrain.bind(this),
          subscription: this.onSubscription.bind(this),
          upgrade: this.onUpgrade.bind(this)
        })
      }
    }

    return new Promise((resolve, reject) => {
      this.app.listen(this.port, (socket) => {
        this.#listenPromise = null

        if (!socket) {
          return reject(new Error(`Listen failed on :${this.port}`))
        }

        resolve(this)
        this.socket = socket
      })
    })
  }

  /**
   * @param {(ctx: HttpContext) => any|Promise<any>} handler
   * @param {((ctx: HttpContext) => any|Promise<any>)|((ctx: HttpContext) => any|Promise<any>)[]} [preHandler]
   * @returns {(ctx: HttpContext) => any|Promise<any>}
   */
  #composeRouteHandler(handler, preHandler) {
    if (preHandler == null) {
      return handler
    }

    const chain = Array.isArray(preHandler) ? preHandler : [preHandler]

    for (let i = 0; i < chain.length; i++) {
      if (typeof chain[i] !== 'function') {
        throw new TypeError('Route preHandler must be a function or an array of functions')
      }
    }

    if (chain.length === 0) {
      return handler
    }

    return async (ctx) => {
      for (let i = 0; i < chain.length; i++) {
        await chain[i](ctx)

        if ((ctx.replied && !ctx.streaming) || ctx.aborted) {
          ctx.finalize()
          return
        }
      }

      return handler(ctx)
    }
  }

  /**
   * @param {Function} fn
   * @param  {...any} args
   * @returns {Promise<void>}
   */
  async safeCall(fn, ...args) {
    if (typeof fn !== 'function') {
      return
    }

    try {
      await fn(...args)
    } catch {
      //
    }
  }

  /**
   * @param {WSContext|null} ctx
   * @param {any} err
   * @returns {Promise<void>}
   */
  safeWsError(ctx, err) {
    return this.safeCall(this.onWsError, ctx, err)
  }

  /**
   * @param {HttpContext} ctx
   * @param {any} err
   * @returns {Promise<void>}
   */
  safeHttpError(ctx, err) {
    return this.safeCall(this.onHttpError, ctx, err)
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   * @returns {WSContext}
   */
  createWsContext(ws) {
    const existing = this.#wsContexts.get(ws)

    if (existing) {
      return existing
    }

    this.#activeWs++

    const ctx = this.wsContextPool.acquire().reset(this, ws, ws.getUserData())

    this.#wsContexts.set(ws, ctx)

    return ctx
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   * @returns {WSContext}
   */
  getWsContext(ws) {
    return this.#wsContexts.get(ws) ?? this.createWsContext(ws)
  }

  /**
   * @param {WSContext} ctx
   * @param {import('uwebsockets.js').WebSocket} ws
   */
  #registerConnection(ctx, ws) {
    if (!this.wsConnectionKey) {
      return
    }

    let key

    try {
      key = this.wsConnectionKey(ctx)
    } catch (err) {
      void this.safeWsError(ctx, err)
      return
    }

    if (key == null || Number.isNaN(key)) {
      return
    }

    if (this.#wsContexts.get(ws) !== ctx) {
      return
    }

    const prev = this.#connections.get(key)

    if (prev && prev !== ws) {
      const prevCtx = this.#wsContexts.get(prev)

      if (prevCtx) {
        prevCtx.key = null
      }
    }

    // noinspection JSConstantReassignment
    ctx.key = key
    this.#connections.set(key, ws)
  }

  /**
   * @param {WSContext} ctx
   * @param {import('uwebsockets.js').WebSocket} ws
   */
  #unregisterConnection(ctx, ws) {
    if (ctx.key != null && this.#connections.get(ctx.key) === ws) {
      this.#connections.delete(ctx.key)
    }
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   */
  deleteWsContext(ws) {
    const ctx = this.#wsContexts.get(ws)

    if (ctx) {
      this.#unregisterConnection(ctx, ws)

      ctx.release()
      this.#wsContexts.delete(ws)
      this.#activeWs--
    }
  }

  finalizeHttpContext(ctx) {
    if (ctx.asyncPending) {
      ctx.releasePending = true
    } else {
      ctx.release()
    }

    this.#activeHttp--

    if (this.#draining) {
      this.#finishShutdownIfNeed()
    }
  }

  /**
   * @param {import('uwebsockets.js').HttpResponse} res
   * @param {import('uwebsockets.js').HttpRequest} req
   * @param {(ctx: HttpContext) => any|Promise<any>} handler
   * @param {string[]} [paramNames] - route :param names, in path order (native routing only)
   * @returns {void}
   */
  handleWithContext(res, req, handler, paramNames) {
    if (this.#draining) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[503])
        res.writeHeader('Connection', 'close')
        res.end()
      })

      return
    }

    this.#activeHttp++

    const ctx = this.httpContextPool.acquire().reset(res, req, this, this.maxBodyBytes)

    res.onAborted(ctx.onAbort)

    let result

    try {
      result = handler(ctx)
    } catch (err) {
      if (!ctx.replied) {
        ctx.sendError(err)
      }

      void this.safeHttpError(ctx, err)

      if (!ctx.streaming) {
        ctx.finalize()
      }

      return
    }

    if (isPromise(result)) {
      ctx.method()
      ctx.url()
      ctx.cacheQuery()
      ctx.cacheHeaders()
      ctx.cacheParams(paramNames)

      ctx.asyncPending = true

      // eslint-disable-next-line promise/catch-or-return
      result.then(ctx.onResolve, ctx.onReject)
      return
    }

    if (!ctx.replied) {
      try {
        ctx.send(result)
      } catch (err) {
        if (!ctx.replied) {
          ctx.sendError(err)
        }

        void this.safeHttpError(ctx, err)
      }
    }

    if (!ctx.streaming) {
      ctx.finalize()
    }
  }

  /**
   * @param {import('uwebsockets.js').HttpResponse} res
   * @param {import('uwebsockets.js').HttpRequest} req
   * @param {import('uwebsockets.js').us_socket_context_t} context
   */
  onUpgrade(res, req, context) {
    if (this.#draining) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[503])
        res.writeHeader('Connection', 'close')
        res.end()
      })

      return
    }

    const secWebSocketKey = req.getHeader('sec-websocket-key')
    const secWebSocketProtocol = req.getHeader('sec-websocket-protocol')
    const secWebSocketExtensions = req.getHeader('sec-websocket-extensions')

    const meta = {
      url: () => req.getUrl(),
      ip: () => {
        const ipBuffer = res.getProxiedRemoteAddressAsText?.() || res.getRemoteAddressAsText?.()

        return ipBuffer ? Buffer.from(ipBuffer).toString('utf8') : ''
      },
      getParameter: (index) => req.getParameter(index),
      getQuery: (key) => req.getQuery(key),
      getHeader: (name) => req.getHeader(name),
      aborted: false
    }

    res.onAborted(() => {
      meta.aborted = true
    })

    let upgradeResult
    let upgradeError
    let isAsync = false

    try {
      upgradeResult = this.onWsUpgrade(meta)
      isAsync = isPromise(upgradeResult)
    } catch (err) {
      upgradeError = err
    }

    if (upgradeError) {
      if (!meta.aborted) {
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[403])
          res.end()
        })
        void this.safeWsError(null, upgradeError)
      }

      return
    }

    if (isAsync) {
      void upgradeResult
        .then((result = {}) => {
          if (meta.aborted) {
            return
          }

          if (result?.isAllowed) {
            res.cork(() => {
              res.upgrade(result.userData || {}, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)
            })

            return
          }

          res.cork(() => {
            res.writeStatus(STATUS_TEXT[403])
            res.end()
          })
        })
        .catch((err) => {
          if (meta.aborted) {
            return
          }

          res.cork(() => {
            res.writeStatus(STATUS_TEXT[403])
            res.end()
          })

          void this.safeWsError(null, err)
        })
      return
    }

    if (!meta.aborted) {
      const result = upgradeResult || {}

      if (result?.isAllowed) {
        res.cork(() => {
          res.upgrade(result.userData || {}, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)
        })
      } else {
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[403])
          res.end()
        })
      }
    }
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   */
  onOpen(ws) {
    if (this.#draining) {
      ws.end(1001, 'server shutting down')
      return
    }

    const ctx = this.createWsContext(ws)

    this.#registerConnection(ctx, ws)

    if (this.#wsContexts.get(ws) !== ctx) {
      return
    }

    let result
    let error
    let isAsync = false

    try {
      result = this.onWsOpen(ctx)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void this.safeWsError(ctx, error)
      return
    }

    if (isAsync) {
      void result.catch((err) => this.safeWsError(ctx, err))
    }
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   * @param {ArrayBuffer} message
   * @param {boolean} isBinary
   */
  onMessage(ws, message, isBinary) {
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = this.onWsMessage(ctx, message, isBinary)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void this.safeWsError(ctx, error)
      return
    }

    if (isAsync) {
      void result.catch((err) => this.safeWsError(ctx, err))
    }
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   * @param {ArrayBuffer} topic
   * @param {number} newCount
   * @param {number} oldCount
   */
  onSubscription(ws, topic, newCount, oldCount) {
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = this.onWsSubscription(ctx, topic, newCount, oldCount)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void this.safeWsError(ctx, error)
      return
    }

    if (isAsync) {
      void result.catch((err) => this.safeWsError(ctx, err))
    }
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   */
  onDrain(ws) {
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = this.onWsDrain(ctx)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void this.safeWsError(ctx, error)
      return
    }

    if (isAsync) {
      void result.catch((err) => this.safeWsError(ctx, err))
    }
  }

  /**
   * @param {import('uwebsockets.js').WebSocket} ws
   * @param {number} code
   * @param {ArrayBuffer} message
   */
  onClose(ws, code, message) {
    const ctx = this.getWsContext(ws)

    this.#unregisterConnection(ctx, ws)

    let result
    let error
    let isAsync = false

    try {
      result = this.onWsClose(ctx, code, message)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void this.safeWsError(ctx, error)
      this.deleteWsContext(ws)
      this.#finishShutdownIfNeed()
      return
    }

    if (isAsync) {
      void result
        .catch((err) => this.safeWsError(ctx, err))
        .finally(() => {
          this.deleteWsContext(ws)
          this.#finishShutdownIfNeed()
        })
      return
    }

    this.deleteWsContext(ws)
    this.#finishShutdownIfNeed()
  }

  /**
   * @param {string} topic
   * @returns {number}
   */
  getSubscribersCount(topic) {
    if (!this.app || !this.wsEnabled) {
      return 0
    }

    return this.app.numSubscribers(topic)
  }

  /**
   * @param {string} topic
   * @param {string | ArrayBuffer | Uint8Array | Buffer} message
   * @param {boolean} [isBinary]
   * @returns {boolean}
   */
  publish(topic, message, isBinary) {
    if (!this.app || !this.wsEnabled) {
      return false
    }

    const bin = isBinary ?? typeof message !== 'string'

    return this.app.publish(topic, message, bin)
  }

  /**
   * @param {string | number} key
   * @param {string | ArrayBuffer | ArrayBufferView} message
   * @param {boolean} [isBinary]
   * @returns {boolean}
   */
  sendTo(key, message, isBinary) {
    const ws = this.#connections.get(key)

    if (!ws) {
      return false
    }

    return ws.send(message, isBinary ?? typeof message !== 'string') !== 2
  }

  /**
   * @param {string | number} key
   * @returns {boolean}
   */
  hasConnection(key) {
    return this.#connections.has(key)
  }

  /**
   * @param {string | number} key
   * @returns {import('uwebsockets.js').WebSocket | undefined}
   */
  getConnection(key) {
    return this.#connections.get(key)
  }

  /**
   * @returns {number}
   */
  get connectionCount() {
    return this.#connections.size
  }

  stopAccepting() {
    if (this.socket) {
      this.#backend?.us_listen_socket_close(this.socket)
      this.socket = null
    }
  }

  #finishShutdownIfNeed() {
    if (!this.#draining) {
      return
    }

    if (this.#activeHttp || this.#activeWs) {
      return
    }

    this.close()
  }

  #resolveShutdownIfNeeded() {
    if (!this.#shutdownResolver) {
      return
    }

    const resolve = this.#shutdownResolver

    this.#shutdownResolver = null
    this.#shutdownPromise = null
    resolve()
  }

  /**
   * @param {number} [timeout]
   * @returns {Promise}
   */
  shutdown(timeout = 10 * 1000) {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise
    }

    const { promise, resolve } = Promise.withResolvers()

    this.#shutdownPromise = promise
    this.#shutdownResolver = resolve

    if (!this.#draining) {
      this.#draining = true

      if (timeout > 0) {
        this.#shutdownTimeout = setTimeout(() => this.close(), timeout)
      }
    }

    this.#finishShutdownIfNeed()

    return this.#shutdownPromise
  }

  /**
   * @description Force stop
   */
  close() {
    this.stopAccepting()

    if (!this.app) {
      this.#resolveShutdownIfNeeded()
      return
    }

    if (this.#shutdownTimeout) {
      clearTimeout(this.#shutdownTimeout)
      this.#shutdownTimeout = null
    }

    const app = this.app

    this.app = null

    try {
      app.close()
    } catch {
      //
    }

    this.#connections.clear()
    this.#draining = false

    this.#resolveShutdownIfNeeded()
  }
}
