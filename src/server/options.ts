import type HttpContext from '../http/context.js'
import type WSContext from '../ws/context.js'
import type WebSocketUpgradeMeta from '../ws/upgrade-meta.js'

export type HeaderPrefetch = false | 'all' | readonly string[]
export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'del' | 'patch' | 'options' | 'head' | 'any'
export type Handler = (ctx: HttpContext) => unknown | Promise<unknown>

export interface HttpErrorEvent {
  readonly timestamp: number
  readonly method: string
  readonly url: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
  readonly ip?: string
}

export interface HttpErrorDeliveryContext {
  readonly signal: AbortSignal
}

export interface HttpErrorDeliveryStats {
  readonly inFlight: number
  readonly queued: number
  readonly completed: number
  readonly timedOut: number
  readonly aborted: number
  readonly rejected: number
  readonly dropped: number
  readonly oldestInFlightMs: number | null
}

export interface HttpErrorDeliveryOptions {
  concurrency?: number
  queueLimit?: number
  timeoutMs?: number
  headers?: readonly string[]
  query?: readonly string[]
  includeIp?: boolean
}

export type HttpErrorHandler = (
  event: HttpErrorEvent,
  error: Error,
  context: HttpErrorDeliveryContext
) => unknown | Promise<unknown>

export interface HttpTransportOptions {
  maxHeaderSize?: number
  maxHeaderCount?: number
  headersTimeoutMs?: number
  keepAliveTimeoutMs?: number
  bodyIdleTimeoutMs?: number
  minBodyRateBytesPerSec?: number | null
  responseWriteTimeoutMs?: number
}

export interface Route {
  method: HttpMethod
  path: string
  handler: Handler
  before?: Handler | Handler[]
  prefetch?: boolean
  prefetchHeaders?: HeaderPrefetch
  maxBodySize?: number
}

export interface HttpBaseOptions {
  prefetch?: boolean
  prefetchHeaders?: HeaderPrefetch
  maxBodySize?: number
  maxBodyBudget?: number | null
  requestTimeoutMs?: number
  onError?: HttpErrorHandler
  errorDelivery?: HttpErrorDeliveryOptions
}

export type HttpOptions = HttpBaseOptions &
  (
    | { onRequest: Handler; routes?: never }
    | { routes: Route[]; onRequest?: never }
    | { onRequest?: never; routes?: never }
  )

export interface WSOptions {
  maxPayloadLength?: number
  maxBackpressure?: number
  closeOnBackpressureLimit?: boolean
  idleTimeoutSec?: number
  upgradeTimeoutMs?: number
  prefetchHeaders?: HeaderPrefetch
  onOpen?: (ctx: WSContext) => unknown
  onDrain?: (ctx: WSContext) => unknown
  onDropped?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => unknown
  onUpgrade: (meta: WebSocketUpgradeMeta) => object | null | Promise<object | null>
  selectProtocol?: (requested: readonly string[], userData: object) => string | undefined
  onError?: (ctx: WSContext | null, error: Error) => unknown
  onClose?: (ctx: WSContext, code: number, reason: ArrayBuffer) => unknown
  onMessage?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => unknown
  onSubscription?: (ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number) => unknown
  connectionKey?: (ctx: WSContext) => string | number | null | undefined
}

export interface CommonServerOptions {
  onServerError?: (error: Error) => unknown | Promise<unknown>
  host?: string
  port?: number
  transport?: HttpTransportOptions
}

type RemovedServerOptions = {
  backend?: never
  maxBodySize?: never
  onHttpError?: never
  prefetch?: never
  router?: never
  routes?: never
}

export type ServerOptions = CommonServerOptions &
  RemovedServerOptions &
  ({ http: HttpOptions; ws?: WSOptions | null } | { http?: HttpOptions | null; ws: WSOptions })

export interface NormalizedHttpOptions {
  onRequest: Handler | null
  routes: NormalizedRoute[] | null
  onError: HttpErrorHandler | null
  errorDelivery: NormalizedHttpErrorDeliveryOptions | null
  maxBodySize: number
  maxBodyBudget: number | null
  requestTimeoutMs: number
  prefetch: boolean
  prefetchHeaders: HeaderPrefetch
}

