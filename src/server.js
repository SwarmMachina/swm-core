import { load as loadTransport } from './backends/uws.js'
import HttpRuntime from './server/http-runtime.js'
import { ALLOW_WS_UPGRADE, NOOP, normalizeHttpOptions, normalizeWsOptions } from './server/options.js'
import WebSocketRuntime from './server/ws-runtime.js'

export default class Server {
  #listenPromise = null
  #shutdownPromise = null
  #shutdownResolver = null
  #shutdownTimeout = null
  #backend = null
  #httpRuntime
  #wsRuntime
  #lifecycle = {
    draining: false,
    activeHttp: 0,
    activeWs: 0
  }

  bindingCapabilities = Object.freeze({})

  /**
   * @param {object} [opt]
   * @param {{onRequest?: (ctx: import('./http-context.js').default) => unknown|Promise<unknown>, routes?: import('./server/options.js').Route[], onError?: (ctx: import('./http-context.js').default, err: Error) => unknown|Promise<unknown>, maxBodySize?: number}|null} [opt.http]
   * @param {(err: Error) => unknown|Promise<unknown>} [opt.onServerError]
   * @param {string} [opt.host]
   * @param {number} [opt.port]
   * @param {import('./server/options.js').WSOptions|null} [opt.ws]
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

    if ('backend' in opt) {
      throw new TypeError('backend is no longer configurable; swm-uws is always used')
    }

    if ('maxBodySize' in opt) {
      throw new TypeError('maxBodySize is no longer a server option; use http.maxBodySize and ws.maxBodySize')
    }

    const { http: httpOptions, onServerError, host = '127.0.0.1', port = 6000, ws: wsOptions } = opt
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

    if (onServerError !== undefined && typeof onServerError !== 'function') {
      throw new TypeError('onServerError must be a function')
    }

    this.host = host
    this.port = port
    this.http = http
    this.ws = ws
    this.httpMaxBodyBytes = Math.floor((http?.maxBodySize ?? 1) * 1024 * 1024)
    this.wsMaxPayloadBytes = Math.floor((ws?.maxBodySize ?? 1) * 1024 * 1024)

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
    this.wsIdleTimeoutSec = 15
    this.wsUpgradeTimeoutMs = 10_000

    if (ws) {
      this.wsIdleTimeoutSec = Math.floor(ws.idleTimeoutSec ?? 15)
      this.wsUpgradeTimeoutMs = Math.floor(ws.upgradeTimeoutMs ?? 10_000)
      this.wsConnectionKey = ws.connectionKey ?? null
    }

    this.app = null
    this.socket = null

    this.#httpRuntime = new HttpRuntime(this, this.#lifecycle)
    this.#wsRuntime = new WebSocketRuntime(this, this.#lifecycle)

    // Contexts intentionally retain the Server facade. Direct runtime callback
    // references keep that contract without adding a proxy call to hot paths.
    this.httpContextPool = this.#httpRuntime.contextPool
    this.wsContextPool = this.#wsRuntime.contextPool
    this.registerHttp = this.#httpRuntime.register
    this.finalizeHttpContext = this.#httpRuntime.finalizeHttpContext
    this.handleWithContext = this.#httpRuntime.handleWithContext
    this.registerWebSocket = this.#wsRuntime.register
    this.createWsContext = this.#wsRuntime.createWsContext
    this.getWsContext = this.#wsRuntime.getWsContext
    this.deleteWsContext = this.#wsRuntime.deleteWsContext
    this.onOpen = this.#wsRuntime.onOpen
    this.onMessage = this.#wsRuntime.onMessage
    this.onDropped = this.#wsRuntime.onDropped
    this.onSubscription = this.#wsRuntime.onSubscription
    this.onDrain = this.#wsRuntime.onDrain
    this.onClose = this.#wsRuntime.onClose
    this.onUpgrade = this.#wsRuntime.onUpgrade
    this.getSubscribersCount = this.#wsRuntime.getSubscribersCount
    this.publish = this.#wsRuntime.publish
    this.sendTo = this.#wsRuntime.sendTo
    this.closeConnection = this.#wsRuntime.closeConnection
    this.terminateConnection = this.#wsRuntime.terminateConnection
    this.hasConnection = this.#wsRuntime.hasConnection
    this.getConnection = this.#wsRuntime.getConnection
    this.clearConnections = this.#wsRuntime.clearConnections
  }

  get activeHttp() {
    return this.#lifecycle.activeHttp
  }

  get activeWs() {
    return this.#lifecycle.activeWs
  }

  get connectionCount() {
    return this.#wsRuntime.connectionCount
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
      // User error hooks must not escape into transport callbacks.
    }
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
      this.#backend = await loadTransport()
      this.bindingCapabilities = Object.freeze({ ...(this.#backend.capabilities || {}) })
      this.app = this.#backend.App()
      this.app.onError?.((err) => void this.safeCall(this.onServerError, err))

      this.registerHttp(this.app)
      this.registerWebSocket(this.app)
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

  stopAccepting() {
    if (this.socket) {
      this.#backend?.us_listen_socket_close(this.socket)
      this.socket = null
    }
  }

  finishShutdownIfNeed() {
    if (!this.#lifecycle.draining) {
      return
    }

    if (this.#lifecycle.activeHttp || this.#lifecycle.activeWs) {
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
   * @returns {Promise<void>}
   */
  shutdown(timeout = 10 * 1000) {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise
    }

    const { promise, resolve } = Promise.withResolvers()

    this.#shutdownPromise = promise
    this.#shutdownResolver = resolve

    if (!this.#lifecycle.draining) {
      this.#lifecycle.draining = true

      if (timeout > 0) {
        this.#shutdownTimeout = setTimeout(() => this.close(), timeout)
      }
    }

    this.finishShutdownIfNeed()

    return this.#shutdownPromise
  }

  /** Force stop. */
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

    this.clearConnections()
    this.#lifecycle.draining = false

    this.#resolveShutdownIfNeeded()
  }
}
