import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Readable } from 'node:stream'
import Server from '../../src/server/server.js'
import { prepareHeaders } from '../../src/http/headers.js'
import type HttpContext from '../../src/http/public-context.js'
import { createMockReq } from '../helpers/mock-http.js'
import { createMockHttpResponse } from '../helpers/mock-uws.js'

for (const name of ['Content-Length', 'content-length', 'TRANSFER-ENCODING', 'Transfer-Encoding']) {
  test(`${name} is rejected while compiling a prepared header block`, () => {
    assert.throws(() => prepareHeaders({ [name]: '2' }), /managed by the HTTP transport/)
  })

  for (const method of [
    'setHeader',
    'appendHeader',
    'setHeaders',
    'flushHeaders',
    'reply',
    'startStreaming',
    'stream'
  ] as const) {
    test(`${method} validates ${name} before writing a native response`, () => {
      const server = new Server({ http: { onRequest: () => 'ok' } })
      const response = createMockHttpResponse()
      const headers = { 'x-first': 'valid', [name]: '2' }

      server.handleWithContext(response, createMockReq(), (ctx) => {
        switch (method) {
          case 'setHeader':
            return ctx.setHeader(name, '2')
          case 'appendHeader':
            return ctx.appendHeader(name, '2')
          case 'setHeaders':
            return ctx.setHeaders(headers)
          case 'flushHeaders':
            return ctx.flushHeaders(headers)
          case 'reply':
            return ctx.reply(200, headers, 'ok')
          case 'startStreaming':
            return ctx.startStreaming(200, headers)
          case 'stream':
            return ctx.stream(Readable.from(['ok']), 200, headers)
        }
      })
      assert.equal(response.getStatus(), '500 Internal Server Error')
      assert.equal(response.calls.filter(({ method }) => method === 'writeStatus').length, 1)
      assert.equal(
        response.calls.some(({ method }) => method === 'close'),
        false
      )
      assert.equal(server.activeHttp, 0)
    })
  }
}

test('prepared and dynamic headers reject native-invalid controls while permitting horizontal tabs', () => {
  for (const value of ['a\0b', 'a\x01b', 'a\x1fb', 'a\x7fb']) {
    assert.throws(() => prepareHeaders({ 'x-value': value }), /control characters/)
    const server = new Server({ http: { onRequest: () => 'ok' } })
    const response = createMockHttpResponse()

    server.handleWithContext(response, createMockReq(), (ctx) => ctx.reply(200, { 'x-value': value }, 'bad'))
    assert.equal(response.getStatus(), '500 Internal Server Error')
    assert.equal(server.activeHttp, 0)
  }

  assert.doesNotThrow(() => prepareHeaders({ 'x-value': 'a\tb' }))
})

for (const asynchronous of [false, true]) {
  test(`a close failure preserves the original response error ${asynchronous ? 'after await' : 'on the handler stack'}`, async () => {
    const failure = new Error('original write failure')
    const cleanupFailure = new Error('response already invalid')
    const errors: Error[] = []
    const server = new Server({
      http: {
        onRequest: () => 'ok',
        onError: (_event, error) => {
          errors.push(error)
        }
      }
    })
    const response = createMockHttpResponse()
    const owner = server.httpContextPool.acquire()

    server.httpContextPool.release(owner)
    response.writeStatus = () => {
      throw failure
    }
    response.close = () => {
      throw cleanupFailure
    }
    let first: HttpContext | undefined

    const reply = (ctx: HttpContext) => {
      first = ctx
      ctx.reply(200, { 'x-safe': 'value' }, 'bad')
    }

    server.handleWithContext(
      response,
      createMockReq(),
      asynchronous
        ? async (ctx) => {
            await nextTurn()
            reply(ctx)
          }
        : reply
    )
    await nextTurn()
    await nextTurn()
    assert.deepEqual(errors, [failure])
    assert.equal(server.activeHttp, 0)
    assert.equal(first!.res, null)
    const replacement = server.httpContextPool.acquire()

    assert.notEqual(replacement, owner)
    server.httpContextPool.release(replacement)
    const next = createMockHttpResponse()
    const gate = Promise.withResolvers<string>()

    server.handleWithContext(next, createMockReq(), () => gate.promise)
    response.triggerAborted()
    assert.equal(next.isEnded(), false)
    assert.equal(server.activeHttp, 1)
    gate.resolve('next')
    await nextTurn()
    assert.equal(next.isEnded(), true)
    assert.equal(server.activeHttp, 0)
  })
}