export interface NormalizedHttpErrorDeliveryOptions {
  concurrency: number
  queueLimit: number
  timeoutMs: number
  headers: readonly string[]
  query: readonly string[]
  includeIp: boolean
}

type NormalizedRoute = Route

export type NormalizedWSOptions = WSOptions & {
  maxPayloadLength: number
  maxBackpressure: number
  closeOnBackpressureLimit: boolean
  upgradeTimeoutMs: number
  prefetchHeaders: HeaderPrefetch
}

type OptionsRecord = Record<string, unknown>

const HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'del',
  'patch',
  'options',
  'head',
  'any'
])
const HTTP_CALLBACK_NAMES = ['onRequest', 'onError']
const HTTP_TRANSPORT_TIMEOUT_NAMES = [
  'headersTimeoutMs',
  'keepAliveTimeoutMs',
  'bodyIdleTimeoutMs',
  'responseWriteTimeoutMs'
]
const WS_CALLBACK_NAMES = [
  'onOpen',
  'onDrain',
  'onDropped',
  'onUpgrade',
  'selectProtocol',
  'onError',
  'onClose',
  'onMessage',
  'onSubscription',
  'connectionKey'
]

export const NOOP = () => {}

export const DEFAULT_HTTP_MAX_BODY_SIZE_BYTES = 1024 * 1024
export const MAX_HTTP_BODY_SIZE_BYTES = 64 * 1024 * 1024
export const DEFAULT_HTTP_BODY_BUDGET_BYTES = 256 * 1024 * 1024
export const DEFAULT_WS_MAX_PAYLOAD_LENGTH_BYTES = 1024 * 1024
export const DEFAULT_WS_MAX_BACKPRESSURE_BYTES = 64 * 1024
const MAX_UWS_UNSIGNED_SIZE = 0xffff_ffff
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_WS_UPGRADE_TIMEOUT_MS = 10_000
const MAX_HTTP_HEADER_COUNT = 100
const MAX_UWS_TIMEOUT_MS = 300_000
const DEFAULT_HTTP_ERROR_DELIVERY_CONCURRENCY = 4
const DEFAULT_HTTP_ERROR_DELIVERY_QUEUE_LIMIT = 256
const DEFAULT_HTTP_ERROR_DELIVERY_TIMEOUT_MS = 5_000
const MAX_HTTP_ERROR_DELIVERY_CONCURRENCY = 1_024
const MAX_HTTP_ERROR_DELIVERY_QUEUE_LIMIT = 65_536
const MAX_HTTP_ERROR_DELIVERY_HEADERS = 100
const MAX_HTTP_ERROR_DELIVERY_QUERY_NAMES = 100
const MAX_HTTP_ERROR_DELIVERY_QUERY_NAME_LENGTH = 256
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HTTP_ERROR_DELIVERY_FIELDS = new Set(['concurrency', 'queueLimit', 'timeoutMs', 'headers', 'query', 'includeIp'])
const HTTP_TRANSPORT_FIELDS = new Set([
  'maxHeaderSize',
  'maxHeaderCount',
  'headersTimeoutMs',
  'keepAliveTimeoutMs',
  'bodyIdleTimeoutMs',
  'minBodyRateBytesPerSec',
  'responseWriteTimeoutMs'
])

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is object}
 */
