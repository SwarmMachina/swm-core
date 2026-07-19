const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'del', 'patch', 'options', 'head', 'any'])

export const NOOP = () => {}
export const ALLOW_WS_UPGRADE = () => Promise.resolve({ isAllowed: true })

/** @typedef {import('../ws-context.js').default} WSCtx */
/** @typedef {import('../http-context.js').default} HttpCtx */

const DEFAULT_MAX_BODY_SIZE_MB = 1

/**
 * @typedef {object} WSOptions
 * @property {number} [maxBodySize]
 * @property {number} [idleTimeoutSec]
 * @property {number} [upgradeTimeoutMs]
 * @property {(ctx: WSCtx) => unknown} [onOpen]
 * @property {(ctx: WSCtx) => unknown} [onDrain]
 * @property {(ctx: WSCtx, msg: ArrayBuffer, isBinary: boolean) => unknown} [onDropped]
 * @property {(meta: object) => ({isAllowed: boolean, userData?: object, protocol?: string}|Promise<{isAllowed: boolean, userData?: object, protocol?: string}>)} [onUpgrade]
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
 * @param {Route} route
 * @param {number} index
 */
function validateRoute(route, index) {
  if (typeof route !== 'object' || route === null || Array.isArray(route)) {
    throw new TypeError(`http.routes[${index}] must be an object`)
  }

  if ('preHandler' in route) {
    throw new TypeError(`http.routes[${index}].preHandler is no longer supported; use before`)
  }

  const { method, path, handler, before } = route

  if (!HTTP_METHODS.has(method)) {
    throw new TypeError(`Invalid HTTP method: ${method}`)
  }

  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`Invalid Path in route, method: ${method}, path: ${path}`)
  }

  if (typeof handler !== 'function') {
    throw new TypeError(`http.routes[${index}].handler must be a function`)
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
 * @param {unknown} http
 * @returns {
 *  {
 *    onRequest: ((ctx: HttpCtx) => unknown|Promise<unknown>)|null,
 *    routes: Route[]|null, onError: (ctx: HttpCtx, err: Error) => unknown|Promise<unknown>,
 *    maxBodySize: number
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

  return {
    onRequest: http.onRequest ?? null,
    routes: http.routes ?? null,
    onError: http.onError ?? NOOP,
    maxBodySize: normalizeMaxBodySize(http.maxBodySize, 'http')
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

  if ('enabled' in ws) {
    throw new TypeError('ws.enabled is no longer supported; use ws: null to disable WebSocket')
  }

  if ('wsIdleTimeoutSec' in ws || 'wsUpgradeTimeoutMs' in ws) {
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
