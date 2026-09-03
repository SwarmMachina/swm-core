import BodyParser from './body-parser.js'
import type RequestBodyStream from './request-body-stream.js'
import type PreparedHeaderReplies from './prepared-header-replies.js'
import ResStreamer from './response-streamer.js'
import { CACHED_ERRORS, JSON_HEADER, OCTET_STREAM_HEADER, STATUS_TEXT, TEXT_PLAIN_HEADER } from './status.js'
import { assertHeaderName, assertHeaderValue, getPreparedHeaders } from './headers.js'
import { getRemoteAddress } from '../net/remote-address.js'
import { DEFAULT_HTTP_MAX_BODY_SIZE_BYTES } from '../server/options.js'

import type { Readable } from 'node:stream'
import type { HttpRequest, HttpResponse, RequestPrefetchPlan, RequestPrefetchSnapshot } from '@swarmmachina/swm-uws'

const MISSING_HEADER = Symbol('missing-header')

type HttpBody = string | ArrayBuffer | ArrayBufferView | Buffer
type HeaderInput = Record<string, string | string[]> | object | null | undefined
type HeaderMap = Record<string, string>
type CachedHeaderMap = Record<string, string | typeof MISSING_HEADER>
type QueryMap = Record<string, string | undefined>
type ParamMap = Record<string | number, string | undefined>
type PendingHeader = [name: string, value: string | string[]]

interface ContextPool {
  release(context: HttpContext): void
}

interface HttpContextServer {
  readonly bindingCapabilities: {
    readonly beginWrite?: boolean
    readonly collectBody?: boolean
    readonly collectBodyLength?: boolean
    readonly responseBatch?: boolean
  }
  readonly preparedHeaderReplies: PreparedHeaderReplies | null
  readonly httpBodyBudget: {
    tryReserve(bytes: number, owner: object): boolean
    resize(bytes: number, owner: object): boolean
    release(owner: object): void
  } | null
  finalizeHttpContext(context: HttpContext): void
  reportHttpError(context: HttpContext, error: unknown): void
}

/**
 * Narrow test-double contract accepted by reset(). Production contexts always
 * receive a complete Server facade; the internal field remains complete so
 * request handling never pays for optional callbacks.
 */
export type HttpContextServerInput = Partial<HttpContextServer> | ((context: HttpContext) => void)

export default class HttpContext {
  #ip = ''
  #ipCached = false
  #method = ''
  #url = ''
  #headersCached = false
  #headers: CachedHeaderMap | null = null
  #headersView: HeaderMap | null = null
  #prefetchHeaders: false | 'all' | readonly string[] = false
  #prefetchedHeaders: RequestPrefetchSnapshot | null = null
  #prefetchedHeadersCached = false
  #requestDetached = false
  #fullQuery = ''
  #fullQueryCached = false
  #fullQueryParsed = false
  #query: QueryMap | null = null
  #params: ParamMap | null = null
  #statusOverride: number | null = null
  #contentLength: number | null | undefined = undefined
  #pendingHeaders = new Map<string, PendingHeader>()
  #cleared = false
  #responseBatch = false
  #preparedHeaderReplies: PreparedHeaderReplies | null = null
  #bodyParser = new BodyParser()
  #resStreamer = new ResStreamer()
  #requestTimeout: ReturnType<typeof setTimeout> | null = null

  declare pool: ContextPool | null
  declare res: HttpResponse | null
  declare req: HttpRequest | null
  declare server: HttpContextServer | null
  declare done: boolean
  declare replied: boolean
  declare aborted: boolean
  declare streaming: boolean
  declare streamingStarted: boolean
  declare terminating: boolean
  declare handlerPending: boolean
  declare abortPending: boolean
  declare asyncPending: boolean
  declare releasePending: boolean
  declare onWritableCallback: ((offset: number) => void) | null

  body(maxSize?: number): Promise<Buffer> {
    return this.#bodyParser.body(maxSize)
  }

