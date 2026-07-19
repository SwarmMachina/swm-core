import BodyParser from './body-parser.js'
import ResStreamer from './res-streamer.js'
import { CACHED_ERRORS, JSON_HEADER, OCTET_STREAM_HEADER, STATUS_TEXT, TEXT_PLAIN_HEADER } from './constants.js'
import { assertHeaderValue, getPreparedHeaders } from './prepared-headers.js'

export default class HttpContext {
  #ip = ''
  #method = ''
  #url = ''
  #headersCached = false
  #headers = Object.create(null)
  #fullQuery = ''
  #fullQueryCached = false
  #fullQueryParsed = false
  #query = Object.create(null)
  #params = Object.create(null)
  #statusOverride = null
  #contentLength = undefined
  #pendingHeaders = new Map()
  #cleared = false
  #responseBatch = false
  #bodyParser = new BodyParser()
  #resStreamer = new ResStreamer()
  #requestTimeout = null

  body = (maxSize) => this.#bodyParser.body(maxSize)
  buffer = (maxSize) => this.#bodyParser.buffer(maxSize)
  text = (maxSize) => this.#bodyParser.text(maxSize)
  json = (maxSize) => this.#bodyParser.json(maxSize)

  prefetchBody() {
    return this.#bodyParser.prefetch()
  }

  startRequestTimeout(timeoutMs) {
    if (
      timeoutMs <= 0 ||
      this.#requestTimeout !== null ||
      this.done ||
      this.aborted ||
      this.replied ||
      this.terminating ||
      this.streaming
    ) {
      return
    }

    this.#requestTimeout = setTimeout(this.onRequestTimeout, timeoutMs)
    this.#requestTimeout.unref?.()
  }

