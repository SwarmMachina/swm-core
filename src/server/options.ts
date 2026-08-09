import type HttpContext from '../http-context.js'
import type WSContext from '../ws-context.js'
import type WebSocketUpgradeMeta from './ws-upgrade-meta.js'

export type HeaderPrefetch = false | 'all' | readonly string[]
export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'del' | 'patch' | 'options' | 'head' | 'any'
export type Handler = (ctx: HttpContext) => unknown | Promise<unknown>

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
  onError?: (ctx: HttpContext, error: Error) => unknown | Promise<unknown>
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
  routes: Route[] | null
  onError: (ctx: HttpContext, error: Error) => unknown | Promise<unknown>
  maxBodySize: number
  maxBodyBudget: number | null
  requestTimeoutMs: number
  prefetch: boolean
  prefetchHeaders: HeaderPrefetch
}

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
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
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
 * both keep headers lazy and avoid native header retention.
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

  for (const name of ['headersTimeoutMs', 'keepAliveTimeoutMs', 'bodyIdleTimeoutMs', 'responseWriteTimeoutMs']) {
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
function validateRoute(route: unknown, index: number): void {
  if (typeof route !== 'object' || route === null || Array.isArray(route)) {
    throw new TypeError(`http.routes[${index}] must be an object`)
  }

  assertOptionsObject(route, `http.routes[${index}]`)

  if (Object.hasOwn(route, 'preHandler')) {
    throw new TypeError(`http.routes[${index}].preHandler is no longer supported; use before`)
  }

  const { method, path, handler, before, prefetch } = route

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

  normalizePrefetchHeaders(route.prefetchHeaders, `http.routes[${index}].prefetchHeaders`)

  if (route.maxBodySize !== undefined) {
    validateBodyByteLimit(route.maxBodySize, `http.routes[${index}].maxBodySize`)
  }

  if (before === undefined) {
    return
  }

  const chain = Array.isArray(before) ? before : [before]

  if (chain.some((item) => typeof item !== 'function')) {
    throw new TypeError('Route before must be a function or an array of functions')
  }
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
 *    routes: Route[]|null, onError: (ctx: HttpCtx, err: Error) => unknown|Promise<unknown>,
 *    maxBodySize: number, maxBodyBudget: number|null, requestTimeoutMs: number, prefetch: boolean,
 *    prefetchHeaders: false|'all'|readonly string[]
 *  }|null}
 */
export function normalizeHttpOptions(http: unknown): NormalizedHttpOptions | null {
  if (http == null) {
    return null
  }

  assertOptionsObject(http, 'http')
  validateCallbacks(http, ['onRequest', 'onError'], 'http')

  if (http.onRequest !== undefined && http.routes !== undefined) {
    throw new TypeError('Cannot use both "http.onRequest" and "http.routes" options. Choose one.')
  }

  if (http.routes !== undefined && !Array.isArray(http.routes)) {
    throw new TypeError('http.routes must be an array')
  }

  const routes = http.routes

  if (Array.isArray(routes)) {
    routes.forEach(validateRoute)
  }

  const prefetch = normalizePrefetch(http.prefetch)
  const maxBodySize = validateBodyByteLimit(
    http.maxBodySize === undefined ? DEFAULT_HTTP_MAX_BODY_SIZE_BYTES : http.maxBodySize,
    'http.maxBodySize'
  )
  const validatedRoutes = routes as Route[] | undefined

  for (let i = 0; i < (validatedRoutes?.length ?? 0); i++) {
    const routeMaxBodySize = validatedRoutes?.[i]?.maxBodySize

    if (routeMaxBodySize !== undefined && routeMaxBodySize > maxBodySize) {
      throw new TypeError(`http.routes[${i}].maxBodySize cannot exceed http.maxBodySize (${maxBodySize})`)
    }
  }

  return {
    onRequest: (http.onRequest as Handler | undefined) ?? null,
    routes: validatedRoutes ?? null,
    onError: (http.onError as ((ctx: HttpContext, error: Error) => unknown | Promise<unknown>) | undefined) ?? NOOP,
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

  validateCallbacks(
    ws,
    [
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
    ],
    'ws'
  )

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

  if (!(typeof idleTimeout === 'number' && Number.isFinite(idleTimeout) && idleTimeout >= 5)) {
    throw new TypeError('ws.idleTimeoutSec must be >= 5')
  }

  const closeOnBackpressureLimit = ws.closeOnBackpressureLimit ?? true

  if (typeof closeOnBackpressureLimit !== 'boolean') {
    throw new TypeError('ws.closeOnBackpressureLimit must be a boolean')
  }

  return {
    ...ws,
    prefetchHeaders: normalizePrefetchHeaders(ws.prefetchHeaders, 'ws.prefetchHeaders'),
    maxPayloadLength: normalizeWsByteCount(
      ws.maxPayloadLength,
      'ws.maxPayloadLength',
      DEFAULT_WS_MAX_PAYLOAD_LENGTH_BYTES,
      MAX_HTTP_BODY_SIZE_BYTES
    ),
    maxBackpressure: normalizeWsByteCount(ws.maxBackpressure, 'ws.maxBackpressure', DEFAULT_WS_MAX_BACKPRESSURE_BYTES),
    closeOnBackpressureLimit,
    upgradeTimeoutMs
  } as NormalizedWSOptions
}