function assertOptionsObject(value: unknown, name: string): asserts value is OptionsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object or null`)
  }
}

/**
 * @param {object} options
 * @param {string[]} names
 * @param {string} namespace
 */
function validateCallbacks(options: OptionsRecord, names: readonly string[], namespace: string): void {
  for (const name of names) {
    if (options[name] !== undefined && typeof options[name] !== 'function') {
      throw new TypeError(`${namespace}.${name} must be a function`)
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {number}
 */
export function validateBodyByteLimit(value: unknown, name = 'maxSize'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_HTTP_BODY_SIZE_BYTES) {
    throw new TypeError(
      `${name} must be specified in bytes as a non-negative safe integer no greater than ${MAX_HTTP_BODY_SIZE_BYTES}`
    )
  }

  return value
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeMaxBodyBudget(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_HTTP_BODY_BUDGET_BYTES
  }

  // `null` is the only explicit unlimited sentinel. In particular, zero is a
  // real zero-byte budget and can never become unlimited through truthiness.
  if (value === null) {
    return null
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('http.maxBodyBudget must be specified in bytes as a non-negative safe integer or null')
  }

  return value
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeRequestTimeout(value: unknown): number {
  const requestTimeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (
    typeof requestTimeoutMs !== 'number' ||
    (requestTimeoutMs !== 0 &&
      !(Number.isFinite(requestTimeoutMs) && requestTimeoutMs >= 100 && requestTimeoutMs <= 300_000))
  ) {
    throw new TypeError('http.requestTimeoutMs must be 0 or in range 100 - 300000')
  }

  return requestTimeoutMs
}

/**
 * Normalize an opt-in request-header retention policy. Omitted and `false`
 * @param {unknown} value
 * @param {string} [name]
 * @returns {false|'all'|readonly string[]}
 */
export function normalizePrefetchHeaders(value: unknown, name = 'http.prefetchHeaders'): HeaderPrefetch {
  if (value === undefined) {
    return false
  }

  if (value === false || value === 'all') {
    return value
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be false, "all", or an array of header names`)
  }

  const names: string[] = []
  const seen = new Set<string>()

  for (let i = 0; i < value.length; i++) {
    const entry = value[i]

    if (typeof entry !== 'string' || !HTTP_HEADER_NAME.test(entry)) {
      throw new TypeError(`${name}[${i}] must be a valid HTTP header name`)
    }

    const headerName = entry.toLowerCase()

    if (!seen.has(headerName)) {
      seen.add(headerName)
      names.push(headerName)
    }
  }

  return names.length === 0 ? false : Object.freeze(names)
}

/** Normalize a case-sensitive query-parameter allowlist for error events. */
function normalizeHttpErrorQuery(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([])
  }

  if (!Array.isArray(value)) {
    throw new TypeError('http.errorDelivery.query must be an array of query parameter names')
  }

  const names: string[] = []
  const seen = new Set<string>()

  for (let i = 0; i < value.length; i++) {
    const name = value[i]

    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_HTTP_ERROR_DELIVERY_QUERY_NAME_LENGTH) {
      throw new TypeError(
        `http.errorDelivery.query[${i}] must be a non-empty string no longer than ${MAX_HTTP_ERROR_DELIVERY_QUERY_NAME_LENGTH} characters`
      )
    }

    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }

  if (names.length > MAX_HTTP_ERROR_DELIVERY_QUERY_NAMES) {
    throw new TypeError(
      `http.errorDelivery.query cannot contain more than ${MAX_HTTP_ERROR_DELIVERY_QUERY_NAMES} names`
    )
  }

  return Object.freeze(names)
}

/**
 * Normalize bounded asynchronous observability delivery. Header capture is an
 * explicit allowlist; request bodies are never part of an error event.
 */
