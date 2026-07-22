const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'del', 'patch', 'options', 'head', 'any'])

export const NOOP = () => {}
export const ALLOW_WS_UPGRADE = () => ({})

/** @typedef {import('../ws-context.js').default} WSCtx */
/** @typedef {import('../http-context.js').default} HttpCtx */

const DEFAULT_MAX_BODY_SIZE_MB = 1
const DEFAULT_MAX_BODY_BUDGET_MB = 0
const DEFAULT_REQUEST_TIMEOUT_MS = 0

/**
 * @typedef {object} WSOptions
 * @property {number} [maxBodySize]
 * @property {number} [idleTimeoutSec]
 * @property {number} [upgradeTimeoutMs]
 * @property {(ctx: WSCtx) => unknown} [onOpen]
 * @property {(ctx: WSCtx) => unknown} [onDrain]
 * @property {(ctx: WSCtx, msg: ArrayBuffer, isBinary: boolean) => unknown} [onDropped]
 * @property {(meta: object) => (object|null|Promise<object|null>)} [onUpgrade]
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
 * @param {string} namespace
 * @returns {number}
 */
function normalizeMaxBodySize(value, namespace) {
  const maxBodySize = value ?? DEFAULT_MAX_BODY_SIZE_MB

  if (!(Number.isFinite(maxBodySize) && maxBodySize >= 1 && maxBodySize <= 64)) {
    throw new TypeError(`${namespace}.maxBodySize must be in range 1 - 64`)
  }

  return maxBodySize
}

/**
 * @param {unknown} value
 * @param {number} maxBodySize
 * @returns {number}
 */
function normalizeMaxBodyBudget(value, maxBodySize) {
  const maxBodyBudget = value ?? DEFAULT_MAX_BODY_BUDGET_MB

  if (
    maxBodyBudget !== 0 &&
    !(
      Number.isFinite(maxBodyBudget) &&
      maxBodyBudget >= maxBodySize &&
      Number.isSafeInteger(Math.floor(maxBodyBudget * 1024 * 1024))
    )
  ) {
    throw new TypeError(`http.maxBodyBudget must be 0 or a safe finite number >= ${maxBodySize}`)
  }

  return maxBodyBudget
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
 *    maxBodySize: number, maxBodyBudget: number, requestTimeoutMs: number, prefetch: boolean
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

  const maxBodySize = normalizeMaxBodySize(http.maxBodySize, 'http')

  return {
    onRequest: http.onRequest ?? null,
    routes: http.routes ?? null,
    onError: http.onError ?? NOOP,
    prefetch: normalizePrefetch(http.prefetch),
    maxBodySize,
    maxBodyBudget: normalizeMaxBodyBudget(http.maxBodyBudget, maxBodySize),
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

  if (
    ws.upgradeTimeoutMs != null &&
    !(Number.isFinite(ws.upgradeTimeoutMs) && ws.upgradeTimeoutMs >= 100 && ws.upgradeTimeoutMs <= 300_000)
  ) {
    throw new TypeError('ws.upgradeTimeoutMs must be in range 100 - 300000')
  }

  const idleTimeout = ws.idleTimeoutSec ?? 15

  if (!(Number.isFinite(idleTimeout) && idleTimeout >= 5)) {
    throw new TypeError('ws.idleTimeoutSec must be >= 5')
  }

  return {
    ...ws,
    maxBodySize: normalizeMaxBodySize(ws.maxBodySize, 'ws')
  }
}
