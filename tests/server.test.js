import { afterEach, beforeEach, describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'
import Server from '../src/index.js'
import { STATUS_TEXT } from '../src/http-context.js'
import {
  createMockHttpRequest,
  createMockHttpResponse,
  createMockWebSocket,
  getCurrentMockApp,
  mockCalls,
  resetMockApp,
  setListenCallback
} from './helpers/mock-uws-module.js'

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
      const server = new Server({ router })

      strictEqual(server.router, router)
      strictEqual(server.routes, null)
      strictEqual(server.useNativeRouting, false)
      strictEqual(server.port, 6000)
      strictEqual(server.maxBodyBytes, 1024 * 1024)
      strictEqual(server.wsEnabled, false)
    })

    test('should create server with routes option', () => {
      const routes = [{ method: 'get', path: '/', handler: () => {} }]
      const server = new Server({ routes })

      strictEqual(server.router, null)
      strictEqual(server.routes, routes)
      strictEqual(server.useNativeRouting, true)
      strictEqual(server.port, 6000)
      strictEqual(server.maxBodyBytes, 1024 * 1024)
      strictEqual(server.wsEnabled, false)
    })

    test('should use custom port', () => {
      const server = new Server({ router: () => {}, port: 3000 })

      strictEqual(server.port, 3000)
    })

    test('should use custom maxBodySize', () => {
      const server = new Server({ router: () => {}, maxBodySize: 5 })

      strictEqual(server.maxBodyBytes, 5 * 1024 * 1024)
    })

    test('should use custom onHttpError handler', () => {
      const onHttpError = () => {}
      const server = new Server({ router: () => {}, onHttpError })

      strictEqual(server.onHttpError, onHttpError)
    })

    test('should use default onHttpError when not provided', () => {
      const server = new Server({ router: () => {} })

      strictEqual(typeof server.onHttpError, 'function')
    })

    test('should throw error when both router and routes are provided', () => {
      throws(() => new Server({ router: () => {}, routes: [] }), {
        name: 'TypeError',
        message: 'Cannot use both "router" and "routes" options. Choose one.'
      })
    })

    test('should throw error when neither router nor routes are provided', () => {
      throws(() => new Server({}), {
        name: 'TypeError',
        message: 'Either "router" or "routes" option must be provided'
      })
    })

    test('should throw error when router is not a function', () => {
      throws(() => new Server({ router: 'not a function' }), {
        name: 'TypeError',
        message: 'Router must be a function'
      })
    })

    test('should throw error when routes is not an array', () => {
      throws(() => new Server({ routes: 'not an array' }), {
        name: 'TypeError',
        message: 'Routes must be an array'
      })
    })

    test('should throw error when port is not a number', () => {
      throws(() => new Server({ router: () => {}, port: '3000' }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is 0', () => {
      throws(() => new Server({ router: () => {}, port: 0 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is negative', () => {
      throws(() => new Server({ router: () => {}, port: -1 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should throw error when port is greater than 65535', () => {
      throws(() => new Server({ router: () => {}, port: 65536 }), {
        name: 'TypeError',
        message: 'Http port must be in range 1 - 65535'
      })
    })

    test('should accept valid port range', () => {
      const server1 = new Server({ router: () => {}, port: 1 })

      strictEqual(server1.port, 1)

      const server2 = new Server({ router: () => {}, port: 65535 })

      strictEqual(server2.port, 65535)
    })

    test('should throw error when maxBodySize is not a number', () => {
      throws(() => new Server({ router: () => {}, maxBodySize: '1' }), {
        name: 'TypeError',
        message: 'Max body size must be in range 1 - 64'
      })
    })

    test('should throw error when maxBodySize is less than 1', () => {
      throws(() => new Server({ router: () => {}, maxBodySize: 0 }), {
        name: 'TypeError',
        message: 'Max body size must be in range 1 - 64'
      })
    })

    test('should throw error when maxBodySize is greater than 64', () => {
      throws(() => new Server({ router: () => {}, maxBodySize: 65 }), {
        name: 'TypeError',
        message: 'Max body size must be in range 1 - 64'
      })
    })

    test('should accept valid maxBodySize range', () => {
      const server1 = new Server({ router: () => {}, maxBodySize: 1 })

      strictEqual(server1.maxBodyBytes, 1024 * 1024)

      const server2 = new Server({ router: () => {}, maxBodySize: 64 })

      strictEqual(server2.maxBodyBytes, 64 * 1024 * 1024)
    })

    test('should enable WebSocket when ws.enabled is true', () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: true }
      })

      strictEqual(server.wsEnabled, true)
      strictEqual(server.wsIdleTimeoutSec, 15)
    })

    test('should enable WebSocket when ws handlers are provided', () => {
      const server = new Server({
        router: () => {},
        ws: { onMessage: () => {} }
      })

      strictEqual(server.wsEnabled, true)
    })

    test('should disable WebSocket when ws is not provided', () => {
      const server = new Server({ router: () => {} })

      strictEqual(server.wsEnabled, false)
    })

    test('should disable WebSocket when ws.enabled is false', () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: false, onMessage: () => {} }
      })

      strictEqual(server.wsEnabled, false)
    })

    test('should use custom wsIdleTimeoutSec', () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: true, wsIdleTimeoutSec: 30 }
      })

      strictEqual(server.wsIdleTimeoutSec, 30)
    })

    test('should throw error when wsIdleTimeoutSec is less than 5', () => {
      throws(
        () =>
          new Server({
            router: () => {},
            ws: { enabled: true, wsIdleTimeoutSec: 4 }
          }),
        {
          name: 'TypeError',
          message: 'wsIdleTimeoutSec must be >= 5'
        }
      )
    })

    test('should assign WebSocket handlers when provided', () => {
      const onOpen = () => {}
      const onClose = () => {}
      const onError = () => {}
      const onMessage = () => {}
      const onDrain = () => {}
      const onSubscription = () => {}
      const onUpgrade = () => Promise.resolve({ isAllowed: true })

      const server = new Server({
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
      const server = new Server({ router: () => {} })

      strictEqual(server.httpContextPool !== null, true)
      strictEqual(server.wsContextPool !== null, true)
    })

    test('should initialize internal state', () => {
      const server = new Server({ router: () => {} })

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })
  })

  describe('listen()', () => {
    test('should register router handler with app.any', async () => {
      const router = () => {}
      const server = new Server({ router, port: 7000 })

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
      const server = new Server({ router: () => {} })

      const result = await server.listen()

      strictEqual(result, server)
      strictEqual(server.socket !== null, true)
    })

    test('should return same promise for concurrent listen calls', async () => {
      const server = new Server({ router: () => {} })

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
      const server = new Server({ router: () => {} })

      await server.listen()

      const result = await server.listen()

      strictEqual(result, server)
    })

    test('should reject on listen failure', async () => {
      const server = new Server({ router: () => {}, port: 8000 })

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
      const server = new Server({ routes })

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

    test('should throw on invalid HTTP method', async () => {
      const routes = [{ method: 'trace', path: '/x', handler: () => {} }]
      const server = new Server({ routes })

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
      const server = new Server({ routes })

      await rejects(
        (async () => {
          await server.listen()
        })(),
        (err) => {
          return err.name === 'TypeError' && err.message === 'Invalid Path in route, method: get, path: x'
        }
      )
    })

    test('should register WebSocket when wsEnabled is true', async () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: true, wsIdleTimeoutSec: 20 }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()
      const wsCall = mockApp.calls.find((c) => c.method === 'ws')

      strictEqual(wsCall !== undefined, true)
      strictEqual(wsCall.path, '/*')
      strictEqual(wsCall.config.idleTimeout, 20)
      strictEqual(wsCall.config.maxPayloadLength, 1024 * 1024)
      strictEqual(typeof wsCall.config.open, 'function')
      strictEqual(typeof wsCall.config.message, 'function')
      strictEqual(typeof wsCall.config.close, 'function')
      strictEqual(typeof wsCall.config.drain, 'function')
      strictEqual(typeof wsCall.config.subscription, 'function')
      strictEqual(typeof wsCall.config.upgrade, 'function')
    })

    test('should use default wsIdleTimeoutSec when not provided', async () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: true }
      })

      await server.listen()

      const mockApp = getCurrentMockApp()
      const wsCall = mockApp.calls.find((c) => c.method === 'ws')

      strictEqual(wsCall.config.idleTimeout, 15)
    })
  })

  describe('safeCall()', () => {
    test('should call function and swallow errors', async () => {
      const server = new Server({ router: () => {} })
      let called = 0

      await server.safeCall(() => {
        called++
        throw new Error('test error')
      })

      strictEqual(called, 1)
    })

    test('should handle async functions', async () => {
      const server = new Server({ router: () => {} })
      let called = 0

      await server.safeCall(async () => {
        called++
        throw new Error('test error')
      })

      strictEqual(called, 1)
    })

    test('should do nothing for non-function', async () => {
      const server = new Server({ router: () => {} })

      await server.safeCall(null)
      await server.safeCall(undefined)
      await server.safeCall('not a function')
      await server.safeCall(123)
    })

    test('should pass arguments correctly', async () => {
      const server = new Server({ router: () => {} })
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

      const server = new Server({
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
      const server = new Server({
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

      const server = new Server({
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
      const server = new Server({
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
      const server = new Server({
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

    test('should create new context after delete', () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: true }
      })

      const ws = createMockWebSocket()
      const ctx1 = server.getWsContext(ws)
      const userData = ws.getUserData()

      strictEqual(server.getWsContext(ws), ctx1)

      const symbolsBefore = Object.getOwnPropertySymbols(userData)

      strictEqual(symbolsBefore.length, 1)

      server.deleteWsContext(ws)

      const symbolsAfter = Object.getOwnPropertySymbols(userData)

      strictEqual(symbolsAfter.length, 0)

      const ctx2 = server.getWsContext(ws)

      strictEqual(ctx2 !== null, true)
      strictEqual(ctx2.server, server)
      strictEqual(ctx2.ws, ws)
    })

    test('should call release on context when deleted', () => {
      const server = new Server({
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
      const server = new Server({
        router: () => {},
        ws: { enabled: true }
      })

      const ws = createMockWebSocket()

      server.deleteWsContext(ws)
    })
  })

  describe('getSubscribersCount() and publish()', () => {
    test('should return 0 when WS disabled', () => {
      const server = new Server({ router: () => {} })

      strictEqual(server.getSubscribersCount('topic'), 0)
    })

    test('should return false when WS disabled', () => {
      const server = new Server({ router: () => {} })

      strictEqual(server.publish('topic', 'message'), false)
    })

    test('should return 0 when app not created', () => {
      const server = new Server({
        router: () => {},
        ws: { enabled: true }
      })

      strictEqual(server.getSubscribersCount('topic'), 0)
      strictEqual(server.publish('topic', 'message'), false)
    })

    test('should call app.numSubscribers after listen', async () => {
      const server = new Server({
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
      const server = new Server({
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
      const server = new Server({
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
      const server = new Server({
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
      const server = new Server({ router: () => {} })

      await server.listen()
      const socket = server.socket

      server.stopAccepting()

      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 1)
      strictEqual(mockCalls.us_listen_socket_close[0].socket, socket)
    })

    test('should do nothing when socket is null', () => {
      const server = new Server({ router: () => {} })

      server.stopAccepting()

      strictEqual(mockCalls.us_listen_socket_close.length, 0)
    })
  })

  describe('shutdown() and close()', () => {
    test('should resolve immediately when no active connections', async () => {
      const server = new Server({ router: () => {} })

      await server.shutdown(0)

      strictEqual(server.app, null)
      strictEqual(server.socket, null)
    })

    test('should call stopAccepting on shutdown', async () => {
      const server = new Server({ router: () => {} })

      await server.listen()

      await server.shutdown(0)

      strictEqual(server.socket, null)
      strictEqual(mockCalls.us_listen_socket_close.length, 1)
    })

    test('should call app.close eventually', async () => {
      const server = new Server({ router: () => {} })

      await server.listen()
      const mockApp = getCurrentMockApp()

      await server.shutdown(0)
      server.close()

      strictEqual(mockApp.getCloseCallCount(), 1)
      strictEqual(server.app, null)
    })

    test('should be idempotent', async () => {
      const server = new Server({ router: () => {} })

      await server.listen()
      const mockApp = getCurrentMockApp()

      server.close()
      server.close()

      strictEqual(mockApp.getCloseCallCount(), 1)
    })

    test('should resolve shutdown promise after close', async () => {
      const server = new Server({ router: () => {} })

      await server.listen()

      const shutdownPromise = server.shutdown(0)

      server.close()

      await shutdownPromise

      strictEqual(server.app, null)
    })

    test('should return same promise for concurrent shutdown calls', async () => {
      const server = new Server({ router: () => {} })

      const promise1 = server.shutdown(0)
      const promise2 = server.shutdown(0)

      strictEqual(promise1, promise2)

      server.close()
      await promise1
    })
  })

  describe('onUpgrade()', () => {
    test('should return 503 when draining', () => {
      const server = new Server({ router: () => {} })

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
      const server = new Server({
        router: () => {},
        ws: {
          enabled: true,
          onUpgrade: () => ({ isAllowed: true, userData })
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
      const server = new Server({
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

      const server = new Server({
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

    test('should not upgrade when aborted before async resolve', async () => {
      let resolveFn
      const upgradePromise = new Promise((resolve) => {
        resolveFn = resolve
      })

      const server = new Server({
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
  })

  describe('onOpen()', () => {
    test('should end WebSocket with 1001 when draining', () => {
      const server = new Server({
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
})
