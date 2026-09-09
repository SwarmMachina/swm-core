import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import Server from '../../src/server/server.js'
import type HttpContext from '../../src/http/public-context.js'
import { createMockHttpRequest, createMockHttpResponse } from '../helpers/mock-uws.js'
import { createMockReq } from '../helpers/mock-http.js'

test('application strings, symbols and non-enumerable properties stay with their request', () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const symbol = Symbol('request payload')
  const contexts: HttpContext[] = []

  server.handleWithContext(createMockHttpResponse(), createMockHttpRequest(), (ctx) => {
    contexts.push(ctx)
    Object.assign(ctx, { user: { id: 'first' }, [symbol]: Buffer.alloc(1024) })
    Object.defineProperty(ctx, 'hidden', { value: Buffer.alloc(1024), configurable: true })

    return 'first'
  })
  assert.equal(Object.hasOwn(contexts[0]!, 'user'), true)
  assert.equal(Object.hasOwn(contexts[0]!, 'hidden'), true)
  assert.equal(Object.hasOwn(contexts[0]!, symbol), true)
  assert.throws(() => contexts[0]!.send('late'), /no longer active/)
  server.handleWithContext(createMockHttpResponse(), createMockHttpRequest(), (ctx) => {
    contexts.push(ctx)

    for (const key of ['user', 'hidden', symbol]) {
      assert.equal(Object.hasOwn(ctx, key), false)
    }

    return 'second'
  })
  assert.notEqual(contexts[1], contexts[0])
  assert.equal(server.activeHttp, 0)
})

test('non-configurable application state remains isolated when internal resources are reused', () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const contexts: HttpContext[] = []

  server.handleWithContext(createMockHttpResponse(), createMockHttpRequest(), (ctx) => {
    contexts.push(ctx)
    Object.defineProperty(ctx, 'user', { value: { id: 'private' } })

    return 'first'
  })
  server.handleWithContext(createMockHttpResponse(), createMockHttpRequest(), (ctx) => {
    contexts.push(ctx)

    return 'second'
  })
  assert.notEqual(contexts[1], contexts[0])
  assert.equal(Object.hasOwn(contexts[1]!, 'user'), false)
  assert.equal(contexts[0]!.server, null)
  assert.equal(server.activeHttp, 0)
})

for (const method of ['end', 'tryEnd'] as const) {
  test(`${method} before the first await keeps the context assigned until handler settlement`, async () => {
    const server = new Server({ http: { onRequest: () => 'ok' } })
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<string>()
    const first = createMockHttpResponse()
    const second = createMockHttpResponse()
    const contexts: HttpContext[] = []

    let resumed = false

    server.handleWithContext(first, createMockReq({ url: '/first' }), async (ctx) => {
      contexts.push(ctx)
      ctx.startStreaming()

      if (method === 'end') {
        ctx.end('first')
      } else {
        ctx.tryEnd('first', 5)
      }

      assert.equal(ctx.server, server)
      assert.equal(ctx.getUrl(), '/first')
      await firstGate.promise
      assert.equal(ctx.getUrl(), '/first')
      resumed = true

      return 'late first response'
    })
    server.handleWithContext(second, createMockReq({ url: '/second' }), (ctx) => {
      assert.notEqual(ctx, contexts[0])

      return secondGate.promise
    })

    firstGate.resolve()
    await nextTurn()
    assert.equal(resumed, true)
    assert.equal(second.isEnded(), false)
    assert.equal(server.activeHttp, 1)
    secondGate.resolve('second')
    await nextTurn()
    assert.equal(second.isEnded(), true)
    assert.equal(server.activeHttp, 0)
  })
}

test('invalid reply headers produce a complete error response before context reuse', () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const response = createMockHttpResponse()

  server.handleWithContext(response, createMockHttpRequest(), (ctx) => {
    ctx.reply(200, { 'x-invalid': 'bad\r\nvalue' }, 'must not be sent')
  })
  assert.equal(response.isEnded(), true)
  assert.equal(response.getStatus(), '500 Internal Server Error')
  assert.equal(response.calls.filter(({ method }) => method === 'writeStatus').length, 1)
  assert.equal(server.activeHttp, 0)
})

