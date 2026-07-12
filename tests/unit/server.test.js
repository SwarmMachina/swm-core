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
  resetMockApp,
  setListenCallback
} from '../helpers/mock-uws-module.js'
import { STATUS_TEXT } from '../../src/constants.js'

// These unit tests exercise the Server against the uWS mock (installed via the
// loader hook), so they pin the uws backend. The backend-selection describe
// block below uses `new Server` directly to test the default and validation.
const makeServer = (opt) => new Server({ backend: 'uws', ...opt })

describe('Server', () => {
  beforeEach(() => {
    resetMockApp()
  })

  afterEach(() => {
    resetMockApp()
  })

  describe('constructor', () => {
    test('should create server with router option', () => {
      const router = () => {}
      const server = makeServer({ router })

      strictEqual(server.router, router)
      strictEqual(server.routes, null)
      strictEqual(server.useNativeRouting, false)
      strictEqual(server.port, 6000)
      strictEqual(server.maxBodyBytes, 1024 * 1024)
      strictEqual(server.wsEnabled, false)
    })

    test('should create server with routes option', () => {
      const routes = [{ method: 'get', path: '/', handler: () => {} }]
      const server = makeServer({ routes })

      strictEqual(server.router, null)
      strictEqual(server.routes, routes)
      strictEqual(server.useNativeRouting, true)
      strictEqual(server.port, 6000)
      strictEqual(server.maxBodyBytes, 1024 * 1024)
      strictEqual(server.wsEnabled, false)
    })

    test('should use custom port', () => {
      const server = makeServer({ router: () => {}, port: 3000 })

      strictEqual(server.port, 3000)
    })

    test('should use custom maxBodySize', () => {
      const server = makeServer({ router: () => {}, maxBodySize: 5 })

      strictEqual(server.maxBodyBytes, 5 * 1024 * 1024)
    })

    test('should use custom onHttpError handler', () => {
      const onHttpError = () => {}
      const server = makeServer({ router: () => {}, onHttpError })

      strictEqual(server.onHttpError, onHttpError)
    })

    test('should use default onHttpError when not provided', () => {
      const server = makeServer({ router: () => {} })

      strictEqual(typeof server.onHttpError, 'function')
    })

    test('should use custom onServerError handler', () => {
      const onServerError = () => {}
      const server = makeServer({ router: () => {}, onServerError })

      strictEqual(server.onServerError, onServerError)
    })

    test('should throw error when both router and routes are provided', () => {
      throws(() => makeServer({ router: () => {}, routes: [] }), {
        name: 'TypeError',
        message: 'Cannot use both "router" and "routes" options. Choose one.'
      })
    })

    test('should throw error when neither router nor routes are provided', () => {
      throws(() => makeServer({}), {
        name: 'TypeError',
        message: 'Either "router" or "routes" option must be provided'
      })
    })

    test('should throw error when router is not a function', () => {
      throws(() => makeServer({ router: 'not a function' }), {
        name: 'TypeError',
        message: 'Router must be a function'
      })
    })

    test('should throw error when routes is not an array', () => {
      throws(() => makeServer({ routes: 'not an array' }), {
        name: 'TypeError',
        message: 'Routes must be an array'
      })
    })

    test('should throw error when port is not a number', () => {
      throws(() => makeServer({ router: () => {}, port: '3000' }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is 0', () => {
      throws(() => makeServer({ router: () => {}, port: 0 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is negative', () => {
      throws(() => makeServer({ router: () => {}, port: -1 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is greater than 65535', () => {
      throws(() => makeServer({ router: () => {}, port: 65536 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should accept valid port range', () => {
      const server1 = makeServer({ router: () => {}, port: 1 })

      strictEqual(server1.port, 1)

      const server2 = makeServer({ router: () => {}, port: 65535 })

      strictEqual(server2.port, 65535)
    })

    test('should throw error when maxBodySize is not a number', () => {
      throws(() => makeServer({ router: () => {}, maxBodySize: '1' }), {
        name: 'TypeError',
        message: 'Max body size must be in range 1 - 64'
      })
    })

    test('should throw error when maxBodySize is less than 1', () => {
      throws(() => makeServer({ router: () => {}, maxBodySize: 0 }), {
        name: 'TypeError',
        message: 'Max body size must be in range 1 - 64'
      })
    })

    test('should throw error when maxBodySize is greater than 64', () => {
      throws(() => makeServer({ router: () => {}, maxBodySize: 65 }), {
        name: 'TypeError',
        message: 'Max body size must be in range 1 - 64'
      })
    })

    test('should accept valid maxBodySize range', () => {
      const server1 = makeServer({ router: () => {}, maxBodySize: 1 })

      strictEqual(server1.maxBodyBytes, 1024 * 1024)

      const server2 = makeServer({ router: () => {}, maxBodySize: 64 })

      strictEqual(server2.maxBodyBytes, 64 * 1024 * 1024)
    })

    test('should enable WebSocket when ws.enabled is true', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      strictEqual(server.wsEnabled, true)
      strictEqual(server.wsIdleTimeoutSec, 15)
    })

    test('should enable WebSocket when ws handlers are provided', () => {
      const server = makeServer({
        router: () => {},
        ws: { onMessage: () => {} }
      })

      strictEqual(server.wsEnabled, true)
    })

    test('should disable WebSocket when ws is not provided', () => {
      const server = makeServer({ router: () => {} })

      strictEqual(server.wsEnabled, false)
    })

    test('should disable WebSocket when ws.enabled is false', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: false, onMessage: () => {} }
      })

      strictEqual(server.wsEnabled, false)
    })

    test('should use custom wsIdleTimeoutSec', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, wsIdleTimeoutSec: 30 }
      })

      strictEqual(server.wsIdleTimeoutSec, 30)
    })

    test('should throw error when wsIdleTimeoutSec is less than 5', () => {
      throws(
        () =>
          makeServer({
            router: () => {},
            ws: { enabled: true, wsIdleTimeoutSec: 4 }
          }),
        {
          name: 'TypeError',
          message: 'wsIdleTimeoutSec must be >= 5'
        }
      )
    })

    test('should validate wsUpgradeTimeoutMs', () => {
      throws(() => makeServer({ router: () => {}, ws: { enabled: true, wsUpgradeTimeoutMs: 99 } }), {
        name: 'TypeError',
        message: 'wsUpgradeTimeoutMs must be in range 100 - 300000'
      })
      throws(() => makeServer({ router: () => {}, ws: { enabled: true, wsUpgradeTimeoutMs: 300_001 } }), {
        name: 'TypeError',
        message: 'wsUpgradeTimeoutMs must be in range 100 - 300000'
      })
    })

    test('should assign WebSocket handlers when provided', () => {
      const onOpen = () => {}
      const onClose = () => {}
      const onError = () => {}
      const onMessage = () => {}
      const onDrain = () => {}
      const onSubscription = () => {}
      const onUpgrade = () => Promise.resolve({ isAllowed: true })

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onOpen,
          onClose,
          onError,
          onMessage,
          onDrain,
          onSubscription,
          onUpgrade
        }
      })

      strictEqual(server.onWsOpen, onOpen)
      strictEqual(server.onWsClose, onClose)
      strictEqual(server.onWsError, onError)
      strictEqual(server.onWsMessage, onMessage)
      strictEqual(server.onWsDrain, onDrain)
      strictEqual(server.onWsSubscription, onSubscription)
      strictEqual(server.onWsUpgrade, onUpgrade)
    })

    test('should initialize context pools', () => {
      const server = makeServer({ router: () => {} })

      strictEqual(server.httpContextPool !== null, true)
      strictEqual(server.wsContextPool !== null, true)
    })

    test('should initialize internal state', () => {
      const server = makeServer({ router: () => {} })

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })
  })

  describe('backend selection', () => {
    // This block tests the backend option itself, so it uses `new Server`
    // directly (not the uws-pinning makeServer helper).
    test('should default to the uws backend', () => {
      const server = new Server({ router: () => {} })

      strictEqual(server.backend, 'uws')
    })

    test('should accept the opt-in node backend', () => {
      const server = new Server({ router: () => {}, backend: 'node' })

      strictEqual(server.backend, 'node')
    })

    test('should throw on an unknown backend', () => {
      throws(() => new Server({ router: () => {}, backend: 'bogus' }), {
        name: 'TypeError',
        message: "backend must be 'uws' or 'node'"
      })
    })

    test('keeps the node backend when combined with WebSocket options', () => {
      const server = new Server({
        router: () => {},
        backend: 'node',
        ws: { onMessage: () => {} }
      })

      // The node backend serves WebSocket natively when explicitly selected.
      strictEqual(server.backend, 'node')
      strictEqual(server.wsEnabled, true)
    })

    test('should load the backend lazily via listen(), not in the constructor', () => {
      // Constructing must not touch the uws module at all.
      new Server({ router: () => {}, backend: 'uws' })

      strictEqual(getCurrentMockApp(), null)
    })
  })

  describe('listen()', () => {
    test('should register router handler with app.any', async () => {
      const router = () => {}
      const server = makeServer({ router, port: 7000 })

      await server.listen()

      const mockApp = getCurrentMockApp()

      strictEqual(mockApp !== null, true)
      strictEqual(mockApp.calls.length, 1)
      strictEqual(mockApp.calls[0].method, 'any')
      strictEqual(mockApp.calls[0].path, '/*')
      strictEqual(typeof mockApp.calls[0].handler, 'function')
      strictEqual(server.socket !== null, true)
      strictEqual(server.app !== null, true)
    })

    test('should return server instance on successful listen', async () => {
      const server = makeServer({ router: () => {} })

      const result = await server.listen()

      strictEqual(result, server)
      strictEqual(server.socket !== null, true)
    })

    test('should return same promise for concurrent listen calls', async () => {
      const server = makeServer({ router: () => {} })

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
      const server = makeServer({ router: () => {} })

      await server.listen()

      const result = await server.listen()

      strictEqual(result, server)
    })

    test('should reject on listen failure', async () => {
      const server = makeServer({ router: () => {}, port: 8000 })

      setListenCallback((cb) => {
        cb(null)
      })

      await rejects(server.listen(), {
        message: 'Listen failed on :8000'
      })

      strictEqual(server.socket, null)
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

      const mockApp = getCurrentMockApp()
      const routeCalls = mockApp.calls.filter((c) => c.method !== 'ws')

      strictEqual(routeCalls.length, 3)
      strictEqual(routeCalls[0].method, 'get')
      strictEqual(routeCalls[0].path, '/x')
      strictEqual(routeCalls[1].method, 'del')
      strictEqual(routeCalls[1].path, '/d')
      strictEqual(routeCalls[2].method, 'post')
      strictEqual(routeCalls[2].path, '/p')
    })

    test('should pre-cache route params so async handlers see them after await, not a stale req', async () => {
      let paramById
      let paramByIndex

      const routes = [
        {
          method: 'get',
          path: '/users/:id',
          handler: async (ctx) => {
            await Promise.resolve()
            paramById = ctx.param('id')
            paramByIndex = ctx.param(0)
          }
        }
      ]
      const server = makeServer({ routes })

      await server.listen()

      const mockApp = getCurrentMockApp()
      const routeCall = mockApp.calls.find((c) => c.method !== 'ws')
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

    test('should throw on invalid HTTP method', async () => {
      const routes = [{ method: 'trace', path: '/x', handler: () => {} }]
      const server = makeServer({ routes })

      await rejects(
        (async () => {
          await server.listen()
        })(),
        (err) => {
          return err.name === 'TypeError' && err.message === 'Invalid HTTP method: trace'
        }
      )
    })

    test('should throw on invalid path (not starting with /)', async () => {
      const routes = [{ method: 'get', path: 'x', handler: () => {} }]
      const server = makeServer({ routes })

      await rejects(
        (async () => {
          await server.listen()
        })(),
        (err) => {
          return err.name === 'TypeError' && err.message === 'Invalid Path in route, method: get, path: x'
        }
      )
    })

    test('should not finalize the context or skip the chain when a preHandler starts streaming', async () => {
      let mainHandlerCalled = false

      const routes = [
        {
          method: 'get',
          path: '/x',
          preHandler: (ctx) => {
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

      const mockApp = getCurrentMockApp()
      const routeCall = mockApp.calls.find((c) => c.method !== 'ws')
      const req = createMockHttpRequest()
      const res = createMockHttpResponse()

      routeCall.handler(res, req)

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(mainHandlerCalled, true)
    })

    test('should throw on invalid preHandler (not a function)', async () => {
      const routes = [{ method: 'get', path: '/x', handler: () => {}, preHandler: 'nope' }]
      const server = makeServer({ routes })

      await rejects(
        (async () => {
          await server.listen()
        })(),
        (err) => {
          return (
            err.name === 'TypeError' && err.message === 'Route preHandler must be a function or an array of functions'
          )
        }
      )
    })

    test('should throw when a preHandler array contains a non-function', async () => {
      const routes = [{ method: 'get', path: '/x', handler: () => {}, preHandler: [() => {}, 42] }]
      const server = makeServer({ routes })

      await rejects(
        (async () => {
          await server.listen()
        })(),
        (err) => {
          return (
            err.name === 'TypeError' && err.message === 'Route preHandler must be a function or an array of functions'
          )
        }
      )
    })

    test('should register WebSocket when wsEnabled is true', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, wsIdleTimeoutSec: 20 }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()
      const wsCall = mockApp.calls.find((c) => c.method === 'ws')

      strictEqual(wsCall !== undefined, true)
      strictEqual(wsCall.path, '/*')
      strictEqual(wsCall.config.idleTimeout, 20)
      strictEqual(wsCall.config.upgradeTimeout, 10_000)
      strictEqual(wsCall.config.maxPayloadLength, 1024 * 1024)
      strictEqual(typeof wsCall.config.open, 'function')
      strictEqual(typeof wsCall.config.message, 'function')
      strictEqual(typeof wsCall.config.close, 'function')
      strictEqual(typeof wsCall.config.drain, 'function')
      strictEqual(typeof wsCall.config.subscription, 'function')
      strictEqual(typeof wsCall.config.upgrade, 'function')
    })

    test('should use default wsIdleTimeoutSec when not provided', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()
      const wsCall = mockApp.calls.find((c) => c.method === 'ws')

      strictEqual(wsCall.config.idleTimeout, 15)
      strictEqual(wsCall.config.upgradeTimeout, 10_000)
    })

    test('should pass custom wsUpgradeTimeoutMs to the backend', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, wsUpgradeTimeoutMs: 2500 }
      })

      await server.listen()

      const wsCall = getCurrentMockApp().calls.find((c) => c.method === 'ws')

      strictEqual(wsCall.config.upgradeTimeout, 2500)
    })
  })

  describe('safeCall()', () => {
    test('should call function and swallow errors', async () => {
      const server = makeServer({ router: () => {} })
      let called = 0

      await server.safeCall(() => {
        called++
        throw new Error('test error')
      })

      strictEqual(called, 1)
    })

    test('should handle async functions', async () => {
      const server = makeServer({ router: () => {} })
      let called = 0

      await server.safeCall(async () => {
        called++
        throw new Error('test error')
      })

      strictEqual(called, 1)
    })

    test('should do nothing for non-function', async () => {
      const server = makeServer({ router: () => {} })

      await server.safeCall(null)
      await server.safeCall(undefined)
      await server.safeCall('not a function')
      await server.safeCall(123)
    })

    test('should pass arguments correctly', async () => {
      const server = makeServer({ router: () => {} })
      let receivedArgs = null

      await server.safeCall(
        (...args) => {
          receivedArgs = args
        },
        'a',
        'b',
        123
      )

      deepStrictEqual(receivedArgs, ['a', 'b', 123])
    })
  })

  describe('safeWsError()', () => {
    test('should call onWsError handler', async () => {
      let called = false
      let receivedCtx = null
      let receivedErr = null

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onError: (ctx, err) => {
            called = true
            receivedCtx = ctx
            receivedErr = err
          }
        }
      })

      const ctx = { test: 'context' }
      const err = new Error('test error')

      await server.safeWsError(ctx, err)

      strictEqual(called, true)
      strictEqual(receivedCtx, ctx)
      strictEqual(receivedErr, err)
    })

    test('should swallow errors from onWsError', async () => {
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onError: () => {
            throw new Error('handler error')
          }
        }
      })

      await server.safeWsError(null, new Error('test'))
    })
  })

  describe('safeHttpError()', () => {
    test('should call onHttpError handler', async () => {
      let called = false
      let receivedCtx = null
      let receivedErr = null

      const server = makeServer({
        router: () => {},
        onHttpError: (ctx, err) => {
          called = true
          receivedCtx = ctx
          receivedErr = err
        }
      })

      const ctx = { test: 'context' }
      const err = new Error('test error')

      await server.safeHttpError(ctx, err)

      strictEqual(called, true)
      strictEqual(receivedCtx, ctx)
      strictEqual(receivedErr, err)
    })

    test('should swallow errors from onHttpError', async () => {
      const server = makeServer({
        router: () => {},
        onHttpError: () => {
          throw new Error('handler error')
        }
      })

      await server.safeHttpError({}, new Error('test'))
    })
  })

  describe('WebSocket context lifecycle', () => {
    test('should create and cache WS context', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
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
        router: () => {},
        ws: { enabled: true }
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
        router: () => {},
        ws: { enabled: true }
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

    test('should call release on context when deleted', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      const ws = createMockWebSocket()
      const ctx = server.getWsContext(ws)

      let called = 0
      const orig = ctx.release.bind(ctx)

      ctx.release = () => {
        called++
        return orig()
      }

      server.deleteWsContext(ws)

      strictEqual(called, 1)
    })

    test('should handle deleteWsContext when no context exists', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      const ws = createMockWebSocket()

      server.deleteWsContext(ws)
    })
  })

  describe('WebSocket connection registry (connectionKey / sendTo)', () => {
    const noise = new ArrayBuffer(0)

    test('should throw when connectionKey is not a function', () => {
      throws(() => makeServer({ router: () => {}, ws: { enabled: true, connectionKey: 'nope' } }), {
        name: 'TypeError',
        message: 'ws.connectionKey must be a function'
      })
    })

    test('should throw for invalid connectionKey even when ws is disabled', () => {
      throws(() => makeServer({ router: () => {}, ws: { enabled: false, connectionKey: 'nope' } }), {
        name: 'TypeError',
        message: 'ws.connectionKey must be a function'
      })
    })

    test('should auto-enable WS when connectionKey is the only ws option', () => {
      const server = makeServer({
        router: () => {},
        ws: { connectionKey: (ctx) => ctx.data.userId }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      strictEqual(server.wsEnabled, true)

      server.onOpen(ws)

      strictEqual(server.hasConnection('u1'), true)
    })

    test('should not register a connection that connectionKey closed synchronously', () => {
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          connectionKey: (ctx) => {
            const key = ctx.data.userId

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
        server.onClose(ws, code, noise)
      }

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.hasConnection('u1'), false)
    })

    test('should not invoke onOpen when connectionKey closed the connection', () => {
      const opened = []
      const closed = []
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
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
        server.onClose(ws, code, noise)
      }

      server.onOpen(ws)

      strictEqual(opened.length, 0)
      strictEqual(closed.length, 1)
    })

    test('should not register when connectionKey returns NaN', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: () => NaN }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.getWsContext(ws).key, null)
    })

    test('should not maintain a registry when connectionKey is unset', () => {
      const server = makeServer({ router: () => {}, ws: { enabled: true } })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.hasConnection('u1'), false)
      strictEqual(server.sendTo('u1', 'hi'), false)
    })

    test('should register a connection on open and expose it via the registry API', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
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
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.sendTo('u1', 'hello'), true)

      const sent = ws.calls.filter((c) => c.method === 'send')

      strictEqual(sent.length, 1)
      strictEqual(sent[0].data, 'hello')
      strictEqual(sent[0].isBinary, false)
    })

    test('should default isBinary from payload type in sendTo', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      const buf = Buffer.from('x')

      server.sendTo('u1', buf)

      const sent = ws.calls.filter((c) => c.method === 'send')

      strictEqual(sent[0].data, buf)
      strictEqual(sent[0].isBinary, true)
    })

    test('should return false from sendTo when uWS reports the message dropped', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      ws.send = () => 2 // uWS DROPPED: backpressure limit exceeded, not sent

      server.onOpen(ws)

      strictEqual(server.sendTo('u1', 'x'), false)
    })

    test('should return false from sendTo/hasConnection for unknown key', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
      })

      strictEqual(server.sendTo('missing', 'x'), false)
      strictEqual(server.hasConnection('missing'), false)
      strictEqual(server.getConnection('missing'), undefined)
    })

    test('should not register when connectionKey returns nullish', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: () => null }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(server.getWsContext(ws).key, null)
    })

    test('should route connectionKey errors to onError and skip registration', () => {
      const errors = []
      const boom = new Error('key boom')
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          connectionKey: () => {
            throw boom
          },
          onError: (ctx, err) => errors.push(err)
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)

      strictEqual(server.connectionCount, 0)
      strictEqual(errors.length, 1)
      strictEqual(errors[0], boom)
    })

    test('should unregister before onClose runs so sendTo cannot hit the closing socket', () => {
      let sendToResult = null
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          connectionKey: (ctx) => ctx.data.userId,
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
      let resolveClose = null
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          connectionKey: (ctx) => ctx.data.userId,
          onClose: () =>
            new Promise((resolve) => {
              resolveClose = resolve
            })
        }
      })
      const ws = createMockWebSocket({ userId: 'u1' })

      server.onOpen(ws)
      server.onClose(ws, 1000, noise)

      // close promise is still pending — the registry must already be clean
      strictEqual(server.hasConnection('u1'), false)
      strictEqual(server.sendTo('u1', 'x'), false)

      resolveClose()
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(server.connectionCount, 0)
    })

    test('should remove the connection from the registry on close', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
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
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
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
        router: () => {},
        ws: { enabled: true, connectionKey: (ctx) => ctx.data.userId }
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
      const server = makeServer({ router: () => {} })

      strictEqual(server.getSubscribersCount('topic'), 0)
    })

    test('should return false when WS disabled', () => {
      const server = makeServer({ router: () => {} })

      strictEqual(server.publish('topic', 'message'), false)
    })

    test('should return 0 when app not created', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      strictEqual(server.getSubscribersCount('topic'), 0)
      strictEqual(server.publish('topic', 'message'), false)
    })

    test('should call app.numSubscribers after listen', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()

      mockApp.setNumSubscribersResult(7)

      strictEqual(server.getSubscribersCount('topic'), 7)

      const numSubsCall = mockApp.calls.find((c) => c.method === 'numSubscribers' && c.topic === 'topic')

      strictEqual(numSubsCall !== undefined, true)
    })

    test('should call app.publish with correct parameters', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()

      mockApp.setPublishResult(true)

      strictEqual(server.publish('topic', 'message'), true)

      const publishCall = mockApp.calls.find((c) => c.method === 'publish' && c.topic === 'topic')

      strictEqual(publishCall !== undefined, true)
      strictEqual(publishCall.message, 'message')
      strictEqual(publishCall.isBinary, false)
    })

    test('should detect binary for ArrayBuffer', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()
      const buffer = new Uint8Array([1, 2, 3]).buffer

      server.publish('topic', buffer)

      const publishCall = mockApp.calls.find((c) => c.method === 'publish' && c.topic === 'topic')

      strictEqual(publishCall.isBinary, true)
    })

    test('should use explicit isBinary parameter', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()

      server.publish('topic', 'message', true)

      const publishCall = mockApp.calls.find((c) => c.method === 'publish' && c.topic === 'topic')

      strictEqual(publishCall.isBinary, true)
    })
  })

  describe('stopAccepting()', () => {
    test('should call us_listen_socket_close and clear socket', async () => {
      const server = makeServer({ router: () => {} })

      await server.listen()
      const socket = server.socket

      server.stopAccepting()

      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 1)
      strictEqual(mockCalls.us_listen_socket_close[0].socket, socket)
    })

    test('should do nothing when socket is null', () => {
      const server = makeServer({ router: () => {} })

      server.stopAccepting()

      strictEqual(mockCalls.us_listen_socket_close.length, 0)
    })
  })

  describe('shutdown() and close()', () => {
    test('should resolve immediately when no active connections', async () => {
      const server = makeServer({ router: () => {} })

      await server.shutdown(0)

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })

    test('should call stopAccepting on shutdown', async () => {
      const server = makeServer({ router: () => {} })

      await server.listen()

      await server.shutdown(0)

      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 1)
    })

    test('should call app.close eventually', async () => {
      const server = makeServer({ router: () => {} })

      await server.listen()
      const mockApp = getCurrentMockApp()

      await server.shutdown(0)
      server.close()

      strictEqual(mockApp.getCloseCallCount(), 1)
      strictEqual(server.app, null)
    })

    test('should be idempotent', async () => {
      const server = makeServer({ router: () => {} })

      await server.listen()
      const mockApp = getCurrentMockApp()

      server.close()
      server.close()

      strictEqual(mockApp.getCloseCallCount(), 1)
    })

    test('should resolve shutdown promise after close', async () => {
      const server = makeServer({ router: () => {} })

      await server.listen()

      const shutdownPromise = server.shutdown(0)

      server.close()

      await shutdownPromise

      strictEqual(server.app, null)
    })

    test('should return same promise for concurrent shutdown calls', async () => {
      const server = makeServer({ router: () => {} })

      const promise1 = server.shutdown(0)
      const promise2 = server.shutdown(0)

      strictEqual(promise1, promise2)

      server.close()
      await promise1
    })
  })

  describe('onUpgrade()', () => {
    test('should return 503 when draining', () => {
      const server = makeServer({ router: () => {} })

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
        router: () => {},
        ws: {
          enabled: true,
          onUpgrade: () => ({ isAllowed: true, userData, protocol: 'protocol123' })
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
      const upgradeCall = res.calls.find((c) => c.method === 'upgrade')

      strictEqual(upgradeCall !== undefined, true)
      strictEqual(upgradeCall.userData, userData)
      strictEqual(upgradeCall.secKey, 'key123')
      strictEqual(upgradeCall.protocol, 'protocol123')
      strictEqual(upgradeCall.extensions, 'extensions123')
      strictEqual(upgradeCall.context, context)

      const status403Call = res.calls.find((c) => c.method === 'writeStatus' && c.status === STATUS_TEXT[403])

      strictEqual(status403Call, undefined)
    })

    test('should return 403 when denied (sync)', () => {
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onUpgrade: () => ({ isAllowed: false })
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

    test('should return 403 and call safeWsError when onUpgrade throws', async () => {
      const error = new Error('x')
      let errorCalled = false
      let errorCtx = null
      let errorErr = null

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
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

    test('should snapshot sec-websocket-* headers synchronously, not read them after an async onUpgrade resolves', async () => {
      let resolveFn
      const upgradePromise = new Promise((resolve) => {
        resolveFn = resolve
      })

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onUpgrade: () => upgradePromise
        }
      })

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'sync-key')
      req.setHeader('sec-websocket-protocol', 'sync-protocol')
      req.setHeader('sec-websocket-extensions', 'sync-extensions')
      const context = {}

      server.onUpgrade(res, req, context)

      // Real uWS invalidates `req` once the synchronous handler call returns;
      // simulate that by mutating the headers a real req could no longer hold.
      req.setHeader('sec-websocket-key', 'STALE-after-return')
      req.setHeader('sec-websocket-protocol', 'STALE-after-return')
      req.setHeader('sec-websocket-extensions', 'STALE-after-return')

      resolveFn({ isAllowed: true, userData: {}, protocol: 'sync-protocol' })

      await Promise.resolve()

      const upgradeCall = res.calls.find((c) => c.method === 'upgrade')

      strictEqual(upgradeCall !== undefined, true)
      strictEqual(upgradeCall.secKey, 'sync-key')
      strictEqual(upgradeCall.protocol, 'sync-protocol')
      strictEqual(upgradeCall.extensions, 'sync-extensions')
    })

    test('should reject an unrequested subprotocol', async () => {
      let receivedError = null
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onUpgrade: () => ({ isAllowed: true, protocol: 'admin' }),
          onError: (ctx, err) => {
            receivedError = err
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
      strictEqual(receivedError?.message, 'WebSocket upgrade protocol was not requested by the client: admin')
    })

    test('should not upgrade when aborted before async resolve', async () => {
      let resolveFn
      const upgradePromise = new Promise((resolve) => {
        resolveFn = resolve
      })

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onUpgrade: () => upgradePromise
        }
      })

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      req.setHeader('sec-websocket-key', 'key')
      const context = {}

      server.onUpgrade(res, req, context)

      res.triggerAborted()

      resolveFn({ isAllowed: true, userData: {} })

      await Promise.resolve()

      strictEqual(res.isUpgraded(), false)
      const upgradeCall = res.calls.find((c) => c.method === 'upgrade')

      strictEqual(upgradeCall, undefined)

      const status403Call = res.calls.find((c) => c.method === 'writeStatus' && c.status === STATUS_TEXT[403])

      strictEqual(status403Call, undefined)
    })

    test('should terminate an async upgrade that exceeds wsUpgradeTimeoutMs', async () => {
      let receivedError = null
      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          wsUpgradeTimeoutMs: 100,
          onUpgrade: () => new Promise(() => {}),
          onError: (_ctx, error) => {
            receivedError = error
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
      strictEqual(receivedError?.code, 'WS_UPGRADE_TIMEOUT')
    })
  })

  describe('onOpen()', () => {
    test('should end WebSocket with 1001 when draining', () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      server.shutdown(0)

      const ws = createMockWebSocket()

      server.onOpen(ws)

      strictEqual(ws.getEndCallCount(), 1)
      const endCall = ws.calls.find((c) => c.method === 'end')

      strictEqual(endCall !== undefined, true)
      strictEqual(endCall.code, 1001)
      strictEqual(endCall.reason, 'server shutting down')
    })
  })

  describe('handleWithContext()', () => {
    test('should respond 503 and close connection when draining', () => {
      const server = makeServer({ router: () => 'ok' })

      server.shutdown(0)

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, server.router)

      strictEqual(res.getStatus(), STATUS_TEXT[503])
      strictEqual(res.getHeaders()['Connection'], 'close')
      strictEqual(res.isEnded(), true)
    })

    test('should register onAborted with ctx.onAbort', () => {
      const server = makeServer({ router: () => 'ok' })
      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, server.router)

      const onAbortedCall = res.calls.find((c) => c.method === 'onAborted')

      strictEqual(onAbortedCall !== undefined, true)
      strictEqual(typeof onAbortedCall.callback, 'function')
    })

    test('aborted async request must not deliver its late result to a reused context', async () => {
      const server = makeServer({ router: () => 'ok' })

      let resolveFirst = null
      const res1 = createMockHttpResponse()
      const req1 = createMockHttpRequest()

      server.handleWithContext(
        res1,
        req1,
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )

      // client 1 disconnects while its handler is still awaiting
      res1.triggerAborted()

      // a new request acquires the released context instance from the pool
      const res2 = createMockHttpResponse()
      const req2 = createMockHttpRequest()

      server.handleWithContext(res2, req2, () => new Promise(() => {}))

      // the late result of the aborted request must go nowhere
      resolveFirst('secret for client 1')
      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(res2.isEnded(), false)
    })

    test('should sendError and safeHttpError when handler throws (sync), and finalize when not streaming', async () => {
      let safeErrCalled = 0
      let finalizeCalled = 0

      const server = makeServer({
        router: () => {
          throw Object.assign(new Error('bad'), { status: 400 })
        },
        onHttpError: (ctx, err) => {
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

      server.handleWithContext(res, req, server.router)

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[400])
      strictEqual(res.isEnded(), true)
      strictEqual(safeErrCalled, 1)
      strictEqual(finalizeCalled, 1)
    })

    test('should NOT finalize when ctx.streaming=true after sync throw', async () => {
      let safeErrCalled = 0
      let finalizeCalled = 0

      const server = makeServer({
        router: (ctx) => {
          ctx.streaming = true
          throw new Error('x')
        },
        onHttpError: (ctx, err) => {
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

      server.handleWithContext(res, req, server.router)

      await Promise.resolve()

      strictEqual(safeErrCalled, 1)
      strictEqual(finalizeCalled, 0)
    })

    test('should handle promise resolve via ctx.onResolve and finalize if not streaming', async () => {
      let finalizeCalled = 0

      const server = makeServer({
        router: () => Promise.resolve('ok')
      })

      const originalFinalize = server.finalizeHttpContext.bind(server)

      server.finalizeHttpContext = (ctx) => {
        finalizeCalled++
        return originalFinalize(ctx)
      }

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, server.router)

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[200])
      strictEqual(res.isEnded(), true)
      strictEqual(finalizeCalled, 1)
    })

    test('should handle promise reject via ctx.onReject, sendError, safeHttpError, and finalize if not streaming', async () => {
      let safeErrCalled = 0
      let finalizeCalled = 0

      const server = makeServer({
        router: () => Promise.reject(Object.assign(new Error('no'), { status: 401 })),
        onHttpError: (ctx, err) => {
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

      server.handleWithContext(res, req, server.router)

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[401])
      strictEqual(res.isEnded(), true)
      strictEqual(safeErrCalled, 1)
      strictEqual(finalizeCalled, 1)
    })

    test('when promise resolves but ctx.send throws, it should sendError(500) and safeHttpError called', async () => {
      let safeErrCalled = 0

      const server = makeServer({
        router: () =>
          Promise.resolve({
            toJSON() {
              throw new Error('boom')
            }
          }),
        onHttpError: (ctx, err) => {
          safeErrCalled++
        }
      })

      const res = createMockHttpResponse()
      const req = createMockHttpRequest()

      server.handleWithContext(res, req, server.router)

      await Promise.resolve()

      strictEqual(res.getStatus(), STATUS_TEXT[500])
      strictEqual(res.getHeaders()['content-type'], 'text/plain; charset=utf-8')
      strictEqual(safeErrCalled, 1)
    })
  })

  describe('WS event handlers', () => {
    test('onMessage: should call handler and swallow errors into safeWsError when handler throws', async () => {
      let errorCalled = 0

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onMessage: () => {
            throw new Error('x')
          },
          onError: (ctx, err) => {
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

    test('onMessage: async reject should call safeWsError', async () => {
      let errorCalled = 0

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onMessage: async () => {
            throw new Error('x')
          },
          onError: (ctx, err) => {
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

    test('onClose: must deleteWsContext and decrement activeWs even if onClose throws', async () => {
      let errorCalled = 0

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onClose: () => {
            throw new Error('close error')
          },
          onError: (ctx, err) => {
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
      let resolveFn

      const server = makeServer({
        router: () => {},
        ws: {
          enabled: true,
          onClose: () =>
            new Promise((resolve) => {
              resolveFn = resolve
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

      resolveFn()

      await new Promise((resolve) => setImmediate(resolve))

      strictEqual(ctx.ws, null)
    })

    test('shutdown should close app only after activeWs becomes 0 (finishShutdownIfNeed)', async () => {
      const server = makeServer({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()
      const mockApp = getCurrentMockApp()

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
