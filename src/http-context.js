export const TEXT_PLAIN_HEADER = Object.freeze({ 'content-type': 'text/plain; charset=utf-8' })
export const JSON_HEADER = Object.freeze({ 'content-type': 'application/json; charset=utf-8' })
export const OCTET_STREAM_HEADER = Object.freeze({ 'content-type': 'application/octet-stream' })

export const STATUS_TEXT = Object.freeze({
  100: '100 Continue',
  101: '101 Switching Protocols',
  102: '102 Processing',

  200: '200 OK',
  201: '201 Created',
  202: '202 Accepted',
  203: '203 Non-Authoritative Information',
  204: '204 No Content',
  205: '205 Reset Content',
  206: '206 Partial Content',

  300: '300 Multiple Choices',
  301: '301 Moved Permanently',
  302: '302 Found',
  303: '303 See Other',
  304: '304 Not Modified',
  307: '307 Temporary Redirect',
  308: '308 Permanent Redirect',

  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
  406: '406 Not Acceptable',
  408: '408 Request Timeout',
  409: '409 Conflict',
  410: '410 Gone',
  413: '413 Payload Too Large',
  414: '414 URI Too Long',
  415: '415 Unsupported Media Type',
  418: "418 I'm a teapot",
  422: '422 Unprocessable Entity',
  429: '429 Too Many Requests',

  500: '500 Internal Server Error',
  501: '501 Not Implemented',
  502: '502 Bad Gateway',
  503: '503 Service Unavailable',
  504: '504 Gateway Timeout'
})

const CACHED_ERRORS = Object.freeze({
  bodyTooLarge: new Error('Request body too large'),
  aborted: new Error('Request aborted'),
  sizeMismatch: new Error('Request body size mismatch')
})

const NOOP = () => {}

export default class HttpContext {
  #ip = ''
  #method = ''
  #url = ''
  #body = null
  #bodyError = null
  #bodyPromise = null
  #finalize = null
  #statusOverride = null
  #contentLength = undefined
  #maxSize = 1024 * 1024 * 16

  /**
   * @param {ContextPool} pool
   */
  constructor(pool) {
    this.pool = pool
    this.res = null
    this.req = null
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null
  }

  /**
   * @param {import('uwebsockets.js').HttpResponse} res
   * @param {import('uwebsockets.js').HttpRequest} req
   * @param {Function} [finalize]
   * @param {number} [maxSize]
   * @returns {HttpContext}
   */
  reset(res, req, finalize = null, maxSize = 1024 * 1024 * 16) {
    this.res = res
    this.req = req

    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null

    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#statusOverride = null
    this.#contentLength = undefined
    this.#maxSize = maxSize

    this.#ip = ''
    this.#url = ''
    this.#method = ''

    this.#finalize = finalize

    return this
  }

  /**
   */
  clear() {
    this.res = null
    this.req = null
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null

    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#finalize = null
    this.#statusOverride = null
    this.#contentLength = undefined
    this.#ip = ''
    this.#url = ''
    this.#method = ''
  }

  /**
   */
  release() {
    if (this.pool) {
      this.pool.release(this)
    }
  }

  ip() {
    if (!this.res) {
      return ''
    }

    if (this.#ip) {
      return this.#ip
    }

    const ipBuffer = this.res.getProxiedRemoteAddressAsText?.() || this.res.getRemoteAddressAsText?.()

    this.#ip = ipBuffer ? Buffer.from(ipBuffer).toString('utf8') : ''

    return this.#ip
  }

  method() {
    if (!this.req) {
      return ''
    }

    if (this.#method) {
      return this.#method
    }

    this.#method = this.req.getMethod()
    return this.#method
  }

  url() {
    if (!this.req) {
      return ''
    }

    if (this.#url) {
      return this.#url
    }

    this.#url = this.req.getUrl()
    return this.#url
  }

  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  query(name) {
    return this.req.getQuery(name)
  }

