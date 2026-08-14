import { load as loadTransport } from './transport/uws.js'
import BodyBudget from '../http/body-budget.js'
import HttpErrorDispatcher, { EMPTY_HTTP_ERROR_DELIVERY_STATS } from '../http/error-dispatcher.js'
import { createHttpErrorEvent, normalizeHttpError } from '../http/error-event.js'
import HttpRuntime from '../http/runtime.js'
import { NOOP, normalizeHttpOptions, normalizeTransportOptions, normalizeWsOptions } from './options.js'
import WebSocketRuntime from '../ws/runtime.js'

import type { HttpRequest, HttpResponse, RequestPrefetchPlan } from '@swarmmachina/swm-uws'
import type HttpContext from '../http/context.js'
import type WSContext from '../ws/context.js'
import type {
  HttpErrorDeliveryStats,
  HttpTransportOptions,
  NormalizedHttpErrorDeliveryOptions,
  NormalizedHttpOptions,
  NormalizedWSOptions,
  ServerOptions
} from './options.js'
import type WebSocketUpgradeMeta from '../ws/upgrade-meta.js'

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
    errorDelivery: Readonly<NormalizedHttpErrorDeliveryOptions> | null
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

function createListenAbortError(): Error {
  const error = new Error('Listen was cancelled')

  error.name = 'AbortError'

  return error
}

/**
 * High-performance HTTP and WebSocket server backed by swm-uws.
 *
 * Construction validates configuration synchronously. Call {@link listen} to
 * begin accepting connections and {@link shutdown} for graceful termination.
 */
export default class Server {
  #httpErrorDispatcher: HttpErrorDispatcher | null
  #httpErrorShutdownPromise: Promise<void> | null = null
  #listenPromise: Promise<this> | null = null
  #listenGeneration = 0
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
   * Creates a server with at least one enabled protocol layer.
   * @param {object} [opt]
   * @param {import('./options.js').HttpOptions|null} [opt.http]
   * @param {(err: Error) => unknown|Promise<unknown>} [opt.onServerError]
   * @param {string} [opt.host]
   * @param {number} [opt.port]
   * @param {import('./options.js').HttpTransportOptions} [opt.transport]
   * @param {import('./options.js').WSOptions|null} [opt.ws]
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

