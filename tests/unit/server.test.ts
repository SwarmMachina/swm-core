// noinspection JSCheckFunctionSignatures

import { afterEach, beforeEach, describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'
import Server from '../../src/index.js'
import {
  createMockHttpRequest,
  createMockHttpResponse,
  createMockWebSocket,
  getCurrentMockApp,
  mockCalls,
  requireCurrentMockApp,
  resetMockApp,
  setListenCallback
} from '../helpers/mock-uws-module.js'
import { STATUS_TEXT } from '../../src/http/status.js'
import type HttpContext from '../../src/http/context.js'
import type { CommonServerOptions, Handler, HttpOptions, Route, WSOptions } from '../../src/server/options.js'
import type WSContext from '../../src/ws/context.js'

// These unit tests exercise the Server against the uWS mock installed by the
// loader hook.
type TestWsOptions = Omit<WSOptions, 'onUpgrade'> & { onUpgrade?: WSOptions['onUpgrade'] }

type TestServerOptions = CommonServerOptions & {
  onRequest?: Handler
  routes?: Route[]
  httpError?: (context: HttpContext, error: Error) => unknown | Promise<unknown>
  http?: HttpOptions | null
  ws?: TestWsOptions | null
} & Record<string, unknown>

function makeServer(options: TestServerOptions): Server
function makeServer(options: Record<string, unknown>): Server
function makeServer({ onRequest, routes, httpError, http, ...opt }: Record<string, unknown> = {}): Server {
  const hasHttpOptions = onRequest !== undefined || routes !== undefined || httpError !== undefined
  // Most tests target behavior unrelated to admission policy. Keep anonymous
  // access explicit in the test fixture while production construction remains
  // fail-fast when onUpgrade is omitted.
  const ws =
    opt.ws && typeof opt.ws === 'object' && !Array.isArray(opt.ws) ? { onUpgrade: () => ({}), ...opt.ws } : opt.ws

  return new Server({
    ...opt,
    http: http ?? (hasHttpOptions ? { onRequest, routes, onError: httpError } : undefined),
    ws
  } as never)
}

function poolSize(pool: object): number {
  return (pool as { pool: unknown[] }).pool.length
}

function responseEndBody(call: unknown): string {
  const body = (call as { body?: unknown } | undefined)?.body

  if (typeof body !== 'string') {
    throw new TypeError('Expected an end call with a string body')
  }

  return body
}

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new TypeError(`${label} is required`)
  }

  return value
}

function at<T>(values: readonly T[], index: number, label = 'array item'): T {
  return requireDefined(values[index], `${label}[${index}]`)
}

function requireHandler(handler: Handler | null): Handler {
  return requireDefined(handler, 'HTTP request handler')
}

function requireRouteCall<T extends { handler?: (...args: unknown[]) => unknown }>(
  call: T | undefined
): T & { handler: (...args: unknown[]) => unknown } {
  if (!call?.handler) {
    throw new TypeError('Expected a registered route handler')
  }

  return call as T & { handler: (...args: unknown[]) => unknown }
}

function requireConfiguredCall<T extends { config?: object }>(
  call: T | undefined
): T & { config: NonNullable<T['config']> } {
  const value = requireDefined(call, 'Expected a registered WebSocket handler')
  const config = requireDefined(value.config, 'Expected WebSocket handler configuration')

  return Object.assign(value, { config }) as T & { config: NonNullable<T['config']> }
}

function userId(ctx: WSContext): string {
  const data = requireDefined(ctx.data, 'WebSocket user data') as { userId?: unknown }

  if (typeof data.userId !== 'string') {
    throw new TypeError('Expected userData.userId to be a string')
  }

  return data.userId
}

function requireHttp(server: Server) {
  return requireDefined(server.http, 'HTTP configuration')
}

function requireEffectiveHttp(server: Server) {
  return requireDefined(server.effectiveConfig.http, 'effective HTTP configuration')
}

function requireWs(server: Server) {
  return requireDefined(server.ws, 'WebSocket configuration')
}

function requireEffectiveWs(server: Server) {
  return requireDefined(server.effectiveConfig.ws, 'effective WebSocket configuration')
}

function requireBodyBudget(server: Server) {
  return requireDefined(server.httpBodyBudget, 'HTTP body budget')
}

function requireTransport(server: Server) {
  return requireDefined(server.transport, 'HTTP transport configuration')
}

interface UpgradeCall {
  userData: Record<string, unknown>
  secKey: string
  protocol: string
  extensions: string
  context: object
}

function requireUpgradeCall(value: unknown): UpgradeCall {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Expected a WebSocket upgrade call')
  }

  return value as UpgradeCall
}