  /**
   * @param {number|string} i
   * @returns {string|undefined}
   */
  param(i) {
    return this.req.getParameter(i)
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  header(name) {
    return this.req.getHeader(name)
  }

  contentLength() {
    if (this.#contentLength !== undefined) {
      return this.#contentLength
    }

    const clh = this.header('content-length')

    if (clh === undefined || clh == null || clh === '') {
      this.#contentLength = null
      return this.#contentLength
    }

    const n = Number(clh)

    if (!Number.isInteger(n) || n < 0) {
      this.#contentLength = null
      return this.#contentLength
    }

    this.#contentLength = n
    return this.#contentLength
  }

  /**
   * @param {number} code
   * @returns {HttpContext}
   */
  status(code) {
    this.#statusOverride = code
    return this
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<Buffer>}
   */
  body(maxSize) {
    if (this.#body !== null) {
      return Promise.resolve(this.#body)
    }

    if (this.#bodyError !== null) {
      return Promise.reject(this.#bodyError)
    }

    if (this.#bodyPromise !== null) {
      return this.#bodyPromise
    }

    const limit = maxSize ?? this.#maxSize
    const contentLength = this.contentLength()

    if (this.aborted) {
      this.#bodyError = CACHED_ERRORS.aborted
      return Promise.reject(this.#bodyError)
    }

    if (contentLength !== null && contentLength > limit) {
      this.#bodyError = CACHED_ERRORS.bodyTooLarge
      return Promise.reject(this.#bodyError)
    }

    if (contentLength === 0) {
      const buf = Buffer.alloc(0)

      this.#body = buf
      this.res.onData(NOOP)
      return Promise.resolve(buf)
    }

    this.#bodyPromise = new Promise((resolve, reject) => {
      let done = false

      const success = (buf) => {
        if (done) {
          return
        }

        done = true
        this.#body = buf
        this.#bodyPromise = null
        resolve(buf)
      }

      const fail = (err) => {
        if (done) {
          return
        }

        done = true
        this.#bodyError = err
        this.#bodyPromise = null
        reject(err)
      }

      if (contentLength !== null) {
        this.#parseKnownLength(contentLength, success, fail)
      } else {
        this.#parseUnknownLength(limit, success, fail)
      }
    })

    return this.#bodyPromise
  }

  #parseKnownLength(contentLength, resolve, reject) {
    const dst = Buffer.allocUnsafe(contentLength)

    let offset = 0
    let done = false

    this.res.onData((ab, isLast) => {
      if (done) {
        return
      }

      if (this.aborted) {
        if (done) {
          return
        }

        done = true
        return reject(CACHED_ERRORS.aborted)
      }

      const u8 = new Uint8Array(ab)
      const chunkSize = u8.byteLength
      const next = offset + chunkSize

      if (next > contentLength) {
        if (done) {
          return
        }

        done = true
        return reject(CACHED_ERRORS.sizeMismatch)
      }

      dst.set(u8, offset)
      offset = next

      if (isLast || offset === contentLength) {
        if (offset !== contentLength) {
          if (done) {
            return
          }

          done = true
          return reject(CACHED_ERRORS.sizeMismatch)
        }

        if (done) {
          return
        }

        done = true
        return resolve(dst)
      }
    })
  }

  #parseUnknownLength(limit, resolve, reject) {
    const chunks = []
    let totalSize = 0
    let done = false

    this.res.onData((ab, isLast) => {
      if (done) {
        return
      }
      if (this.aborted) {
        done = true
        return reject(CACHED_ERRORS.aborted)
      }

      const buf = Buffer.from(ab) // <- копия
      const nextSize = totalSize + buf.length

      if (nextSize > limit) {
        done = true
        return reject(CACHED_ERRORS.bodyTooLarge)
      }

      chunks.push(buf)
      totalSize = nextSize

      if (isLast) {
        done = true
        return resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize))
      }
    })
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<Buffer>}
   */
  buffer(maxSize) {
    return this.body(maxSize)
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<any>}
   */
  async json(maxSize) {
    const buf = await this.body(maxSize)

    if (buf.length === 0) {
      return null
    }

    try {
      return JSON.parse(buf.toString('utf8'))
    } catch (err) {
      throw new Error('Invalid JSON: ' + err.message)
    }
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<string>}
   */
  async text(maxSize) {
    const buf = await this.body(maxSize)

    return buf.toString('utf8')
  }

  /**
   * @param {string|number} status
   * @returns {any}
   */
  getStatus(status) {
    const finalStatus = this.#statusOverride !== null ? this.#statusOverride : status

    return STATUS_TEXT[finalStatus ?? 500]
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {HttpContext}
   */
  setHeader(key, value) {
    this.res.writeHeader(key, value)
    return this
  }

  /**
   * @param {Record<string, string> | null | undefined} headers
   */
  setHeaders(headers) {
    if (!headers) {
      return
    }

    if (headers === TEXT_PLAIN_HEADER) {
      this.res.writeHeader('content-type', 'text/plain; charset=utf-8')
      return
    }

    if (headers === JSON_HEADER) {
      this.res.writeHeader('content-type', 'application/json; charset=utf-8')
      return
    }

    if (headers === OCTET_STREAM_HEADER) {
      this.res.writeHeader('content-type', 'application/octet-stream')
      return
    }

    for (const key in headers) {
      const value = headers[key]

      if (value !== undefined && value !== null) {
        this.res.writeHeader(key, value)
      }
    }
  }

  /**
   * @param {any} result
   * @returns {void}
   */
  send(result) {
    if (result == null) {
      return this.reply(204, TEXT_PLAIN_HEADER, null)
    }

    const type = typeof result

    if (type === 'string') {
      return this.reply(200, TEXT_PLAIN_HEADER, result)
    }

    if (type === 'object') {
      if (ArrayBuffer.isView(result) || result instanceof ArrayBuffer) {
        return this.reply(200, OCTET_STREAM_HEADER, result)
      }

      return this.reply(200, JSON_HEADER, JSON.stringify(result))
    }

    return this.reply(200, TEXT_PLAIN_HEADER, String(result))
  }

  /**
   * @param {object | Array} data
   * @param {number} [status]
   * @returns {void}
   */
  sendJson(data, status = 200) {
    this.reply(status, JSON_HEADER, JSON.stringify(data))
  }

  /**
   * @param {string} text
   * @param {number} [status]
   * @returns {void}
   */
  sendText(text, status = 200) {
    this.reply(status, TEXT_PLAIN_HEADER, text)
  }

  /**
   * @param {Buffer|Uint8Array|ArrayBuffer} buffer
   * @param {number} [status]
   * @returns {void}
   */
  sendBuffer(buffer, status = 200) {
    this.reply(status, OCTET_STREAM_HEADER, buffer)
  }

  /**
   * @param {number} status
   * @param {Record<string,string>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   */
  reply(status = 200, headers = null, body = null) {
    if (this.replied || this.aborted) {
      return
    }

    this.replied = true

    this.res.cork(() => {
      if (this.aborted) {
        return
      }

      this.res.writeStatus(this.getStatus(status))
      this.setHeaders(headers)

      if (body != null) {
        this.res.end(body)
      } else {
        this.res.end()
      }
    })
  }

  /**
   * @param {number} status
   * @param {Record<string,string>} headers
   * @returns {HttpContext}
   */
  startStreaming(status = 200, headers = null) {
    if (this.replied || this.aborted) {
      return this
    }

    this.replied = true
    this.streaming = true

    this.res.cork(() => {
      this.res.writeStatus(this.getStatus(status))
      this.setHeaders(headers)
    })

    return this
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array|Buffer} chunk
   * @returns {boolean}
   */
  write(chunk) {
    if (this.aborted) {
      return false
    }

    if (!this.streaming) {
      throw new Error('Must call startStreaming() before write()')
    }

    this.streamingStarted = true

    let ok = false

    this.res.cork(() => {
      ok = this.res.write(chunk)
    })

    return ok
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array|Buffer} [chunk]
   * @returns {[boolean, boolean]}
   */
  tryEnd(chunk) {
    if (this.aborted) {
      return [false, false]
    }

    if (!this.streaming) {
      throw new Error('Must call startStreaming() before tryEnd()')
    }

    let result = [false, false]

    this.res.cork(() => {
      const offset = this.res.getWriteOffset()
      const chunkLen = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
      const totalSize = offset + chunkLen
      const [ok, done] = this.res.tryEnd(chunk, totalSize)

      result = [ok, done]

      if (done) {
        this.streaming = false

        if (this.#finalize) {
          this.#finalize()
        }
      }
    })

    return result
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array|Buffer} [chunk]
   */
  end(chunk) {
    if (this.aborted) {
      return
    }

    if (!this.streaming) {
      throw new Error('Must call startStreaming() before end()')
    }

    this.res.cork(() => {
      if (chunk != null) {
        this.res.end(chunk)
      } else {
        this.res.end()
      }
    })

    this.streaming = false

    if (this.#finalize) {
      this.#finalize()
    }
  }

  /**
   * @param {Function} callback
   */
  onWritable(callback) {
    if (this.aborted) {
      return
    }

    this.onWritableCallback = callback

    this.res.onWritable((offset) => {
      const cb = this.onWritableCallback

      if (!cb) {
        return true
      }

      this.onWritableCallback = null
      cb(offset)

      return false
    })
  }

  /**
   * @returns {number}
   */
  getWriteOffset() {
    if (this.aborted) {
      return 0
    }

    return this.res.getWriteOffset()
  }

  /**
   * @param {import('stream').Readable} readable
   * @param {number} status
   * @param {Record<string,string>} headers
   * @returns {Promise<void>}
   */
  async stream(readable, status = 200, headers = null) {
    this.startStreaming(status, headers)

    return new Promise((resolve, reject) => {
      let paused = false

      readable.on('data', (chunk) => {
        if (this.aborted) {
          readable.destroy()
          resolve()
          return
        }

        const ok = this.write(chunk)

        if (!ok && !paused) {
          paused = true
          readable.pause()

          this.onWritable(() => {
            paused = false
            readable.resume()
          })
        }
      })

      readable.on('end', () => {
        this.end()
        resolve()
      })

      readable.on('error', (err) => {
        if (!this.aborted) {
          this.end()
        }
        reject(err)
      })
    })
  }
}
