import { createHash } from 'node:crypto'
import NodeHttpRequest from '../request.js'
import NodeWebSocket from './connection.js'
import { encode } from './writer.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const EMPTY = Buffer.alloc(0)
const WS_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * @param {unknown} value
 * @param {string} token
 * @returns {boolean}
 */
function headerHasToken(value, token) {
  if (typeof value !== 'string') {
    return false
  }

  return value.split(',').some((part) => part.trim().toLowerCase() === token)
}

/**
 * RFC 6455 requires a base64-encoded 16-byte nonce.
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidWebSocketKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    return false
  }

  const decoded = Buffer.from(value, 'base64')

  return decoded.length === 16 && decoded.toString('base64') === value
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidProtocolHeader(value) {
  if (value === undefined) {
    return true
  }

  if (typeof value !== 'string') {
    return false
  }

  const protocols = value.split(',').map((protocol) => protocol.trim())

  return protocols.length > 0 && protocols.every((protocol) => WS_PROTOCOL_TOKEN.test(protocol))
}

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
export class UpgradeResponse {
  #socket
  #head
  #layer
  #status = '101'
  #headers = []
  #done = false
  #abortedCb = null
  #timeout = null

  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @param {WsLayer} layer
   * @param {number} timeoutMs
   */
  constructor(socket, head, layer, timeoutMs) {
    this.#socket = socket
    this.#head = head
    this.#layer = layer

    if (timeoutMs > 0) {
      this.#timeout = setTimeout(this.#onTimeout, timeoutMs)
      this.#timeout.unref?.()
    }
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

    this.#finish()

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
    if (this.#done) {
      return
    }

    this.#done = true
    const cb = this.#abortedCb

    this.#cleanup()

    if (cb) {
      cb()
    }
  }

  #onTimeout = () => {
    if (this.#done) {
      return
    }

    this.#done = true
    const cb = this.#abortedCb

    this.#cleanup()

    if (cb) {
      cb()
    }

    this.#socket.destroy()
  }

  #detachAborted() {
    this.#socket.removeListener('close', this.#onAborted)
    this.#socket.removeListener('error', this.#onAborted)
  }

  #cleanup() {
    if (this.#timeout) {
      clearTimeout(this.#timeout)
      this.#timeout = null
    }

    this.#detachAborted()
  }

  #finish() {
    this.#done = true
    this.#cleanup()
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

    if (protocol && !WS_PROTOCOL_TOKEN.test(protocol)) {
      this.#finish()
      this.#socket.destroy()

      return
    }

    this.#finish()

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')

    let raw = 'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'

    raw += `sec-websocket-accept: ${accept}\r\n`

    if (protocol) {
      raw += `sec-websocket-protocol: ${protocol}\r\n`
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
  #upgradeTimeoutMs
  #sendPings

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
    this.#upgradeTimeoutMs = behavior.upgradeTimeout ?? 10_000
    this.#sendPings = behavior.sendPingsAutomatically !== false

    if (this.#idleTimeoutMs > 0) {
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
    const connectionHeader = req.headers.connection
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    const protocol = req.headers['sec-websocket-protocol']

    if (
      req.method !== 'GET' ||
      upgradeHeader !== 'websocket' ||
      !headerHasToken(connectionHeader, 'upgrade') ||
      !isValidWebSocketKey(key) ||
      !isValidProtocolHeader(protocol) ||
      String(version) !== '13'
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
      socket.destroy()

      return
    }

    socket.setNoDelay(true)

    const request = new NodeHttpRequest(req, [])
    const res = new UpgradeResponse(socket, head, this, this.#upgradeTimeoutMs)

    try {
      this.#behavior.upgrade(res, request, null)
    } catch {
      res.writeStatus('500 Internal Server Error')
      res.end()
    }
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

    this.#pingTimer = setInterval(() => this.runMaintenance(), interval)

    this.#pingTimer.unref?.()
  }

  /**
   * Shared connection maintenance pass. This keeps timeout cost at one timer
   * per server rather than one timer per socket.
   * @param {number} [now]
   */
  runMaintenance(now = Date.now()) {
    const pingAfter = Math.max(1000, Math.floor(this.#idleTimeoutMs / 2))

    for (const conn of this.#connections) {
      const idle = now - conn.lastActivity
      const assemblingTooLong = conn.pendingSince > 0 && now - conn.pendingSince >= this.#idleTimeoutMs

      if (idle >= this.#idleTimeoutMs || assemblingTooLong) {
        conn.terminate()
      } else if (this.#sendPings && idle >= pingAfter) {
        conn.ping()
      }
    }
  }
}
