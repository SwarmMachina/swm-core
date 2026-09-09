import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import Server from '../../src/server/server.js'
import type HttpContext from '../../src/http/public-context.js'
import { createMockReq } from '../helpers/mock-http.js'
import { createMockHttpResponse } from '../helpers/mock-uws.js'

test('frozen and non-configurable public contexts do not retain the pooled resource owner', () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const owner = server.httpContextPool.acquire()

  server.httpContextPool.release(owner)
  let first: HttpContext | undefined

  server.handleWithContext(createMockHttpResponse(), createMockReq(), (ctx) => {
    first = ctx
    Object.defineProperty(ctx, 'user', { value: { id: 'first' } })
    Object.freeze(ctx)

    return 'ok'
  })
  assert.equal(first!.res, null)
  assert.equal(first!.req, null)
  assert.equal(first!.server, null)
  assert.throws(() => first!.reply(200, null, 'late'), /no longer active/)
  assert.equal(server.httpContextPool.acquire(), owner)
  assert.equal(Object.hasOwn(owner, 'user'), false)
  server.httpContextPool.release(owner)
  server.handleWithContext(createMockHttpResponse(), createMockReq(), (ctx) => {
    assert.notEqual(ctx, first)
    assert.equal(Object.hasOwn(ctx, 'user'), false)

    return 'second'
  })
})

test('custom data and request/response aliases remain stable through await and cannot cross requests', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const first = createMockHttpResponse()
  const gate = Promise.withResolvers<void>()

  let client: { req: HttpContext; res: HttpContext } | undefined

  const symbol = Symbol('user')

  server.handleWithContext(first, createMockReq({ url: '/first' }), async (ctx) => {
    client = { req: ctx, res: ctx }
    Object.assign(ctx, { user: 'first', [symbol]: 'one' })
    assert.equal(ctx.res, first)
    assert.equal(ctx.server, server)
    assert.equal(ctx.setStatus(201).setHeader('x-user', 'first'), ctx)
    await gate.promise
    assert.equal(client.req, client.res)
    assert.equal(client.req.getUrl(), '/first')

    return 'first'
  })
  server.handleWithContext(createMockHttpResponse(), createMockReq(), (ctx) => {
    assert.equal(Object.hasOwn(ctx, 'user'), false)
    assert.equal(Object.hasOwn(ctx, symbol), false)

    return 'second'
  })
  gate.resolve()
  await nextTurn()
  assert.equal(first.getStatus(), '201 Created')
  Object.assign(client!.req, { user: 'late first' })
  assert.throws(() => client!.res.send('late'), /no longer active/)
  server.handleWithContext(createMockHttpResponse(), createMockReq(), (ctx) => {
    assert.equal(Object.hasOwn(ctx, 'user'), false)

    return 'third'
  })
  assert.equal(server.activeHttp, 0)
})

test('a manual stream keeps its public context active for writable callbacks after the handler returns', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const response = createMockHttpResponse()

  let writable: ((offset: number) => boolean) | undefined
  let context: HttpContext | undefined

  response.onWritable = (callback) => {
    writable = callback

    return response
  }
  server.handleWithContext(response, createMockReq(), (ctx) => {
    context = ctx
    Object.assign(ctx, { user: 'stream user' })
    assert.equal(ctx.startStreaming(200, { 'x-stream': 'yes' }), ctx)
    ctx.onWritable((offset) => {
      assert.equal(offset, 10)
      assert.equal(Reflect.get(ctx, 'user'), 'stream user')
      ctx.end('done')
    })
  })
  await nextTurn()
  assert.equal(context!.res, response)
  assert.equal(server.activeHttp, 1)
  assert.ok(writable)
  writable(10)
  assert.equal(response.isEnded(), true)
  assert.equal(server.activeHttp, 0)
  assert.equal(context!.res, null)
  assert.throws(() => context!.write('late'), /no longer active/)
})

test('one pooled owner alternates plain, manual and Readable replies on their own transports', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const owner = server.httpContextPool.acquire()
  const responses: ReturnType<typeof createMockHttpResponse>[] = []
  const callCounts: number[] = []

  server.httpContextPool.release(owner)

  for (const mode of ['plain', 'manual', 'plain', 'readable', 'manual'] as const) {
    const response = createMockHttpResponse()

    server.handleWithContext(response, createMockReq(), (ctx) => {
      if (mode === 'manual') {
        ctx.startStreaming().end(mode)

        return
      }

      return mode === 'readable' ? ctx.stream(Readable.from([mode])) : mode
    })
    await nextTurn()
    assert.equal(response.isEnded(), true)
    assert.equal(server.activeHttp, 0)
    assert.equal(server.httpContextPool.acquire(), owner)
    server.httpContextPool.release(owner)

    for (const [index, previous] of responses.entries()) {
      assert.equal(previous.calls.length, callCounts[index])
    }

    responses.push(response)
    callCounts.push(response.calls.length)
  }
})