  bodyStream(maxSize?: number): RequestBodyStream {
    return this.#bodyParser.bodyStream(maxSize)
  }

  buffer(maxSize?: number): Promise<Buffer> {
    return this.#bodyParser.body(maxSize)
  }

  text(maxSize?: number): Promise<string> {
    return this.#bodyParser.text(maxSize)
  }

  json(maxSize?: number): Promise<unknown> {
    return this.#bodyParser.json(maxSize)
  }

  prefetchBody(): Error | null {
    return this.#bodyParser.prefetch()
  }

  startRequestTimeout(timeoutMs: number): void {
    if (
      timeoutMs <= 0 ||
      this.#requestTimeout !== null ||
      this.done ||
      this.aborted ||
      this.terminating ||
      this.streaming
    ) {
      return
    }

    this.#requestTimeout = setTimeout(this.onRequestTimeout, timeoutMs)
    this.#requestTimeout.unref?.()
  }

  stopRequestTimeout(): void {
    if (this.#requestTimeout === null) {
      return
    }

    clearTimeout(this.#requestTimeout)
    this.#requestTimeout = null
  }

  onRequestTimeout = (): void => {
    this.#requestTimeout = null

    if (this.done || this.aborted || this.terminating || this.streaming) {
      return
    }

    this.#bodyParser.timeout()

    if (!this.replied) {
      try {
        this.replyAndClose(408, TEXT_PLAIN_HEADER, CACHED_ERRORS.requestTimeout.message)
      } catch {
        // The transport may have closed without delivering onAborted yet.
      }
    }

    this.reportError(CACHED_ERRORS.requestTimeout)

    if (!this.done && !this.aborted && !this.terminating && !this.streaming) {
      this.finalize()
    }
  }

  onAbort = (): void => this.abort()

  finalize = (): void => {
    if (this.done) {
      return
    }

    this.stopRequestTimeout()
    this.done = true
    this.server!.finalizeHttpContext(this)
  }

  onResolve = (result: unknown): void => {
    this.asyncPending = false

    if (this.done || this.aborted) {
      this.maybeRelease()

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

      this.reportError(err)
    }

    if (!this.streaming) {
      this.finalize()
    }
  }

  onReject = (err: unknown): void => {
    this.asyncPending = false

    if (this.done || this.aborted) {
      this.maybeRelease()

      return
    }

    if (!this.replied) {
      try {
        this.sendError(err)
      } catch {
        //
      }
    }

    this.reportError(err)

    if (!this.streaming) {
      this.finalize()
    }
  }

  /**
   * @param {ContextPool} pool
   */
  constructor(pool: ContextPool | null) {
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
   * @param {number} [maxStreamSize]
   * @returns {HttpContext}
   */
  reset(
    res: HttpResponse,
    req: HttpRequest,
    server: HttpContextServer | HttpContextServerInput | null = null,
    maxSize = DEFAULT_HTTP_MAX_BODY_SIZE_BYTES,
    maxStreamSize = maxSize
  ): this {
    this.stopRequestTimeout()

    if (!this.#cleared) {
      this.#resetRequestState()
    }

    this.#cleared = false
    const testFinalize = typeof server === 'function' ? server : null
    const serverInput = typeof server === 'object' ? server : null

    this.#responseBatch = serverInput?.bindingCapabilities?.responseBatch === true
    this.#preparedHeaderReplies = serverInput?.preparedHeaderReplies ?? null

    this.res = res
    this.req = req
    this.server = testFinalize
      ? {
          bindingCapabilities: {},
          preparedHeaderReplies: null,
          httpBodyBudget: null,
          finalizeHttpContext: testFinalize,
          reportHttpError: () => {}
        }
      : (serverInput as HttpContextServer | null)

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

    this.#bodyParser.reset(this, maxSize, maxStreamSize)
    this.#resStreamer.reset(this, res)

    return this
  }

  /**
   */
  clear(): void {
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
    this.#preparedHeaderReplies = null

    if (!this.#cleared) {
      this.#resetRequestState()

      this.#bodyParser.clear()
      this.#resStreamer.clear()
      this.#cleared = true
    }
  }

  abort(): void {
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
  release(): void {
    if (this.pool) {
      this.pool.release(this)
    }
  }

  /** Submit stable metadata to observability without retaining this context. */
  reportError(error: unknown): void {
    this.server?.reportHttpError(this, error)
  }

  /**
   * Release after a late asynchronous handler branch settles. Error delivery
   * owns an immutable event and never participates in request lifecycle.
   */
  maybeRelease(): void {
    if (!this.releasePending || this.asyncPending) {
      return
    }

    this.releasePending = false
    this.release()
  }

  /**
   * Retain the configured request headers while the native request is still attached.
   * @param {false|'all'|readonly string[]} selection
   * @param {object|null} plan
   */
  attachPrefetchedHeaders(selection: false | 'all' | readonly string[], plan: RequestPrefetchPlan | null): void {
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
  #isHeaderPrefetched(name: string): boolean {
    return (
      this.#prefetchHeaders === 'all' || (Array.isArray(this.#prefetchHeaders) && this.#prefetchHeaders.includes(name))
    )
  }

  /**
   * @param {string} name
   * @param {string|symbol} value
   */
  #storeHeader(name: string, value: string | typeof MISSING_HEADER): void {
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
  cacheRequest(paramNames?: string[]): void {
    this.getMethod()
    this.getUrl()
    this.cacheQuery()
    this.cacheParams(paramNames)
    this.#requestDetached = true
  }

  cacheHeaders(): void {
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

  #cachePrefetchedHeaders(): void {
    if (this.#prefetchedHeadersCached) {
      return
    }

    const prefetched = this.#prefetchedHeaders?.getHeaders?.()

    if (prefetched && typeof prefetched === 'object') {
      for (const name in prefetched) {
        this.#storeHeader(name.toLowerCase(), prefetched[name]!)
      }
    }

    this.#prefetchedHeadersCached = true
  }

  cacheQuery(): void {
    if (this.#fullQueryCached || !this.req) {
      return
    }

    const fullQuery = this.req.getQuery()

    this.#fullQuery = typeof fullQuery === 'string' ? fullQuery : ''
    this.#fullQueryCached = true
    this.#fullQueryParsed = false
  }

  #parseFullQuery(): void {
    if (this.#fullQueryParsed) {
      return
    }

    const fullQuery = this.#fullQuery

    if (!fullQuery) {
      this.#fullQueryParsed = true

      return
    }

    const query = (this.#query ??= Object.create(null) as QueryMap)

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

  getIP(): string {
    if (this.#ipCached) {
      return this.#ip
    }

    this.#ip = getRemoteAddress(this.res)
    this.#ipCached = true

    return this.#ip
  }

  /** Read an internally retained observability header without widening ctx access. */
  readErrorHeader(name: string): string | undefined {
    const headerName = name.toLowerCase()
    const cached = this.#headers?.[headerName]

    if (cached !== undefined) {
      return cached === MISSING_HEADER ? undefined : cached
    }

    const prefetched = this.#prefetchedHeaders?.getHeader?.(headerName)

    if (prefetched !== undefined) {
      return prefetched
    }

    if (this.#requestDetached || !this.req) {
      return undefined
    }

    return this.req.getHeader(headerName)
  }

  /** Read one allowlisted observability query parameter from stable request metadata. */
  readErrorQuery(name: string): string | undefined {
    return this.#getQueryParameter(name)
  }

  /** Numeric status selected for the framework-controlled error response. */
  resolveErrorStatus(error: Error): number {
    const errorStatus = (error as Error & { status?: unknown }).status

    if (Number.isFinite(this.#statusOverride)) {
      return this.#statusOverride!
    }

    return Number.isFinite(errorStatus) ? (errorStatus as number) : 500
  }

  getMethod(): string {
    if (!this.req) {
      return ''
    }

    if (this.#method) {
      return this.#method
    }

    this.#method = this.req.getMethod()

    return this.#method
  }

  getUrl(): string {
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
   * @param {string} [name]
   * @returns {string|undefined}
   */
  getQuery(): string
  getQuery(name: string): string | undefined
  getQuery(name?: string): string | undefined {
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

  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  #getQueryParameter(name: string): string | undefined {
    let query = this.#query

    if (query && Object.hasOwn(query, name)) {
      return query[name]!
    }

    if (this.#fullQueryCached) {
      this.#parseFullQuery()
      query = this.#query

      if (query && Object.hasOwn(query, name)) {
        return query[name]!
      }

      if (!query) {
        query = Object.create(null) as QueryMap
        this.#query = query
      }

      query![name] = undefined

      return undefined
    }

    if (!this.req) {
      return undefined
    }

    const value = this.req.getQuery(name)

    if (!query) {
      query = Object.create(null) as QueryMap
      this.#query = query
    }

    query![name] = value

    return value
  }

  /**
   * @param {number|string} i
   * @returns {string|undefined}
   */
  getParameter(i: number | string): string | undefined {
    let params = this.#params

    if (params && Object.hasOwn(params, i)) {
      return params[i]!
    }

    if (!this.req) {
      return undefined
    }

    const value = this.req.getParameter(i)

    if (!params) {
      params = Object.create(null) as ParamMap
      this.#params = params
    }

    params![i] = value

    return value
  }

  /**
   * @param {string[]} [names]
   */
  cacheParams(names?: string[]): void {
    if (!names || names.length === 0 || !this.req) {
      return
    }

    const params = (this.#params ??= Object.create(null) as ParamMap)

    for (let i = 0; i < names.length; i++) {
      const value = this.req.getParameter(i)

      params[i] = value
      params[names[i]!] = value
    }
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  getReqHeader(name: string): string {
    const headerName = name.toLowerCase()
    const headers = this.#headers

    if (headers && Object.hasOwn(headers, headerName)) {
      const value = headers[headerName]

      return value === MISSING_HEADER ? '' : value!
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
  get headers(): HeaderMap {
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
        const value = cachedHeaders[name]!

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
  getHeaders(): HeaderMap {
    this.cacheHeaders()

    if (!this.#headersCached) {
      if (!this.#requestDetached && !this.req) {
        return Object.create(null)
      }

      const error = new Error(
        'All request headers are unavailable after the async boundary; use prefetchHeaders: "all" or call getHeaders() synchronously'
      )

      ;(error as Error & { code: string }).code = 'REQUEST_HEADERS_NOT_RETAINED'

      throw error
    }

    const headers = Object.create(null)
    const cachedHeaders = this.#headers

    if (cachedHeaders) {
      for (const name in cachedHeaders) {
        const value = cachedHeaders[name]!

        if (value !== MISSING_HEADER) {
          headers[name] = value
        }
      }
    }

    return headers
  }

  getContentLength(): number | null {
    if (this.#contentLength !== undefined) {
      return this.#contentLength
    }

    const clh = this.getReqHeader('content-length')

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

  /**
   * @param {number} code
   * @returns {HttpContext}
   */
  setStatus(code: number): this {
    this.#statusOverride = code

    return this
  }

  /**
   * @param {string|number} status
   * @returns {string}
   */
  getStatus(status?: number | null): string {
    const finalStatus = this.#statusOverride !== null ? this.#statusOverride : status

    if (finalStatus == null) {
      return STATUS_TEXT[500]!
    }

    return STATUS_TEXT[finalStatus] ?? `${finalStatus} Unknown`
  }

  /**
   * @param {string} key
   * @param {string | number | readonly string[]} value
   * @returns {HttpContext}
   */
  setHeader(key: string, value: string | number | readonly string[] | null | undefined): this {
    if (this.replied || this.aborted) {
      return this
    }

    if (typeof key !== 'string') {
      throw new TypeError('Header name must be a string')
    }

    assertHeaderName(key)

    if (value === undefined || value === null) {
      return this
    }

    const headerKey = key.toLowerCase()

    if (Array.isArray(value)) {
      const headerValues: string[] = []

      for (let i = 0, len = value.length; i < len; i++) {
        const entry = value[i]

        if (entry === undefined || entry === null) {
          continue
        }

        const headerValue = `${entry}`

        assertHeaderValue(headerValue)
        headerValues.push(headerValue)
      }

      const pendingValue = headerKey === 'cookie' && headerValues.length > 0 ? headerValues.join('; ') : headerValues

      this.#pendingHeaders.set(headerKey, [key, pendingValue])

      return this
    }

    const headerValue = `${value}`

    assertHeaderValue(headerValue)

    this.#pendingHeaders.set(headerKey, [key, headerValue])

    return this
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {HttpContext}
   */
  appendHeader(key: string, value: string | number | null | undefined): this {
    if (this.replied || this.aborted) {
      return this
    }

    if (typeof key !== 'string') {
      throw new TypeError('Header name must be a string')
    }

    assertHeaderName(key)

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
  setHeaders(headers: HeaderInput): void {
    if (this.replied || this.aborted) {
      return
    }

    this.#stageHeaders(headers)
  }

  /**
   * @param {Record<string, string | string[]> | null | undefined} headers
   */
  flushHeaders(headers: HeaderInput = null): void {
    this.#flushPendingHeaders(headers)
  }

  /**
   * @param {string} key
   * @param {string | string[] | null | undefined} value
   * @param {boolean} append
   */
  #stagePendingHeader(key: string, value: string | string[] | null | undefined, append: boolean): void {
    if (value === undefined || value === null) {
      return
    }

    assertHeaderName(key)

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
  #stagePendingHeaderArray(key: string, headerKey: string, value: string[], append: boolean): void {
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
  #stageHeaders(headers: HeaderInput, prepared = getPreparedHeaders(headers)): void {
    if (!headers) {
      return
    }

    if (prepared) {
      const groups = prepared.groups

      for (let i = 0; i < groups.length; i++) {
        const { key, name, values } = groups[i]!

        this.#pendingHeaders.set(key, [name, values.length === 1 ? values[0]! : values.slice()])
      }

      return
    }

    const headerMap = headers as Record<string, string | string[]>

    for (const key in headerMap) {
      this.#stagePendingHeader(key, headerMap[key]!, false)
    }
  }

  /**
   * @param {Record<string, string | string[]> | null | undefined} headers
   * @param {{groups: ReadonlyArray<object>, lines: ReadonlyArray<string>}|undefined} prepared
   */
  #flushPendingHeaders(headers: HeaderInput = null, prepared = getPreparedHeaders(headers)): void {
    if (!this.res) {
      this.#pendingHeaders.clear()

      return
    }

    if (prepared && this.#pendingHeaders.size === 0) {
      const lines = prepared.lines

      for (let i = 0; i < lines.length; i += 2) {
        this.res.writeHeader(lines[i]!, lines[i + 1]!)
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
        this.res.writeHeader(name, headerValue[i]!)
      }
    }

    this.#pendingHeaders.clear()
  }

  /**
   * @param {unknown} result
   * @returns {void}
   */
  send(result: unknown): void {
    if (result == null) {
      return this.reply(204, TEXT_PLAIN_HEADER, null)
    }

    if (typeof result === 'string') {
      return this.reply(200, TEXT_PLAIN_HEADER, result)
    }

    if (typeof result === 'object') {
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
  sendJson(data: object | unknown[], status = 200): void {
    this.reply(status, JSON_HEADER, JSON.stringify(data))
  }

  /**
   * @param {string} text
   * @param {number} [status]
   * @returns {void}
   */
  sendText(text: string, status = 200): void {
    this.reply(status, TEXT_PLAIN_HEADER, text)
  }

  /**
   * @param {Buffer|Uint8Array|ArrayBuffer} buffer
   * @param {number} [status]
   * @returns {void}
   */
  sendBuffer(buffer: Buffer | Uint8Array | ArrayBuffer, status = 200): void {
    this.reply(status, OCTET_STREAM_HEADER, buffer)
  }

  /**
   * @param {Error} error
   * @returns {void}
   */
  sendError(error: unknown): void {
    const responseError = error as { status?: unknown; message?: unknown } | null | undefined

    if (Number.isFinite(responseError?.status)) {
      return this.reply(
        responseError!.status as number,
        TEXT_PLAIN_HEADER,
        responseError!.message as string | undefined
      )
    }

    return this.reply(500, TEXT_PLAIN_HEADER, 'Internal Server Error')
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   */
  reply(status = 200, headers: HeaderInput = null, body: HttpBody | null | undefined = null): void {
    this.#reply(status, headers, body, false)
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   */
  replyAndClose(status = 200, headers: HeaderInput = null, body: HttpBody | null | undefined = null): void {
    this.#reply(status, headers, body, true)
  }

  terminate(): void {
    if (this.done || this.aborted || this.terminating) {
      return
    }

    // Prevent a fallback response if onAborted runs after close() returns.
    this.stopRequestTimeout()
    this.terminating = true
    this.replied = true
    this.res!.close()
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @param {string|ArrayBuffer|Uint8Array|Buffer|null|undefined} body
   * @param {boolean} closeConnection
   */
  #reply(status: number, headers: HeaderInput, body: HttpBody | null | undefined, closeConnection: boolean): void {
    if (this.replied || this.aborted) {
      return
    }

    this.stopRequestTimeout()
    this.replied = true

    const prepared = getPreparedHeaders(headers)

    if (
      !closeConnection &&
      prepared &&
      this.#pendingHeaders.size === 0 &&
      this.res &&
      this.#preparedHeaderReplies?.send(this.res, this.getStatus(status), prepared, body ?? undefined)
    ) {
      return
    }

    if (
      !closeConnection &&
      this.#responseBatch &&
      prepared &&
      this.#pendingHeaders.size === 0 &&
      typeof this.res?.endBatch === 'function'
    ) {
      this.res.endBatch(this.getStatus(status), [...prepared.lines], body ?? undefined)

      return
    }

    this.res!.cork(() => {
      if (this.aborted) {
        return
      }

      this.res!.writeStatus(this.getStatus(status))
      this.#flushPendingHeaders(headers, prepared)

      if (body != null) {
        if (closeConnection) {
          this.res!.end(body, true)
        } else {
          this.res!.end(body)
        }
      } else if (closeConnection) {
        this.res!.end(undefined, true)
      } else {
        this.res!.end()
      }
    })
  }

  /**
   * @param {number} status
   * @param {Record<string, string | string[]>} headers
   * @returns {HttpContext}
   */
  startStreaming(status = 200, headers: HeaderInput = null): this {
    if (this.replied || this.aborted) {
      return this
    }

    this.stopRequestTimeout()
    this.replied = true
    this.streaming = true

    this.#resStreamer.begin(status, headers as Record<string, string | string[]> | null)

    return this
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array|Buffer} chunk
   * @returns {boolean}
   */
  write(chunk: HttpBody): boolean {
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
  tryEnd(chunk: HttpBody, totalSize: number): [boolean, boolean] {
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
  end(chunk?: HttpBody): void {
    if (this.aborted) {
      return
    }

    if (!this.streaming) {
      throw new Error('Must call startStreaming() before end()')
    }

    this.#resStreamer.end(chunk)
  }

  onWritable(callback: (offset: number) => void): void {
    if (this.aborted) {
      return
    }

    this.#resStreamer.onWritable(callback)
  }

  getWriteOffset(): number {
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
  stream(readable: Readable, status = 200, headers: HeaderInput = null): Promise<void> {
    if (this.replied || this.aborted) {
      return Promise.resolve()
    }

    this.stopRequestTimeout()
    this.replied = true
    this.streaming = true

    return this.#resStreamer.stream(readable, status, headers as Record<string, string | string[]> | null)
  }
}
