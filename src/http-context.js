import BodyParser from './body-parser.js'
import ResStreamer from './res-streamer.js'
import { CACHED_ERRORS, JSON_HEADER, OCTET_STREAM_HEADER, STATUS_TEXT, TEXT_PLAIN_HEADER } from './constants.js'
import { assertHeaderValue, getPreparedHeaders } from './prepared-headers.js'
import { getRemoteAddress } from './remote-address.js'
import { DEFAULT_HTTP_MAX_BODY_SIZE_BYTES } from './server/options.js'

const MISSING_HEADER = Symbol('missing-header')

export default class HttpContext {
  #ip = ''
  #ipCached = false
  #method = ''
  #url = ''
  #headersCached = false
  #headers = null
  #headersView = null
  #prefetchHeaders = false
  #prefetchedHeaders = null
  #prefetchedHeadersCached = false
  #requestDetached = false
  #fullQuery = ''
  #fullQueryCached = false
  #fullQueryParsed = false
  #query = null
  #params = null
  #statusOverride = null
  #contentLength = undefined
  #pendingHeaders = new Map()
  #cleared = false
  #responseBatch = false
  #bodyParser = new BodyParser()
  #resStreamer = new ResStreamer()
  #requestTimeout = null

  body(maxSize) {
    return this.#bodyParser.body(maxSize)
  }

  buffer(maxSize) {
    return this.#bodyParser.buffer(maxSize)
  }

  text(maxSize) {
    return this.#bodyParser.text(maxSize)
  }

  json(maxSize) {
    return this.#bodyParser.json(maxSize)
  }

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