describe('Server', () => {
  beforeEach(() => {
    resetMockApp()
  })

  afterEach(() => {
    resetMockApp()
  })

  describe('constructor', () => {
    test('should create server with http.onRequest', () => {
      const onRequest = () => {}
      const server = makeServer({ http: { onRequest } })

      strictEqual(requireHttp(server).onRequest, onRequest)
      strictEqual(requireHttp(server).routes, null)
      strictEqual(server.host, '127.0.0.1')
      strictEqual(server.port, 6000)
      strictEqual(server.httpMaxBodyBytes, 1024 * 1024)
      strictEqual(requireBodyBudget(server).limitBytes, 256 * 1024 * 1024)
      strictEqual(requireEffectiveHttp(server).maxBodyBudget, 256 * 1024 * 1024)
      strictEqual(server.httpRequestTimeoutMs, 30_000)
      strictEqual(requireHttp(server).prefetch, false)
      strictEqual(requireHttp(server).prefetchHeaders, false)
      strictEqual(server.transport, null)
      strictEqual(server.ws, null)
      strictEqual(server.wsIdleTimeoutSec, 15)
    })

    test('should create server with http.routes', () => {
      const routes = [{ method: 'get', path: '/', handler: () => {} }]
      const server = makeServer({ http: { routes } })

      strictEqual(requireHttp(server).onRequest, null)
      deepStrictEqual(requireHttp(server).routes, routes)
      strictEqual(server.port, 6000)
      strictEqual(server.httpMaxBodyBytes, 1024 * 1024)
      strictEqual(server.ws, null)
    })

    test('should use custom port', () => {
      const server = makeServer({ onRequest: () => {}, port: 3000 })

      strictEqual(server.port, 3000)
    })

    test('should use custom host', () => {
      const server = makeServer({ onRequest: () => {}, host: '0.0.0.0' })

      strictEqual(server.host, '0.0.0.0')
    })

    test('should configure HTTP-level prefetch', () => {
      const server = makeServer({ http: { onRequest: () => {}, prefetch: true } })

      strictEqual(requireHttp(server).prefetch, true)
      strictEqual(requireHttp(server).maxBodyBudget, 256 * 1024 * 1024)
      strictEqual(requireBodyBudget(server).limitBytes, 256 * 1024 * 1024)
      strictEqual(requireEffectiveHttp(server).maxBodyBudget, 256 * 1024 * 1024)
    })

    test('should reject an invalid HTTP-level prefetch', () => {
      throws(() => makeServer({ http: { onRequest: () => {}, prefetch: 'yes' } }), {
        name: 'TypeError',
        message: 'http.prefetch must be a boolean'
      })
    })

    test('should normalize selective HTTP header prefetch once', () => {
      const server = makeServer({
        http: {
          onRequest: () => {},
          prefetchHeaders: ['Authorization', 'traceparent', 'AUTHORIZATION']
        }
      })

      deepStrictEqual(requireHttp(server).prefetchHeaders, ['authorization', 'traceparent'])
      strictEqual(Object.isFrozen(requireHttp(server).prefetchHeaders), true)
      deepStrictEqual(requireEffectiveHttp(server).prefetchHeaders, ['authorization', 'traceparent'])
    })

    test('should reject invalid HTTP header prefetch configuration', () => {
      throws(() => makeServer({ http: { onRequest: () => {}, prefetchHeaders: true } }), {
        name: 'TypeError',
        message: 'http.prefetchHeaders must be false, "all", or an array of header names'
      })

      throws(() => makeServer({ http: { onRequest: () => {}, prefetchHeaders: ['bad header'] } }), {
        name: 'TypeError',
        message: 'http.prefetchHeaders[0] must be a valid HTTP header name'
      })
    })

    test('should validate a per-route body limit against the HTTP ceiling', () => {
      const server = makeServer({
        http: {
          maxBodySize: 1024,
          routes: [{ method: 'post', path: '/small', maxBodySize: 128, handler: () => {} }]
        }
      })

      strictEqual(at(requireDefined(requireHttp(server).routes, 'HTTP routes'), 0, 'HTTP route').maxBodySize, 128)

      throws(
        () =>
          makeServer({
            http: {
              maxBodySize: 1024,
              routes: [{ method: 'post', path: '/large', maxBodySize: 1025, handler: () => {} }]
            }
          }),
        {
          name: 'TypeError',
          message: 'http.routes[0].maxBodySize cannot exceed http.maxBodySize (1024)'
        }
      )
    })

    test('should validate and freeze explicit native transport options', () => {
      const server = makeServer({
        onRequest: () => {},
        transport: {
          maxHeaderSize: 16 * 1024,
          maxHeaderCount: 80,
          headersTimeoutMs: 10_000,
          keepAliveTimeoutMs: 5_000,
          bodyIdleTimeoutMs: 10_000,
          minBodyRateBytesPerSec: null,
          responseWriteTimeoutMs: 10_000
        }
      })

      strictEqual(Object.isFrozen(server.transport), true)
      strictEqual(requireTransport(server).maxHeaderSize, 16 * 1024)
      strictEqual(requireTransport(server).minBodyRateBytesPerSec, null)
      strictEqual(server.effectiveConfig.transport, server.transport)
    })

    test('should treat an empty native transport policy as omitted', () => {
      const server = makeServer({ onRequest: () => {}, transport: {} })

      strictEqual(server.transport, null)
      strictEqual(server.effectiveConfig.transport, null)
    })

    test('should reject invalid native transport options without coercion', () => {
      throws(() => makeServer({ onRequest: () => {}, transport: { maxHeaderCount: 101 } }), {
        name: 'TypeError',
        message: 'transport.maxHeaderCount must be a positive safe integer no greater than 100'
      })
      throws(() => makeServer({ onRequest: () => {}, transport: { headersTimeoutMs: 0 } }), {
        name: 'TypeError',
        message: 'transport.headersTimeoutMs must be a positive safe integer no greater than 300000'
      })
      throws(() => makeServer({ onRequest: () => {}, transport: { maxHeaderSize: '16384' } }), TypeError)
      throws(() => makeServer({ onRequest: () => {}, transport: { unknown: 1 } }), {
        name: 'TypeError',
        message: 'Unknown transport option: unknown'
      })
    })

    test('should reject the removed server-level prefetch option', () => {
      throws(() => makeServer({ onRequest: () => {}, prefetch: true }), {
        name: 'TypeError',
        message: 'prefetch is no longer a server option; use http.prefetch'
      })
    })

    test('should reject an invalid host', () => {
      throws(() => makeServer({ onRequest: () => {}, host: '' }), {
        name: 'TypeError',
        message: 'Host must be a non-empty string'
      })
    })

    test('should use custom http.maxBodySize', () => {
      const server = makeServer({ http: { onRequest: () => {}, maxBodySize: 5 * 1024 * 1024 } })

      strictEqual(server.httpMaxBodyBytes, 5 * 1024 * 1024)
    })

    test('should configure aggregate body budget and request timeout', () => {
      const server = makeServer({
        http: {
          onRequest: () => {},
          maxBodySize: 2 * 1024 * 1024,
          maxBodyBudget: 8 * 1024 * 1024,
          requestTimeoutMs: 15_000
        }
      })

      strictEqual(requireBodyBudget(server).limitBytes, 8 * 1024 * 1024)
      strictEqual(server.httpRequestTimeoutMs, 15_000)
    })

    test('should use custom http.onError handler', () => {
      const onError = () => {}
      const server = makeServer({ http: { onRequest: () => {}, onError } })

      strictEqual(server.httpErrorHandler, onError)
    })

    test('should use default HTTP error handler when not provided', () => {
      const server = makeServer({ onRequest: () => {} })

      strictEqual(typeof server.httpErrorHandler, 'function')
    })

    test('should use custom onServerError handler', () => {
      const onServerError = () => {}
      const server = makeServer({ onRequest: () => {}, onServerError })

      strictEqual(server.onServerError, onServerError)
    })

    test('should reject both http.onRequest and http.routes', () => {
      throws(() => makeServer({ http: { onRequest: () => {}, routes: [] } }), {
        name: 'TypeError',
        message: 'Cannot use both "http.onRequest" and "http.routes" options. Choose one.'
      })
    })

    test('should reject when neither application protocol is configured', () => {
      throws(() => makeServer({}), {
        name: 'TypeError',
        message: 'At least one of "http" or "ws" must be configured'
      })
    })

    test('should reject legacy root HTTP options', () => {
      const message = 'Legacy HTTP options are no longer supported; use http.onRequest, http.routes, and http.onError'

      throws(() => new Server({ router: () => {} } as never), { name: 'TypeError', message })
      throws(() => new Server({ routes: [] } as never), { name: 'TypeError', message })
      throws(() => new Server({ http: {}, onHttpError: () => {} } as never), { name: 'TypeError', message })
    })

    test('should reject invalid server options', () => {
      throws(() => new Server(null as never), { name: 'TypeError', message: 'Server options must be an object' })
      throws(() => new Server([] as never), { name: 'TypeError', message: 'Server options must be an object' })
    })

    test('should reject invalid http.onRequest', () => {
      throws(() => makeServer({ http: { onRequest: 'not a function' } }), {
        name: 'TypeError',
        message: 'http.onRequest must be a function'
      })
    })

    test('should reject invalid http.routes', () => {
      throws(() => makeServer({ http: { routes: 'not an array' } }), {
        name: 'TypeError',
        message: 'http.routes must be an array'
      })
    })

    test('should reject non-object protocol options', () => {
      throws(() => makeServer({ http: false, ws: {} }), {
        name: 'TypeError',
        message: 'http must be an object or null'
      })
      throws(() => makeServer({ http: {}, ws: false }), {
        name: 'TypeError',
        message: 'ws must be an object or null'
      })
    })

    test('should reject invalid protocol callbacks', () => {
      throws(() => makeServer({ http: { onError: 'nope' } }), {
        name: 'TypeError',
        message: 'http.onError must be a function'
      })
      throws(() => makeServer({ http: null, ws: { onMessage: 'nope' } }), {
        name: 'TypeError',
        message: 'ws.onMessage must be a function'
      })
      throws(() => makeServer({ http: null, ws: { selectProtocol: 'nope' } }), {
        name: 'TypeError',
        message: 'ws.selectProtocol must be a function'
      })
      throws(() => makeServer({ http: {}, onServerError: 'nope' }), {
        name: 'TypeError',
        message: 'onServerError must be a function'
      })
    })

    test('should validate route handlers during construction', () => {
      throws(() => makeServer({ http: { routes: [{ method: 'get', path: '/', handler: null }] } }), {
        name: 'TypeError',
        message: 'http.routes[0].handler must be a function'
      })
    })

    test('should treat an empty http object as enabled', () => {
      const server = makeServer({ http: {} })

      strictEqual(server.http !== null, true)
      strictEqual(server.ws, null)
    })

    test('should require explicit WebSocket upgrade authorization', () => {
      throws(() => new Server({ http: null, ws: {} } as never), {
        name: 'TypeError',
        message: 'ws.onUpgrade is required; explicitly authorize or reject every WebSocket upgrade'
      })
    })

    test('should enable WebSocket with an explicit authorizer', () => {
      const server = makeServer({ http: null, ws: {} })

      strictEqual(server.http, null)
      strictEqual(server.ws !== null, true)
      strictEqual(server.wsIdleTimeoutSec, 15)
    })

    test('should reject legacy ws.enabled', () => {
      throws(() => makeServer({ http: {}, ws: { enabled: false } }), {
        name: 'TypeError',
        message: 'ws.enabled is no longer supported; use ws: null to disable WebSocket'
      })
    })

    test('should reject legacy WebSocket timeout option names', () => {
      const message =
        'Legacy WebSocket timeout options are no longer supported; use ws.idleTimeoutSec and ws.upgradeTimeoutMs'

      throws(() => makeServer({ http: {}, ws: { wsIdleTimeoutSec: 15 } }), { name: 'TypeError', message })
      throws(() => makeServer({ http: {}, ws: { wsUpgradeTimeoutMs: 10_000 } }), { name: 'TypeError', message })
    })

    test('should throw error when port is not a number', () => {
      throws(() => makeServer({ onRequest: () => {}, port: '3000' }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is 0', () => {
      throws(() => makeServer({ onRequest: () => {}, port: 0 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is negative', () => {
      throws(() => makeServer({ onRequest: () => {}, port: -1 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is greater than 65535', () => {
      throws(() => makeServer({ onRequest: () => {}, port: 65536 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should reject a fractional port before listen', () => {
      throws(() => makeServer({ onRequest: () => {}, port: 6000.5 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should accept valid port range', () => {
      const server1 = makeServer({ onRequest: () => {}, port: 1 })

      strictEqual(server1.port, 1)

      const server2 = makeServer({ onRequest: () => {}, port: 65535 })

      strictEqual(server2.port, 65535)
    })

    test('should throw error when http.maxBodySize is not a number', () => {
      throws(() => makeServer({ http: { onRequest: () => {}, maxBodySize: '1' } }), {
        name: 'TypeError',
        message: 'http.maxBodySize must be specified in bytes as a non-negative safe integer no greater than 67108864'
      })
    })

    test('should preserve an explicit zero-byte http.maxBodySize', () => {
      strictEqual(makeServer({ http: { onRequest: () => {}, maxBodySize: 0 } }).httpMaxBodyBytes, 0)
    })

    test('should throw error above the supported 64 MiB HTTP body maximum', () => {
      throws(() => makeServer({ http: { onRequest: () => {}, maxBodySize: 64 * 1024 * 1024 + 1 } }), {
        name: 'TypeError',
        message: 'http.maxBodySize must be specified in bytes as a non-negative safe integer no greater than 67108864'
      })
    })

    test('should accept valid http.maxBodySize range', () => {
      const server1 = makeServer({ http: { onRequest: () => {}, maxBodySize: 1 } })

      strictEqual(server1.httpMaxBodyBytes, 1)

      const server2 = makeServer({ http: { onRequest: () => {}, maxBodySize: 64 * 1024 * 1024 } })

      strictEqual(server2.httpMaxBodyBytes, 64 * 1024 * 1024)
    })

    test('distinguishes omitted, zero, finite, and unlimited body budgets', () => {
      const omitted = makeServer({ http: { onRequest: () => {} } })

      strictEqual(requireBodyBudget(omitted).limitBytes, 256 * 1024 * 1024)
      strictEqual(requireEffectiveHttp(omitted).maxBodyBudget, 256 * 1024 * 1024)

      const zero = makeServer({ http: { onRequest: () => {}, maxBodyBudget: 0 } })

      strictEqual(requireBodyBudget(zero).limitBytes, 0)
      strictEqual(requireEffectiveHttp(zero).maxBodyBudget, 0)

      const finite = makeServer({ http: { onRequest: () => {}, maxBodyBudget: 8192 } })

      strictEqual(requireBodyBudget(finite).limitBytes, 8192)
      strictEqual(makeServer({ http: { onRequest: () => {}, maxBodyBudget: null } }).httpBodyBudget, null)
    })

    test('uses the same finite default budget for route prefetch', () => {
      const server = makeServer({
        http: {
          routes: [{ method: 'post', path: '/', prefetch: true, handler: () => {} }]
        }
      })

      strictEqual(requireBodyBudget(server).limitBytes, 256 * 1024 * 1024)
    })

    test('rejects invalid body budget byte counts without coercion', () => {
      for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}, Object(1)]) {
        throws(() => makeServer({ http: { onRequest: () => {}, maxBodyBudget: value } }), {
          name: 'TypeError',
          message: 'http.maxBodyBudget must be specified in bytes as a non-negative safe integer or null'
        })
      }
    })

    test('should validate http.requestTimeoutMs and allow zero', () => {
      strictEqual(makeServer({ http: { onRequest: () => {}, requestTimeoutMs: 0 } }).httpRequestTimeoutMs, 0)

      throws(() => makeServer({ http: { onRequest: () => {}, requestTimeoutMs: 99 } }), {
        name: 'TypeError',
        message: 'http.requestTimeoutMs must be 0 or in range 100 - 300000'
      })
    })

    test('should reject legacy root maxBodySize', () => {
      throws(() => makeServer({ onRequest: () => {}, maxBodySize: 1 }), {
        name: 'TypeError',
        message: 'maxBodySize is no longer a server option; use http.maxBodySize or ws.maxPayloadLength'
      })
    })

    test('should configure HTTP and WebSocket body limits independently', () => {
      const server = makeServer({
        http: { onRequest: () => {}, maxBodySize: 2 * 1024 * 1024 },
        ws: { maxPayloadLength: 7 * 1024 * 1024 }
      })

      strictEqual(server.httpMaxBodyBytes, 2 * 1024 * 1024)
      strictEqual(server.wsMaxPayloadBytes, 7 * 1024 * 1024)
    })

    test('should reject legacy ws.maxBodySize terminology', () => {
      throws(() => makeServer({ http: {}, ws: { maxBodySize: 1 } }), {
        name: 'TypeError',
        message: 'ws.maxBodySize is no longer supported; use ws.maxPayloadLength in bytes'
      })
    })

    test('should validate and expose WebSocket byte limits', () => {
      const server = makeServer({
        http: {},
        ws: {
          maxPayloadLength: 1024 * 32,
          maxBackpressure: 1024 * 64,
          closeOnBackpressureLimit: true
        }
      })

      strictEqual(server.wsMaxPayloadBytes, 32_768)
      strictEqual(server.wsMaxBackpressureBytes, 65_536)
      strictEqual(server.wsCloseOnBackpressureLimit, true)
      deepStrictEqual(server.effectiveConfig.ws, {
        maxPayloadLength: 32_768,
        maxBackpressure: 65_536,
        closeOnBackpressureLimit: true,
        idleTimeoutSec: 15,
        upgradeTimeoutMs: 10_000,
        prefetchHeaders: false
      })
    })

    test('should normalize selective WebSocket upgrade header prefetch', () => {
      const server = makeServer({
        http: null,
        ws: { prefetchHeaders: ['Authorization', 'authorization'] }
      })

      deepStrictEqual(requireWs(server).prefetchHeaders, ['authorization'])
      strictEqual(Object.isFrozen(requireWs(server).prefetchHeaders), true)
      deepStrictEqual(requireEffectiveWs(server).prefetchHeaders, ['authorization'])

      throws(() => makeServer({ http: null, ws: { prefetchHeaders: ['bad header'] } }), {
        name: 'TypeError',
        message: 'ws.prefetchHeaders[0] must be a valid HTTP header name'
      })
    })

    test('should use explicit swm-core WebSocket resource defaults', () => {
      const server = makeServer({ http: null, ws: {} })

      strictEqual(server.wsMaxPayloadBytes, 1024 * 1024)
      strictEqual(server.wsMaxBackpressureBytes, 64 * 1024)
      strictEqual(server.wsCloseOnBackpressureLimit, true)
    })

    test('should reject invalid WebSocket byte counts without coercion', () => {
      const invalid = [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1', null, {}, Object(1)]

      for (const value of invalid) {
        throws(() => makeServer({ http: null, ws: { maxPayloadLength: value } }), TypeError)
        throws(() => makeServer({ http: null, ws: { maxBackpressure: value } }), TypeError)
      }

      throws(() => makeServer({ http: null, ws: { maxPayloadLength: 0 } }), {
        name: 'TypeError',
        message: 'ws.maxPayloadLength must be at least 1 byte'
      })

      throws(
        () => makeServer({ http: null, ws: { maxPayloadLength: 64 * 1024 * 1024 + 1 } }),
        /ws\.maxPayloadLength must be specified in bytes/
      )
      throws(
        () => makeServer({ http: null, ws: { maxBackpressure: 0x1_0000_0000 } }),
        /ws\.maxBackpressure must be specified in bytes/
      )
      throws(
        () => makeServer({ http: null, ws: { closeOnBackpressureLimit: 1 } }),
        /ws\.closeOnBackpressureLimit must be a boolean/
      )
    })

    test('should enable WebSocket when ws is an empty object', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      strictEqual(server.ws !== null, true)
      strictEqual(server.wsIdleTimeoutSec, 15)
    })

    test('should enable WebSocket when ws handlers are provided', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { onMessage: () => {} }
      })

      strictEqual(server.ws !== null, true)
    })

    test('should enable WebSocket when onDropped is the only handler', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { onDropped: () => {} }
      })

      strictEqual(server.ws !== null, true)
    })

    test('should disable WebSocket when ws is not provided', () => {
      const server = makeServer({ onRequest: () => {} })

      strictEqual(server.ws, null)
    })

    test('should use custom ws.idleTimeoutSec', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { idleTimeoutSec: 30 }
      })

      strictEqual(server.wsIdleTimeoutSec, 30)
    })

    test('should validate ws.idleTimeoutSec against the native binding contract', () => {
      strictEqual(makeServer({ onRequest: () => {}, ws: { idleTimeoutSec: 8 } }).wsIdleTimeoutSec, 8)

      throws(
        () =>
          makeServer({
            onRequest: () => {},
            ws: { idleTimeoutSec: 7 }
          }),
        {
          name: 'TypeError',
          message: 'ws.idleTimeoutSec must be a safe integer in range 8 - 960'
        }
      )

      throws(() => makeServer({ onRequest: () => {}, ws: { idleTimeoutSec: 961 } }), TypeError)
      throws(() => makeServer({ onRequest: () => {}, ws: { idleTimeoutSec: 8.5 } }), TypeError)
    })

    test('should validate ws.upgradeTimeoutMs', () => {
      for (const value of [0, 1, 99, 100, 2500]) {
        strictEqual(makeServer({ onRequest: () => {}, ws: { upgradeTimeoutMs: value } }).wsUpgradeTimeoutMs, value)
      }

      throws(() => makeServer({ onRequest: () => {}, ws: { upgradeTimeoutMs: 300_001 } }), {
        name: 'TypeError',
        message: 'ws.upgradeTimeoutMs must be a safe integer in milliseconds in range 0 - 300000'
      })

      for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '0', null, {}]) {
        throws(() => makeServer({ onRequest: () => {}, ws: { upgradeTimeoutMs: value } }), TypeError)
      }
    })

    test('should assign WebSocket handlers when provided', () => {
      const onOpen = () => {}
      const onClose = () => {}
      const onError = () => {}
      const onMessage = () => {}
      const onDrain = () => {}
      const onDropped = () => {}
      const onSubscription = () => {}
      const onUpgrade = () => Promise.resolve({})
      const selectProtocol = () => undefined
      const server = makeServer({
        onRequest: () => {},
        ws: {
          onOpen,
          onClose,
          onError,
          onMessage,
          onDrain,
          onDropped,
          onSubscription,
          onUpgrade,
          selectProtocol
        }
      })

      strictEqual(server.onWsOpen, onOpen)
      strictEqual(server.onWsClose, onClose)
      strictEqual(server.onWsError, onError)
      strictEqual(server.onWsMessage, onMessage)
      strictEqual(server.onWsDrain, onDrain)
      strictEqual(server.onWsDropped, onDropped)
      strictEqual(server.onWsSubscription, onSubscription)
      strictEqual(server.onWsUpgrade, onUpgrade)
      strictEqual(server.wsProtocolSelector, selectProtocol)
    })

    test('should initialize the HTTP context pool', () => {
      const server = makeServer({ onRequest: () => {} })

      strictEqual(server.httpContextPool !== null, true)
    })

    test('should initialize internal state', () => {
      const server = makeServer({ onRequest: () => {} })

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })
  })

  describe('transport loading', () => {
    test('should reject the removed backend option', () => {
      throws(() => new Server({ http: { onRequest: () => {} }, backend: 'node' } as never), {
        name: 'TypeError',
        message: 'backend is no longer configurable; swm-uws is always used'
      })
    })

    test('should load the transport lazily via listen(), not in the constructor', () => {
      // Constructing must not touch the uws module at all.
      new Server({ http: { onRequest: () => {} } })

      strictEqual(getCurrentMockApp(), null)
    })
  })

  describe('listen()', () => {
    test('should register onRequest handler with app.any', async () => {
      const onRequest = () => {}
      const server = makeServer({ onRequest, port: 7000 })

      await server.listen()

      const mockApp = requireCurrentMockApp()

      strictEqual(mockApp !== null, true)
      strictEqual(mockApp.calls.length, 1)
      strictEqual(at(mockApp.calls, 0, 'registered route').method, 'any')
      strictEqual(at(mockApp.calls, 0, 'registered route').path, '/*')
      strictEqual(typeof at(mockApp.calls, 0, 'registered route').handler, 'function')
      strictEqual(server.socket !== null, true)
      strictEqual(server.app !== null, true)
      deepStrictEqual(server.bindingCapabilities, {
        beginWrite: true,
        collectBody: true,
        collectBodyLength: true,
        httpTransportConfig: true,
        requestPause: false,
        requestPrefetch: true,
        responseBatch: false
      })
      deepStrictEqual(
        mockCalls.listen.map(({ host, port }) => ({ host, port })),
        [{ host: '127.0.0.1', port: 7000 }]
      )
    })

    test('should listen on a custom host', async () => {
      const server = makeServer({ onRequest: () => {}, host: '0.0.0.0', port: 7000 })

      await server.listen()

      deepStrictEqual(
        mockCalls.listen.map(({ host, port }) => ({ host, port })),
        [{ host: '0.0.0.0', port: 7000 }]
      )
    })

    test('should pass explicit native transport options to swm-uws App', async () => {
      const transport = {
        maxHeaderSize: 16 * 1024,
        headersTimeoutMs: 10_000,
        keepAliveTimeoutMs: 5_000
      }
      const server = makeServer({ onRequest: () => {}, transport })

      await server.listen()

      deepStrictEqual(requireCurrentMockApp().appOptions, { http: transport })
    })

    test('should return server instance on successful listen', async () => {
      const server = makeServer({ onRequest: () => {} })
      const result = await server.listen()

      strictEqual(result, server)
      strictEqual(server.socket !== null, true)
    })

    test('should return same promise for concurrent listen calls', async () => {
      const server = makeServer({ onRequest: () => {} })

      setListenCallback((cb) => {
        setTimeout(() => cb({ sock: 1 }), 0)
      })

      const promise1 = server.listen()
      const promise2 = server.listen()

      strictEqual(promise1, promise2, 'Both calls should return the same promise instance')
      const result = await promise1

      strictEqual(result, server)
    })

    test('should return resolved promise if socket already exists', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.listen()

      const result = await server.listen()

      strictEqual(result, server)
    })

    test('should reject on listen failure', async () => {
      const server = makeServer({ onRequest: () => {}, port: 8000 })

      setListenCallback((cb) => {
        cb(null)
      })

      await rejects(server.listen(), {
        message: 'Listen failed on 127.0.0.1:8000'
      })

      strictEqual(server.socket, null)
    })

    test('should reject listen without creating a socket when close races startup', async () => {
      const server = makeServer({ onRequest: () => {} })

      setListenCallback((callback) => {
        setImmediate(() => callback({ socket: 'late' }))
      })

      const listening = server.listen()

      server.close()

      await rejects(listening, { name: 'AbortError', message: 'Listen was cancelled' })

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 0)
    })

    test('should register native routes with correct methods', async () => {
      const handler1 = () => {}
      const handler2 = () => {}
      const routes = [
        { method: 'get', path: '/x', handler: handler1 },
        { method: 'delete', path: '/d', handler: handler2 },
        { method: 'post', path: '/p', handler: handler1 }
      ]
      const server = makeServer({ routes })

      await server.listen()

      const mockApp = requireCurrentMockApp()
      const routeCalls = mockApp.calls.filter((c) => c.path !== '/*')

      strictEqual(routeCalls.length, 3)
      strictEqual(at(routeCalls, 0, 'GET route').method, 'get')
      strictEqual(at(routeCalls, 0, 'GET route').path, '/x')
      strictEqual(at(routeCalls, 1, 'DELETE route').method, 'del')
      strictEqual(at(routeCalls, 1, 'DELETE route').path, '/d')
      strictEqual(at(routeCalls, 2, 'POST route').method, 'post')
      strictEqual(at(routeCalls, 2, 'POST route').path, '/p')
    })

    test('should prefetch a route body before an asynchronous before hook yields', async () => {
      const resume = { value: null as (() => void) | null }

      const pending = new Promise<void>((resolve) => {
        resume.value = resolve
      })
      const server = makeServer({
        routes: [
          {
            method: 'post',
            path: '/x',
            prefetch: true,
            before: () => pending,
            handler: (ctx) => ctx.json()
          }
        ]
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/x'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('content-length', '11')
      routeCall.handler(res, req)

      strictEqual(res.calls.filter((call) => call.method === 'onData').length, 1)
      res.pushData('{"ok":true}', true)
      requireDefined(resume.value, 'prefetch resume')()
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res.isEnded(), true)
      strictEqual(responseEndBody(res.calls.find((call) => call.method === 'end')), '{"ok":true}')
    })

    test('should apply HTTP prefetch to onRequest', async () => {
      const server = makeServer({
        http: {
          prefetch: true,
          onRequest: (ctx) => ctx.text()
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/*'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('content-length', '2')
      routeCall.handler(res, req)

      strictEqual(res.calls.filter((call) => call.method === 'onData').length, 1)
      res.pushData('ok', true)
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(responseEndBody(res.calls.find((call) => call.method === 'end')), 'ok')
    })

    test('should enforce a route-specific body limit', async () => {
      const server = makeServer({
        http: {
          maxBodySize: 1024,
          routes: [
            {
              method: 'post',
              path: '/small',
              maxBodySize: 1,
              handler: (ctx) => ctx.body()
            }
          ]
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/small'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('content-length', '2')
      routeCall.handler(res, req)
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res.getStatus(), STATUS_TEXT[413])
    })

    test('should retain only selected HTTP headers without a full header iteration', async () => {
      const gate = Promise.withResolvers<void>()
      const server = makeServer({
        http: {
          prefetchHeaders: ['authorization'],
          onRequest: async (ctx) => {
            await gate.promise

            const headers = ctx.headers

            return {
              authorization: ctx.getReqHeader('authorization'),
              omitted: ctx.getReqHeader('x-omitted'),
              headers,
              stableHeaders: headers === ctx.headers
            }
          }
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/*'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('authorization', 'Bearer original')
      req.setHeader('x-omitted', 'not-retained')
      routeCall.handler(res, req)
      req.setHeader('authorization', 'Bearer stale')
      gate.resolve()

      await new Promise((resolve) => setImmediate(resolve))

      const body = JSON.parse(responseEndBody(res.calls.find((call) => call.method === 'end')))

      deepStrictEqual(body, {
        authorization: 'Bearer original',
        omitted: '',
        headers: { authorization: 'Bearer original' },
        stableHeaders: true
      })
      strictEqual(req.calls.filter((call) => call.method === 'prefetch').length, 1)
      strictEqual(
        req.calls.some((call) => call.method === 'forEach'),
        false
      )
    })

    test('should make getHeaders collect every field and hydrate the stable headers view', async () => {
      const server = makeServer({
        http: {
          prefetchHeaders: ['authorization'],
          onRequest: (ctx) => ({
            prefetched: ctx.headers,
            all: ctx.getHeaders()
          })
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/*'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('authorization', 'Bearer token')
      req.setHeader('x-omitted', 'collected explicitly')
      routeCall.handler(res, req)

      const body = JSON.parse(responseEndBody(res.calls.find((call) => call.method === 'end')))

      deepStrictEqual(body, {
        prefetched: {
          authorization: 'Bearer token',
          'x-omitted': 'collected explicitly'
        },
        all: {
          authorization: 'Bearer token',
          'x-omitted': 'collected explicitly'
        }
      })
      strictEqual(req.calls.filter((call) => call.method === 'forEach').length, 1)
    })

    test('should not return partial data from getHeaders after a selective async boundary', async () => {
      const server = makeServer({
        http: {
          prefetchHeaders: ['authorization'],
          onRequest: async (ctx) => {
            await Promise.resolve()

            try {
              ctx.getHeaders()
            } catch (err) {
              return (err as { code?: unknown }).code
            }
          }
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/*'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('authorization', 'Bearer token')
      req.setHeader('x-omitted', 'not retained')
      routeCall.handler(res, req)
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(responseEndBody(res.calls.find((call) => call.method === 'end')), 'REQUEST_HEADERS_NOT_RETAINED')
      strictEqual(
        req.calls.some((call) => call.method === 'forEach'),
        false
      )
    })

    test('should make all headers available after await when prefetchHeaders is all', async () => {
      const server = makeServer({
        http: {
          prefetchHeaders: 'all',
          onRequest: async (ctx) => {
            await Promise.resolve()

            return ctx.getHeaders()
          }
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/*'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('authorization', 'Bearer token')
      req.setHeader('x-extra', 'retained')
      routeCall.handler(res, req)
      await new Promise((resolve) => setImmediate(resolve))

      deepStrictEqual(JSON.parse(responseEndBody(res.calls.find((call) => call.method === 'end'))), {
        authorization: 'Bearer token',
        'x-extra': 'retained'
      })
      strictEqual(
        req.calls.some((call) => call.method === 'forEach'),
        false
      )
    })

    test('should let a route disable inherited header prefetch', async () => {
      const server = makeServer({
        http: {
          prefetchHeaders: ['authorization'],
          routes: [
            {
              method: 'get',
              path: '/x',
              prefetchHeaders: false,
              handler: async (ctx) => {
                await Promise.resolve()

                return ctx.getReqHeader('authorization')
              }
            }
          ]
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/x'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setHeader('authorization', 'Bearer token')
      routeCall.handler(res, req)
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(
        req.calls.some((call) => call.method === 'prefetch'),
        false
      )
      strictEqual(responseEndBody(res.calls.find((call) => call.method === 'end')), '')
    })

    test('should let a route disable inherited HTTP prefetch', async () => {
      const server = makeServer({
        http: {
          prefetch: true,
          routes: [{ method: 'post', path: '/x', prefetch: false, handler: () => 'ok' }]
        }
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((call) => call.path === '/x'))
      const res = createMockHttpResponse()

      routeCall.handler(res, createMockHttpRequest())

      strictEqual(
        res.calls.some((call) => call.method === 'onData'),
        false
      )
      strictEqual(res.isEnded(), true)
    })

    test('should keep synchronous before hooks on the synchronous response path', async () => {
      const order: string[] = []
      const server = makeServer({
        routes: [
          {
            method: 'get',
            path: '/x',
            before: [() => order.push('before-1'), () => order.push('before-2')],
            handler: () => {
              order.push('handler')

              return 'ok'
            }
          }
        ]
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((c) => c.path === '/x'))
      const res = createMockHttpResponse()

      routeCall.handler(res, createMockHttpRequest())

      deepStrictEqual(order, ['before-1', 'before-2', 'handler'])
      strictEqual(res.isEnded(), true)
      strictEqual(poolSize(server.httpContextPool), 1)
    })

    test('should switch to the asynchronous path only when a before hook returns a promise', async () => {
      const order: string[] = []

      const resume = { value: null as (() => void) | null }

      const pending = new Promise<void>((resolve) => {
        resume.value = resolve
      })
      const server = makeServer({
        routes: [
          {
            method: 'get',
            path: '/x',
            before: [
              () => order.push('sync-before'),
              () => {
                order.push('async-before')

                return pending
              },
              () => order.push('after-await')
            ],
            handler: () => {
              order.push('handler')

              return 'ok'
            }
          }
        ]
      })

      await server.listen()

      const routeCall = requireRouteCall(requireCurrentMockApp().calls.find((c) => c.path === '/x'))
      const res = createMockHttpResponse()

      routeCall.handler(res, createMockHttpRequest())

      deepStrictEqual(order, ['sync-before', 'async-before'])
      strictEqual(res.isEnded(), false)

      requireDefined(resume.value, 'before hook resume')()
      await new Promise((resolve) => setImmediate(resolve))

      deepStrictEqual(order, ['sync-before', 'async-before', 'after-await', 'handler'])
      strictEqual(res.isEnded(), true)
      strictEqual(poolSize(server.httpContextPool), 1)
    })

    test('should pre-cache route params so async handlers see them after await, not a stale req', async () => {
      let paramById
      let paramByIndex

      const routes: Route[] = [
        {
          method: 'get',
          path: '/users/:id',
          handler: async (ctx) => {
            await Promise.resolve()
            paramById = ctx.getParameter('id')
            paramByIndex = ctx.getParameter(0)
          }
        }
      ]
      const server = makeServer({ routes })

      await server.listen()

      const mockApp = requireCurrentMockApp()
      const routeCall = requireRouteCall(mockApp.calls.find((c) => c.method !== 'ws'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      req.setParameter(0, 'sync-id')

      routeCall.handler(res, req)

      // Real uWS invalidates `req` once the synchronous callback returns;
      // simulate that by mutating the value a real req could no longer hold.
      req.setParameter(0, 'STALE-after-return')

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(paramById, 'sync-id')
      strictEqual(paramByIndex, 'sync-id')
    })

    test('should throw on invalid HTTP method', () => {
      const routes = [{ method: 'trace', path: '/x', handler: () => {} }]

      throws(() => makeServer({ routes }), {
        name: 'TypeError',
        message: 'Invalid HTTP method: trace'
      })
    })

    test('should throw on invalid path (not starting with /)', () => {
      const routes = [{ method: 'get', path: 'x', handler: () => {} }]

      throws(() => makeServer({ routes }), {
        name: 'TypeError',
        message: 'Invalid Path in route, method: get, path: x'
      })
    })

    test('should not finalize the context or skip the chain when a before hook starts streaming', async () => {
      let mainHandlerCalled = false

      const routes: Route[] = [
        {
          method: 'get',
          path: '/x',
          before: (ctx) => {
            ctx.startStreaming(200)
          },
          handler: (ctx) => {
            mainHandlerCalled = true
            ctx.end('done')
          }
        }
      ]
      const server = makeServer({ routes })

      await server.listen()

      const mockApp = requireCurrentMockApp()
      const routeCall = requireRouteCall(mockApp.calls.find((c) => c.method !== 'ws'))
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      routeCall.handler(res, req)

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(mainHandlerCalled, true)
    })

    test('should throw on invalid before hook (not a function)', () => {
      const routes = [{ method: 'get', path: '/x', handler: () => {}, before: 'nope' }]

      throws(() => makeServer({ routes }), {
        name: 'TypeError',
        message: 'Route before must be a function or an array of functions'
      })
    })

    test('should throw when a before array contains a non-function', () => {
      const routes = [{ method: 'get', path: '/x', handler: () => {}, before: [() => {}, 42] }]

      throws(() => makeServer({ routes }), {
        name: 'TypeError',
        message: 'Route before must be a function or an array of functions'
      })
    })

    test('should reject a non-boolean route prefetch option', () => {
      const routes = [{ method: 'post', path: '/x', handler: () => {}, prefetch: 'yes' }]

      throws(() => makeServer({ routes }), {
        name: 'TypeError',
        message: 'http.routes[0].prefetch must be a boolean'
      })
    })

    test('should reject the legacy preHandler route option', () => {
      const routes = [{ method: 'get', path: '/x', handler: () => {}, preHandler: () => {} }]

      throws(() => makeServer({ routes }), {
        name: 'TypeError',
        message: 'http.routes[0].preHandler is no longer supported; use before'
      })
    })

    test('should register WebSocket when ws is configured', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {
          idleTimeoutSec: 20,
          maxPayloadLength: 6 * 1024 * 1024,
          maxBackpressure: 128 * 1024,
          closeOnBackpressureLimit: true
        }
      })

      await server.listen()

      const mockApp = requireCurrentMockApp()
      const wsCall = requireConfiguredCall(mockApp.calls.find((c) => c.method === 'ws'))

      strictEqual(wsCall !== undefined, true)
      strictEqual(wsCall.path, '/*')
      strictEqual(wsCall.config.idleTimeout, 20)
      strictEqual(wsCall.config.upgradeTimeout, 10_000)
      strictEqual(wsCall.config.maxPayloadLength, 6 * 1024 * 1024)
      strictEqual(wsCall.config.maxBackpressure, 128 * 1024)
      strictEqual(wsCall.config.closeOnBackpressureLimit, true)
      strictEqual(typeof wsCall.config.open, 'function')
      strictEqual(typeof wsCall.config.message, 'function')
      strictEqual(typeof wsCall.config.dropped, 'function')
      strictEqual(typeof wsCall.config.close, 'function')
      strictEqual(typeof wsCall.config.drain, 'function')
      strictEqual(typeof wsCall.config.subscription, 'function')
      strictEqual(typeof wsCall.config.upgrade, 'function')
    })

    test('should use default ws.idleTimeoutSec when not provided', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      await server.listen()

      const mockApp = requireCurrentMockApp()
      const wsCall = requireConfiguredCall(mockApp.calls.find((c) => c.method === 'ws'))

      strictEqual(wsCall.config.idleTimeout, 15)
      strictEqual(wsCall.config.upgradeTimeout, 10_000)
      strictEqual(wsCall.config.closeOnBackpressureLimit, true)
    })

    test('should pass custom ws.upgradeTimeoutMs to the transport', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { upgradeTimeoutMs: 2500 }
      })

      await server.listen()

      const wsCall = requireConfiguredCall(requireCurrentMockApp().calls.find((c) => c.method === 'ws'))

      strictEqual(wsCall.config.upgradeTimeout, 2500)
    })

    test('should register only a minimal HTTP fallback for a WS-only server', async () => {
      const server = makeServer({ http: null, ws: {} })

      await server.listen()

      const calls = requireCurrentMockApp().calls
      const httpCall = requireRouteCall(calls.find(({ method }) => method === 'any'))
      const wsCall = requireDefined(
        calls.find(({ method }) => method === 'ws'),
        'WebSocket route'
      )
      const res = createMockHttpResponse()

      strictEqual(httpCall.path, '/*')
      strictEqual(wsCall.path, '/*')

      httpCall.handler(res, createMockHttpRequest())

      strictEqual(res.getStatus(), STATUS_TEXT[404])
      strictEqual(res.isEnded(), true)
      strictEqual(poolSize(server.httpContextPool), 0)
    })

    test('should not register WebSocket for an HTTP-only server', async () => {
      const server = makeServer({ http: {}, ws: null })

      await server.listen()

      strictEqual(
        requireCurrentMockApp().calls.some(({ method }) => method === 'ws'),
        false
      )
    })
  })

  describe('safeCall()', () => {
    test('should call function and swallow errors', async () => {
      const server = makeServer({ onRequest: () => {} })

      let called = 0

      await server.safeCall(() => {
        called++
        throw new Error('test error')
      })

      strictEqual(called, 1)
    })

    test('should handle async functions', async () => {
      const server = makeServer({ onRequest: () => {} })

      let called = 0

      await server.safeCall(async () => {
        called++
        throw new Error('test error')
      })

      strictEqual(called, 1)
    })

    test('should do nothing for non-function', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.safeCall(null)
      await server.safeCall(undefined)
      await server.safeCall('not a function')
      await server.safeCall(123)
    })

    test('should pass arguments correctly', async () => {
      const server = makeServer({ onRequest: () => {} })

      let receivedArgs: unknown[] | null = null

      await server.safeCall(
        (...args: unknown[]) => {
          receivedArgs = args
        },
        'a',
        'b',
        123
      )

      deepStrictEqual(receivedArgs, ['a', 'b', 123])
    })
  })

  describe('WebSocket context lifecycle', () => {
    test('should preserve upgrade data identity without calling getUserData', () => {
      const dataFromOnUpgrade = { userId: 123 }
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })
      const ws = createMockWebSocket(dataFromOnUpgrade)
      const ctx = server.getWsContext(ws)

      strictEqual(ctx.data, dataFromOnUpgrade)
      strictEqual(
        ws.calls.some((call) => call.method === 'getUserData'),
        false
      )
    })

    test('should create and cache WS context', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })
      const ws = createMockWebSocket()
      const ctx1 = server.getWsContext(ws)
      const ctx2 = server.getWsContext(ws)

      strictEqual(ctx1, ctx2)
      strictEqual(ctx1.server, server)
      strictEqual(ctx1.ws, ws)
    })

    test('should keep contexts isolated per connection', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })
      const wsA = createMockWebSocket()
      const wsB = createMockWebSocket()
      const ctxA = server.getWsContext(wsA)
      const ctxB = server.getWsContext(wsB)

      strictEqual(ctxA !== ctxB, true)
      strictEqual(ctxA.ws, wsA)
      strictEqual(ctxB.ws, wsB)
      strictEqual(server.getWsContext(wsA), ctxA)
      strictEqual(server.getWsContext(wsB), ctxB)

      // removing A must not disturb B
      server.deleteWsContext(wsA)

      strictEqual(server.getWsContext(wsB), ctxB)
      strictEqual(ctxB.ws, wsB)
    })

    test('should create new context after delete', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })
      const ws = createMockWebSocket()
      const ctx1 = server.getWsContext(ws)

      strictEqual(server.getWsContext(ws), ctx1)

      server.deleteWsContext(ws)

      // release() clears the context on delete
      strictEqual(ctx1.ws, null)

      const ctx2 = server.getWsContext(ws)

      strictEqual(ctx2 !== null, true)
      strictEqual(ctx2.server, server)
      strictEqual(ctx2.ws, ws)
    })

    test('should delete the runtime reference and clear context state', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })
      const ws = createMockWebSocket()
      const ctx = server.getWsContext(ws)
      const clear = ctx.clear.bind(ctx)

      let clearCalls = 0

      ctx.clear = () => {
        clearCalls++
        clear()
      }

      server.deleteWsContext(ws)

      strictEqual(clearCalls, 1)
      strictEqual(ctx.ws, null)
      strictEqual(server.getWsContext(ws) !== ctx, true)
    })

    test('should handle deleteWsContext when no context exists', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })
      const ws = createMockWebSocket()

      server.deleteWsContext(ws)
    })
  })

  describe('WebSocket connection registry (connectionKey / sendTo)', () => {
    const noise = new ArrayBuffer(0)

    test('should throw when connectionKey is not a function', () => {
      throws(() => makeServer({ onRequest: () => {}, ws: { connectionKey: 'nope' } }), {
        name: 'TypeError',
        message: 'ws.connectionKey must be a function'
      })
    })

    test('should enable WS when connectionKey is the only ws option', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      strictEqual(server.ws !== null, true)

      server.onOpen(ws)

      strictEqual(server.hasConnection('u1'), true)
    })

    test('should not register a connection that connectionKey closed synchronously', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {
          connectionKey: (ctx) => {
            const key = userId(ctx)

            ctx.end(4001, 'rejected')

            return key
          }
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })
      // Real uWS fires the close callback synchronously inside end()
      const plainEnd = ws.end.bind(ws)

      ws.end = (code, reason) => {
        plainEnd(code, reason)
        server.onClose(ws, code ?? 1000, noise)
      }

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.hasConnection('u1'), false)
    })

    test('should not invoke onOpen when connectionKey closed the connection', () => {
      const opened: WSContext[] = []
      const closed: number[] = []
      const server = makeServer({
        onRequest: () => {},
        ws: {
          connectionKey: (ctx) => {
            ctx.end(4001, 'rejected')

            return 'u1'
          },
          onOpen: (ctx) => opened.push(ctx),
          onClose: () => closed.push(1)
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })
      const plainEnd = ws.end.bind(ws)

      ws.end = (code, reason) => {
        plainEnd(code, reason)
        server.onClose(ws, code ?? 1000, noise)
      }

      server.onOpen(ws)

      strictEqual(opened.length, 0)
      strictEqual(closed.length, 1)
    })

    test('should not register when connectionKey returns NaN', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: () => NaN }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.getWsContext(ws).key, null)
    })

    test('should not maintain a registry when connectionKey is unset', () => {
      const server = makeServer({ onRequest: () => {}, ws: {} })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.hasConnection('u1'), false)
      strictEqual(server.sendTo('u1', 'hi'), false)
    })

    test('should register a connection on open and expose it via the registry API', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 1)
      strictEqual(server.hasConnection('u1'), true)
      strictEqual(server.getConnection('u1'), ws)
      strictEqual(server.getWsContext(ws).key, 'u1')
    })

    test('should send directly to a registered connection', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.sendTo('u1', 'hello'), true)

      const sent = ws.calls.filter((c) => c.method === 'send')

      strictEqual(sent.length, 1)
      strictEqual(at(sent, 0, 'sent message').data, 'hello')
      strictEqual(at(sent, 0, 'sent message').isBinary, false)
    })

    test('should default isBinary from payload type in sendTo', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      const buf = Buffer.from('x')

      server.sendTo('u1', buf)

      const sent = ws.calls.filter((c) => c.method === 'send')

      strictEqual(at(sent, 0, 'sent message').data, buf)
      strictEqual(at(sent, 0, 'sent message').isBinary, true)
    })

    test('should return false from sendTo when uWS reports the message dropped', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      ws.send = () => 2 // uWS DROPPED: backpressure limit exceeded, not sent

      server.onOpen(ws)

      strictEqual(server.sendTo('u1', 'x'), false)
    })

    test('should return false from sendTo/hasConnection for unknown key', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })

      strictEqual(server.sendTo('missing', 'x'), false)
      strictEqual(server.hasConnection('missing'), false)
      strictEqual(server.getConnection('missing'), undefined)
    })

    test('should gracefully close a connection by key and remove it from the registry immediately', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.closeConnection('u1', 1008, 'policy violation'), true)
      strictEqual(server.hasConnection('u1'), false)
      strictEqual(server.connectionCount, 0)
      strictEqual(server.getWsContext(ws).key, 'u1')
      deepStrictEqual(
        ws.calls.find(({ method }) => method === 'end'),
        {
          method: 'end',
          code: 1008,
          reason: 'policy violation'
        }
      )
      strictEqual(server.closeConnection('u1'), false)
    })

    test('should force-close a connection by key and remove it from the registry immediately', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.terminateConnection('u1'), true)
      strictEqual(server.hasConnection('u1'), false)
      strictEqual(server.connectionCount, 0)
      strictEqual(ws.getCloseCallCount(), 1)
      strictEqual(server.terminateConnection('u1'), false)
    })

    test('should validate addressed graceful close arguments before touching the registry', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      throws(() => server.closeConnection('u1', 1006, ''), {
        name: 'RangeError',
        message: 'WebSocket close code must be a valid wire code'
      })
      strictEqual(server.hasConnection('u1'), true)
      strictEqual(ws.getEndCallCount(), 0)
    })

    test('should not register when connectionKey returns nullish', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: () => null }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.getWsContext(ws).key, null)
    })

    test('should route connectionKey errors to onError and skip registration', () => {
      const errors: Error[] = []
      const boom = new Error('key boom')
      const server = makeServer({
        onRequest: () => {},
        ws: {
          connectionKey: () => {
            throw boom
          },
          onError: (_ctx, err) => errors.push(err)
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(errors.length, 1)
      strictEqual(at(errors, 0, 'connection error'), boom)
    })

    test('should unregister before onClose runs so sendTo cannot hit the closing socket', () => {
      let sendToResult = null

      const server = makeServer({
        onRequest: () => {},
        ws: {
          connectionKey: (ctx) => userId(ctx),
          onClose: () => {
            sendToResult = server.sendTo('u1', 'bye')
          }
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)
      server.onClose(ws, 1000, noise)

      strictEqual(sendToResult, false)
      strictEqual(server.connectionCount, 0)
    })

    test('should unregister during async onClose before its promise settles', async () => {
      const resolveClose = { value: null as (() => void) | null }

      const server = makeServer({
        onRequest: () => {},
        ws: {
          connectionKey: (ctx) => userId(ctx),
          onClose: () =>
            new Promise<void>((resolve) => {
              resolveClose.value = resolve
            })
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)
      server.onClose(ws, 1000, noise)

      // close promise is still pending — the registry must already be clean
      strictEqual(server.hasConnection('u1'), false)
      strictEqual(server.sendTo('u1', 'x'), false)

      requireDefined(resolveClose.value, 'close resolver')()
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(server.connectionCount, 0)
    })

    test('should remove the connection from the registry on close', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)
      strictEqual(server.connectionCount, 1)

      server.onClose(ws, 1000, noise)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.hasConnection('u1'), false)
    })

    test('should clear ctx.key of the displaced connection on same-key reconnect', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const wsOld = createMockWebSocket({ userId: 'u1' })
      const wsNew = createMockWebSocket({ userId: 'u1' })

      server.onOpen(wsOld)
      server.onOpen(wsNew)

      strictEqual(server.getWsContext(wsOld).key, null)
      strictEqual(server.getWsContext(wsNew).key, 'u1')
    })

    test('should let a reconnect with the same key win, and not be evicted by the old socket closing', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: { connectionKey: (ctx) => userId(ctx) }
      })
      const wsOld = createMockWebSocket({ userId: 'u1' })
      const wsNew = createMockWebSocket({ userId: 'u1' })

      server.onOpen(wsOld)
      server.onOpen(wsNew)

      // newer connection owns the key
      strictEqual(server.getConnection('u1'), wsNew)
      strictEqual(server.connectionCount, 1)

      // old socket closing must not evict the newer connection
      server.onClose(wsOld, 1000, noise)

      strictEqual(server.getConnection('u1'), wsNew)
      strictEqual(server.connectionCount, 1)

      // closing the newer socket clears it
      server.onClose(wsNew, 1000, noise)

      strictEqual(server.connectionCount, 0)
    })
  })

  describe('getSubscribersCount() and publish()', () => {
    test('should return 0 when WS disabled', () => {
      const server = makeServer({ onRequest: () => {} })

      strictEqual(server.getSubscribersCount('topic'), 0)
    })

    test('should return false when WS disabled', () => {
      const server = makeServer({ onRequest: () => {} })

      strictEqual(server.publish('topic', 'message'), false)
    })

    test('should return 0 when app not created', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      strictEqual(server.getSubscribersCount('topic'), 0)
      strictEqual(server.publish('topic', 'message'), false)
    })

    test('should call app.numSubscribers after listen', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      await server.listen()

      const mockApp = requireCurrentMockApp()

      mockApp.setNumSubscribersResult(7)

      strictEqual(server.getSubscribersCount('topic'), 7)

      const numSubsCall = mockApp.calls.find((c) => c.method === 'numSubscribers' && c.topic === 'topic')

      strictEqual(numSubsCall !== undefined, true)
    })

    test('should call app.publish with correct parameters', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      await server.listen()

      const mockApp = requireCurrentMockApp()

      mockApp.setPublishResult(true)

      strictEqual(server.publish('topic', 'message'), true)

      const publishCall = mockApp.calls.find((c) => c.method === 'publish' && c.topic === 'topic')

      strictEqual(publishCall !== undefined, true)
      strictEqual(requireDefined(publishCall, 'publish call').message, 'message')
      strictEqual(requireDefined(publishCall, 'publish call').isBinary, false)
    })

    test('should detect binary for ArrayBuffer', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      await server.listen()

      const mockApp = requireCurrentMockApp()
      const buffer = new Uint8Array([1, 2, 3]).buffer

      server.publish('topic', buffer)

      const publishCall = mockApp.calls.find((c) => c.method === 'publish' && c.topic === 'topic')

      strictEqual(requireDefined(publishCall, 'publish call').isBinary, true)
    })

    test('should use explicit isBinary parameter', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      await server.listen()

      const mockApp = requireCurrentMockApp()

      server.publish('topic', 'message', true)

      const publishCall = mockApp.calls.find((c) => c.method === 'publish' && c.topic === 'topic')

      strictEqual(requireDefined(publishCall, 'publish call').isBinary, true)
    })
  })

  describe('stopAccepting()', () => {
    test('should call us_listen_socket_close and clear socket', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.listen()
      const socket = server.socket

      server.stopAccepting()

      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 1)
      strictEqual(at(mockCalls.us_listen_socket_close, 0, 'listen socket close').socket, socket)
    })

    test('should do nothing when socket is null', () => {
      const server = makeServer({ onRequest: () => {} })

      server.stopAccepting()

      strictEqual(mockCalls.us_listen_socket_close.length, 0)
    })
  })

  describe('shutdown() and close()', () => {
    test('should resolve immediately when no active connections', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.shutdown(0)

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })

    test('should call stopAccepting on shutdown', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.listen()

      await server.shutdown(0)

      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 1)
    })

    test('should call app.close eventually', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.listen()
      const mockApp = requireCurrentMockApp()

      await server.shutdown(0)
      server.close()

      strictEqual(mockApp.getCloseCallCount(), 1)
      strictEqual(server.app, null)
    })

    test('should be idempotent', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.listen()
      const mockApp = requireCurrentMockApp()

      server.close()
      server.close()

      strictEqual(mockApp.getCloseCallCount(), 1)
    })

    test('should resolve shutdown promise after close', async () => {
      const server = makeServer({ onRequest: () => {} })

      await server.listen()

      const shutdownPromise = server.shutdown(0)

      server.close()

      await shutdownPromise

      strictEqual(server.app, null)
    })

    test('should wait for an in-flight listen cancellation before shutdown resolves', async () => {
      const server = makeServer({ onRequest: () => {} })

      setListenCallback((callback) => {
        setImmediate(() => callback({ socket: 'late' }))
      })

      const listening = server.listen()
      const shutdown = server.shutdown(0)

      await rejects(listening, { name: 'AbortError' })
      await shutdown

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })

    test('should return same promise for concurrent shutdown calls', async () => {
      const server = makeServer({ onRequest: () => {} })
      const promise1 = server.shutdown(0)
      const promise2 = server.shutdown(0)

      strictEqual(promise1, promise2)

      server.close()
      await promise1
    })
  })

  describe('onUpgrade()', () => {
    test('should return 503 when draining', () => {
      const server = makeServer({ onRequest: () => {} })

      server.shutdown(0)

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()
      const context = {}

      server.onUpgrade(res, req, context)

      strictEqual(res.getStatus(), STATUS_TEXT[503])
      strictEqual(res.getHeaders()['Connection'], 'close')
      strictEqual(res.isEnded(), true)
      strictEqual(res.isUpgraded(), false)

      const upgradeCall = res.calls.find((c) => c.method === 'upgrade')

      strictEqual(upgradeCall, undefined)
    })

    test('should upgrade when allowed (sync)', () => {
      const userData = { a: 1 }
      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: () => userData,
          selectProtocol: (requested, data) => {
            deepStrictEqual(requested, ['protocol123'])
            strictEqual(data, userData)

            return 'protocol123'
          }
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'key123')
      req.setHeader('sec-websocket-protocol', 'protocol123')
      req.setHeader('sec-websocket-extensions', 'extensions123')
      const context = { ctx: 'test' }

      server.onUpgrade(res, req, context)

      strictEqual(res.isUpgraded(), true)
      const upgradeCall = requireUpgradeCall(res.calls.find((c) => c.method === 'upgrade'))

      strictEqual(upgradeCall.userData.a, userData.a)
      strictEqual(upgradeCall.secKey, 'key123')
      strictEqual(upgradeCall.protocol, 'protocol123')
      strictEqual(upgradeCall.extensions, 'extensions123')
      strictEqual(upgradeCall.context, context)

      const status403Call = res.calls.find((c) => c.method === 'writeStatus' && c.status === STATUS_TEXT[403])

      strictEqual(status403Call, undefined)
    })

    test('should return 403 when denied (sync)', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: () => null
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()
      const context = {}

      server.onUpgrade(res, req, context)

      strictEqual(res.getStatus(), STATUS_TEXT[403])
      strictEqual(res.isEnded(), true)
      strictEqual(res.isUpgraded(), false)
    })

    test('should return 403 and call ws.onError when onUpgrade throws', async () => {
      const error = new Error('x')

      let errorCalled = false
      let errorCtx = null
      let errorErr = null

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: () => {
            throw error
          },
          onError: (ctx, err) => {
            errorCalled = true
            errorCtx = ctx
            errorErr = err
          }
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()
      const context = {}

      server.onUpgrade(res, req, context)

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res.getStatus(), STATUS_TEXT[403])
      strictEqual(res.isEnded(), true)
      strictEqual(res.isUpgraded(), false)
      strictEqual(errorCalled, true)
      strictEqual(errorCtx, null)
      strictEqual(errorErr, error)
    })

    test('should return 403 and call ws.onError when an upgrade then getter throws', async () => {
      let errorCalled = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: () => {
            const result = {}

            Object.defineProperty(result, 'then', {
              get() {
                throw new Error('then getter failed')
              }
            })

            return result
          },
          onError: () => {
            errorCalled++
          }
        }
      })
      const res = createMockHttpResponse()

      server.onUpgrade(res, createMockHttpRequest(), {})
      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[403])
      strictEqual(res.isEnded(), true)
      strictEqual(res.isUpgraded(), false)
      strictEqual(errorCalled, 1)
    })

    test('should capture non-header upgrade metadata and synchronously read headers before async detach', async () => {
      const gate = Promise.withResolvers<void>()
      const userData = { role: 'reader' }

      let observation

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: async (meta) => {
            const headers = meta.headers
            const headersBeforeAwait = { ...headers }
            const headerBeforeAwait = meta.getHeader('x-auth')

            await gate.promise

            observation = {
              url: meta.url(),
              parameter: meta.getParameter(0),
              query: meta.getQuery(),
              one: meta.getQuery('one'),
              missing: meta.getQuery('missing'),
              header: meta.getHeader('x-auth'),
              headerBeforeAwait,
              headersBeforeAwait,
              headers: { ...headers },
              stableHeaders: headers === meta.headers
            }

            return userData
          },
          selectProtocol: (requested, data) => {
            deepStrictEqual(requested, ['sync-protocol', 'events'])
            strictEqual(data, userData)

            return 'sync-protocol'
          }
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setUrl('/original')
      req.setParameter(0, 'original-param')
      req.setFullQuery('one=original&empty=')
      req.setHeader('sec-websocket-key', 'sync-key')
      req.setHeader('sec-websocket-protocol', 'sync-protocol, events')
      req.setHeader('sec-websocket-extensions', 'sync-extensions')
      req.setHeader('x-auth', 'original-token')
      const context = {}

      server.onUpgrade(res, req, context)

      req.setUrl('/stale')
      req.setParameter(0, 'stale-param')
      req.setFullQuery('one=stale')
      req.setHeader('sec-websocket-key', 'STALE-after-return')
      req.setHeader('sec-websocket-protocol', 'STALE-after-return')
      req.setHeader('sec-websocket-extensions', 'STALE-after-return')
      req.setHeader('x-auth', 'stale-token')

      gate.resolve()

      await new Promise((resolve) => setImmediate(resolve))

      const upgradeCall = requireUpgradeCall(res.calls.find((c) => c.method === 'upgrade'))

      deepStrictEqual(observation, {
        url: '/original',
        parameter: 'original-param',
        query: 'one=original&empty=',
        one: 'original',
        missing: undefined,
        header: 'original-token',
        headerBeforeAwait: 'original-token',
        headersBeforeAwait: {},
        headers: { 'x-auth': 'original-token' },
        stableHeaders: true
      })
      strictEqual(req.calls.filter((call) => call.method === 'forEach').length, 0)
      strictEqual(upgradeCall.userData.role, userData.role)
      strictEqual(upgradeCall.secKey, 'sync-key')
      strictEqual(upgradeCall.protocol, 'sync-protocol')
      strictEqual(upgradeCall.extensions, 'sync-extensions')
    })

    test('should keep upgrade meta.headers empty until named headers are read without prefetch', async () => {
      let observation

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: (meta) => {
            const headers = meta.headers

            observation = {
              before: { ...headers },
              header: meta.getHeader('x-auth'),
              after: { ...headers },
              stableHeaders: headers === meta.headers
            }

            return {}
          }
        }
      })

      await server.listen()

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'key')
      req.setHeader('x-auth', 'token')
      req.setHeader('x-omitted', 'not-read')
      server.onUpgrade(res, req, {})

      deepStrictEqual(observation, {
        before: {},
        header: 'token',
        after: { 'x-auth': 'token' },
        stableHeaders: true
      })
      strictEqual(req.calls.filter((call) => call.method === 'forEach').length, 0)
    })

    test('should selectively retain WebSocket upgrade headers without a full header iteration', async () => {
      const gate = Promise.withResolvers<void>()

      let observation

      const server = makeServer({
        onRequest: () => {},
        ws: {
          prefetchHeaders: ['x-auth'],
          onUpgrade: async (meta) => {
            await gate.promise

            observation = {
              url: meta.url(),
              auth: meta.getHeader('x-auth'),
              omitted: meta.getHeader('x-omitted'),
              headers: { ...meta.headers },
              stableHeaders: meta.headers === meta.headers
            }

            return {}
          }
        }
      })

      await server.listen()

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setUrl('/socket')
      req.setHeader('sec-websocket-key', 'key')
      req.setHeader('x-auth', 'original')
      req.setHeader('x-omitted', 'not-retained')
      server.onUpgrade(res, req, {})

      req.setUrl('/stale')
      req.setHeader('x-auth', 'stale')
      gate.resolve()
      await new Promise((resolve) => setImmediate(resolve))

      deepStrictEqual(observation, {
        url: '/socket',
        auth: 'original',
        omitted: '',
        headers: { 'x-auth': 'original' },
        stableHeaders: true
      })
      strictEqual(req.calls.filter((call) => call.method === 'prefetch').length, 1)
      strictEqual(
        req.calls.some((call) => call.method === 'forEach'),
        false
      )
      strictEqual(res.isUpgraded(), true)
    })

    test('should reject an unrequested subprotocol', async () => {
      const receivedError = { value: null as Error | null }

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: () => ({}),
          selectProtocol: () => 'admin',
          onError: (_ctx, err) => {
            receivedError.value = err
          }
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'key')
      req.setHeader('sec-websocket-protocol', 'chat, events')
      server.onUpgrade(res, req, {})

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res.isUpgraded(), false)
      strictEqual(res.getStatus(), STATUS_TEXT[403])
      strictEqual(receivedError.value?.message, 'WebSocket upgrade protocol was not requested by the client: admin')
    })

    test('should not upgrade when aborted before async resolve', async () => {
      const resolveFn = { value: null as ((value: object) => void) | null }

      const upgradePromise = new Promise<object>((resolve) => {
        resolveFn.value = resolve
      })
      const server = makeServer({
        onRequest: () => {},
        ws: {
          onUpgrade: () => upgradePromise
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'key')
      const context = {}

      server.onUpgrade(res, req, context)

      res.triggerAborted()

      requireDefined(resolveFn.value, 'upgrade resolver')({})

      await Promise.resolve()

      strictEqual(res.isUpgraded(), false)
      const upgradeCall = res.calls.find((c) => c.method === 'upgrade')

      strictEqual(upgradeCall, undefined)

      const status403Call = res.calls.find((c) => c.method === 'writeStatus' && c.status === STATUS_TEXT[403])

      strictEqual(status403Call, undefined)
    })

    test('should let an immediately resolved async decision win with a zero-millisecond timeout', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {
          upgradeTimeoutMs: 0,
          onUpgrade: () => Promise.resolve({ accepted: true })
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'key')
      server.onUpgrade(res, req, {})
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res.isUpgraded(), true)
      strictEqual(res.getStatus(), null)
    })

    test('should time out an unresolved upgrade at zero milliseconds', async () => {
      const receivedError = { value: null as (Error & { code?: string }) | null }

      const server = makeServer({
        onRequest: () => {},
        ws: {
          upgradeTimeoutMs: 0,
          onUpgrade: () => new Promise(() => {}),
          onError: (_ctx, error) => {
            receivedError.value = error as Error & { code?: string }
          }
        }
      })
      const res = createMockHttpResponse()

      server.onUpgrade(res, createMockHttpRequest(), {})
      await new Promise((resolve) => setTimeout(resolve, 10))

      strictEqual(res.getStatus(), STATUS_TEXT[408])
      strictEqual(receivedError.value?.code, 'WS_UPGRADE_TIMEOUT')
      strictEqual(receivedError.value?.message, 'WebSocket upgrade timed out after 0ms')
    })

    test('should terminate an async upgrade that exceeds ws.upgradeTimeoutMs', async () => {
      const receivedError = { value: null as (Error & { code?: string }) | null }

      const server = makeServer({
        onRequest: () => {},
        ws: {
          upgradeTimeoutMs: 100,
          onUpgrade: () => new Promise(() => {}),
          onError: (_ctx, error) => {
            receivedError.value = error as Error & { code?: string }
          }
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.onUpgrade(res, req, {})
      await new Promise((resolve) => setTimeout(resolve, 120))

      strictEqual(res.getStatus(), STATUS_TEXT[408])
      strictEqual(res.isEnded(), true)
      strictEqual(res.isUpgraded(), false)
      strictEqual(receivedError.value?.code, 'WS_UPGRADE_TIMEOUT')
    })
  })

  describe('onOpen()', () => {
    test('should end WebSocket with 1001 when draining', () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      server.shutdown(0)

      const ws = createMockWebSocket()

      server.onOpen(ws)

      strictEqual(ws.getEndCallCount(), 1)
      const endCall = requireDefined(
        ws.calls.find((c) => c.method === 'end'),
        'WebSocket end call'
      )

      strictEqual(endCall.code, 1001)
      strictEqual(endCall.reason, 'server shutting down')
    })
  })

  describe('handleWithContext()', () => {
    test('should respond 503 and close connection when draining', () => {
      const server = makeServer({ onRequest: () => 'ok' })

      server.shutdown(0)

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      strictEqual(res.getStatus(), STATUS_TEXT[503])
      strictEqual(res.getHeaders()['Connection'], 'close')
      strictEqual(res.isEnded(), true)
    })

    test('should register onAborted with ctx.onAbort', () => {
      const server = makeServer({ onRequest: () => 'ok' })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      const onAbortedCall = requireDefined(
        res.calls.find((c) => c.method === 'onAborted'),
        'onAborted callback'
      )

      strictEqual(typeof onAbortedCall.callback, 'function')
    })

    test('should stop processing when terminate synchronously triggers onAborted', () => {
      let errors = 0

      const server = makeServer({ onRequest: () => {}, httpError: () => errors++ })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, (ctx) => ctx.terminate())

      strictEqual(res.calls.filter(({ method }) => method === 'close').length, 1)
      strictEqual(res.calls.filter(({ method }) => method === 'end').length, 0)
      strictEqual(server.activeHttp, 0)
      strictEqual(errors, 0)
    })

    test('should retain an aborted async handler context until its promise settles', async () => {
      const resolveHandler = { value: null as ((value: unknown) => void) | null }

      const server = makeServer({ onRequest: () => {} })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, (ctx) => {
        ctx.terminate()

        return new Promise<unknown>((resolve) => {
          resolveHandler.value = resolve
        })
      })

      strictEqual(server.activeHttp, 0)

      requireDefined(resolveHandler.value, 'handler resolver')('late response')
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res.calls.filter(({ method }) => method === 'end').length, 0)
    })

    test('aborted async request must not deliver its late result to a reused context', async () => {
      const server = makeServer({ onRequest: () => 'ok' })

      const resolveFirst = { value: null as ((value: unknown) => void) | null }

      const res1 = createMockHttpResponse()
      const req1 = createMockHttpRequest()

      server.handleWithContext(
        res1,
        req1,
        () =>
          new Promise<unknown>((resolve) => {
            resolveFirst.value = resolve
          })
      )

      // client 1 disconnects while its handler is still awaiting
      res1.triggerAborted()

      // a new request acquires the released context instance from the pool
      const res2 = createMockHttpResponse()
      const req2 = createMockHttpRequest()

      server.handleWithContext(res2, req2, () => new Promise(() => {}))

      // the late result of the aborted request must go nowhere
      requireDefined(resolveFirst.value, 'first handler resolver')('secret for client 1')
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res2.isEnded(), false)
    })

    test('should sendError and call http.onError when handler throws (sync), and finalize when not streaming', async () => {
      let safeErrCalled = 0
      let finalizeCalled = 0

      const server = makeServer({
        onRequest: () => {
          throw Object.assign(new Error('bad'), { status: 400 })
        },
        httpError: (_ctx, _err) => {
          safeErrCalled++
        }
      })
      const originalFinalize = server.finalizeHttpContext.bind(server)

      server.finalizeHttpContext = (ctx) => {
        finalizeCalled++

        return originalFinalize(ctx)
      }

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[400])
      strictEqual(res.isEnded(), true)
      strictEqual(safeErrCalled, 1)
      strictEqual(finalizeCalled, 1)
    })

    test('should keep an async http.onError context isolated until the hook settles', async () => {
      const hook = Promise.withResolvers<void>()
      const observed: { before?: string; after?: string; header?: string } = {}
      const server = makeServer({
        onRequest: () => {},
        httpError: async (ctx) => {
          observed.before = ctx.getUrl()
          observed.header = ctx.getReqHeader('x-request-id')
          await hook.promise
          observed.after = ctx.getUrl()
        }
      })
      const requestA = createMockHttpRequest()
      const responseA = createMockHttpResponse()

      requestA.setUrl('/request-a')
      requestA.setHeader('x-request-id', 'a')
      server.handleWithContext(responseA, requestA, () => {
        throw new Error('request A failed')
      })

      strictEqual(poolSize(server.httpContextPool), 0)

      const requestB = createMockHttpRequest()
      const responseB = createMockHttpResponse()

      requestB.setUrl('/request-b')
      server.handleWithContext(responseB, requestB, () => 'response B')

      hook.resolve()
      await new Promise((resolve) => setImmediate(resolve))

      deepStrictEqual(observed, { before: '/request-a', after: '/request-a', header: 'a' })
      strictEqual(responseB.getStatus(), STATUS_TEXT[200])
      strictEqual(responseEndBody(responseB.calls.find(({ method }) => method === 'end')), 'response B')
      strictEqual(poolSize(server.httpContextPool), 2)
    })

    test('should not expose a non-prefetched header to an error hook after an async handler rejects', async () => {
      const rejectHandler = Promise.withResolvers<void>()

      let header = ''

      const server = makeServer({
        onRequest: async () => {
          await rejectHandler.promise
          throw new Error('async failure')
        },
        httpError: (ctx) => {
          header = ctx.getReqHeader('x-request-id')
        }
      })
      const request = createMockHttpRequest()

      request.setHeader('x-request-id', 'original')
      server.handleWithContext(createMockHttpResponse(), request, requireHandler(requireHttp(server).onRequest))
      request.setHeader('x-request-id', 'stale')
      rejectHandler.resolve()

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(header, '')
    })

    test('should finalize a pending handler after an early response reaches requestTimeoutMs', async () => {
      const pending = Promise.withResolvers<void>()
      const server = makeServer({
        http: {
          requestTimeoutMs: 100,
          onRequest: (ctx) => {
            ctx.sendText('ok')

            return pending.promise
          }
        }
      })
      const response = createMockHttpResponse()

      server.handleWithContext(response, createMockHttpRequest(), requireHandler(requireHttp(server).onRequest))
      await new Promise((resolve) => setTimeout(resolve, 150))

      strictEqual(response.getStatus(), STATUS_TEXT[200])
      strictEqual(responseEndBody(response.calls.find(({ method }) => method === 'end')), 'ok')
      strictEqual(server.activeHttp, 0)

      pending.resolve()
      await new Promise((resolve) => setImmediate(resolve))
    })

    test('should contain a throwing then getter like a handler error', async () => {
      const error = new Error('then getter failed')

      let reported = 0

      const server = makeServer({
        onRequest: () => {},
        httpError: () => {
          reported++
        }
      })
      const response = createMockHttpResponse()
      const thenable = {}

      Object.defineProperty(thenable, 'then', {
        get() {
          response.triggerAborted()

          throw error
        }
      })

      server.handleWithContext(response, createMockHttpRequest(), () => thenable)

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(response.isEnded(), false)
      strictEqual(reported, 1)
      strictEqual(server.activeHttp, 0)
      strictEqual(poolSize(server.httpContextPool), 1)
    })

    test('should NOT finalize when ctx.streaming=true after sync throw', async () => {
      let safeErrCalled = 0
      let finalizeCalled = 0

      const server = makeServer({
        onRequest: (ctx) => {
          ctx.streaming = true
          throw new Error('x')
        },
        httpError: (_ctx, _err) => {
          safeErrCalled++
        }
      })
      const originalFinalize = server.finalizeHttpContext.bind(server)

      server.finalizeHttpContext = (ctx) => {
        finalizeCalled++

        return originalFinalize(ctx)
      }

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      await Promise.resolve()

      strictEqual(safeErrCalled, 1)
      strictEqual(finalizeCalled, 0)
    })

    test('should handle promise resolve via ctx.onResolve and finalize if not streaming', async () => {
      let finalizeCalled = 0

      const server = makeServer({
        onRequest: () => Promise.resolve('ok')
      })
      const originalFinalize = server.finalizeHttpContext.bind(server)

      server.finalizeHttpContext = (ctx) => {
        finalizeCalled++

        return originalFinalize(ctx)
      }

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[200])
      strictEqual(res.isEnded(), true)
      strictEqual(finalizeCalled, 1)
    })

    test('should handle promise reject via ctx.onReject, sendError, http.onError, and finalize', async () => {
      let safeErrCalled = 0
      let finalizeCalled = 0

      const server = makeServer({
        onRequest: () => Promise.reject(Object.assign(new Error('no'), { status: 401 })),
        httpError: (_ctx, _err) => {
          safeErrCalled++
        }
      })
      const originalFinalize = server.finalizeHttpContext.bind(server)

      server.finalizeHttpContext = (ctx) => {
        finalizeCalled++

        return originalFinalize(ctx)
      }

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[401])
      strictEqual(res.isEnded(), true)
      strictEqual(safeErrCalled, 1)
      strictEqual(finalizeCalled, 1)
    })

    test('when promise resolves but ctx.send throws, it should sendError(500) and call http.onError', async () => {
      let safeErrCalled = 0

      const server = makeServer({
        onRequest: () =>
          Promise.resolve({
            toJSON() {
              throw new Error('boom')
            }
          }),
        httpError: (_ctx, _err) => {
          safeErrCalled++
        }
      })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, requireHandler(requireHttp(server).onRequest))

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[500])
      strictEqual(res.getHeaders()['content-type'], 'text/plain; charset=utf-8')
      strictEqual(safeErrCalled, 1)
    })
  })

  describe('WS event handlers', () => {
    test('onDropped: should expose the connection context and rejected payload', () => {
      const received = { value: null as { ctx: WSContext; message: ArrayBuffer; isBinary: boolean } | null }

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onDropped: (ctx, message, isBinary) => {
            received.value = { ctx, message, isBinary }
          }
        }
      })
      const ws = createMockWebSocket({ id: 'slow-1' })
      const message = new Uint8Array([1, 2, 3]).buffer

      server.onOpen(ws)
      server.onDropped(ws, message, true)

      const dropped = requireDefined(received.value, 'dropped message')

      strictEqual(dropped.ctx, server.getWsContext(ws))
      strictEqual((requireDefined(dropped.ctx.data, 'dropped WebSocket data') as { id?: unknown }).id, 'slow-1')
      strictEqual(dropped.message, message)
      strictEqual(dropped.isBinary, true)
    })

    test('onDropped: should route sync and async handler errors to onError', async () => {
      let calls = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onDropped: () => {
            calls++

            if (calls === 1) {
              throw new Error('sync drop error')
            }

            return Promise.reject(new Error('async drop error'))
          },
          onError: () => {
            calls++
          }
        }
      })
      const ws = createMockWebSocket()
      const message = new ArrayBuffer(0)

      server.onOpen(ws)
      server.onDropped(ws, message, false)
      await Promise.resolve()

      strictEqual(calls, 2)

      server.onDropped(ws, message, false)
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(calls, 4)
    })

    test('onMessage: should call handler and route thrown errors to ws.onError', async () => {
      let errorCalled = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onMessage: () => {
            throw new Error('x')
          },
          onError: (_ctx, _err) => {
            errorCalled++
          }
        }
      })
      const ws = createMockWebSocket()

      server.onOpen(ws)
      server.onMessage(ws, new Uint8Array([1]).buffer, true)

      await Promise.resolve()

      strictEqual(errorCalled, 1)
    })

    test('onMessage: async reject should call ws.onError', async () => {
      let errorCalled = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onMessage: async () => {
            throw new Error('x')
          },
          onError: (_ctx, _err) => {
            errorCalled++
          }
        }
      })
      const ws = createMockWebSocket()

      server.onOpen(ws)
      server.onMessage(ws, new Uint8Array([1]).buffer, true)

      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(errorCalled, 1)
    })

    test('onMessage: rejected thenable without catch should call ws.onError', async () => {
      let errorCalled = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onMessage: () => ({
            then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
              reject(new Error('x'))
            }
          }),
          onError: () => {
            errorCalled++
          }
        }
      })
      const ws = createMockWebSocket()

      server.onOpen(ws)
      server.onMessage(ws, new Uint8Array([1]).buffer, true)

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(errorCalled, 1)
    })

    test('onClose: must deleteWsContext and decrement activeWs even if onClose throws', async () => {
      let errorCalled = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onClose: () => {
            throw new Error('close error')
          },
          onError: (_ctx, _err) => {
            errorCalled++
          }
        }
      })
      const ws = createMockWebSocket()

      server.onOpen(ws)
      const ctx = server.getWsContext(ws)

      strictEqual(ctx.ws, ws)

      server.onClose(ws, 1000, new Uint8Array([1]).buffer)

      await Promise.resolve()

      // context deleted (and cleared) after the close handler throws
      strictEqual(ctx.ws, null)
      strictEqual(errorCalled, 1)
    })

    test('onClose: async onClose should deleteWsContext only after promise settles', async () => {
      const resolveFn = { value: null as (() => void) | null }

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onClose: () =>
            new Promise<void>((resolve) => {
              resolveFn.value = resolve
            })
        }
      })
      const ws = createMockWebSocket()

      server.onOpen(ws)
      const ctx = server.getWsContext(ws)

      strictEqual(ctx.ws, ws)

      server.onClose(ws, 1000, new Uint8Array([1]).buffer)

      // still registered while the async close handler is pending
      strictEqual(ctx.ws, ws)

      requireDefined(resolveFn.value, 'close handler resolver')()

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(ctx.ws, null)
    })

    test('onClose: should copy the native close reason before an async hook can observe it', async () => {
      const received: { reason?: ArrayBuffer } = {}
      const server = makeServer({
        onRequest: () => {},
        ws: {
          onClose: async (_ctx, _code, reason) => {
            await Promise.resolve()
            received.reason = reason
          }
        }
      })
      const ws = createMockWebSocket()
      const nativeReason = new TextEncoder().encode('audit-reason').buffer

      server.onOpen(ws)
      server.onClose(ws, 4000, nativeReason)

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(received.reason === nativeReason, false)
      strictEqual(new TextDecoder().decode(received.reason), 'audit-reason')
    })

    test('onClose: should clean up when a then getter throws', async () => {
      let errors = 0

      const server = makeServer({
        onRequest: () => {},
        ws: {
          onClose: () => {
            const result = {}

            Object.defineProperty(result, 'then', {
              get() {
                throw new Error('then getter failed')
              }
            })

            return result
          },
          onError: () => {
            errors++
          }
        }
      })
      const ws = createMockWebSocket()

      server.onOpen(ws)
      const ctx = server.getWsContext(ws)

      server.onClose(ws, 1000, new ArrayBuffer(0))
      await Promise.resolve()

      strictEqual(ctx.ws, null)
      strictEqual(errors, 1)
    })

    test('shutdown should close app only after activeWs becomes 0 (finishShutdownIfNeed)', async () => {
      const server = makeServer({
        onRequest: () => {},
        ws: {}
      })

      await server.listen()
      const mockApp = requireCurrentMockApp()
      const ws = createMockWebSocket()

      server.onOpen(ws)

      const shutdownPromise = server.shutdown(0)

      strictEqual(mockApp.getCloseCallCount(), 0)

      server.onClose(ws, 1000, new Uint8Array([1]).buffer)

      await Promise.resolve()

      strictEqual(mockApp.getCloseCallCount(), 1)
      await shutdownPromise
    })
  })
})
