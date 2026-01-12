export default class WSContext {
  /**
   * @param {ContextPool} pool
   */
  constructor(pool) {
    this.pool = pool
    this.server = null
    this.ws = null
    this.data = null
  }

  /**
   * @param {Server} server
   * @param {import('uwebsockets.js').WebSocket} ws
   * @param {object} userData
   * @returns {WSContext}
   */
  reset(server, ws, userData) {
    this.server = server
    this.ws = ws
    this.data = userData
    return this
  }

  /**
   */
  clear() {
    this.server = null
    this.ws = null
    this.data = null
  }

  /**
   */
  release() {
    if (this.pool) {
      this.pool.release(this)
    }
  }

  /**
   * @param {string | ArrayBuffer | ArrayBufferView} data
   * @param {boolean} [isBinary]
   * @returns {number}
   */
  send(data, isBinary) {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    if (typeof data !== 'string' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new TypeError('WSContext.send: unsupported data type')
    }

    return this.ws.send(data, isBinary ?? typeof data !== 'string')
  }

  /**
   * @param {number} [code]
   * @param {string} [reason]
   * @returns {void}
   */
  end(code = 1000, reason = '') {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    this.ws.end(code, reason)
  }

  /**
   * @param {string} topic
   * @returns {boolean}
   */
  subscribe(topic) {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    return this.ws.subscribe(topic)
  }

  /**
   * @param {string} topic
   * @returns {boolean}
   */
  unsubscribe(topic) {
    if (this.ws === null) {
      throw new Error('WSContext: ws is null (did you forget reset?)')
    }

    return this.ws.unsubscribe(topic)
  }

  /**
   * @param {string} topic
   * @param {string | ArrayBuffer | ArrayBufferView} msg
   * @param {boolean} [isBinary]
   * @returns {boolean}
   */
  publish(topic, msg, isBinary) {
    if (this.server === null) {
      throw new Error('WSContext: server is null (did you forget reset?)')
    }

    return this.server.publish(topic, msg, isBinary)
  }
}