  stopRequestTimeout() {
    if (this.#requestTimeout === null) {
      return
    }

    clearTimeout(this.#requestTimeout)
    this.#requestTimeout = null
  }

  onRequestTimeout = () => {
    this.#requestTimeout = null

    if (this.done || this.aborted || this.replied || this.terminating || this.streaming) {
      return
    }

    this.#bodyParser.timeout()

    try {
      this.replyAndClose(408, TEXT_PLAIN_HEADER, CACHED_ERRORS.requestTimeout.message)
    } catch {
      // The transport may have closed without delivering onAborted yet.
    }

    void this.server.safeCall(this.server.httpErrorHandler, this, CACHED_ERRORS.requestTimeout)

    if (!this.done && !this.aborted && !this.terminating && !this.streaming) {
      this.finalize()
    }
  }

  onAbort = () => this.abort()

  finalize = () => {
    if (this.done) {
      return
    }

    this.stopRequestTimeout()
    this.done = true
    this.server.finalizeHttpContext(this)
  }

  onResolve = (result) => {
    this.asyncPending = false

    if (this.done || this.aborted) {
      if (this.releasePending) {
        this.releasePending = false
        this.release()
      }

      return
    }

    try {
      if (!this.replied) {
        this.send(result)
      }
    } catch (err) {
      if (!this.replied) {
        try {
          this.sendError(err)
        } catch {
          //
        }
      }

      void this.server.safeCall(this.server.httpErrorHandler, this, err)
    }

    if (!this.streaming) {
      this.finalize()
    }
  }

  onReject = (err) => {
    this.asyncPending = false

    if (this.done || this.aborted) {
      if (this.releasePending) {
        this.releasePending = false
        this.release()
      }

      return
    }

    if (!this.replied) {
      try {
        this.sendError(err)
      } catch {
        //
      }
    }

    void this.server.safeCall(this.server.httpErrorHandler, this, err)

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
    this.terminating = false
    this.handlerPending = false
    this.abortPending = false
    this.asyncPending = false
    this.releasePending = false
    this.onWritableCallback = null
  }

  /**
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {Server} [server]
   * @param {number} [maxSize]
   * @returns {HttpContext}
   */
  reset(res, req, server, maxSize = 1024 * 1024 * 16) {
    this.stopRequestTimeout()

    if (!this.#cleared) {
      this.#statusOverride = null
      this.#contentLength = undefined
      this.#pendingHeaders.clear()
      this.#ip = ''
      this.#url = ''
      this.#method = ''
      this.#headersCached = false
      this.#headers = Object.create(null)
      this.#fullQuery = ''
      this.#fullQueryCached = false
      this.#fullQueryParsed = false
      this.#query = Object.create(null)
      this.#params = Object.create(null)
    }

    this.#cleared = false
    this.#responseBatch = server?.bindingCapabilities?.responseBatch === true

    this.res = res
    this.req = req
    this.server = server

    this.done = false
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.terminating = false
    this.handlerPending = false
    this.abortPending = false
    this.asyncPending = false
    this.releasePending = false
    this.onWritableCallback = null

    this.#bodyParser.reset(this, maxSize)
    this.#resStreamer.reset(this, res)

    return this
  }

  /**
   */
  clear() {
    this.stopRequestTimeout()

    this.res = null
    this.req = null
    this.server = null

    this.done = true
    this.replied = false
    this.aborted = false
    this.streaming = false
    this.streamingStarted = false
    this.terminating = false
    this.handlerPending = false
    this.abortPending = false
    this.asyncPending = false
    this.releasePending = false
    this.onWritableCallback = null

    this.#responseBatch = false

    if (!this.#cleared) {
      this.#statusOverride = null
      this.#contentLength = undefined
      this.#pendingHeaders.clear()
      this.#ip = ''
      this.#url = ''
      this.#method = ''
      this.#headersCached = false
      this.#headers = Object.create(null)
      this.#fullQuery = ''
      this.#fullQueryCached = false
      this.#fullQueryParsed = false
      this.#query = Object.create(null)
      this.#params = Object.create(null)

      this.#bodyParser.clear()
      this.#resStreamer.clear()
      this.#cleared = true
    }
  }

  abort() {
    if (this.done || this.aborted) {
      return
    }

    this.aborted = true
    this.stopRequestTimeout()
    this.streaming = false
    this.streamingStarted = false
    this.onWritableCallback = null

    this.#resStreamer.abort()
    this.#bodyParser.abort()

    if (this.handlerPending) {
      this.abortPending = true

      return
    }

    this.finalize()
  }

  /**
   */
  release() {
    if (this.pool) {
      this.pool.release(this)
    }
  }

  /**
   * Preserve request metadata before the native request object expires. Newer
   * bindings can materialize it in one crossing; older backends keep the
   * compatibility path.
   * @param {string[]} [paramNames]
   */
  cacheRequest(paramNames) {
    const canSnapshot = this.server?.bindingCapabilities?.requestSnapshot === true

    if (canSnapshot && this.req && typeof this.req.snapshot === 'function') {
      const names = paramNames || []
      const snapshot = this.req.snapshot(names.length)

      this.#method = typeof snapshot?.method === 'string' ? snapshot.method : ''
      this.#url = typeof snapshot?.url === 'string' ? snapshot.url : ''
      this.#fullQuery = typeof snapshot?.query === 'string' ? snapshot.query : ''
      this.#fullQueryCached = true
      this.#fullQueryParsed = false
      this.#headers = snapshot?.headers || Object.create(null)
      this.#headersCached = true

      const values = Array.isArray(snapshot?.params) ? snapshot.params : []

      for (let i = 0; i < names.length; i++) {
        this.#params[i] = values[i]
        this.#params[names[i]] = values[i]
      }

      return
    }

    this.method()
    this.url()
    this.cacheQuery()
    this.cacheHeaders()
    this.cacheParams(paramNames)
  }

  cacheHeaders() {
    if (this.#headersCached || !this.req) {
      return
    }

    this.req.forEach((key, value) => {
      this.#headers[key] = value
    })

    this.#headersCached = true
  }

  cacheQuery() {
    if (this.#fullQueryCached || !this.req) {
      return
    }

    const fullQuery = this.req.getQuery()

    this.#fullQuery = typeof fullQuery === 'string' ? fullQuery : ''
    this.#fullQueryCached = true
    this.#fullQueryParsed = false
  }

  #parseFullQuery() {
    if (this.#fullQueryParsed) {
      return
    }

    const fullQuery = this.#fullQuery

    if (!fullQuery) {
      this.#fullQueryParsed = true

      return
    }

    let start = 0

    while (start <= fullQuery.length) {
      let end = fullQuery.indexOf('&', start)

      if (end === -1) {
        end = fullQuery.length
      }

      const eq = fullQuery.indexOf('=', start)
      const hasEq = eq !== -1 && eq < end
      const key = hasEq ? fullQuery.slice(start, eq) : fullQuery.slice(start, end)

      if (!(key in this.#query)) {
        this.#query[key] = hasEq ? fullQuery.slice(eq + 1, end) : ''
      }

      if (end === fullQuery.length) {
        break
      }

      start = end + 1
    }

    this.#fullQueryParsed = true
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
   * @returns {string}
   */
  fullQuery() {
    if (this.#fullQueryCached) {
      return this.#fullQuery
    }

    if (!this.req) {
      return ''
    }

    const fullQuery = this.req.getQuery()

    this.#fullQuery = typeof fullQuery === 'string' ? fullQuery : ''
    this.#fullQueryCached = true
    this.#fullQueryParsed = false

    return this.#fullQuery
  }

  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  query(name) {
    if (name in this.#query) {
      return this.#query[name]
    }

    if (this.#fullQueryCached) {
      this.#parseFullQuery()

      if (name in this.#query) {
        return this.#query[name]
      }

      this.#query[name] = undefined

      return undefined
    }

    if (!this.req) {
      return undefined
    }

    const value = this.req.getQuery(name)

    this.#query[name] = value

    return value
  }

  /**
   * @param {number|string} i
   * @returns {string|undefined}
   */
  param(i) {
    if (i in this.#params) {
      return this.#params[i]
    }

    if (!this.req) {
      return undefined
    }

    const value = this.req.getParameter(i)

    this.#params[i] = value

    return value
  }

  /**
   * @param {string[]} [names]
   */
  cacheParams(names) {
    if (!names || !this.req) {
      return
    }

    for (let i = 0; i < names.length; i++) {
      const value = this.req.getParameter(i)

      this.#params[i] = value
      this.#params[names[i]] = value
    }
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  header(name) {
    const headerName = name.toLowerCase()

    if (headerName in this.#headers) {
      return this.#headers[headerName]
    }

    if (this.#headersCached || !this.req) {
      return ''
    }

    const value = this.req.getHeader(headerName)

    this.#headers[headerName] = value

    return value
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
   * @returns {string}
   */
  getStatus(status) {
    const finalStatus = this.#statusOverride !== null ? this.#statusOverride : status

    if (finalStatus == null) {
      return STATUS_TEXT[500]
    }

    return STATUS_TEXT[finalStatus] || `${finalStatus} Unknown`
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {HttpContext}
   */
  setHeader(key, value) {
    if (this.replied || this.aborted) {
      return this
    }

    if (typeof key !== 'string') {
      throw new TypeError('Header name must be a string')
    }

    if (value === undefined || value === null) {
      return this
    }

    const headerValue = `${value}`

    assertHeaderValue(headerValue)

    const headerKey = key.toLowerCase()

    this.#pendingHeaders.set(headerKey, [key, headerValue])

    return this
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {HttpContext}
   */
  appendHeader(key, value) {
    if (this.replied || this.aborted) {
      return this
    }

    if (typeof key !== 'string') {
      throw new TypeError('Header name must be a string')
    }

    if (value === undefined || value === null) {
      return this
    }

    const headerValue = `${value}`

    assertHeaderValue(headerValue)

    const headerKey = key.toLowerCase()
    const pendingHeader = this.#pendingHeaders.get(headerKey)

    if (!pendingHeader) {
      this.#pendingHeaders.set(headerKey, [key, headerValue])

      return this
    }

    pendingHeader[0] = key
    const cur = pendingHeader[1]

    if (typeof cur === 'string') {
      pendingHeader[1] = [cur, headerValue]
    } else {
      cur[cur.length] = headerValue
    }

    return this
  }

  /**
   * @param {Record<string, string | string[]> | null | undefined} headers
   */
  setHeaders(headers) {
    if (this.replied || this.aborted) {
      return
    }

    this.#stageHeaders(headers)
  }

  /**
   * @param {Record<string, string | string[]> | null | undefined} headers
   */
  flushHeaders(headers = null) {
    this.#flushPendingHeaders(headers)
  }

  /**
   * @param {string} key
   * @param {string | string[] | null | undefined} value
   * @param {boolean} append
   */
  #stagePendingHeader(key, value, append) {
    if (value === undefined || value === null) {
      return
    }

    const headerKey = key.toLowerCase()

    if (!Array.isArray(value)) {
      const headerValue = `${value}`

      assertHeaderValue(headerValue)

      if (!append) {
        this.#pendingHeaders.set(headerKey, [key, headerValue])

        return
      }

      const pendingHeader = this.#pendingHeaders.get(headerKey)

      if (!pendingHeader) {
        this.#pendingHeaders.set(headerKey, [key, headerValue])

        return
      }

      pendingHeader[0] = key
      const cur = pendingHeader[1]

      if (typeof cur === 'string') {
        pendingHeader[1] = [cur, headerValue]
      } else {
        cur[cur.length] = headerValue
      }

      return
    }

    this.#stagePendingHeaderArray(key, headerKey, value, append)
  }

  /**
   * @param {string} key
   * @param {string} headerKey
   * @param {string[]} value
   * @param {boolean} append
   */
  #stagePendingHeaderArray(key, headerKey, value, append) {
    let pendingHeader = append ? this.#pendingHeaders.get(headerKey) : null

    for (let i = 0, len = value.length; i < len; i++) {
      const entry = value[i]

      if (entry === undefined || entry === null) {
        continue
      }

      const headerValue = `${entry}`

      assertHeaderValue(headerValue)

      if (!pendingHeader) {
        pendingHeader = [key, headerValue]
        this.#pendingHeaders.set(headerKey, pendingHeader)
        continue
      }

      pendingHeader[0] = key
      const cur = pendingHeader[1]

      if (typeof cur === 'string') {
        pendingHeader[1] = [cur, headerValue]
      } else {
        cur[cur.length] = headerValue
      }
    }
  }

  /**
   * @param {Record<string, string | string[]> | null | undefined} headers
   * @param {{groups: ReadonlyArray<object>, lines: ReadonlyArray<string>}|undefined} prepared
   */
  #stageHeaders(headers, prepared = getPreparedHeaders(headers)) {
    if (!headers) {
      return
    }

    if (prepared) {
      const groups = prepared.groups

      for (let i = 0; i < groups.length; i++) {
        const { key, name, values } = groups[i]

        this.#pendingHeaders.set(key, [name, values.length === 1 ? values[0] : values.slice()])
      }

      return
    }

    for (const key in headers) {
      this.#stagePendingHeader(key, headers[key], false)
    }
  }

  /**
   * @param {Record<string, string | string[]> | null | undefined} headers
   * @param {{groups: ReadonlyArray<object>, lines: ReadonlyArray<string>}|undefined} prepared
   */
  #flushPendingHeaders(headers = null, prepared = getPreparedHeaders(headers)) {
    if (!this.res) {
      this.#pendingHeaders.clear()

      return
    }

    if (prepared && this.#pendingHeaders.size === 0) {
      const lines = prepared.lines

      for (let i = 0; i < lines.length; i += 2) {
        this.res.writeHeader(lines[i], lines[i + 1])
      }

      return
    }

    if (headers) {
      this.#stageHeaders(headers, prepared)
    }

    for (const [, pendingHeader] of this.#pendingHeaders) {
      const headerValue = pendingHeader[1]

      if (typeof headerValue === 'string') {
        this.res.writeHeader(pendingHeader[0], headerValue)
        continue
      }

      const name = pendingHeader[0]

      for (let i = 0, len = headerValue.length; i < len; i++) {
        this.res.writeHeader(name, headerValue[i])
      }
    }

    this.#pendingHeaders.clear()
  }

  /**
   * @param {unknown} result
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
   * @param {Record<string, string | string[]>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   */
  reply(status = 200, headers = null, body = null) {
    this.#reply(status, headers, body, false)
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   */
  replyAndClose(status = 200, headers = null, body = null) {
    this.#reply(status, headers, body, true)
  }

  terminate() {
    if (this.done || this.aborted || this.terminating) {
      return
    }

    // Prevent a fallback response if onAborted runs after close() returns.
    this.stopRequestTimeout()
    this.terminating = true
    this.replied = true
    this.res.close()
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   * @param {boolean} closeConnection
   */
  #reply(status, headers, body, closeConnection) {
    if (this.replied || this.aborted) {
      return
    }

    this.stopRequestTimeout()
    this.replied = true

    const prepared = getPreparedHeaders(headers)

    if (
      !closeConnection &&
      this.#responseBatch &&
      prepared &&
      this.#pendingHeaders.size === 0 &&
      typeof this.res?.endBatch === 'function'
    ) {
      this.res.endBatch(this.getStatus(status), prepared.lines, body ?? undefined)

      return
    }

    this.res.cork(() => {
      if (this.aborted) {
        return
      }

      this.res.writeStatus(this.getStatus(status))
      this.#flushPendingHeaders(headers, prepared)

      if (body != null) {
        if (closeConnection) {
          this.res.end(body, true)
        } else {
          this.res.end(body)
        }
      } else if (closeConnection) {
        this.res.end(undefined, true)
      } else {
        this.res.end()
      }
    })
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @returns {HttpContext}
   */
  startStreaming(status = 200, headers = null) {
    if (this.replied || this.aborted) {
      return this
    }

    this.stopRequestTimeout()
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
