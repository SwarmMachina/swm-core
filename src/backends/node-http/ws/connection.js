import FrameParser from './parser.js'
import { encode, encodePing, encodePong, encodeClose } from './writer.js'

const EMPTY = Buffer.alloc(0)
const EMPTY_AB = new ArrayBuffer(0)
// uWS default backpressure ceiling: refuse to queue past this and report DROPPED.
const DEFAULT_MAX_BACKPRESSURE = 64 * 1024
// Grace period for the peer to echo our close frame before we tear down.
const CLOSE_TIMEOUT = 5000
// SendStatus, matching uWS: 0 = BACKPRESSURE (queued), 1 = SUCCESS, 2 = DROPPED.
const BACKPRESSURE = 0
const SUCCESS = 1
const DROPPED = 2

/**
 * @param {string|Buffer|ArrayBuffer|ArrayBufferView} data
 * @returns {Buffer}
 */
function toBuffer(data) {
  if (typeof data === 'string') {
    return Buffer.from(data)
  }

  if (Buffer.isBuffer(data)) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * @param {Buffer|null} buf
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(buf) {
  if (!buf || buf.length === 0) {
    return EMPTY_AB
  }

  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer
  }

  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export default class NodeWebSocket {
  #socket
  #behavior
  #hub
  #userData
  #parser
  #maxBackpressure

  #open = true
  #backpressured = false

  #closeSent = false
  #finalized = false
  #hardClose = false
  #code = null
  #reason = null
  #closeTimer = null

  lastActivity = 0
  pendingSince = 0

  /**
   * @param {object} opt
   * @param {import('node:net').Socket} opt.socket
   * @param {object} opt.behavior - { message, drain, close }
   * @param {object} opt.hub - { subscribe, unsubscribe, remove }
   * @param {object} opt.userData
   * @param {number} opt.maxPayload
   * @param {number} [opt.maxBackpressure]
   */
  constructor({ socket, behavior, hub, userData, maxPayload, maxBackpressure = DEFAULT_MAX_BACKPRESSURE }) {
    this.#socket = socket
    this.#behavior = behavior
    this.#hub = hub
    this.#userData = userData
    this.#maxBackpressure = maxBackpressure

    this.#parser = new FrameParser({
      maxPayload,
      onMessage: (payload, isBinary) => this.#behavior.message(this, payload, isBinary),
      onPing: (payload) => {
        this.#writeControl(encodePong(payload))
      },
      onPong: () => {},
      onClose: (code, reason) => this.#handlePeerClose(code, reason),
      onError: (code) => this.#handleProtocolError(code)
    })

    socket.on('data', this.#onData)
    socket.on('error', this.#onSocketDown)
    socket.on('close', this.#onSocketDown)
    // HTTP server sockets are half-open, so a peer FIN without a close frame
    // emits only 'end'. Finalize the WS context on that path as well.
    socket.on('end', this.#onSocketDown)
    socket.on('drain', this.#onDrain)

    this.lastActivity = Date.now()
  }

  /**
   * Feed the bytes already read past the HTTP upgrade headers. Call after the
   * hub has invoked behavior.open.
   * @param {Buffer} head
   */
  pushHead(head) {
    if (head && head.length) {
      this.#feed(head)
    }
  }

  /**
   * @returns {object}
   */
  getUserData() {
    return this.#userData
  }

  /**
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} data
   * @param {boolean} isBinary
   * @returns {number}
   */
  send(data, isBinary) {
    if (!this.#open) {
      return DROPPED
    }

    if (this.#socket.writableLength >= this.#maxBackpressure) {
      this.#reportDropped(data, isBinary)

      return DROPPED
    }

    const ok = this.#socket.write(encode(isBinary ? 0x2 : 0x1, toBuffer(data)))

    if (!ok) {
      this.#backpressured = true

      return BACKPRESSURE
    }

    return SUCCESS
  }

  /**
   * Write a pre-serialized frame. Used by pub/sub to broadcast one buffer to
   * many subscribers without re-encoding per connection.
   * @param {Buffer} frame
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} data
   * @param {boolean} isBinary
   * @returns {number}
   */
  sendFrame(frame, data, isBinary) {
    if (!this.#open) {
      return DROPPED
    }

    if (this.#socket.writableLength >= this.#maxBackpressure) {
      this.#reportDropped(data, isBinary)

      return DROPPED
    }

    const ok = this.#socket.write(frame)

    if (!ok) {
      this.#backpressured = true

      return BACKPRESSURE
    }

    return SUCCESS
  }

  /**
   * @param {number} [code]
   * @param {string} [reason]
   */
  end(code = 1000, reason = '') {
    if (!this.#open || this.#closeSent) {
      return
    }

    this.#closeSent = true
    this.#code = code
    this.#reason = reason ? Buffer.from(reason) : EMPTY

    this.#socket.write(encodeClose(code, reason))

    this.#closeTimer = setTimeout(() => this.#finalize(), CLOSE_TIMEOUT)
    this.#closeTimer.unref?.()
  }

  /**
   * @param {Buffer} [payload]
   */
  ping(payload = EMPTY) {
    this.#writeControl(encodePing(payload))
  }

  terminate() {
    if (this.#finalized) {
      return
    }

    this.#code = this.#code ?? 1006
    this.#hardClose = true
    this.#finalize()
  }

  /**
   * @param {string} topic
   * @returns {boolean}
   */
  subscribe(topic) {
    return this.#hub.subscribe(this, topic)
  }

  /**
   * @param {string} topic
   * @returns {boolean}
   */
  unsubscribe(topic) {
    return this.#hub.unsubscribe(this, topic)
  }

  #onData = (chunk) => this.#feed(chunk)

  #onDrain = () => {
    if (this.#backpressured) {
      this.#backpressured = false
      this.#behavior.drain(this)
    }
  }

  #onSocketDown = () => {
    if (this.#finalized) {
      return
    }

    if (this.#code === null) {
      this.#code = 1006
    }

    this.#hardClose = true
    this.#finalize()
  }

  /**
   * Control frames obey the same memory ceiling as application messages. If
   * even a small control frame cannot be queued safely, terminate the socket
   * instead of growing the writable buffer without bound.
   * @param {Buffer} frame
   * @returns {number}
   */
  #writeControl(frame) {
    if (!this.#open) {
      return DROPPED
    }

    if (this.#socket.writableLength >= this.#maxBackpressure) {
      this.#hardClose = true
      this.#code = 1006
      this.#finalize()

      return DROPPED
    }

    const ok = this.#socket.write(frame)

    if (!ok) {
      this.#backpressured = true

      return BACKPRESSURE
    }

    return SUCCESS
  }

  /**
   * Report an application message rejected by the backpressure ceiling. This
   * stays off the successful send path, including its payload conversion cost.
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} data
   * @param {boolean} isBinary
   */
  #reportDropped(data, isBinary) {
    this.#behavior.dropped?.(this, toArrayBuffer(toBuffer(data)), isBinary)
  }

  /**
   * @param {Buffer} chunk
   */
  #feed(chunk) {
    if (!this.#open) {
      return
    }

    const now = Date.now()

    this.lastActivity = now

    this.#socket.cork()

    try {
      this.#parser.push(chunk)
    } finally {
      this.#socket.uncork()
    }

    if (this.#parser.pending) {
      this.pendingSince ||= now
    } else {
      this.pendingSince = 0
    }
  }

  /**
   * @param {number} code
   * @param {Buffer} reason
   */
  #handlePeerClose(code, reason) {
    if (!this.#closeSent) {
      this.#closeSent = true
      this.#code = code
      this.#reason = reason
      this.#socket.write(encodeClose(code === 1005 ? undefined : code))
    }

    this.#finalize()
  }

  /**
   * @param {number} code
   */
  #handleProtocolError(code) {
    if (!this.#closeSent) {
      this.#closeSent = true
      this.#code = code
      this.#reason = EMPTY
      this.#socket.write(encodeClose(code))
    }

    this.#finalize()
  }

  #finalize() {
    if (this.#finalized) {
      return
    }

    this.#finalized = true
    this.#open = false
    this.pendingSince = 0
    this.#parser.stop()

    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer)
      this.#closeTimer = null
    }

    const socket = this.#socket

    // Stop reading, but keep the guarded 'error'/'close' handlers attached so a
    // post-close socket error (write-after-end, peer RST) is swallowed rather
    // than thrown as an unhandled 'error' event.
    socket.removeListener('data', this.#onData)
    socket.removeListener('drain', this.#onDrain)

    try {
      if (this.#hardClose) {
        socket.destroy()
      } else {
        socket.end()
      }
    } catch {
      // Socket already gone.
    }

    this.#hub.remove(this)
    this.#behavior.close(this, this.#code ?? 1006, toArrayBuffer(this.#reason))
  }
}
