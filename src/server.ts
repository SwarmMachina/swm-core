import { load as loadTransport } from './backends/uws.js'
import BodyBudget from './body-budget.js'
import HttpRuntime from './server/http-runtime.js'
import { NOOP, normalizeHttpOptions, normalizeTransportOptions, normalizeWsOptions } from './server/options.js'
import WebSocketRuntime from './server/ws-runtime.js'

import type { HttpRequest, HttpResponse, RequestPrefetchPlan } from '@swarmmachina/swm-uws'
import type HttpContext from './http-context.js'
import type WSContext from './ws-context.js'
import type {
  HttpTransportOptions,
  NormalizedHttpOptions,
  NormalizedWSOptions,
  ServerOptions
} from './server/options.js'
import type WebSocketUpgradeMeta from './server/ws-upgrade-meta.js'

type AsyncCallback<Args extends unknown[] = unknown[]> = (...args: Args) => unknown | Promise<unknown>
type NativeRouteHandler = (res: HttpResponse, req: HttpRequest) => void
type NativeRouteMethod = (path: string, handler: NativeRouteHandler) => void
type NativeWebSocketMethod = (pattern: string, behavior: object) => void
type WebSocketPayload = string | ArrayBuffer | Uint8Array | Buffer

interface LifecycleState {
  draining: boolean
  activeHttp: number
  activeWs: number
}

interface NativeApp {
  any: NativeRouteMethod
  del: NativeRouteMethod
  get: NativeRouteMethod
  head: NativeRouteMethod
  options: NativeRouteMethod
  patch: NativeRouteMethod
  post: NativeRouteMethod
  put: NativeRouteMethod
  ws: NativeWebSocketMethod
  numSubscribers(topic: string): number
  publish(topic: string, message: WebSocketPayload, isBinary: boolean): boolean
  onError?(handler: (error: Error) => void): void
  listen(host: string, port: number, callback: (socket: unknown) => void): void
  close(): void
}

interface EffectiveConfig {
  http: Readonly<{
    prefetch: boolean
    prefetchHeaders: false | 'all' | readonly string[]
    maxBodySize: number
    maxBodyBudget: number | null
    requestTimeoutMs: number
  }> | null
  transport: Readonly<Record<string, number | null>> | null
  ws: Readonly<{
    maxPayloadLength: number
    maxBackpressure: number
    closeOnBackpressureLimit: boolean
    idleTimeoutSec: number
    upgradeTimeoutMs: number
    prefetchHeaders: false | 'all' | readonly string[]
  }> | null
}