  #resetRequestState() {
    this.#statusOverride = null
    this.#contentLength = undefined
    this.#pendingHeaders.clear()
    this.#ip = ''
    this.#ipCached = false
    this.#url = ''
    this.#method = ''
    this.#headersCached = false
    this.#headers = null
    this.#headersView = null
    this.#prefetchHeaders = false
    this.#prefetchedHeaders = null
    this.#prefetchedHeadersCached = false
    this.#requestDetached = false
    this.#fullQuery = ''
    this.#fullQueryCached = false
    this.#fullQueryParsed = false
    this.#query = null
    this.#params = null
  }

  /**
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {Server} [server]
   * @param {number} [maxSize]
   * @returns {HttpContext}
   */
  reset(res, req, server, maxSize = DEFAULT_HTTP_MAX_BODY_SIZE_BYTES) {
    this.stopRequestTimeout()

    if (!this.#cleared) {
      this.#resetRequestState()
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
      this.#resetRequestState()

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
   * Retain the configured request headers while the native request is still attached.
   * @param {false|'all'|readonly string[]} selection
   * @param {object|null} plan
   */
  attachPrefetchedHeaders(selection, plan) {
    this.#prefetchHeaders = selection

    if (plan === null) {
      return
    }

    if (!this.req || typeof this.req.prefetch !== 'function') {
      throw new Error('swm-uws advertised requestPrefetch but HttpRequest.prefetch is unavailable')
    }

    const retained = this.req.prefetch(plan)

    if (!retained || typeof retained.getHeader !== 'function' || typeof retained.getHeaders !== 'function') {
      throw new Error('swm-uws requestPrefetch did not return an owned header snapshot')
    }

    this.#prefetchedHeaders = retained
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  #isHeaderPrefetched(name) {
    return (
      this.#prefetchHeaders === 'all' || (Array.isArray(this.#prefetchHeaders) && this.#prefetchHeaders.includes(name))
    )
  }

  /**
   * @param {string} name
   * @param {string|symbol} value
   */
  #storeHeader(name, value) {
    const headers = (this.#headers ??= Object.create(null))

    headers[name] = value

    if (!this.#headersView) {
      return
    }

    if (value === MISSING_HEADER) {
      delete this.#headersView[name]
    } else {
      this.#headersView[name] = value
    }
  }

  /**
   * Preserve non-header request metadata before the native request object
   * expires. Headers remain lazy unless the configured native prefetch plan
   * retained them or application code read them synchronously.
   * @param {string[]} [paramNames]
   */
  cacheRequest(paramNames) {
    this.getMethod()
    this.getUrl()
    this.cacheQuery()
    this.cacheParams(paramNames)
    this.#requestDetached = true
  }

  cacheHeaders() {
    if (this.#headersCached) {
      return
    }

    if (this.#prefetchHeaders === 'all') {
      this.#cachePrefetchedHeaders()
      this.#headersCached = true

      return
    }

    if (this.#requestDetached || !this.req) {
      return
    }

    this.req.forEach((key, value) => {
      this.#storeHeader(key.toLowerCase(), value)
    })

    this.#headersCached = true
  }

  #cachePrefetchedHeaders() {
    if (this.#prefetchedHeadersCached) {
      return
    }

    const prefetched = this.#prefetchedHeaders?.getHeaders?.()

    if (prefetched && typeof prefetched === 'object') {
      for (const name in prefetched) {
        this.#storeHeader(name.toLowerCase(), prefetched[name])
      }
    }

    this.#prefetchedHeadersCached = true
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

    let query = this.#query

    if (!query) {
      query = Object.create(null)
      this.#query = query
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

      if (!Object.hasOwn(query, key)) {
        query[key] = hasEq ? fullQuery.slice(eq + 1, end) : ''
      }

      if (end === fullQuery.length) {
        break
      }

      start = end + 1
    }

    this.#fullQueryParsed = true
  }

  getIP() {
    if (this.#ipCached) {
      return this.#ip
    }

    this.#ip = getRemoteAddress(this.res)
    this.#ipCached = true

    return this.#ip
  }

  ip() {
    return this.getIP()
  }

  getMethod() {
    if (!this.req) {
      return ''
    }

    if (this.#method) {
      return this.#method
    }

    this.#method = this.req.getMethod()

    return this.#method
  }

  method() {
    return this.getMethod()
  }

  getUrl() {
    if (!this.req) {
      return ''
    }

    if (this.#url) {
      return this.#url
    }

    this.#url = this.req.getUrl()

    return this.#url
  }

  url() {
    return this.getUrl()
  }

  /**
   * @param {string} [name]
   * @returns {string|undefined}
   */
  getQuery(name) {
    if (name !== undefined) {
      return this.#getQueryParameter(name)
    }

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

  fullQuery() {
    return this.getQuery()
  }

  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  #getQueryParameter(name) {
    let query = this.#query

    if (query && Object.hasOwn(query, name)) {
      return query[name]
    }

    if (this.#fullQueryCached) {
      this.#parseFullQuery()
      query = this.#query

      if (query && Object.hasOwn(query, name)) {
        return query[name]
      }

      if (!query) {
        query = Object.create(null)
        this.#query = query
      }

      query[name] = undefined

      return undefined
    }

    if (!this.req) {
      return undefined
    }

    const value = this.req.getQuery(name)

    if (!query) {
      query = Object.create(null)
      this.#query = query
    }

    query[name] = value

    return value
  }

  query(name) {
    return this.getQuery(name)
  }

  /**
   * @param {number|string} i
   * @returns {string|undefined}
   */
  getParameter(i) {
    let params = this.#params

    if (params && Object.hasOwn(params, i)) {
      return params[i]
    }

    if (!this.req) {
      return undefined
    }

    const value = this.req.getParameter(i)

    if (!params) {
      params = Object.create(null)
      this.#params = params
    }

    params[i] = value

    return value
  }

  param(i) {
    return this.getParameter(i)
  }

  /**
   * @param {string[]} [names]
   */
  cacheParams(names) {
    if (!names || names.length === 0 || !this.req) {
      return
    }

    const params = (this.#params ??= Object.create(null))

    for (let i = 0; i < names.length; i++) {
      const value = this.req.getParameter(i)

      params[i] = value
      params[names[i]] = value
    }
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  getHeader(name) {
    const headerName = name.toLowerCase()
    const headers = this.#headers

    if (headers && Object.hasOwn(headers, headerName)) {
      const value = headers[headerName]

      return value === MISSING_HEADER ? '' : value
    }

    if (this.#isHeaderPrefetched(headerName)) {
      const value = this.#prefetchedHeaders?.getHeader?.(headerName)

      this.#storeHeader(headerName, value === undefined ? MISSING_HEADER : value)

      return value ?? ''
    }

    if (this.#headersCached || this.#requestDetached || !this.req) {
      return ''
    }

    const value = this.req.getHeader(headerName) ?? ''

    this.#storeHeader(headerName, value === '' ? MISSING_HEADER : value)

    return value
  }

  /**
   * Lazily materialized stable view of retained and already-read headers.
   * Accessing this property never enumerates the native request.
   * @returns {Record<string, string>}
   */
  get headers() {
    if (this.#headersView) {
      return this.#headersView
    }

    if (this.#prefetchHeaders !== false) {
      this.#cachePrefetchedHeaders()
    }

    const headers = Object.create(null)
    const cachedHeaders = this.#headers

    if (cachedHeaders) {
      for (const name in cachedHeaders) {
        const value = cachedHeaders[name]

        if (value !== MISSING_HEADER) {
          headers[name] = value
        }
      }
    }

    this.#headersView = headers

    return headers
  }

  /**
   * Materialize a complete header collection. Selective prefetch intentionally
   * cannot satisfy this operation after the native request has detached.
   * @returns {Record<string, string>}
   */
  getHeaders() {
    this.cacheHeaders()

    if (!this.#headersCached) {
      if (!this.#requestDetached && !this.req) {
        return Object.create(null)
      }

      const error = new Error(
        'All request headers are unavailable after the async boundary; use prefetchHeaders: "all" or call getHeaders() synchronously'
      )

      error.code = 'REQUEST_HEADERS_NOT_RETAINED'

      throw error
    }

    const headers = Object.create(null)
    const cachedHeaders = this.#headers

    if (cachedHeaders) {
      for (const name in cachedHeaders) {
        const value = cachedHeaders[name]

        if (value !== MISSING_HEADER) {
          headers[name] = value
        }
      }
    }

    return headers
  }

  header(name) {
    return this.getHeader(name)
  }

  getContentLength() {
    if (this.#contentLength !== undefined) {
      return this.#contentLength
    }

    const clh = this.getHeader('content-length')

    if (clh === '') {
      this.#contentLength = null

      return this.#contentLength
    }

    if (!/^(?:0|[1-9]\d*)$/.test(clh)) {
      this.#contentLength = null

      return this.#contentLength
    }

    const n = Number(clh)

    if (!Number.isSafeInteger(n)) {
      this.#contentLength = null

      return this.#contentLength
    }

    this.#contentLength = n

    return this.#contentLength
  }

  contentLength() {
    return this.getContentLength()
  }

  /**
   * @param {number} code
   * @returns {HttpContext}
   */
  setStatus(code) {
    this.#statusOverride = code

    return this
  }

  status(code) {
    return this.setStatus(code)
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
    if (Number.isFinite(error?.status)) {
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

    return this.#resStreamer.tryEnd(chunk, totalSize)
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