test('a failed native response stays assigned until its deferred abort arrives', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const first = createMockHttpResponse()
  const second = createMockHttpResponse()
  const contexts: HttpContext[] = []
  const gate = Promise.withResolvers<string>()

  let closed = 0

  first.writeHeader = () => {
    throw new Error('native write failed')
  }
  first.close = () => {
    closed++

    return first
  }
  server.handleWithContext(first, createMockHttpRequest(), (ctx) => {
    contexts.push(ctx)
    ctx.reply(200, { 'x-valid': 'value' }, 'first')
  })
  assert.equal(closed, 1)
  assert.equal(server.activeHttp, 1)
  server.handleWithContext(second, createMockHttpRequest(), (ctx) => {
    assert.notEqual(ctx, contexts[0])

    return gate.promise
  })
  first.triggerAborted()
  assert.equal(second.isEnded(), false)
  assert.equal(server.activeHttp, 1)
  gate.resolve('second')
  await nextTurn()
  assert.equal(second.getStatus(), '200 OK')
  assert.equal(server.activeHttp, 0)
})

test('an early response after await releases retained body bytes without failing a live request', async () => {
  const reported: unknown[] = []
  const server = new Server({
    http: {
      onRequest: () => 'ok',
      requestTimeoutMs: 100,
      maxBodyBudget: 4,
      onError: (_event, error) => reported.push(error)
    }
  })
  const gate = Promise.withResolvers<void>()
  const failure = new Error('handler failed after its early reply')
  const response = createMockHttpResponse()

  server.handleWithContext(response, createMockReq({ headers: { 'content-length': '4' } }), async (ctx) => {
    await ctx.body()
    ctx.sendText('accepted')
    await gate.promise

    throw failure
  })
  response.pushData('body', true)
  await nextTurn()
  assert.equal(response.isEnded(), true)
  assert.equal(server.httpBodyBudget!.usedBytes, 4)
  await delay(150)
  assert.equal(server.httpBodyBudget!.usedBytes, 0)
  assert.equal(server.httpBodyBudget!.activeReservations, 0)

  // The deadline only reclaims body bytes: an answered request is not a failure
  // and its handler still owns the lifecycle.
  assert.deepEqual(reported, [])
  assert.equal(server.activeHttp, 1)
  gate.resolve()
  await delay(10)
  assert.equal(response.calls.filter(({ method }) => method === 'end').length, 1)
  assert.equal(server.activeHttp, 0)
  assert.deepEqual(reported, [failure])
})

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? 'rejected' : 'throwing'} streaming handler closes the response and releases resources`, async () => {
    const server = new Server({ http: { onRequest: () => 'ok' } })
    const response = createMockHttpResponse()
    const fail = (ctx: HttpContext) => {
      ctx.startStreaming()

      if (asynchronous) {
        return Promise.reject(new Error('stream handler failed'))
      }

      throw new Error('stream handler failed')
    }

    server.handleWithContext(response, createMockHttpRequest(), fail)
    await nextTurn()
    assert.equal(response.calls.filter(({ method }) => method === 'close').length, 1)
    assert.equal(response.isEnded(), false)
    assert.equal(server.activeHttp, 0)
  })
}

test('abort contains asynchronous Readable destruction errors without retaining its context', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const response = createMockHttpResponse()
  const source = new Readable({
    read() {},
    destroy(_error, callback) {
      setImmediate(() => callback(new Error('late destruction failure')))
    }
  })
  const closed = new Promise<void>((resolve) => source.on('close', resolve))

  server.handleWithContext(response, createMockHttpRequest(), (ctx) => ctx.stream(source))
  response.triggerAborted()
  await closed
  await nextTurn()
  assert.equal(source.destroyed, true)
  assert.equal(source.listenerCount('error'), 0)
  assert.equal(source.listenerCount('data'), 0)
  assert.equal(server.activeHttp, 0)
})

test('stream setup failure destroys a source that has not started emitting', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const response = createMockHttpResponse()
  const source = new Readable({ read() {} })

  server.handleWithContext(response, createMockHttpRequest(), (ctx) =>
    ctx.stream(source, 200, { 'bad\nname': 'value' })
  )
  await nextTurn()
  assert.equal(source.destroyed, true)
  assert.equal(server.activeHttp, 0)
})

test('idle shutdown returns a Promise and clears draining even without a native app', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const shutdown = server.shutdown(100)

  assert.ok(shutdown instanceof Promise)
  await shutdown
  const response = createMockHttpResponse()

  server.handleWithContext(response, createMockHttpRequest(), () => 'new generation')
  assert.equal(response.getStatus(), '200 OK')
  assert.equal(server.activeHttp, 0)
})