function normalizeHttpErrorDelivery(value: unknown): Readonly<NormalizedHttpErrorDeliveryOptions> {
  if (value === undefined) {
    return Object.freeze({
      concurrency: DEFAULT_HTTP_ERROR_DELIVERY_CONCURRENCY,
      queueLimit: DEFAULT_HTTP_ERROR_DELIVERY_QUEUE_LIMIT,
      timeoutMs: DEFAULT_HTTP_ERROR_DELIVERY_TIMEOUT_MS,
      headers: Object.freeze([]),
      query: Object.freeze([]),
      includeIp: false
    })
  }

  assertOptionsObject(value, 'http.errorDelivery')

  for (const name of Object.keys(value)) {
    if (!HTTP_ERROR_DELIVERY_FIELDS.has(name)) {
      throw new TypeError(`Unknown http.errorDelivery option: ${name}`)
    }
  }

  const concurrency = value.concurrency ?? DEFAULT_HTTP_ERROR_DELIVERY_CONCURRENCY
  const queueLimit = value.queueLimit ?? DEFAULT_HTTP_ERROR_DELIVERY_QUEUE_LIMIT
  const timeoutMs = value.timeoutMs ?? DEFAULT_HTTP_ERROR_DELIVERY_TIMEOUT_MS
  const query = normalizeHttpErrorQuery(value.query)
  const includeIp = value.includeIp ?? false

  if (
    typeof concurrency !== 'number' ||
    !Number.isSafeInteger(concurrency) ||
    concurrency <= 0 ||
    concurrency > MAX_HTTP_ERROR_DELIVERY_CONCURRENCY
  ) {
    throw new TypeError(
      `http.errorDelivery.concurrency must be a positive safe integer no greater than ${MAX_HTTP_ERROR_DELIVERY_CONCURRENCY}`
    )
  }

  if (
    typeof queueLimit !== 'number' ||
    !Number.isSafeInteger(queueLimit) ||
    queueLimit < 0 ||
    queueLimit > MAX_HTTP_ERROR_DELIVERY_QUEUE_LIMIT
  ) {
    throw new TypeError(
      `http.errorDelivery.queueLimit must be a non-negative safe integer no greater than ${MAX_HTTP_ERROR_DELIVERY_QUEUE_LIMIT}`
    )
  }

  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > MAX_UWS_TIMEOUT_MS
  ) {
    throw new TypeError('http.errorDelivery.timeoutMs must be a safe integer in range 100 - 300000')
  }

  if (typeof includeIp !== 'boolean') {
    throw new TypeError('http.errorDelivery.includeIp must be a boolean')
  }

  if (value.headers !== undefined && !Array.isArray(value.headers)) {
    throw new TypeError('http.errorDelivery.headers must be an array of header names')
  }

  const headers = normalizePrefetchHeaders(value.headers, 'http.errorDelivery.headers')

  if (headers === 'all') {
    throw new TypeError('http.errorDelivery.headers must be an array of header names')
  }

  if (Array.isArray(headers) && headers.length > MAX_HTTP_ERROR_DELIVERY_HEADERS) {
    throw new TypeError(`http.errorDelivery.headers cannot contain more than ${MAX_HTTP_ERROR_DELIVERY_HEADERS} names`)
  }

  return Object.freeze({
    concurrency,
    queueLimit,
    timeoutMs,
    headers: headers === false ? Object.freeze([]) : headers,
    query,
    includeIp
  })
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} [maximum]
 * @returns {number}
 */
