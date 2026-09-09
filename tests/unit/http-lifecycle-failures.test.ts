import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import Server from '../../src/server/server.js'
import type HttpContext from '../../src/http/public-context.js'
import { prepareHeaders } from '../../src/http/headers.js'
import PreparedHeaderReplies from '../../src/http/prepared-header-replies.js'
import { createMockReq } from '../helpers/mock-http.js'
import { createMockHttpResponse } from '../helpers/mock-uws.js'
import { PreparedHeaderBlock } from '../helpers/mock-uws-module.js'

for (const method of ['writeStatus', 'end', 'endPrepared', 'endBatch', 'stream.end', 'stream.tryEnd'] as const) {
  for (const asynchronous of [false, true]) {
    test(`${method} failure ${asynchronous ? 'after await' : 'on the handler stack'} waits for abort before reuse`, async (t) => {
      const failure = new Error(`${method} failed`)
      const errors: Array<{ url: string; error: Error }> = []
      const server = new Server({
        http: {
          onRequest: () => 'ok',
          onError: (event, error) => {
            errors.push({ url: event.url, error })
          }
        }
      })
      const first = Object.assign(createMockHttpResponse(), {
        endPrepared() {
          throw failure
        },
        endBatch() {
          throw failure
        }
      })
      const second = createMockHttpResponse()
      const contexts: HttpContext[] = []
      const secondGate = Promise.withResolvers<string>()

      let closeCalls = 0

      t.after(() => {
        first.triggerAborted()
        secondGate.resolve('second')
        server.close()
      })
      first.close = () => {
        closeCalls++

        return first
      }

      if (method === 'writeStatus') {
        first.writeStatus = () => {
          throw failure
        }
      }

      if (method === 'end' || method === 'stream.end') {
        first.end = () => {
          throw failure
        }
      }

      if (method === 'stream.tryEnd') {
        first.tryEnd = () => {
          throw failure
        }
      }

      if (method === 'endPrepared') {
        server.preparedHeaderReplies = new PreparedHeaderReplies(PreparedHeaderBlock)
      }

      if (method === 'endBatch') {
        server.bindingCapabilities = { responseBatch: true }
      }

      const reply = (ctx: HttpContext) => {
        contexts.push(ctx)

        if (method === 'stream.end' || method === 'stream.tryEnd') {
          ctx.startStreaming()

          if (method === 'stream.end') {
            ctx.end('first')
          } else {
            ctx.tryEnd('first', 5)
          }
        } else {
          ctx.reply(200, prepareHeaders({ 'x-response': 'first' }), 'first')
        }
      }

      server.handleWithContext(
        first,
        createMockReq({ url: '/failed' }),
        asynchronous
          ? async (ctx) => {
              await nextTurn()
              reply(ctx)
            }
          : reply
      )
      await nextTurn()
      await nextTurn()

      assert.equal(closeCalls, 1)
      assert.equal(first.isEnded(), false)
      assert.equal(server.activeHttp, 1)
      assert.deepEqual(errors, [{ url: '/failed', error: failure }])

      server.handleWithContext(second, createMockReq({ url: '/second' }), (ctx) => {
        contexts.push(ctx)

        return secondGate.promise
      })
      assert.notEqual(contexts[0], contexts[1])
      first.triggerAborted()
      assert.equal(contexts[0]!.res, null)
      assert.equal(contexts[1]!.aborted, false)
      assert.equal(server.activeHttp, 1)
      secondGate.resolve('second')
      await nextTurn()
      assert.equal(second.getStatus(), '200 OK')
      assert.equal(server.activeHttp, 0)
      assert.equal(second.calls.filter(({ method: name }) => name === 'end').length, 1)
    })
  }
}

