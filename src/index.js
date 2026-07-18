import HttpContext from './http-context.js'

import WSContext from './ws-context.js'
import ContextPool from './context-pool.js'
import { STATUS_TEXT } from './constants.js'

export { default as cors } from './cors.js'
export { default as serveStatic } from './serve-static.js'
export { prepareHeaders } from './prepared-headers.js'

const isPromise = (v) => v != null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function'
const WS_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'del', 'patch', 'options', 'head', 'any'])
const NOOP = () => {}
const ALLOW_WS_UPGRADE = () => Promise.resolve({ isAllowed: true })

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is object}
 */
function assertOptionsObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object or null`)
  }
}

/**
 * @param {object} options
 * @param {string[]} names
 * @param {string} namespace
 */
function validateCallbacks(options, names, namespace) {
  for (const name of names) {
    if (options[name] !== undefined && typeof options[name] !== 'function') {
      throw new TypeError(`${namespace}.${name} must be a function`)
    }
  }
}

/**
 * @param {Route} route
 * @param {number} index
 */
function validateRoute(route, index) {
  if (typeof route !== 'object' || route === null || Array.isArray(route)) {
    throw new TypeError(`http.routes[${index}] must be an object`)
  }

  const { method, path, handler, preHandler } = route

  if (!HTTP_METHODS.has(method)) {
    throw new TypeError(`Invalid HTTP method: ${method}`)
  }

  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`Invalid Path in route, method: ${method}, path: ${path}`)
  }

  if (typeof handler !== 'function') {
    throw new TypeError(`http.routes[${index}].handler must be a function`)
  }

  if (preHandler === undefined) {
    return
  }

  const chain = Array.isArray(preHandler) ? preHandler : [preHandler]

  if (chain.some((item) => typeof item !== 'function')) {
    throw new TypeError('Route preHandler must be a function or an array of functions')
  }
}

/**
 * @param {unknown} http
 * @returns {{onRequest: ((ctx: HttpContext) => unknown|Promise<unknown>)|null, routes: Route[]|null, onError: (ctx: HttpContext, err: Error) => unknown|Promise<unknown>}|null}
 */
function normalizeHttpOptions(http) {
  if (http == null) {
    return null
  }

  assertOptionsObject(http, 'http')
  validateCallbacks(http, ['onRequest', 'onError'], 'http')

  if (http.onRequest !== undefined && http.routes !== undefined) {
    throw new TypeError('Cannot use both "http.onRequest" and "http.routes" options. Choose one.')
  }

  if (http.routes !== undefined && !Array.isArray(http.routes)) {
    throw new TypeError('http.routes must be an array')
  }

  http.routes?.forEach(validateRoute)

  return {
    onRequest: http.onRequest ?? null,
    routes: http.routes ?? null,
    onError: http.onError ?? NOOP
  }
}

/**
 * @param {unknown} ws
 * @returns {WSOptions|null}
 */
function normalizeWsOptions(ws) {
  if (ws == null) {
    return null
  }

  assertOptionsObject(ws, 'ws')

  if ('enabled' in ws) {
    throw new TypeError('ws.enabled is no longer supported; use ws: null to disable WebSocket')
  }

  validateCallbacks(
    ws,
    [
      'onOpen',
      'onDrain',
      'onDropped',
      'onUpgrade',
      'onError',
      'onClose',
      'onMessage',
      'onSubscription',
      'connectionKey'
    ],
    'ws'
  )

  if (
    ws.wsUpgradeTimeoutMs != null &&
    !(Number.isFinite(ws.wsUpgradeTimeoutMs) && ws.wsUpgradeTimeoutMs >= 100 && ws.wsUpgradeTimeoutMs <= 300_000)
  ) {
    throw new TypeError('wsUpgradeTimeoutMs must be in range 100 - 300000')
  }

  const idleTimeout = ws.wsIdleTimeoutSec ?? 15

  if (!(Number.isFinite(idleTimeout) && idleTimeout >= 5)) {
    throw new TypeError('wsIdleTimeoutSec must be >= 5')
  }

  return ws
}

/**
 * @param {import('@swarmmachina/swm-uws').HttpResponse} res
 */
function sendNotFound(res) {
  res.cork(() => {
    res.writeStatus(STATUS_TEXT[404])
    res.end('Not Found')
  })
}

/**
 * Select and validate the application-requested WebSocket subprotocol.
 * @param {string} requestedHeader
 * @param {unknown} selected
 * @returns {string}
 */
function selectWsProtocol(requestedHeader, selected) {
  if (selected == null || selected === '') {
    return ''
  }

  if (typeof selected !== 'string' || !WS_PROTOCOL_TOKEN.test(selected)) {
    throw new TypeError('WebSocket upgrade protocol must be a valid protocol token')
  }

  const requested = requestedHeader
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)

  if (!requested.includes(selected)) {
    throw new TypeError(`WebSocket upgrade protocol was not requested by the client: ${selected}`)
  }

  return selected
}

/**
 * Resolve a backend module to the uWS-shaped surface and its optional capabilities.
 * @param {'uws'|'node'} name
 * @returns {Promise<{App: (...args: unknown[]) => object, us_listen_socket_close: (socket: unknown) => void, capabilities?: object}>}
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
 * @property {number} [wsIdleTimeoutSec]
 * @property {number} [wsUpgradeTimeoutMs]
 * @property {(ctx: WSContext) => unknown} [onOpen]
 * @property {(ctx: WSContext) => unknown} [onDrain]
 * @property {(ctx: WSContext, msg: ArrayBuffer, isBinary: boolean) => unknown} [onDropped]
 * @property {(meta: object) => ({isAllowed: boolean, userData?: object, protocol?: string}|Promise<{isAllowed: boolean, userData?: object, protocol?: string}>)} [onUpgrade]
 * @property {(ctx: WSContext|null, err: Error) => unknown} [onError]
 * @property {(ctx: WSContext, code: number, reason: ArrayBuffer) => unknown} [onClose]
 * @property {(ctx: WSContext, msg: ArrayBuffer, isBinary: boolean) => unknown} [onMessage]
 * @property {(ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number) => unknown} [onSubscription]
 * @property {(ctx: WSContext) => (string|number|null|undefined)} [connectionKey] - Opt-in. Derive a stable key for the connection (e.g. a user id) so it can be addressed via server.sendTo(). Computed once in onOpen.
 */

/**
 * @typedef {object} Route
 * @property {'get'|'post'|'put'|'delete'|'del'|'patch'|'options'|'head'|'any'} method
 * @property {string} path - '/users/:id','/*'
 * @property {(ctx: HttpContext) => unknown|Promise<unknown>} handler
 * @property {((ctx: HttpContext) => unknown|Promise<unknown>)|((ctx: HttpContext) => unknown|Promise<unknown>)[]} [preHandler]
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

  bindingCapabilities = Object.freeze({})

  /**
   * @param {object} [opt]
   * @param {{onRequest?: (ctx: HttpContext) => unknown|Promise<unknown>, routes?: Route[], onError?: (ctx: HttpContext, err: Error) => unknown|Promise<unknown>}|null} [opt.http]
   * @param {(err: Error) => unknown|Promise<unknown>} [opt.onServerError]
   * @param {string} [opt.host]
   * @param {number} [opt.port]
   * @param {number} [opt.maxBodySize] - in mb
   * @param {WSOptions|null} [opt.ws]
   * @param {'uws'|'node'} [opt.backend] - Transport backend. 'uws' (default) is the native turbo engine; 'node' is the opt-in node:http backend.
   */
  constructor(opt = {}) {
    if (typeof opt !== 'object' || opt === null || Array.isArray(opt)) {
      throw new TypeError('Server options must be an object')
    }

    if ('router' in opt || 'routes' in opt || 'onHttpError' in opt) {
      throw new TypeError(
        'Legacy HTTP options are no longer supported; use http.onRequest, http.routes, and http.onError'
      )
    }

    const {
      http: httpOptions,
      onServerError,
      host = '127.0.0.1',
      port = 6000,
      maxBodySize = 1,
      ws: wsOptions,
      backend = 'uws'
    } = opt
    const http = normalizeHttpOptions(httpOptions)
    const ws = normalizeWsOptions(wsOptions)

    if (!http && !ws) {
      throw new TypeError('At least one of "http" or "ws" must be configured')
    }

    if (!(Number.isFinite(port) && port > 0 && port <= 65535)) {
      throw new TypeError('Http port must be in range 1 - 65535')
    }

    if (typeof host !== 'string' || host.length === 0) {
      throw new TypeError('Host must be a non-empty string')
    }

    if (!(Number.isFinite(maxBodySize) && maxBodySize >= 1 && maxBodySize <= 64)) {
      throw new TypeError('Max body size must be in range 1 - 64')
    }

    if (onServerError !== undefined && typeof onServerError !== 'function') {
      throw new TypeError('onServerError must be a function')
    }

    if (backend !== 'uws' && backend !== 'node') {
      throw new TypeError("backend must be 'uws' or 'node'")
    }

    this.backend = backend
    this.host = host
    this.port = port
    this.http = http
    this.ws = ws
    this.maxBodyBytes = Math.floor(maxBodySize * 1024 * 1024)

    this.httpErrorHandler = http?.onError ?? NOOP
    this.onServerError = typeof onServerError === 'function' ? onServerError : NOOP
    this.onWsOpen = ws?.onOpen ?? NOOP
    this.onWsClose = ws?.onClose ?? NOOP
    this.onWsError = ws?.onError ?? NOOP
    this.onWsMessage = ws?.onMessage ?? NOOP
    this.onWsDrain = ws?.onDrain ?? NOOP
    this.onWsDropped = ws?.onDropped ?? NOOP
    this.onWsSubscription = ws?.onSubscription ?? NOOP
    this.onWsUpgrade = ws?.onUpgrade ?? ALLOW_WS_UPGRADE
    this.wsConnectionKey = null
    this.wsUpgradeTimeoutMs = 10_000

    if (ws) {
      this.wsIdleTimeoutSec = Math.floor(ws.wsIdleTimeoutSec ?? 15)
      this.wsUpgradeTimeoutMs = Math.floor(ws.wsUpgradeTimeoutMs ?? 10_000)
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
      this.bindingCapabilities = Object.freeze({ ...(this.#backend.capabilities || {}) })
      this.app = this.#backend.App()
      this.app.onError?.((err) => void this.safeCall(this.onServerError, err))

      if (this.http?.routes) {
        for (const route of this.http.routes) {
          const { method, path, handler, preHandler } = route
          const methodName = method === 'delete' ? 'del' : method
          const routeHandler = this.#composeRouteHandler(handler, preHandler)
          const paramNames = path.match(/:[^/]+/g)?.map((name) => name.slice(1)) ?? []

          this.app[methodName](path, (res, req) => this.handleWithContext(res, req, routeHandler, paramNames))
        }

        if (!this.http.routes.some(({ method, path }) => method === 'any' && path === '/*')) {
          this.app.any('/*', sendNotFound)
        }
      } else if (this.http?.onRequest) {
        this.app.any('/*', (res, req) => this.handleWithContext(res, req, this.http.onRequest))
      } else {
        this.app.any('/*', sendNotFound)
      }

      if (this.ws) {
        this.app.ws('/*', {
          idleTimeout: this.wsIdleTimeoutSec,
          upgradeTimeout: this.wsUpgradeTimeoutMs,
          sendPingsAutomatically: true,
          maxPayloadLength: this.maxBodyBytes,
          open: this.onOpen.bind(this),
          message: this.onMessage.bind(this),
          dropped: this.onDropped.bind(this),
          close: this.onClose.bind(this),
          drain: this.onDrain.bind(this),
          subscription: this.onSubscription.bind(this),
          upgrade: this.onUpgrade.bind(this)
        })
      }
    }

    return new Promise((resolve, reject) => {
      this.app.listen(this.host, this.port, (socket) => {
        this.#listenPromise = null

        if (!socket) {
          return reject(new Error(`Listen failed on ${this.host}:${this.port}`))
        }

        resolve(this)
        this.socket = socket
      })
    })
  }

  /**
   * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
   * @param {((ctx: HttpContext) => unknown|Promise<unknown>)|((ctx: HttpContext) => unknown|Promise<unknown>)[]} [preHandler]
   * @returns {(ctx: HttpContext) => unknown|Promise<unknown>}
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
   * @param {(...args: unknown[]) => unknown|Promise<unknown>} fn
   * @param {...unknown} args
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
   * @param {unknown} err
   * @returns {Promise<void>}
   */
  safeWsError(ctx, err) {
    return this.safeCall(this.onWsError, ctx, err)
  }

  /**
   * @param {HttpContext} ctx
   * @param {unknown} err
   * @returns {Promise<void>}
   */
  safeHttpError(ctx, err) {
    return this.safeCall(this.httpErrorHandler, ctx, err)
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @returns {WSContext}
   */
  getWsContext(ws) {
    return this.#wsContexts.get(ws) ?? this.createWsContext(ws)
  }

  /**
   * @param {WSContext} ctx
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  #unregisterConnection(ctx, ws) {
    if (ctx.key != null && this.#connections.get(ctx.key) === ws) {
      this.#connections.delete(ctx.key)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
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
      ctx.cacheRequest(paramNames)

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
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {import('@swarmmachina/swm-uws').us_socket_context_t} context
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

    let upgradeTimer = null

    res.onAborted(() => {
      meta.aborted = true
      clearTimeout(upgradeTimer)
      upgradeTimer = null
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
      let settled = false

      upgradeTimer = setTimeout(() => {
        if (settled || meta.aborted) {
          return
        }

        settled = true
        upgradeTimer = null
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[408])
          res.end()
        })

        const error = new Error(`WebSocket upgrade timed out after ${this.wsUpgradeTimeoutMs}ms`)

        error.code = 'WS_UPGRADE_TIMEOUT'
        void this.safeWsError(null, error)
      }, this.wsUpgradeTimeoutMs)

      void upgradeResult
        .then((result = {}) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true
          clearTimeout(upgradeTimer)
          upgradeTimer = null

          if (result?.isAllowed) {
            this.#acceptUpgrade(res, result, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)

            return
          }

          res.cork(() => {
            res.writeStatus(STATUS_TEXT[403])
            res.end()
          })
        })
        .catch((err) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true
          clearTimeout(upgradeTimer)
          upgradeTimer = null

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
        this.#acceptUpgrade(res, result, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)
      } else {
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[403])
          res.end()
        })
      }
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {{userData?: object, protocol?: string}} result
   * @param {string} secWebSocketKey
   * @param {string} requestedProtocol
   * @param {string} secWebSocketExtensions
   * @param {import('@swarmmachina/swm-uws').us_socket_context_t} context
   */
  #acceptUpgrade(res, result, secWebSocketKey, requestedProtocol, secWebSocketExtensions, context) {
    let protocol

    try {
      protocol = selectWsProtocol(requestedProtocol, result.protocol)
    } catch (err) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[403])
        res.end()
      })
      void this.safeWsError(null, err)

      return
    }

    res.cork(() => {
      res.upgrade(result.userData || {}, secWebSocketKey, protocol, secWebSocketExtensions, context)
    })
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} message
   * @param {boolean} isBinary
   */
  onDropped(ws, message, isBinary) {
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = this.onWsDropped(ctx, message, isBinary)
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
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
    if (!this.app || !this.ws) {
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
    if (!this.app || !this.ws) {
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
   * @returns {import('@swarmmachina/swm-uws').WebSocket | undefined}
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