export default class Server {
  #listenPromise: Promise<this> | null = null
  #shutdownPromise: Promise<void> | null = null
  #shutdownResolver: ((value?: void | PromiseLike<void>) => void) | null = null
  #shutdownTimeout: ReturnType<typeof setTimeout> | null = null
  #backend: Awaited<ReturnType<typeof loadTransport>> | null = null
  #httpRuntime: HttpRuntime
  #wsRuntime: WebSocketRuntime
  #lifecycle: LifecycleState = {
    draining: false,
    activeHttp: 0,
    activeWs: 0
  }

  declare bindingCapabilities: Readonly<Record<string, boolean>>
  declare requestPrefetchPlanClass:
    (new (options: { headers: 'all' | readonly string[] }) => RequestPrefetchPlan) | null
  declare host: string
  declare port: number
  declare http: NormalizedHttpOptions | null
  declare transport: Readonly<HttpTransportOptions> | null
  declare ws: NormalizedWSOptions | null
  declare httpMaxBodyBytes: number
  declare httpBodyBudget: BodyBudget | null
  declare httpRequestTimeoutMs: number
  declare wsMaxPayloadBytes: number
  declare wsMaxBackpressureBytes: number
  declare wsCloseOnBackpressureLimit: boolean
  declare httpErrorHandler: AsyncCallback<[HttpContext, Error]>
  declare onServerError: AsyncCallback<[Error]>
  declare onWsOpen: AsyncCallback<[WSContext]>
  declare onWsClose: AsyncCallback<[WSContext, number, ArrayBuffer]>
  declare onWsError: AsyncCallback<[WSContext | null, Error]>
  declare onWsMessage: AsyncCallback<[WSContext, ArrayBuffer, boolean]>
  declare onWsDrain: AsyncCallback<[WSContext]>
  declare onWsDropped: AsyncCallback<[WSContext, ArrayBuffer, boolean]>
  declare onWsSubscription: AsyncCallback<[WSContext, ArrayBuffer, number, number]>
  declare onWsUpgrade: ((meta: WebSocketUpgradeMeta) => object | null | Promise<object | null>) | null
  declare wsProtocolSelector: ((requested: readonly string[], userData: object) => string | undefined) | null
  declare wsConnectionKey: ((ctx: WSContext) => string | number | null | undefined) | null
  declare wsIdleTimeoutSec: number
  declare wsUpgradeTimeoutMs: number
  declare effectiveConfig: Readonly<EffectiveConfig>
  declare app: NativeApp | null
  declare socket: unknown | null
  declare httpContextPool: HttpRuntime['contextPool']
  declare registerHttp: HttpRuntime['register']
  declare finalizeHttpContext: HttpRuntime['finalizeHttpContext']
  declare handleWithContext: HttpRuntime['handleWithContext']
  declare registerWebSocket: WebSocketRuntime['register']
  declare createWsContext: WebSocketRuntime['createWsContext']
  declare getWsContext: WebSocketRuntime['getWsContext']
  declare deleteWsContext: WebSocketRuntime['deleteWsContext']
  declare onOpen: WebSocketRuntime['onOpen']
  declare onMessage: WebSocketRuntime['onMessage']
  declare onDropped: WebSocketRuntime['onDropped']
  declare onSubscription: WebSocketRuntime['onSubscription']
  declare onDrain: WebSocketRuntime['onDrain']
  declare onClose: WebSocketRuntime['onClose']
  declare onUpgrade: WebSocketRuntime['onUpgrade']
  declare getSubscribersCount: WebSocketRuntime['getSubscribersCount']
  declare publish: WebSocketRuntime['publish']
  declare sendTo: WebSocketRuntime['sendTo']
  declare closeConnection: WebSocketRuntime['closeConnection']
  declare terminateConnection: WebSocketRuntime['terminateConnection']
  declare hasConnection: WebSocketRuntime['hasConnection']
  declare getConnection: WebSocketRuntime['getConnection']
  declare clearConnections: WebSocketRuntime['clearConnections']

  /**
   * @param {object} [opt]
   * @param {{onRequest?: (ctx: import('./http-context.js').default) => unknown|Promise<unknown>, routes?: import('./server/options.js').Route[], onError?: (ctx: import('./http-context.js').default, err: Error) => unknown|Promise<unknown>, prefetch?: boolean, prefetchHeaders?: false|'all'|string[], maxBodySize?: number, maxBodyBudget?: number|null, requestTimeoutMs?: number}|null} [opt.http]
   * @param {(err: Error) => unknown|Promise<unknown>} [opt.onServerError]
   * @param {string} [opt.host]
   * @param {number} [opt.port]
   * @param {import('./server/options.js').HttpTransportOptions} [opt.transport]
   * @param {import('./server/options.js').WSOptions|null} [opt.ws]
   */
  constructor(opt: ServerOptions) {
    if (typeof opt !== 'object' || opt === null || Array.isArray(opt)) {
      throw new TypeError('Server options must be an object')
    }

    if (Object.hasOwn(opt, 'router') || Object.hasOwn(opt, 'routes') || Object.hasOwn(opt, 'onHttpError')) {
      throw new TypeError(
        'Legacy HTTP options are no longer supported; use http.onRequest, http.routes, and http.onError'
      )
    }

    if (Object.hasOwn(opt, 'backend')) {
      throw new TypeError('backend is no longer configurable; swm-uws is always used')
    }

    if (Object.hasOwn(opt, 'maxBodySize')) {
      throw new TypeError('maxBodySize is no longer a server option; use http.maxBodySize or ws.maxPayloadLength')
    }

    if (Object.hasOwn(opt, 'prefetch')) {
      throw new TypeError('prefetch is no longer a server option; use http.prefetch')
    }

    const options = opt as unknown as Record<string, unknown>
    const {
      http: httpOptions,
      onServerError,
      host = '127.0.0.1',
      port = 6000,
      transport: transportOptions,
      ws: wsOptions
    } = options
    const http = normalizeHttpOptions(httpOptions)
    const transport = normalizeTransportOptions(transportOptions)
    const ws = normalizeWsOptions(wsOptions)

    if (!http && !ws) {
      throw new TypeError('At least one of "http" or "ws" must be configured')
    }

    this.bindingCapabilities = Object.freeze({})
    this.requestPrefetchPlanClass = null

    if (!(typeof port === 'number' && Number.isFinite(port) && port > 0 && port <= 65535)) {
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
    this.transport = transport
    this.ws = ws
    this.httpMaxBodyBytes = http?.maxBodySize ?? 0
    this.httpBodyBudget = http && http.maxBodyBudget !== null ? new BodyBudget(http.maxBodyBudget) : null
    this.httpRequestTimeoutMs = http?.requestTimeoutMs ?? 0
    this.wsMaxPayloadBytes = ws?.maxPayloadLength ?? 0
    this.wsMaxBackpressureBytes = ws?.maxBackpressure ?? 0
    this.wsCloseOnBackpressureLimit = ws?.closeOnBackpressureLimit ?? false

    this.httpErrorHandler = http?.onError ?? NOOP
    this.onServerError = typeof onServerError === 'function' ? (onServerError as AsyncCallback<[Error]>) : NOOP
    this.onWsOpen = ws?.onOpen ?? NOOP
    this.onWsClose = ws?.onClose ?? NOOP
    this.onWsError = ws?.onError ?? NOOP
    this.onWsMessage = ws?.onMessage ?? NOOP
    this.onWsDrain = ws?.onDrain ?? NOOP
    this.onWsDropped = ws?.onDropped ?? NOOP
    this.onWsSubscription = ws?.onSubscription ?? NOOP
    this.onWsUpgrade = ws?.onUpgrade ?? null
    this.wsProtocolSelector = ws?.selectProtocol ?? null
    this.wsConnectionKey = null
    this.wsIdleTimeoutSec = 15
    this.wsUpgradeTimeoutMs = 10_000

    if (ws) {
      this.wsIdleTimeoutSec = Math.floor(ws.idleTimeoutSec ?? 15)
      this.wsUpgradeTimeoutMs = ws.upgradeTimeoutMs
      this.wsConnectionKey = ws.connectionKey ?? null
    }

    this.effectiveConfig = Object.freeze({
      http: http
        ? Object.freeze({
            prefetch: http.prefetch,
            prefetchHeaders: http.prefetchHeaders,
            maxBodySize: this.httpMaxBodyBytes,
            maxBodyBudget: http.maxBodyBudget,
            requestTimeoutMs: this.httpRequestTimeoutMs
          })
        : null,
      transport,
      ws: ws
        ? Object.freeze({
            maxPayloadLength: this.wsMaxPayloadBytes,
            maxBackpressure: this.wsMaxBackpressureBytes,
            closeOnBackpressureLimit: this.wsCloseOnBackpressureLimit,
            idleTimeoutSec: this.wsIdleTimeoutSec,
            upgradeTimeoutMs: this.wsUpgradeTimeoutMs,
            prefetchHeaders: ws.prefetchHeaders
          })
        : null
    })

    this.app = null
    this.socket = null

    this.#httpRuntime = new HttpRuntime(this, this.#lifecycle)
    this.#wsRuntime = new WebSocketRuntime(this, this.#lifecycle)

    // Contexts intentionally retain the Server facade. Direct runtime callback
    // references keep that contract without adding a proxy call to hot paths.
    this.httpContextPool = this.#httpRuntime.contextPool
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
  async safeCall(fn: unknown, ...args: unknown[]): Promise<void> {
    if (typeof fn !== 'function') {
      return
    }

    try {
      await fn(...args)
    } catch {
      // User error hooks must not escape into transport callbacks.
    }
  }

  listen(): Promise<this> {
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
  async #doListen(): Promise<this> {
    let app = this.app

    if (!app) {
      const backend = await loadTransport()

      this.#backend = backend
      this.bindingCapabilities = Object.freeze({ ...backend.capabilities })
      this.requestPrefetchPlanClass =
        this.bindingCapabilities.requestPrefetch === true ? (backend.RequestPrefetchPlan ?? null) : null

      if (this.transport && this.bindingCapabilities.httpTransportConfig !== true) {
        throw new Error('transport options require a swm-uws binding with the httpTransportConfig capability')
      }

      app = (this.transport ? backend.App({ http: this.transport }) : backend.App()) as NativeApp
      this.app = app
      app.onError?.((err) => void this.safeCall(this.onServerError, err))

      this.registerHttp(app)
      this.registerWebSocket(app)
    }

    return new Promise((resolve, reject) => {
      app.listen(this.host, this.port, (socket) => {
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
  shutdown(timeout = 10 * 1000): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise
    }

    const { promise, resolve } = Promise.withResolvers<void>()

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
