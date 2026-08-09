import WSContext from '../ws-context.js'
import ContextPool from '../context-pool.js'
import { isPromise, validateWsClose } from './utils.js'
import WebSocketUpgradeRuntime, { WS_CONTEXT_DATA } from './ws-upgrade.js'

import type { RequestPrefetchPlan, WebSocket } from '@swarmmachina/swm-uws'
import type { HeaderPrefetch } from './options.js'
import type WebSocketUpgradeMeta from './ws-upgrade-meta.js'

type NativeWebSocket = WebSocket<object> & { [WS_CONTEXT_DATA]?: object }
type WSKey = string | number
type WSPayload = string | ArrayBuffer | ArrayBufferView

interface LifecycleState {
  draining: boolean
  activeWs: number
}

interface WebSocketApp {
  ws(pattern: string, behavior: object): void
  numSubscribers(topic: string): number
  publish(topic: string, message: string | ArrayBuffer | Uint8Array | Buffer, isBinary: boolean): boolean
}

interface WebSocketServer {
  readonly ws: { prefetchHeaders: HeaderPrefetch } | null
  readonly app: WebSocketApp | null
  readonly requestPrefetchPlanClass:
    (new (options: { headers: 'all' | readonly string[] }) => RequestPrefetchPlan) | null
  readonly wsConnectionKey: ((ctx: WSContext) => WSKey | null | undefined) | null
  readonly wsProtocolSelector: ((requested: readonly string[], userData: object) => string | undefined) | null
  readonly wsIdleTimeoutSec: number
  readonly wsUpgradeTimeoutMs: number
  readonly wsMaxPayloadBytes: number
  readonly wsMaxBackpressureBytes: number
  readonly wsCloseOnBackpressureLimit: boolean
  readonly onWsError: unknown
  readonly onWsUpgrade: ((meta: WebSocketUpgradeMeta) => object | null | Promise<object | null>) | null
  onWsOpen(ctx: WSContext): unknown
  onWsMessage(ctx: WSContext, message: ArrayBuffer, isBinary: boolean): unknown
  onWsDropped(ctx: WSContext, message: ArrayBuffer, isBinary: boolean): unknown
  onWsSubscription(ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number): unknown
  onWsDrain(ctx: WSContext): unknown
  onWsClose(ctx: WSContext, code: number, message: ArrayBuffer): unknown
  safeCall(handler: unknown, ...args: unknown[]): Promise<void>
  finishShutdownIfNeed(): void
  publish(topic: string, message: WSPayload, isBinary?: boolean): boolean
}

export default class WebSocketRuntime {
  readonly #server: WebSocketServer
  readonly #lifecycle: LifecycleState
  readonly #upgradeRuntime: WebSocketUpgradeRuntime
  readonly #wsContexts = new WeakMap<NativeWebSocket, WSContext>()
  readonly #connections = new Map<WSKey, NativeWebSocket>()
  readonly contextPool: ContextPool<WSContext>
  readonly onUpgrade: WebSocketUpgradeRuntime['handle']

  constructor(server: WebSocketServer, lifecycle: LifecycleState) {
    this.#server = server
    this.#lifecycle = lifecycle
    this.#upgradeRuntime = new WebSocketUpgradeRuntime(server, lifecycle)

    // WSContext instances are never reused across connections. A retained
    // post-close reference must fail instead of targeting another socket.
    this.contextPool = new ContextPool((pool) => new WSContext(pool), 0)

    this.register = this.register.bind(this)
    this.onUpgrade = this.#upgradeRuntime.handle
    this.getSubscribersCount = this.getSubscribersCount.bind(this)
    this.publish = this.publish.bind(this)
    this.sendTo = this.sendTo.bind(this)
    this.closeConnection = this.closeConnection.bind(this)
    this.terminateConnection = this.terminateConnection.bind(this)
    this.hasConnection = this.hasConnection.bind(this)
    this.getConnection = this.getConnection.bind(this)
    this.clearConnections = this.clearConnections.bind(this)
  }

