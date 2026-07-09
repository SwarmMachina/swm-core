const EMPTY = new Uint8Array(0)

/**
 * @param {string|Buffer|ArrayBuffer|ArrayBufferView} body
 * @returns {number}
 */
function byteLengthOf(body) {
  if (typeof body === 'string') {
    return Buffer.byteLength(body)
  }

  return body.byteLength
}

/**
 * @param {string|Buffer|ArrayBuffer|ArrayBufferView} chunk
 * @returns {string|Buffer|Uint8Array}
 */
function toWritable(chunk) {
  if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
    return chunk
  }

  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk)
  }

  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }

  return chunk
}

export default class NodeHttpResponse {
  #statusCode = 200
  #statusMessage = ''
  #headers = []
  #headersSent = false

  #offset = 0
  #total = -1

  #onDataAttached = false
  #drainAttached = false
  #writableHandler = null

  #abortedCb = null
  #aborted = false
  #closeAttached = false
  #finished = false

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  constructor(req, res) {
    this.req = req
    this.res = res
  }

  /**
   * @param {() => void} fn
   */
  cork(fn) {
    const res = this.res

    res.cork()

    try {
      fn()
    } finally {
      res.uncork()
    }
  }

  /**
   * @param {string} status - Pre-formatted status line, e.g. '200 OK'.
   */
  writeStatus(status) {
    const sp = status.indexOf(' ')

    if (sp === -1) {
      this.#statusCode = parseInt(status, 10) || 200
      this.#statusMessage = ''
    } else {
      this.#statusCode = parseInt(status, 10) || 200
      this.#statusMessage = status.slice(sp + 1)
    }
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  writeHeader(key, value) {
    this.#headers.push(key, typeof value === 'string' ? value : `${value}`)
  }

  #hasContentLength() {
    const headers = this.#headers

    for (let i = 0; i < headers.length; i += 2) {
      if (headers[i].length === 14 && headers[i].toLowerCase() === 'content-length') {
        return true
      }
    }

    return false
  }

  #flush() {
    if (this.#headersSent) {
      return
    }

    this.#headersSent = true
    this.res.writeHead(this.#statusCode, this.#statusMessage, this.#headers)
  }

  #drainRequest() {
    if (!this.#onDataAttached) {
      // Nobody consumed the request body; drain it so the keep-alive socket
      // can be reused instead of stalling on unread bytes.
      this.req.resume()
    }
  }

  /**
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} [body]
   */
  end(body) {
    if (this.#finished) {
      return
    }

    this.#finished = true

    if (!this.#hasContentLength()) {
      this.writeHeader('content-length', body == null ? '0' : `${byteLengthOf(body)}`)
    }

    this.#flush()
    this.#drainRequest()

    if (body == null) {
      this.res.end()
    } else {
      this.res.end(toWritable(body))
    }
  }

  /**
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} chunk
   * @param {number} total
   * @returns {[boolean, boolean]}
   */
  tryEnd(chunk, total) {
    if (this.#total < 0) {
      this.#total = total

      if (!this.#hasContentLength()) {
        this.writeHeader('content-length', `${total}`)
      }

      this.#flush()
    }

    const ok = this.res.write(toWritable(chunk))

    this.#offset += byteLengthOf(chunk)

    const done = this.#offset >= total

    if (done && !this.#finished) {
      this.#finished = true
      this.#drainRequest()
      this.res.end()
    }

    return [ok, done]
  }

  /**
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} chunk
   * @returns {boolean}
   */
  write(chunk) {
    this.#flush()

    const ok = this.res.write(toWritable(chunk))

    this.#offset += byteLengthOf(chunk)

    return ok
  }

  /**
   * @returns {number}
   */
  getWriteOffset() {
    return this.#offset
  }

  /**
   * @param {(offset: number) => void} handler
   */
  onWritable(handler) {
    this.#writableHandler = handler

    if (!this.#drainAttached) {
      this.#drainAttached = true
      this.res.on('drain', this.#onDrain)
    }
  }

  #onDrain = () => {
    const handler = this.#writableHandler

    if (handler) {
      handler(this.#offset)
    }
  }

  /**
   * @param {(chunk: Buffer, isLast: boolean) => void} cb
   */
  onData(cb) {
    this.#onDataAttached = true

    const req = this.req

    req.on('data', (chunk) => cb(chunk, false))
    req.on('end', () => cb(EMPTY, true))
  }

  /**
   * @param {() => void} cb
   */
  onAborted(cb) {
    this.#abortedCb = cb

    if (!this.#closeAttached) {
      this.#closeAttached = true
      this.res.on('close', this.#onClose)
    }
  }

  #onClose = () => {
    if (this.#aborted || this.res.writableFinished) {
      return
    }

    this.#aborted = true

    const cb = this.#abortedCb

    if (cb) {
      cb()
    }
  }

  /**
   * @returns {Buffer}
   */
  getRemoteAddressAsText() {
    return Buffer.from(this.req.socket?.remoteAddress ?? '')
  }
}
