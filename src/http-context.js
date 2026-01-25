import BodyParser from './body-parser.js'
import ResStreamer from './res-streamer.js'
import { JSON_HEADER, OCTET_STREAM_HEADER, STATUS_TEXT, TEXT_PLAIN_HEADER } from './constants.js'

export default class HttpContext {
  #ip = ''
  #method = ''
  #url = ''
  #statusOverride = null
  #contentLength = undefined
  #bodyParser = new BodyParser()
  #resStreamer = new ResStreamer()

  body = (maxSize) => this.#bodyParser.body(maxSize)
  buffer = (maxSize) => this.#bodyParser.buffer(maxSize)
  text = (maxSize) => this.#bodyParser.text(maxSize)
  json = (maxSize) => this.#bodyParser.json(maxSize)

  onAbort = () => this.abort()

  finalize = () => {
    if (this.done) {
      return
    }

    this.done = true
    this.server.finalizeHttpContext(this)
  }

  onResolve = (result) => {
    if (this.done || this.aborted || this.replied) {
      return
    }

    try {
      this.send(result)
    } catch (err) {
      if (!this.replied) {
        try {
          this.sendError(err)
        } catch {
          //
        }
      }

      void this.server.safeHttpError(this, err)
    }

    if (!this.streaming) {
      this.finalize()
    }
  }

  onReject = (err) => {
    if (this.done || this.aborted || this.replied) {
      return
    }

    try {
      this.sendError(err)
    } catch {
      //
    }

    void this.server.safeHttpError(this, err)

    if (!this.streaming) {
      this.finalize()
    }
  }

  /**
   * @param {ContextPool} pool
   */
  constructor(pool) {
    this.pool = pool

    this.res = null
    this.req = null
    this.server = null

    this.done = false
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null
  }

  /**
   * @param {import('uwebsockets.js').HttpResponse} res
   * @param {import('uwebsockets.js').HttpRequest} req
   * @param {Server} [server]
   * @param {number} [maxSize]
   * @returns {HttpContext}
   */
  reset(res, req, server, maxSize = 1024 * 1024 * 16) {
    this.res = res
    this.req = req
    this.server = server

    this.done = false
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null

    this.#statusOverride = null
    this.#contentLength = undefined

    this.#ip = ''
    this.#url = ''
    this.#method = ''

    this.#bodyParser.reset(this, maxSize)
    this.#resStreamer.reset(this, res)

    return this
  }

  /**
   */
  clear() {
    this.res = null
    this.req = null
    this.server = null

    this.done = true
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null

    this.#statusOverride = null
    this.#contentLength = undefined
    this.#ip = ''
    this.#url = ''
    this.#method = ''

    this.#bodyParser.clear()
    this.#resStreamer.clear()
  }

  abort() {
    if (this.done || this.aborted) {
      return
    }

    this.aborted = true
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null

    this.#resStreamer.abort()
    this.#bodyParser.abort()
    this.finalize()
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
   * @param {string|number} status
   * @returns {any}
   */
  getStatus(status) {
    const finalStatus = this.#statusOverride !== null ? this.#statusOverride : status

    return STATUS_TEXT[finalStatus] || STATUS_TEXT[500]
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
   * @param {Error} error
   * @returns {void}
   */
  sendError(error) {
    if (isFinite(error?.status)) {
      return this.reply(error.status, TEXT_PLAIN_HEADER, error.message)
    }

    return this.reply(500, TEXT_PLAIN_HEADER, 'Internal Server Error')
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

    this.#resStreamer.begin(status, headers)

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
    return this.#resStreamer.write(chunk)
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array|Buffer} [chunk]
   * @param {number} totalSize
   * @returns {[boolean, boolean]}
   */
  tryEnd(chunk, totalSize) {
    if (this.aborted) {
      return [false, false]
    }
    if (!this.streaming) {
      throw new Error('Must call startStreaming() before tryEnd()')
    }

    const [ok, done] = this.#resStreamer.tryEnd(chunk, totalSize)

    if (done) {
      this.streaming = false
    }

    return [ok, done]
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

    this.streaming = false
    this.#resStreamer.end(chunk)
  }

  onWritable(callback) {
    if (this.aborted) {
      return
    }
    this.#resStreamer.onWritable(callback)
  }

  getWriteOffset() {
    if (this.aborted) {
      return 0
    }

    return this.#resStreamer.getWriteOffset()
  }

  /**
   * @param {import('stream').Readable} readable
   * @param {number} status
   * @param {Record<string,string>} headers
   * @returns {Promise<void>}
   */
  stream(readable, status = 200, headers = null) {
    if (this.replied || this.aborted) {
      return Promise.resolve()
    }

    this.replied = true
    this.streaming = true

    return this.#resStreamer.stream(readable, status, headers)
  }
}
