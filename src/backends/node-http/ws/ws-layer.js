import { createHash } from 'node:crypto'
import NodeHttpRequest from '../request.js'
import NodeWebSocket from './connection.js'
import { encode } from './writer.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const EMPTY = Buffer.alloc(0)

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
 * @param {string} topic
 * @returns {ArrayBuffer}
 */
function topicToArrayBuffer(topic) {
  const buf = Buffer.from(topic)

  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/**
 * Minimal uWS-shaped response for the upgrade handshake, writing raw HTTP over
 * the socket. Implements only what Server.onUpgrade calls.
 */
class UpgradeResponse {
  #socket
  #head
  #layer
  #status = '101'
  #headers = []
  #done = false
  #abortedCb = null

  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @param {WsLayer} layer
   */
  constructor(socket, head, layer) {
    this.#socket = socket
    this.#head = head
    this.#layer = layer
  }

  /**
   * @param {() => void} fn
   */
  cork(fn) {
    fn()
  }

  /**
   * @param {string} status
   */
  writeStatus(status) {
    this.#status = status
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  writeHeader(key, value) {
    this.#headers.push(key, value)
  }

  /**
   * Reject path: write a raw HTTP response and close the socket.
   * @param {string} [body]
   */
  end(body) {
    if (this.#done) {
      return
    }

    this.#done = true
    this.#detachAborted()

    const bodyBuf = body ? toBuffer(body) : EMPTY

    let raw = `HTTP/1.1 ${this.#status}\r\n`

    for (let i = 0; i < this.#headers.length; i += 2) {
      raw += `${this.#headers[i]}: ${this.#headers[i + 1]}\r\n`
    }

    raw += `content-length: ${bodyBuf.length}\r\nconnection: close\r\n\r\n`

    this.#socket.write(raw)

    if (bodyBuf.length) {
      this.#socket.write(bodyBuf)
    }

    this.#socket.end()
  }

  /**
   * @param {() => void} cb
   */
  onAborted(cb) {
    this.#abortedCb = cb
    this.#socket.on('close', this.#onAborted)
    this.#socket.on('error', this.#onAborted)
  }

  #onAborted = () => {
    const cb = this.#abortedCb

    this.#detachAborted()

    if (cb) {
      cb()
    }
  }

  #detachAborted() {
    this.#socket.removeListener('close', this.#onAborted)
    this.#socket.removeListener('error', this.#onAborted)
  }

  /**
   * @returns {Buffer}
   */
  getRemoteAddressAsText() {
    return Buffer.from(this.#socket.remoteAddress ?? '')
  }

  /**
   * Complete the WebSocket handshake and hand the socket to the layer.
   * @param {object} userData
   * @param {string} key
   * @param {string} protocol
   */
  upgrade(userData, key, protocol) {
    if (this.#done) {
      return
    }

    this.#done = true
    this.#detachAborted()

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')

    let raw = 'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'

    raw += `sec-websocket-accept: ${accept}\r\n`

    if (protocol) {
      const first = protocol.split(',')[0].trim()

      if (first) {
        raw += `sec-websocket-protocol: ${first}\r\n`
      }
    }

    raw += '\r\n'

    this.#socket.write(raw)
    this.#layer.open(this.#socket, this.#head, userData)
  }
}

export default class WsLayer {
  #behavior
  #maxPayload
  #idleTimeoutMs

  #topics = new Map()
  #subs = new WeakMap()
  #connections = new Set()
  #pingTimer = null

  /**
   * @param {object} behavior - uWS-shaped ws behavior (idleTimeout, maxPayloadLength, open/message/close/drain/subscription/upgrade).
   */
  constructor(behavior) {
    this.#behavior = behavior
    this.#maxPayload = behavior.maxPayloadLength
    this.#idleTimeoutMs = (behavior.idleTimeout ?? 15) * 1000

    if (behavior.sendPingsAutomatically !== false && this.#idleTimeoutMs > 0) {
      this.#startPingTimer()
    }
  }

  /**
   * Handle an HTTP `upgrade` event.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  handleUpgrade(req, socket, head) {
    const upgradeHeader = String(req.headers.upgrade ?? '').toLowerCase()
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']

    if (upgradeHeader !== 'websocket' || !key || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    socket.setNoDelay(true)

    const request = new NodeHttpRequest(req, [])
    const res = new UpgradeResponse(socket, head, this)

    this.#behavior.upgrade(res, request, null)
  }

  /**
   * Create a connection after a successful handshake, fire open, feed the head.
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @param {object} userData
   */
  open(socket, head, userData) {
    const conn = new NodeWebSocket({
      socket,
      behavior: this.#behavior,
      hub: this,
      userData,
      maxPayload: this.#maxPayload
    })

    this.#connections.add(conn)
    this.#subs.set(conn, new Set())

    this.#behavior.open(conn)
    conn.pushHead(head)
  }

  // --- hub interface used by NodeWebSocket ---

  /**
   * @param {NodeWebSocket} conn
   * @param {string} topic
   * @returns {boolean}
   */
  subscribe(conn, topic) {
    let set = this.#topics.get(topic)
    const oldCount = set ? set.size : 0

    if (!set) {
      set = new Set()
      this.#topics.set(topic, set)
    }

    if (set.has(conn)) {
      return true
    }

    set.add(conn)
    this.#subs.get(conn)?.add(topic)

    this.#behavior.subscription(conn, topicToArrayBuffer(topic), set.size, oldCount)

    return true
  }

  /**
   * @param {NodeWebSocket} conn
   * @param {string} topic
   * @returns {boolean}
   */
  unsubscribe(conn, topic) {
    const set = this.#topics.get(topic)

    if (!set || !set.has(conn)) {
      return false
    }

    const oldCount = set.size

    set.delete(conn)
    this.#subs.get(conn)?.delete(topic)

    if (set.size === 0) {
      this.#topics.delete(topic)
    }

    this.#behavior.subscription(conn, topicToArrayBuffer(topic), set.size, oldCount)

    return true
  }

  /**
   * @param {NodeWebSocket} conn
   */
  remove(conn) {
    this.#connections.delete(conn)

    const topics = this.#subs.get(conn)

    if (topics) {
      for (const topic of topics) {
        const set = this.#topics.get(topic)

        if (set) {
          const oldCount = set.size

          set.delete(conn)

          if (set.size === 0) {
            this.#topics.delete(topic)
          }

          this.#behavior.subscription(conn, topicToArrayBuffer(topic), set.size, oldCount)
        }
      }

      this.#subs.delete(conn)
    }
  }

  // --- app-level pub/sub ---

  /**
   * @param {string} topic
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} message
   * @param {boolean} isBinary
   * @returns {boolean}
   */
  publish(topic, message, isBinary) {
    const set = this.#topics.get(topic)

    if (!set || set.size === 0) {
      return false
    }

    const frame = encode(isBinary ? 0x2 : 0x1, toBuffer(message))

    for (const conn of set) {
      conn.sendFrame(frame)
    }

    return true
  }

  /**
   * @param {string} topic
   * @returns {number}
   */
  numSubscribers(topic) {
    const set = this.#topics.get(topic)

    return set ? set.size : 0
  }

  close() {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer)
      this.#pingTimer = null
    }

    for (const conn of this.#connections) {
      conn.terminate()
    }

    this.#connections.clear()
    this.#topics.clear()
  }

  #startPingTimer() {
    const interval = Math.max(1000, Math.floor(this.#idleTimeoutMs / 2))

    this.#pingTimer = setInterval(() => {
      const now = Date.now()

      for (const conn of this.#connections) {
        const idle = now - conn.lastActivity

        if (idle >= this.#idleTimeoutMs) {
          conn.terminate()
        } else if (idle >= interval) {
          conn.ping()
        }
      }
    }, interval)

    this.#pingTimer.unref?.()
  }
}