for (const method of ['end', 'tryEnd'] as const) {
  test(`synchronous ${method} cannot reissue its context during a nested request`, () => {
    const server = new Server({ http: { onRequest: () => 'ok' } })
    const contexts: HttpContext[] = []

    let outerUrlAfterNested = ''

    server.handleWithContext(createMockHttpResponse(), createMockReq({ url: '/outer' }), (ctx) => {
      contexts.push(ctx)
      ctx.startStreaming()

      if (method === 'end') {
        ctx.end('outer')
      } else {
        ctx.tryEnd('outer', 5)
      }

      server.handleWithContext(createMockHttpResponse(), createMockReq({ url: '/inner' }), (nested) => {
        contexts.push(nested)

        return 'inner'
      })
      outerUrlAfterNested = ctx.getUrl()
    })
    assert.notEqual(contexts[0], contexts[1])
    assert.equal(outerUrlAfterNested, '/outer')
    assert.equal(server.activeHttp, 0)
    assert.equal(contexts[0]!.server, null)
    assert.equal(contexts[1]!.server, null)
  })

  test(`${method} followed by a late rejection cannot reject another request`, async (t) => {
    const server = new Server({ http: { onRequest: () => 'ok' } })
    const gate = Promise.withResolvers<never>()
    const secondGate = Promise.withResolvers<string>()
    const second = createMockHttpResponse()
    const contexts: HttpContext[] = []

    t.after(() => {
      gate.reject(new Error('cleanup'))
      secondGate.resolve('second')
      server.close()
    })
    server.handleWithContext(createMockHttpResponse(), createMockReq({ url: '/first' }), (ctx) => {
      contexts.push(ctx)
      ctx.startStreaming()

      if (method === 'end') {
        ctx.end('first')
      } else {
        ctx.tryEnd('first', 5)
      }

      return gate.promise
    })
    server.handleWithContext(second, createMockReq({ url: '/second' }), (ctx) => {
      contexts.push(ctx)

      return secondGate.promise
    })
    assert.notEqual(contexts[0], contexts[1])
    gate.reject(new Error('late failure'))
    await nextTurn()
    assert.equal(second.isEnded(), false)
    assert.equal(server.activeHttp, 1)
    assert.equal(contexts[0]!.server, null)
    secondGate.resolve('second')
    await nextTurn()
    assert.equal(second.getStatus(), '200 OK')
    assert.equal(server.activeHttp, 0)
  })
}

