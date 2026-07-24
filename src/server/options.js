const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'del', 'patch', 'options', 'head', 'any'])

export const NOOP = () => {}

/** @typedef {import('../ws-context.js').default} WSCtx */
/** @typedef {import('../http-context.js').default} HttpCtx */

export const DEFAULT_HTTP_MAX_BODY_SIZE_BYTES = 1024 * 1024
export const MAX_HTTP_BODY_SIZE_BYTES = 64 * 1024 * 1024
export const DEFAULT_HTTP_BODY_BUDGET_BYTES = 256 * 1024 * 1024
export const DEFAULT_WS_MAX_PAYLOAD_LENGTH_BYTES = 1024 * 1024
export const DEFAULT_WS_MAX_BACKPRESSURE_BYTES = 64 * 1024
const MAX_UWS_UNSIGNED_SIZE = 0xffff_ffff
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_WS_UPGRADE_TIMEOUT_MS = 10_000

/**
 * @typedef {object} WSOptions
 * @property {number} [maxPayloadLength]
 * @property {number} [maxBackpressure]
 * @property {boolean} [closeOnBackpressureLimit]
 * @property {number} [idleTimeoutSec]
 * @property {number} [upgradeTimeoutMs]
 * @property {(ctx: WSCtx) => unknown} [onOpen]
 * @property {(ctx: WSCtx) => unknown} [onDrain]
 * @property {(ctx: WSCtx, msg: ArrayBuffer, isBinary: boolean) => unknown} [onDropped]
 * @property {(meta: object) => (object|null|Promise<object|null>)} onUpgrade
 * @property {(requested: string[], userData: object) => (string|undefined)} [selectProtocol]
 * @property {(ctx: WSCtx|null, err: Error) => unknown} [onError]
 * @property {(ctx: WSCtx, code: number, reason: ArrayBuffer) => unknown} [onClose]
 * @property {(ctx: WSCtx, msg: ArrayBuffer, isBinary: boolean) => unknown} [onMessage]
 * @property {(ctx: WSCtx, topic: ArrayBuffer, newCount: number, oldCount: number) => unknown} [onSubscription]
 * @property {(ctx: WSCtx) => (string|number|null|undefined)} [connectionKey]
 */

/**
 * @typedef {object} Route
 * @property {'get'|'post'|'put'|'delete'|'del'|'patch'|'options'|'head'|'any'} method
 * @property {string} path
 * @property {(ctx: HttpCtx) => unknown|Promise<unknown>} handler
 * @property {((ctx: HttpCtx) => unknown|Promise<unknown>)|((ctx: HttpCtx) => unknown|Promise<unknown>)[]} [before]
 * @property {boolean} [prefetch]
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is object}
 */
function assertOptionsObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object or null`)
  }
}

/**
 * @param {object} options
 * @param {string[]} names
 * @param {string} namespace
 */
function validateCallbacks(options, names, namespace) {
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
export function validateBodyByteLimit(value, name = 'maxSize') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_HTTP_BODY_SIZE_BYTES) {
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
function normalizeMaxBodyBudget(value) {
  if (value === undefined) {
    return DEFAULT_HTTP_BODY_BUDGET_BYTES
  }

  // `null` is the only explicit unlimited sentinel. In particular, zero is a
  // real zero-byte budget and can never become unlimited through truthiness.
  if (value === null) {
    return null
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('http.maxBodyBudget must be specified in bytes as a non-negative safe integer or null')
  }

  return value
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeRequestTimeout(value) {
  const requestTimeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (
    requestTimeoutMs !== 0 &&
    !(Number.isFinite(requestTimeoutMs) && requestTimeoutMs >= 100 && requestTimeoutMs <= 300_000)
  ) {
    throw new TypeError('http.requestTimeoutMs must be 0 or in range 100 - 300000')
  }

  return requestTimeoutMs
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @param {number} maximum
 * @returns {number}
 */
function normalizeWsByteCount(value, name, fallback, maximum = MAX_UWS_UNSIGNED_SIZE) {
  const bytes = value === undefined ? fallback : value

  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) {
    throw new TypeError(`${name} must be specified in bytes as a non-negative safe integer no greater than ${maximum}`)
  }

  return bytes
}

/**
 * @param {Route} route
 * @param {number} index
 */
function validateRoute(route, index) {
  if (typeof route !== 'object' || route === null || Array.isArray(route)) {
    throw new TypeError(`http.routes[${index}] must be an object`)
  }

  if (Object.hasOwn(route, 'preHandler')) {
    throw new TypeError(`http.routes[${index}].preHandler is no longer supported; use before`)
  }

  const { method, path, handler, before, prefetch } = route

  if (!HTTP_METHODS.has(method)) {
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
function normalizePrefetch(value) {
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
 *    maxBodySize: number, maxBodyBudget: number|null, requestTimeoutMs: number, prefetch: boolean
 *  }|null}
 */
export function normalizeHttpOptions(http) {
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

  http.routes?.forEach(validateRoute)

  const prefetch = normalizePrefetch(http.prefetch)
  const maxBodySize = validateBodyByteLimit(
    http.maxBodySize === undefined ? DEFAULT_HTTP_MAX_BODY_SIZE_BYTES : http.maxBodySize,
    'http.maxBodySize'
  )

  return {
    onRequest: http.onRequest ?? null,
    routes: http.routes ?? null,
    onError: http.onError ?? NOOP,
    prefetch,
    maxBodySize,
    maxBodyBudget: normalizeMaxBodyBudget(http.maxBodyBudget),
    requestTimeoutMs: normalizeRequestTimeout(http.requestTimeoutMs)
  }
}

/**
 * @param {unknown} ws
 * @returns {WSOptions|null}
 */
export function normalizeWsOptions(ws) {
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

  if (!Number.isSafeInteger(upgradeTimeoutMs) || upgradeTimeoutMs < 0 || upgradeTimeoutMs > 300_000) {
    throw new TypeError('ws.upgradeTimeoutMs must be a safe integer in milliseconds in range 0 - 300000')
  }

  const idleTimeout = ws.idleTimeoutSec ?? 15

  if (!(Number.isFinite(idleTimeout) && idleTimeout >= 5)) {
    throw new TypeError('ws.idleTimeoutSec must be >= 5')
  }

  const closeOnBackpressureLimit = ws.closeOnBackpressureLimit ?? true

  if (typeof closeOnBackpressureLimit !== 'boolean') {
    throw new TypeError('ws.closeOnBackpressureLimit must be a boolean')
  }

  return {
    ...ws,
    maxPayloadLength: normalizeWsByteCount(
      ws.maxPayloadLength,
      'ws.maxPayloadLength',
      DEFAULT_WS_MAX_PAYLOAD_LENGTH_BYTES,
      MAX_HTTP_BODY_SIZE_BYTES
    ),
    maxBackpressure: normalizeWsByteCount(ws.maxBackpressure, 'ws.maxBackpressure', DEFAULT_WS_MAX_BACKPRESSURE_BYTES),
    closeOnBackpressureLimit,
    upgradeTimeoutMs
  }
}