function normalizePositiveTransportInteger(value: unknown, name: string, maximum = MAX_UWS_UNSIGNED_SIZE): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`)
  }

  return value
}

/**
 * Validate the optional native HTTP transport policy without filling binding-
 * owned defaults. An omitted policy therefore remains compatible with older
 * bindings and keeps their current effective defaults.
 * @param {unknown} transport
 * @returns {Readonly<HttpTransportOptions>|null}
 */
export function normalizeTransportOptions(transport: unknown): Readonly<HttpTransportOptions> | null {
  if (transport === undefined || transport === null) {
    return null
  }

  assertOptionsObject(transport, 'transport')

  for (const name of Object.keys(transport)) {
    if (!HTTP_TRANSPORT_FIELDS.has(name)) {
      throw new TypeError(`Unknown transport option: ${name}`)
    }
  }

  const normalized: Record<string, number | null> = {}

  if (transport.maxHeaderSize !== undefined) {
    normalized.maxHeaderSize = normalizePositiveTransportInteger(transport.maxHeaderSize, 'transport.maxHeaderSize')
  }

  if (transport.maxHeaderCount !== undefined) {
    normalized.maxHeaderCount = normalizePositiveTransportInteger(
      transport.maxHeaderCount,
      'transport.maxHeaderCount',
      MAX_HTTP_HEADER_COUNT
    )
  }

  for (const name of HTTP_TRANSPORT_TIMEOUT_NAMES) {
    if (transport[name] !== undefined) {
      normalized[name] = normalizePositiveTransportInteger(transport[name], `transport.${name}`, MAX_UWS_TIMEOUT_MS)
    }
  }

  if (transport.minBodyRateBytesPerSec !== undefined) {
    normalized.minBodyRateBytesPerSec =
      transport.minBodyRateBytesPerSec === null
        ? null
        : normalizePositiveTransportInteger(transport.minBodyRateBytesPerSec, 'transport.minBodyRateBytesPerSec')
  }

  return Object.keys(normalized).length === 0 ? null : Object.freeze(normalized)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @param {number} maximum
 * @returns {number}
 */
function normalizeWsByteCount(value: unknown, name: string, fallback: number, maximum = MAX_UWS_UNSIGNED_SIZE): number {
  const bytes = value === undefined ? fallback : value

  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) {
    throw new TypeError(`${name} must be specified in bytes as a non-negative safe integer no greater than ${maximum}`)
  }

  return bytes
}

/**
 * @param {Route} route
 * @param {number} index
 */
function normalizeRoute(route: unknown, index: number): NormalizedRoute {
  if (typeof route !== 'object' || route === null || Array.isArray(route)) {
    throw new TypeError(`http.routes[${index}] must be an object`)
  }

  assertOptionsObject(route, `http.routes[${index}]`)

  if (Object.hasOwn(route, 'preHandler')) {
    throw new TypeError(`http.routes[${index}].preHandler is no longer supported; use before`)
  }

  const { method, path, handler, before, prefetch } = route
  const typedRoute = route as unknown as Route

  if (typeof method !== 'string' || !HTTP_METHODS.has(method as HttpMethod)) {
    throw new TypeError(`Invalid HTTP method: ${method}`)
  }

  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`Invalid Path in route, method: ${method}, path: ${path}`)
  }

  if (typeof handler !== 'function') {
    throw new TypeError(`http.routes[${index}].handler must be a function`)
  }

  if (prefetch !== undefined && typeof prefetch !== 'boolean') {
    throw new TypeError(`http.routes[${index}].prefetch must be a boolean`)
  }

  const hasPrefetchHeaders = Object.hasOwn(route, 'prefetchHeaders')
  const prefetchHeaders = normalizePrefetchHeaders(route.prefetchHeaders, `http.routes[${index}].prefetchHeaders`)

  if (route.maxBodySize !== undefined) {
    validateBodyByteLimit(route.maxBodySize, `http.routes[${index}].maxBodySize`)
  }

  if (before === undefined) {
    return hasPrefetchHeaders ? { ...typedRoute, prefetchHeaders } : typedRoute
  }

  if (typeof before !== 'function' && (!Array.isArray(before) || before.some((item) => typeof item !== 'function'))) {
    throw new TypeError('Route before must be a function or an array of functions')
  }

  return hasPrefetchHeaders ? { ...typedRoute, prefetchHeaders } : typedRoute
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function normalizePrefetch(value: unknown): boolean {
  const prefetch = value ?? false

  if (typeof prefetch !== 'boolean') {
    throw new TypeError('http.prefetch must be a boolean')
  }

  return prefetch
}

/**
 * @param {unknown} http
 * @returns {
 *  {
 *    onRequest: ((ctx: HttpCtx) => unknown|Promise<unknown>)|null,
 *    routes: Route[]|null, onError: HttpErrorHandler|null,
 *    errorDelivery: NormalizedHttpErrorDeliveryOptions|null,
 *    maxBodySize: number, maxBodyBudget: number|null, requestTimeoutMs: number, prefetch: boolean,
 *    prefetchHeaders: false|'all'|readonly string[]
 *  }|null}
 */
export function normalizeHttpOptions(http: unknown): NormalizedHttpOptions | null {
  if (http == null) {
    return null
  }

  assertOptionsObject(http, 'http')
  validateCallbacks(http, HTTP_CALLBACK_NAMES, 'http')

  if (http.errorDelivery !== undefined && http.onError === undefined) {
    throw new TypeError('http.errorDelivery requires http.onError')
  }

  if (http.onRequest !== undefined && http.routes !== undefined) {
    throw new TypeError('Cannot use both "http.onRequest" and "http.routes" options. Choose one.')
  }

  if (http.routes !== undefined && !Array.isArray(http.routes)) {
    throw new TypeError('http.routes must be an array')
  }

  const routes = Array.isArray(http.routes) ? http.routes.map(normalizeRoute) : null
  const prefetch = normalizePrefetch(http.prefetch)
  const maxBodySize = validateBodyByteLimit(
    http.maxBodySize === undefined ? DEFAULT_HTTP_MAX_BODY_SIZE_BYTES : http.maxBodySize,
    'http.maxBodySize'
  )

  for (let i = 0; i < (routes?.length ?? 0); i++) {
    const routeMaxBodySize = routes?.[i]?.maxBodySize

    if (routeMaxBodySize !== undefined && routeMaxBodySize > maxBodySize) {
      throw new TypeError(`http.routes[${i}].maxBodySize cannot exceed http.maxBodySize (${maxBodySize})`)
    }
  }

  const onError = (http.onError as HttpErrorHandler | undefined) ?? null

  return {
    onRequest: (http.onRequest as Handler | undefined) ?? null,
    routes,
    onError,
    errorDelivery: onError ? normalizeHttpErrorDelivery(http.errorDelivery) : null,
    prefetch,
    prefetchHeaders: normalizePrefetchHeaders(http.prefetchHeaders),
    maxBodySize,
    maxBodyBudget: normalizeMaxBodyBudget(http.maxBodyBudget),
    requestTimeoutMs: normalizeRequestTimeout(http.requestTimeoutMs)
  }
}

/**
 * @param {unknown} ws
 * @returns {WSOptions|null}
 */
export function normalizeWsOptions(ws: unknown): NormalizedWSOptions | null {
  if (ws == null) {
    return null
  }

  assertOptionsObject(ws, 'ws')

  if (Object.hasOwn(ws, 'enabled')) {
    throw new TypeError('ws.enabled is no longer supported; use ws: null to disable WebSocket')
  }

  if (Object.hasOwn(ws, 'wsIdleTimeoutSec') || Object.hasOwn(ws, 'wsUpgradeTimeoutMs')) {
    throw new TypeError(
      'Legacy WebSocket timeout options are no longer supported; use ws.idleTimeoutSec and ws.upgradeTimeoutMs'
    )
  }

  if (Object.hasOwn(ws, 'maxBodySize')) {
    throw new TypeError('ws.maxBodySize is no longer supported; use ws.maxPayloadLength in bytes')
  }

  validateCallbacks(ws, WS_CALLBACK_NAMES, 'ws')

  if (ws.onUpgrade === undefined) {
    throw new TypeError('ws.onUpgrade is required; explicitly authorize or reject every WebSocket upgrade')
  }

  const upgradeTimeoutMs = ws.upgradeTimeoutMs === undefined ? DEFAULT_WS_UPGRADE_TIMEOUT_MS : ws.upgradeTimeoutMs

  if (
    typeof upgradeTimeoutMs !== 'number' ||
    !Number.isSafeInteger(upgradeTimeoutMs) ||
    upgradeTimeoutMs < 0 ||
    upgradeTimeoutMs > 300_000
  ) {
    throw new TypeError('ws.upgradeTimeoutMs must be a safe integer in milliseconds in range 0 - 300000')
  }

  const idleTimeout = ws.idleTimeoutSec ?? 15

  if (typeof idleTimeout !== 'number' || !Number.isSafeInteger(idleTimeout) || idleTimeout < 8 || idleTimeout > 960) {
    throw new TypeError('ws.idleTimeoutSec must be a safe integer in range 8 - 960')
  }

  const closeOnBackpressureLimit = ws.closeOnBackpressureLimit ?? true

  if (typeof closeOnBackpressureLimit !== 'boolean') {
    throw new TypeError('ws.closeOnBackpressureLimit must be a boolean')
  }

  const maxPayloadLength = normalizeWsByteCount(
    ws.maxPayloadLength,
    'ws.maxPayloadLength',
    DEFAULT_WS_MAX_PAYLOAD_LENGTH_BYTES,
    MAX_HTTP_BODY_SIZE_BYTES
  )

  if (maxPayloadLength === 0) {
    throw new TypeError('ws.maxPayloadLength must be at least 1 byte')
  }

  return {
    ...ws,
    prefetchHeaders: normalizePrefetchHeaders(ws.prefetchHeaders, 'ws.prefetchHeaders'),
    maxPayloadLength,
    maxBackpressure: normalizeWsByteCount(ws.maxBackpressure, 'ws.maxBackpressure', DEFAULT_WS_MAX_BACKPRESSURE_BYTES),
    closeOnBackpressureLimit,
    upgradeTimeoutMs
  } as NormalizedWSOptions
}