  get connectionCount(): number {
    return this.#connections.size
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @returns {WSContext}
   */
  createWsContext = (ws: NativeWebSocket): WSContext => {
    const existing = this.#wsContexts.get(ws)

    if (existing) {
      return existing
    }

    this.#lifecycle.activeWs++

    const ctx = this.contextPool.acquire().reset(this.#server, ws, ws[WS_CONTEXT_DATA]!)

    this.#wsContexts.set(ws, ctx)

    return ctx
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @returns {WSContext}
   */
  getWsContext = (ws: NativeWebSocket): WSContext => {
    return this.#wsContexts.get(ws) ?? this.createWsContext(ws)
  }

  /**
   * @param {WSContext} ctx
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  #registerConnection(ctx: WSContext, ws: NativeWebSocket): void {
    const server = this.#server

    if (!server.wsConnectionKey) {
      return
    }

    let key: WSKey | null | undefined

    try {
      key = server.wsConnectionKey(ctx)
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)

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
  #unregisterConnection(ctx: WSContext, ws: NativeWebSocket): void {
    if (ctx.key != null && this.#connections.get(ctx.key) === ws) {
      this.#connections.delete(ctx.key)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  deleteWsContext = (ws: NativeWebSocket): void => {
    const ctx = this.#wsContexts.get(ws)

    if (ctx) {
      this.#unregisterConnection(ctx, ws)

      ctx.release()
      this.#wsContexts.delete(ws)
      this.#lifecycle.activeWs--
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  onOpen = (ws: NativeWebSocket): void => {
    const server = this.#server

    if (this.#lifecycle.draining) {
      ws.end(1001, 'server shutting down')

      return
    }

    const ctx = this.createWsContext(ws)

    this.#registerConnection(ctx, ws)

    if (this.#wsContexts.get(ws) !== ctx) {
      return
    }

    try {
      const result = server.onWsOpen(ctx)

      if (isPromise(result)) {
        void Promise.resolve(result).catch((err) => server.safeCall(server.onWsError, ctx, err))
      }
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} message
   * @param {boolean} isBinary
   */
  onMessage = (ws: NativeWebSocket, message: ArrayBuffer, isBinary: boolean): void => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    try {
      const result = server.onWsMessage(ctx, message, isBinary)

      if (isPromise(result)) {
        void Promise.resolve(result).catch((err) => server.safeCall(server.onWsError, ctx, err))
      }
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} message
   * @param {boolean} isBinary
   */
  onDropped = (ws: NativeWebSocket, message: ArrayBuffer, isBinary: boolean): void => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    try {
      const result = server.onWsDropped(ctx, message, isBinary)

      if (isPromise(result)) {
        void Promise.resolve(result).catch((err) => server.safeCall(server.onWsError, ctx, err))
      }
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} topic
   * @param {number} newCount
   * @param {number} oldCount
   */
  onSubscription = (ws: NativeWebSocket, topic: ArrayBuffer, newCount: number, oldCount: number): void => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    try {
      const result = server.onWsSubscription(ctx, topic, newCount, oldCount)

      if (isPromise(result)) {
        void Promise.resolve(result).catch((err) => server.safeCall(server.onWsError, ctx, err))
      }
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  onDrain = (ws: NativeWebSocket): void => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    try {
      const result = server.onWsDrain(ctx)

      if (isPromise(result)) {
        void Promise.resolve(result).catch((err) => server.safeCall(server.onWsError, ctx, err))
      }
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {number} code
   * @param {ArrayBuffer} message
   */
  onClose = (ws: NativeWebSocket, code: number, message: ArrayBuffer): void => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    this.#unregisterConnection(ctx, ws)

    let result

    try {
      result = server.onWsClose(ctx, code, message)
    } catch (err) {
      void server.safeCall(server.onWsError, ctx, err)
      this.deleteWsContext(ws)
      server.finishShutdownIfNeed()

      return
    }

    if (isPromise(result)) {
      void Promise.resolve(result)
        .catch((err) => server.safeCall(server.onWsError, ctx, err))
        .finally(() => {
          this.deleteWsContext(ws)
          server.finishShutdownIfNeed()
        })

      return
    }

    this.deleteWsContext(ws)
    server.finishShutdownIfNeed()
  }

  /**
   * @param {object} app
   */
  register(app: WebSocketApp): void {
    const server = this.#server

    if (!server.ws) {
      return
    }

    this.#upgradeRuntime.configureHeaderPrefetch(server.ws.prefetchHeaders, server.requestPrefetchPlanClass)

    app.ws('/*', {
      idleTimeout: server.wsIdleTimeoutSec,
      upgradeTimeout: server.wsUpgradeTimeoutMs,
      sendPingsAutomatically: true,
      maxPayloadLength: server.wsMaxPayloadBytes,
      maxBackpressure: server.wsMaxBackpressureBytes,
      closeOnBackpressureLimit: server.wsCloseOnBackpressureLimit,
      open: this.onOpen,
      message: this.onMessage,
      dropped: this.onDropped,
      close: this.onClose,
      drain: this.onDrain,
      subscription: this.onSubscription,
      upgrade: this.onUpgrade
    })
  }

  /**
   * @param {string} topic
   * @returns {number}
   */
  getSubscribersCount(topic: string): number {
    const server = this.#server

    if (!server.app || !server.ws) {
      return 0
    }

    return server.app.numSubscribers(topic)
  }

  /**
   * @param {string} topic
   * @param {string | ArrayBuffer | Uint8Array | Buffer} message
   * @param {boolean} [isBinary]
   * @returns {boolean}
   */
  publish(topic: string, message: string | ArrayBuffer | Uint8Array | Buffer, isBinary?: boolean): boolean {
    const server = this.#server

    if (!server.app || !server.ws) {
      return false
    }

    const bin = isBinary ?? typeof message !== 'string'

    return server.app.publish(topic, message, bin)
  }

  /**
   * @param {string | number} key
   * @param {string | ArrayBuffer | ArrayBufferView} message
   * @param {boolean} [isBinary]
   * @returns {boolean}
   */
  sendTo(key: WSKey, message: WSPayload, isBinary?: boolean): boolean {
    const ws = this.#connections.get(key)

    if (!ws) {
      return false
    }

    return ws.send(message, isBinary ?? typeof message !== 'string') !== 2
  }

  /**
   * Gracefully close the connection registered under key.
   * @param {string | number} key
   * @param {number} [code]
   * @param {string} [reason]
   * @returns {boolean}
   */
  closeConnection(key: WSKey, code = 1000, reason = ''): boolean {
    validateWsClose(code, reason)

    const ws = this.#connections.get(key)

    if (!ws) {
      return false
    }

    // Make the closing socket unreachable before end() synchronously invokes
    // onClose. Keep ctx.key intact so the application can inspect it there.
    this.#connections.delete(key)
    ws.end(code, reason)

    return true
  }

  /**
   * Force-close the connection registered under key without a close frame.
   * @param {string | number} key
   * @returns {boolean}
   */
  terminateConnection(key: WSKey): boolean {
    const ws = this.#connections.get(key)

    if (!ws) {
      return false
    }

    this.#connections.delete(key)
    ws.close()

    return true
  }

  /**
   * @param {string | number} key
   * @returns {boolean}
   */
  hasConnection(key: WSKey): boolean {
    return this.#connections.has(key)
  }

  /**
   * @param {string | number} key
   * @returns {import('@swarmmachina/swm-uws').WebSocket | undefined}
   */
  getConnection(key: WSKey): NativeWebSocket | undefined {
    return this.#connections.get(key)
  }

  clearConnections(): void {
    this.#connections.clear()
  }
}
