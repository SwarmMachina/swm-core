import WSContext from '../ws-context.js'
import ContextPool from '../context-pool.js'
import { isPromise, validateWsClose } from './utils.js'
import WebSocketUpgradeRuntime, { WS_CONTEXT_DATA } from './ws-upgrade.js'

export default class WebSocketRuntime {
  #server
  #lifecycle
  #upgradeRuntime
  #wsContexts = new WeakMap()
  #connections = new Map()

  constructor(server, lifecycle) {
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

  get connectionCount() {
    return this.#connections.size
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @returns {WSContext}
   */
  createWsContext = (ws) => {
    const existing = this.#wsContexts.get(ws)

    if (existing) {
      return existing
    }

    this.#lifecycle.activeWs++

    const ctx = this.contextPool.acquire().reset(this.#server, ws, ws[WS_CONTEXT_DATA])

    this.#wsContexts.set(ws, ctx)

    return ctx
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @returns {WSContext}
   */
  getWsContext = (ws) => {
    return this.#wsContexts.get(ws) ?? this.createWsContext(ws)
  }

  /**
   * @param {WSContext} ctx
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  #registerConnection(ctx, ws) {
    const server = this.#server

    if (!server.wsConnectionKey) {
      return
    }

    let key

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
  #unregisterConnection(ctx, ws) {
    if (ctx.key != null && this.#connections.get(ctx.key) === ws) {
      this.#connections.delete(ctx.key)
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  deleteWsContext = (ws) => {
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
  onOpen = (ws) => {
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

    let result
    let error
    let isAsync = false

    try {
      result = server.onWsOpen(ctx)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void server.safeCall(server.onWsError, ctx, error)

      return
    }

    if (isAsync) {
      void result.catch((err) => server.safeCall(server.onWsError, ctx, err))
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} message
   * @param {boolean} isBinary
   */
  onMessage = (ws, message, isBinary) => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = server.onWsMessage(ctx, message, isBinary)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void server.safeCall(server.onWsError, ctx, error)

      return
    }

    if (isAsync) {
      void result.catch((err) => server.safeCall(server.onWsError, ctx, err))
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} message
   * @param {boolean} isBinary
   */
  onDropped = (ws, message, isBinary) => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = server.onWsDropped(ctx, message, isBinary)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void server.safeCall(server.onWsError, ctx, error)

      return
    }

    if (isAsync) {
      void result.catch((err) => server.safeCall(server.onWsError, ctx, err))
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {ArrayBuffer} topic
   * @param {number} newCount
   * @param {number} oldCount
   */
  onSubscription = (ws, topic, newCount, oldCount) => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = server.onWsSubscription(ctx, topic, newCount, oldCount)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void server.safeCall(server.onWsError, ctx, error)

      return
    }

    if (isAsync) {
      void result.catch((err) => server.safeCall(server.onWsError, ctx, err))
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   */
  onDrain = (ws) => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    let result
    let error
    let isAsync = false

    try {
      result = server.onWsDrain(ctx)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void server.safeCall(server.onWsError, ctx, error)

      return
    }

    if (isAsync) {
      void result.catch((err) => server.safeCall(server.onWsError, ctx, err))
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').WebSocket} ws
   * @param {number} code
   * @param {ArrayBuffer} message
   */
  onClose = (ws, code, message) => {
    const server = this.#server
    const ctx = this.getWsContext(ws)

    this.#unregisterConnection(ctx, ws)

    let result
    let error
    let isAsync = false

    try {
      result = server.onWsClose(ctx, code, message)
      isAsync = isPromise(result)
    } catch (err) {
      error = err
    }

    if (error) {
      void server.safeCall(server.onWsError, ctx, error)
      this.deleteWsContext(ws)
      server.finishShutdownIfNeed()

      return
    }

    if (isAsync) {
      void result
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
  register(app) {
    const server = this.#server

    if (!server.ws) {
      return
    }

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
  getSubscribersCount(topic) {
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
  publish(topic, message, isBinary) {
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
  sendTo(key, message, isBinary) {
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
  closeConnection(key, code = 1000, reason = '') {
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
  terminateConnection(key) {
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

  clearConnections() {
    this.#connections.clear()
  }
}