    if (!(typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port <= 65535)) {
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

    this.#httpErrorDispatcher =
      http?.onError && http.errorDelivery ? new HttpErrorDispatcher(http.onError, http.errorDelivery) : null
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
            requestTimeoutMs: this.httpRequestTimeoutMs,
            errorDelivery: http.errorDelivery
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

  /** Number of HTTP requests whose lifecycle has not completed. */
  get activeHttp() {
    return this.#lifecycle.activeHttp
  }

  /** Number of open WebSocket connections. */
  get activeWs() {
    return this.#lifecycle.activeWs
  }

  /** Number of live entries in the addressable WebSocket registry. */
  get connectionCount() {
    return this.#wsRuntime.connectionCount
  }

  /** Returns a frozen point-in-time view of bounded HTTP error delivery. */
  get httpErrorDeliveryStats(): Readonly<HttpErrorDeliveryStats> {
    return this.#httpErrorDispatcher?.stats ?? EMPTY_HTTP_ERROR_DELIVERY_STATS
  }

  /** Captures body-free request metadata and submits an observability event. */
  reportHttpError(context: HttpContext, value: unknown): void {
    const dispatcher = this.#httpErrorDispatcher
    const delivery = this.http?.errorDelivery

    if (!dispatcher || !delivery) {
      return
    }

    const error = normalizeHttpError(value)
    const event = createHttpErrorEvent(context, error, delivery.headers, delivery.query, delivery.includeIp)

    dispatcher.dispatch(event, error)
  }

  /**
   * Calls a user hook while containing synchronous throws and rejections.
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

  /** Starts the native listener and resolves with this server when ready. */
  listen(): Promise<this> {
    if (this.socket) {
      return Promise.resolve(this)
    }

    if (this.#listenPromise) {
      return this.#listenPromise
    }

    if (this.#httpErrorDispatcher?.closed) {
      const http = this.http

      this.#httpErrorDispatcher =
        http?.onError && http.errorDelivery ? new HttpErrorDispatcher(http.onError, http.errorDelivery) : null
    }

    const generation = ++this.#listenGeneration
    const promise = this.#doListen(generation)

    this.#listenPromise = promise

    promise.catch(() => {
      if (this.#listenPromise === promise) {
        this.#listenPromise = null
        this.#resolveShutdownIfNeeded()
      }
    })

    return promise
  }

  /**
   * Creates the native application and binds its listener.
   * @param {number} generation Listen generation used to reject stale completions.
   * @returns {Promise<Server>}
   */
  async #doListen(generation: number): Promise<this> {
    let app = this.app

    if (!app) {
      const backend = await loadTransport()

      if (generation !== this.#listenGeneration) {
        throw createListenAbortError()
      }

      this.#backend = backend
      this.bindingCapabilities = Object.freeze({ ...backend.capabilities })
      this.requestPrefetchPlanClass =
        this.bindingCapabilities.requestPrefetch === true ? (backend.RequestPrefetchPlan ?? null) : null

      if (this.transport && this.bindingCapabilities.httpTransportConfig !== true) {
        throw new Error('transport options require a swm-uws binding with the httpTransportConfig capability')
      }

      const candidate = (this.transport ? backend.App({ http: this.transport }) : backend.App()) as NativeApp

      candidate.onError?.((err) => void this.safeCall(this.onServerError, err))

      try {
        this.registerHttp(candidate)
        this.registerWebSocket(candidate)
      } catch (err) {
        try {
          candidate.close()
        } catch {
          // Keep the original route-registration error.
        }

        throw err
      }

      if (generation !== this.#listenGeneration) {
        try {
          candidate.close()
        } catch {
          // Cancellation must still reject listen().
        }

        throw createListenAbortError()
      }

      this.app = candidate
      app = candidate
    }

    return new Promise((resolve, reject) => {
      app.listen(this.host, this.port, (socket) => {
        this.#listenPromise = null

        if (generation !== this.#listenGeneration) {
          if (socket) {
            this.#backend?.us_listen_socket_close(socket)
          }

          if (this.app === app) {
            this.app = null

            try {
              app.close()
            } catch {
              // Cancellation must still reject listen().
            }
          }

          this.#resolveShutdownIfNeeded()
          reject(createListenAbortError())

          return
        }

        if (!socket) {
          return reject(new Error(`Listen failed on ${this.host}:${this.port}`))
        }

        this.socket = socket
        resolve(this)
      })
    })
  }

  /** Stops accepting new connections without closing active work. */
  stopAccepting() {
    if (this.socket) {
      this.#backend?.us_listen_socket_close(this.socket)
      this.socket = null
    }
  }

  /** Completes graceful shutdown after every tracked connection is gone. */
  finishShutdownIfNeed() {
    if (!this.#lifecycle.draining) {
      return
    }

    if (this.#lifecycle.activeHttp || this.#lifecycle.activeWs) {
      return
    }

    const dispatcher = this.#httpErrorDispatcher

    if (dispatcher && !this.#httpErrorShutdownPromise) {
      const shutdownPromise = dispatcher.shutdown()

      this.#httpErrorShutdownPromise = shutdownPromise
      void shutdownPromise.then(() => {
        if (this.#httpErrorShutdownPromise !== shutdownPromise) {
          return
        }

        this.#httpErrorShutdownPromise = null

        if (this.#lifecycle.draining) {
          this.close()
        }
      })

      return
    }

    if (this.#httpErrorShutdownPromise) {
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
   * Stops accepting new work and waits for active HTTP and WebSocket lifecycles.
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

  /** Immediately closes the listener and active native connections. */
  close() {
    this.#listenGeneration++
    this.#httpErrorDispatcher?.abort()
    this.#httpErrorShutdownPromise = null
    this.stopAccepting()

    if (!this.app) {
      if (!this.#listenPromise) {
        this.#resolveShutdownIfNeeded()
      }

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