for (const terminal of ['abort', 'timeout'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`${terminal} releases the body budget and isolates application fields after late ${outcome}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const server = new Server({ http: { onRequest: () => 'ok', requestTimeoutMs: 100, maxBodyBudget: 4 } })
      const gate = Promise.withResolvers<void>()
      const response = createMockHttpResponse()
      const contexts: HttpContext[] = []
      const requestState = { privateData: Buffer.alloc(1024) }

      t.after(() => {
        gate.resolve()
        server.close()
      })
      server.handleWithContext(response, createMockReq({ headers: { 'content-length': '4' } }), async (ctx) => {
        contexts.push(ctx)
        Object.assign(ctx, { user: requestState })
        await ctx.body()

        if (terminal === 'timeout') {
          ctx.sendText('accepted')
        }

        await gate.promise
      })
      response.pushData('body', true)
      await nextTurn()
      assert.equal(server.httpBodyBudget!.usedBytes, 4)

      if (terminal === 'abort') {
        response.triggerAborted()
      } else {
        t.mock.timers.tick(99)
        assert.equal(server.httpBodyBudget!.usedBytes, 4)
        t.mock.timers.tick(1)
      }

      assert.equal(server.httpBodyBudget!.usedBytes, 0)
      assert.equal(server.httpBodyBudget!.activeReservations, 0)

      // An aborted request is over at once. An answered one only gives back its
      // retained body bytes at the deadline and stays active for its handler.
      assert.equal(server.activeHttp, terminal === 'abort' ? 0 : 1)
      assert.equal(Reflect.get(contexts[0]!, 'user'), requestState)
      const nativeCallsAtTerminal = response.calls.length

      if (outcome === 'resolve') {
        gate.resolve()
      } else {
        gate.reject(new Error('late failure'))
      }

      await nextTurn()
      assert.equal(response.calls.length, nativeCallsAtTerminal)
      assert.equal(server.activeHttp, 0)
      assert.equal(Reflect.get(contexts[0]!, 'user'), requestState)
      assert.throws(() => contexts[0]!.send('late'), /no longer active/)
      assert.equal(contexts[0]!.server, null)

      const recovered = createMockHttpResponse()

      server.handleWithContext(recovered, createMockReq({ headers: { 'content-length': '4' } }), async (ctx) => {
        contexts.push(ctx)
        assert.equal(Object.hasOwn(ctx, 'user'), false)

        return await ctx.body()
      })
      recovered.pushData('next', true)
      await nextTurn()
      assert.notEqual(contexts[1], contexts[0])
      assert.equal(recovered.getStatus(), '200 OK')
      assert.equal(server.httpBodyBudget!.usedBytes, 0)
      assert.equal(server.activeHttp, 0)
    })
  }
}

for (const terminal of ['abort', 'setup failure'] as const) {
  test(`late Readable destruction after ${terminal} cannot affect a reused context`, async (t) => {
    const server = new Server({ http: { onRequest: () => 'ok' } })
    const owner = server.httpContextPool.acquire()

    server.httpContextPool.release(owner)
    const first = createMockHttpResponse()
    const second = createMockHttpResponse()
    const contexts: HttpContext[] = []
    const gate = Promise.withResolvers<string>()

    let finishDestroy: ((error: Error | null) => void) | undefined

    const source = new Readable({
      read() {},
      destroy(_error, callback) {
        finishDestroy = callback
      }
    })
    const closed = new Promise<void>((resolve) => source.once('close', resolve))

    t.after(() => {
      finishDestroy?.(null)
      gate.resolve('second')
      server.close()
    })
    server.handleWithContext(first, createMockReq(), (ctx) => {
      contexts.push(ctx)

      return ctx.stream(source, 200, terminal === 'setup failure' ? { 'bad\nheader': 'value' } : null)
    })

    if (terminal === 'abort') {
      first.triggerAborted()
    }

    await nextTurn()
    assert.ok(finishDestroy)
    assert.equal(source.closed, false)
    assert.equal(server.activeHttp, 0)
    assert.equal(server.httpContextPool.acquire(), owner)
    server.httpContextPool.release(owner)
    server.handleWithContext(second, createMockReq(), (ctx) => {
      contexts.push(ctx)

      return gate.promise
    })
    assert.notEqual(contexts[1], contexts[0])
    finishDestroy(new Error('late source failure'))
    finishDestroy = undefined
    await closed
    assert.equal(source.listenerCount('error'), 0)
    assert.equal(source.listenerCount('data'), 0)
    assert.equal(second.isEnded(), false)
    assert.equal(
      second.calls.some(({ method }) => method === 'close'),
      false
    )
    assert.equal(server.activeHttp, 1)
    gate.resolve('second')
    await nextTurn()
    assert.equal(server.activeHttp, 0)
  })
}

test('repeated requests do not evaluate or inherit application accessors', () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const contexts: HttpContext[] = []

  let getterCalls = 0

  const owner = server.httpContextPool.acquire()

  server.httpContextPool.release(owner)

  for (let index = 0; index < 100; index++) {
    const response = createMockHttpResponse()

    server.handleWithContext(response, createMockReq(), (ctx) => {
      contexts.push(ctx)
      assert.deepEqual(Reflect.ownKeys(ctx), [])
      Object.defineProperty(ctx, `request${index}`, {
        configurable: true,
        get() {
          getterCalls++
          throw new Error('cleanup must not read request accessors')
        }
      })
      Object.assign(ctx, { [Symbol(`body${index}`)]: Buffer.alloc(1024) })

      return 'ok'
    })
    const keys = Reflect.ownKeys(contexts[index]!)

    assert.equal(keys.length, 2)
    assert.equal(keys[0], `request${index}`)
    assert.equal(server.httpContextPool.acquire(), owner)
    server.httpContextPool.release(owner)
    assert.equal(
      Reflect.ownKeys(owner).some((key) => typeof key === 'string' && key.startsWith('request')),
      false
    )
    assert.equal(response.getStatus(), '200 OK')
    assert.equal(server.activeHttp, 0)
  }

  assert.equal(getterCalls, 0)
})

test('a native end failure from a Readable rejects stream() and waits for transport abort', async (t) => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const response = createMockHttpResponse()
  const failure = new Error('native end failed after source EOF')
  const observed: unknown[] = []
  const contexts: HttpContext[] = []
  const rejected = Promise.withResolvers<void>()

  let closeCalls = 0

  t.after(() => {
    response.triggerAborted()
    server.close()
  })
  response.end = () => {
    throw failure
  }
  response.close = () => {
    closeCalls++

    return response
  }
  server.handleWithContext(response, createMockReq(), (ctx) => {
    contexts.push(ctx)

    return ctx.stream(Readable.from(['body'])).catch((error) => {
      observed.push(error)
      rejected.resolve()
    })
  })
  await rejected.promise
  await nextTurn()
  assert.deepEqual(observed, [failure])
  assert.equal(closeCalls, 1)
  assert.equal(response.isEnded(), false)
  assert.equal(server.activeHttp, 1)
  assert.equal(contexts[0]!.res, response)
  response.triggerAborted()
  assert.equal(server.activeHttp, 0)
  assert.equal(contexts[0]!.res, null)
})
