import { describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'
import HttpContext, { JSON_HEADER, OCTET_STREAM_HEADER, STATUS_TEXT, TEXT_PLAIN_HEADER } from '../src/http-context.js'
import { createMockReq, createMockRes } from './helpers/mock-http.js'

describe('HttpContext', () => {
  describe('reset()/clear()/release()', () => {
    describe('reset()', () => {
      test('should set res and req', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)

        strictEqual(ctx.res, res)
        strictEqual(ctx.req, req)
      })

      test('should reset replied/aborted/streaming/streamingStarted/onWritableCallback', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.replied = true
        ctx.aborted = true
        ctx.streaming = true
        ctx.streamingStarted = true
        ctx.onWritableCallback = () => {}

        ctx.reset(res, req)

        strictEqual(ctx.replied, false)
        strictEqual(ctx.aborted, false)
        strictEqual(ctx.streaming, false)
        strictEqual(ctx.streamingStarted, false)
        strictEqual(ctx.onWritableCallback, null)
      })

      test('should reset private fields and preserve finalize/maxSize', async () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()
        const finalize = () => {}

        // Set some values
        ctx.reset(res, req, finalize, 5000)
        ctx.status(418)
        ctx.ip() // populate cache
        ctx.method() // populate cache
        ctx.url() // populate cache
        ctx.contentLength() // populate cache

        // Reset with same finalize and maxSize
        ctx.reset(res, req, finalize, 5) // small maxSize for testing

        strictEqual(ctx.getStatus(200), STATUS_TEXT[200]) // statusOverride should be reset
        strictEqual(ctx.ip(), '') // cache should be reset
        strictEqual(ctx.method(), '') // cache should be reset
        strictEqual(ctx.url(), '') // cache should be reset
        strictEqual(ctx.contentLength(), null) // cache should be reset

        // Verify maxSize is preserved: body with unknown length > maxSize should reject
        const bodyPromise = ctx.body()

        res.pushData('123', false) // 3 bytes
        res.pushData('456', false) // 3 more bytes = 6 total > 5 limit

        await rejects(bodyPromise, (err) => {
          strictEqual(err.message, 'Request body too large')
          return true
        })
      })

      test('should return this', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        strictEqual(ctx.reset(res, req), ctx)
      })
    })

    describe('clear()', () => {
      test('should nullify res/req/finalize and reset caches', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()
        const finalize = () => {}

        ctx.reset(res, req, finalize)
        ctx.ip() // populate cache
        ctx.method() // populate cache
        ctx.url() // populate cache

        ctx.clear()

        strictEqual(ctx.res, null)
        strictEqual(ctx.req, null)
        strictEqual(ctx.ip(), '') // cache cleared
        strictEqual(ctx.method(), '') // cache cleared
        strictEqual(ctx.url(), '') // cache cleared
      })

      test('should reset all state flags', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.replied = true
        ctx.aborted = true
        ctx.streaming = true
        ctx.streamingStarted = true
        ctx.onWritableCallback = () => {}

        ctx.clear()

        strictEqual(ctx.replied, false)
        strictEqual(ctx.aborted, false)
        strictEqual(ctx.streaming, false)
        strictEqual(ctx.streamingStarted, false)
        strictEqual(ctx.onWritableCallback, null)
      })
    })

    describe('release()', () => {
      test('should call pool.release(this) if pool exists', () => {
        const pool = {
          releaseCalls: 0,
          release(ctx) {
            this.releaseCalls++
            this.last = ctx
          }
        }
        const ctx = new HttpContext(pool)

        ctx.release()

        strictEqual(pool.releaseCalls, 1)
        strictEqual(pool.last, ctx)
      })

      test('should do nothing if pool is null', () => {
        const ctx = new HttpContext(null)

        ctx.release() // should not throw
      })
    })
  })

  describe('ip()/method()/url() caching', () => {
    describe('ip()', () => {
      test('should return empty string if res is null', () => {
        const ctx = new HttpContext(null)

        strictEqual(ctx.ip(), '')
      })

      test('should use getProxiedRemoteAddressAsText if available', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        res.setProxiedIp('1.2.3.4')
        ctx.reset(res, req)

        strictEqual(ctx.ip(), '1.2.3.4')
        strictEqual(res.getProxiedRemoteAddressAsTextCallCount(), 1)
      })

      test('should fallback to getRemoteAddressAsText if proxied is not available', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        res.setRemoteIp('5.6.7.8')
        ctx.reset(res, req)

        strictEqual(ctx.ip(), '5.6.7.8')
        strictEqual(res.getRemoteAddressAsTextCallCount(), 1)
      })

      test('should cache result', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        res.setProxiedIp('1.2.3.4')
        ctx.reset(res, req)

        ctx.ip()
        ctx.ip()

        strictEqual(res.getProxiedRemoteAddressAsTextCallCount(), 1)
      })
    })

    describe('method()', () => {
      test('should return empty string if req is null', () => {
        const ctx = new HttpContext(null)

        strictEqual(ctx.method(), '')
      })

      test('should return req.getMethod() and cache it', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq({ method: 'POST' })

        ctx.reset(res, req)

        strictEqual(ctx.method(), 'POST')
        strictEqual(ctx.method(), 'POST') // second call

        strictEqual(req.calls.filter((c) => c[0] === 'getMethod').length, 1)
      })
    })

    describe('url()', () => {
      test('should return empty string if req is null', () => {
        const ctx = new HttpContext(null)

        strictEqual(ctx.url(), '')
      })

      test('should return req.getUrl() and cache it', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq({ url: '/api/users' })

        ctx.reset(res, req)

        strictEqual(ctx.url(), '/api/users')
        strictEqual(ctx.url(), '/api/users') // second call

        strictEqual(req.calls.filter((c) => c[0] === 'getUrl').length, 1)
      })
    })
  })

  describe('header/query/param simple proxies', () => {
    test('header(name) should call req.getHeader(name)', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-type': 'application/json' } })

      ctx.reset(res, req)

      strictEqual(ctx.header('content-type'), 'application/json')
      deepStrictEqual(
        req.calls.filter((c) => c[0] === 'getHeader'),
        [['getHeader', 'content-type']]
      )
    })

    test('query(name) should call req.getQuery(name)', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ query: { id: '123' } })

      ctx.reset(res, req)

      strictEqual(ctx.query('id'), '123')
      deepStrictEqual(
        req.calls.filter((c) => c[0] === 'getQuery'),
        [['getQuery', 'id']]
      )
    })

    test('param(i) should call req.getParameter(i)', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ parameters: ['user', '123'] })

      ctx.reset(res, req)

      strictEqual(ctx.param(0), 'user')
      strictEqual(ctx.param(1), '123')
      deepStrictEqual(
        req.calls.filter((c) => c[0] === 'getParameter'),
        [
          ['getParameter', 0],
          ['getParameter', 1]
        ]
      )
    })
  })

  describe('contentLength() parsing and cache', () => {
    test('should return null if header is absent/empty/undefined', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req1 = createMockReq()
      const req2 = createMockReq({ headers: { 'content-length': '' } })
      const req3 = createMockReq({ headers: { 'content-length': undefined } })

      ctx.reset(res, req1)
      strictEqual(ctx.contentLength(), null)

      ctx.reset(res, req2)
      strictEqual(ctx.contentLength(), null)

      ctx.reset(res, req3)
      strictEqual(ctx.contentLength(), null)
    })

    test('should parse valid numbers', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req1 = createMockReq({ headers: { 'content-length': '0' } })
      const req2 = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req1)
      strictEqual(ctx.contentLength(), 0)

      ctx.reset(res, req2)
      strictEqual(ctx.contentLength(), 10)
    })

    test('should return null for invalid values', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req1 = createMockReq({ headers: { 'content-length': '-1' } })
      const req2 = createMockReq({ headers: { 'content-length': '1.5' } })
      const req3 = createMockReq({ headers: { 'content-length': 'abc' } })

      ctx.reset(res, req1)
      strictEqual(ctx.contentLength(), null)

      ctx.reset(res, req2)
      strictEqual(ctx.contentLength(), null)

      ctx.reset(res, req3)
      strictEqual(ctx.contentLength(), null)
    })

    test('should cache result', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '42' } })

      ctx.reset(res, req)

      ctx.contentLength()
      ctx.contentLength()

      strictEqual(req.calls.filter((c) => c[0] === 'getHeader' && c[1] === 'content-length').length, 1)
    })
  })

  describe('status()/getStatus()', () => {
    test('status(code) should override getStatus(statusFromCall)', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.status(418)

      strictEqual(ctx.getStatus(200), STATUS_TEXT[418])
    })

    test('getStatus should return 500 if statusFromCall is undefined/null and no override', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      strictEqual(ctx.getStatus(undefined), STATUS_TEXT[500])
      strictEqual(ctx.getStatus(null), STATUS_TEXT[500])
    })

    test('getStatus should return undefined for unknown status codes', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      strictEqual(ctx.getStatus(599), undefined)
    })
  })

  describe('setHeader()/setHeaders()', () => {
    test('setHeader should call res.writeHeader and return ctx', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      strictEqual(ctx.setHeader('x', '1'), ctx)
      deepStrictEqual(
        res.calls.filter((c) => c[0] === 'writeHeader'),
        [['writeHeader', 'x', '1']]
      )
    })

    test('setHeaders(null/undefined) should do nothing', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      ctx.setHeaders(null)
      ctx.setHeaders(undefined)

      strictEqual(res.calls.filter((c) => c[0] === 'writeHeader').length, 0)
    })

    test('setHeaders with TEXT_PLAIN_HEADER should write content-type', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      ctx.setHeaders(TEXT_PLAIN_HEADER)

      const writeHeaderCalls = res.calls.filter((c) => c[0] === 'writeHeader')

      strictEqual(writeHeaderCalls.length, 1)
      deepStrictEqual(writeHeaderCalls[0], ['writeHeader', 'content-type', 'text/plain; charset=utf-8'])
    })

    test('setHeaders with JSON_HEADER should write content-type', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      ctx.setHeaders(JSON_HEADER)

      const writeHeaderCalls = res.calls.filter((c) => c[0] === 'writeHeader')

      strictEqual(writeHeaderCalls.length, 1)
      deepStrictEqual(writeHeaderCalls[0], ['writeHeader', 'content-type', 'application/json; charset=utf-8'])
    })

    test('setHeaders with OCTET_STREAM_HEADER should write content-type', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      ctx.setHeaders(OCTET_STREAM_HEADER)

      const writeHeaderCalls = res.calls.filter((c) => c[0] === 'writeHeader')

      strictEqual(writeHeaderCalls.length, 1)
      deepStrictEqual(writeHeaderCalls[0], ['writeHeader', 'content-type', 'application/octet-stream'])
    })

    test('setHeaders should only write non-null/undefined values', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      ctx.setHeaders({ a: '1', b: null, c: undefined, d: '2' })

      const writeHeaderCalls = res.calls.filter((c) => c[0] === 'writeHeader')

      strictEqual(writeHeaderCalls.length, 2)
      deepStrictEqual(writeHeaderCalls, [
        ['writeHeader', 'a', '1'],
        ['writeHeader', 'd', '2']
      ])
    })
  })

  describe('reply()', () => {
    test('reply(200, TEXT_PLAIN_HEADER, "ok") should set replied and write status/headers/body', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.reply(200, TEXT_PLAIN_HEADER, 'ok')

      strictEqual(ctx.replied, true)
      strictEqual(res.calls[0][0], 'cork')
      strictEqual(res.calls.filter((c) => c[0] === 'cork').length, 1)
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[200]),
        true
      )
      strictEqual(
        res.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'text/plain; charset=utf-8'
        ),
        true
      )
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === 'ok'),
        true
      )
    })

    test('reply(204, TEXT_PLAIN_HEADER, null) should call end() without argument', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.reply(204, TEXT_PLAIN_HEADER, null)

      const endCalls = res.calls.filter((c) => c[0] === 'end')

      strictEqual(endCalls.length, 1)
      strictEqual(endCalls[0].length, 1) // only ['end'], no body argument
    })

    test('should do nothing if ctx.replied is true', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.replied = true
      ctx.reply(200, TEXT_PLAIN_HEADER, 'ok')

      strictEqual(res.calls.length, 0)
    })

    test('should do nothing if ctx.aborted is true', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.aborted = true
      ctx.reply(200, TEXT_PLAIN_HEADER, 'ok')

      strictEqual(res.calls.length, 0)
    })

    test('should check aborted inside cork and not write if aborted', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes({
        onCork: () => {
          ctx.aborted = true
        }
      })
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.reply(200, TEXT_PLAIN_HEADER, 'ok')

      // cork should be called, but nothing inside
      strictEqual(res.calls.length, 1)
      strictEqual(res.calls[0][0], 'cork')
      strictEqual(res.calls.filter((c) => c[0] === 'writeStatus').length, 0)
      strictEqual(res.calls.filter((c) => c[0] === 'writeHeader').length, 0)
      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
    })
  })

  describe('send()/sendJson()/sendText()/sendBuffer()', () => {
    test('send(null/undefined) should call reply(204, TEXT_PLAIN_HEADER, null)', () => {
      const ctx = new HttpContext(null)
      const res1 = createMockRes()
      const res2 = createMockRes()
      const req = createMockReq()

      ctx.reset(res1, req)
      ctx.send(null)

      strictEqual(res1.calls.filter((c) => c[0] === 'writeStatus' && c[1] === STATUS_TEXT[204]).length, 1)
      const endCalls1 = res1.calls.filter((c) => c[0] === 'end')

      strictEqual(endCalls1.length, 1)
      strictEqual(endCalls1[0].length, 1) // no body

      ctx.reset(res2, req)
      ctx.send(undefined)

      strictEqual(res2.calls.filter((c) => c[0] === 'writeStatus' && c[1] === STATUS_TEXT[204]).length, 1)
      const endCalls2 = res2.calls.filter((c) => c[0] === 'end')

      strictEqual(endCalls2.length, 1)
      strictEqual(endCalls2[0].length, 1) // no body
    })

    test('send("str") should call reply(200, TEXT_PLAIN_HEADER, "str")', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.send('hello')

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[200]),
        true
      )
      strictEqual(
        res.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'text/plain; charset=utf-8'
        ),
        true
      )
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === 'hello'),
        true
      )
    })

    test('send(123) should call reply(200, TEXT_PLAIN_HEADER, "123")', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.send(123)

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === '123'),
        true
      )
    })

    test('send(Buffer/Uint8Array/ArrayBuffer) should use OCTET_STREAM_HEADER', () => {
      const ctx = new HttpContext(null)
      const res1 = createMockRes()
      const res2 = createMockRes()
      const res3 = createMockRes()
      const req = createMockReq()

      const buf = Buffer.from('test')
      const u8 = new Uint8Array([1, 2, 3])
      const ab = new ArrayBuffer(4)

      ctx.reset(res1, req)
      ctx.send(buf)

      strictEqual(
        res1.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'application/octet-stream'
        ),
        true
      )

      ctx.reset(res2, req)
      ctx.send(u8)

      strictEqual(
        res2.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'application/octet-stream'
        ),
        true
      )

      ctx.reset(res3, req)
      ctx.send(ab)

      strictEqual(
        res3.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'application/octet-stream'
        ),
        true
      )
    })

    test('send({a:1}) should call reply(200, JSON_HEADER, JSON string)', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.send({ a: 1 })

      strictEqual(
        res.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'application/json; charset=utf-8'
        ),
        true
      )
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === '{"a":1}'),
        true
      )
    })

    test('sendJson({a:1}, 201) should use status 201 and JSON header', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.sendJson({ a: 1 }, 201)

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[201]),
        true
      )
      strictEqual(
        res.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'application/json; charset=utf-8'
        ),
        true
      )
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === '{"a":1}'),
        true
      )
    })

    test('sendText("x", 202) should use text/plain and status 202', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.sendText('x', 202)

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[202]),
        true
      )
      strictEqual(
        res.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'text/plain; charset=utf-8'
        ),
        true
      )
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === 'x'),
        true
      )
    })

    test('sendBuffer(buf, 203) should use octet-stream and status 203', () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      const buf = Buffer.from('test')

      ctx.reset(res, req)
      ctx.sendBuffer(buf, 203)

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[203]),
        true
      )
      strictEqual(
        res.calls.some(
          ([name, ...args]) =>
            name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'application/octet-stream'
        ),
        true
      )
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === buf),
        true
      )
    })
  })

  describe('body()/buffer() - parsing only (no streaming)', () => {
    test('should reject if aborted before body()', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.aborted = true

      await rejects(ctx.body(), (err) => {
        strictEqual(err.message, 'Request aborted')
        return true
      })
    })

    test('should reject if content-length > limit', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '5' } })

      ctx.reset(res, req)

      await rejects(ctx.body(4), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })

    test('content-length == 0 should resolve empty buffer and call onData with NOOP', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '0' } })

      ctx.reset(res, req)

      const result = await ctx.body()

      strictEqual(result.length, 0)
      strictEqual(Buffer.isBuffer(result), true)
      strictEqual(res.calls.filter((c) => c[0] === 'onData').length, 1)
      // onDataCb should exist (it's NOOP, but we can check it was called)
      strictEqual(typeof res.onDataCb, 'function')
    })

    test('known length success: should resolve with all chunks', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      const bodyPromise = ctx.body()

      // Simulate data arrival
      res.pushData(Buffer.from([1, 2]), false)
      res.pushData(Buffer.from([3, 4]), true)

      const result = await bodyPromise

      strictEqual(result.length, 4)
      deepStrictEqual(Array.from(result), [1, 2, 3, 4])
    })

    test('known length sizeMismatch: too much data', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      const bodyPromise = ctx.body()

      res.pushData(Buffer.from([1, 2, 3]), true)

      await rejects(bodyPromise, (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        return true
      })
    })

    test('known length sizeMismatch: isLast too early', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      const bodyPromise = ctx.body()

      res.pushData(Buffer.from([1, 2]), true)

      await rejects(bodyPromise, (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        return true
      })
    })

    test('unknown length success: no content-length header', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, null, 10)

      const bodyPromise = ctx.body()

      res.pushData('ab', false)
      res.pushData('cd', true)

      const result = await bodyPromise

      strictEqual(result.toString('utf8'), 'abcd')
    })

    test('unknown length too large: should reject', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, null, 3)

      const bodyPromise = ctx.body()

      res.pushData('ab', false)
      res.pushData('cd', true)

      await rejects(bodyPromise, (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })

    test('body() memoization: should return same promise before resolve', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      const promise1 = ctx.body()
      const promise2 = ctx.body()

      strictEqual(promise1, promise2)

      res.pushData(Buffer.from([1, 2]), true)

      await promise1
    })

    test('body() after resolve should return resolved promise with same buffer', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      const promise1 = ctx.body()

      res.pushData(Buffer.from([1, 2]), true)
      const result1 = await promise1

      const promise2 = ctx.body()
      const result2 = await promise2

      strictEqual(result1, result2)
      strictEqual(Buffer.isBuffer(result2), true)
    })

    test('body() after reject should return rejected promise with same error', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      const promise1 = ctx.body()

      res.pushData(Buffer.from([1, 2, 3]), true) // too much data

      await rejects(promise1, (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        return true
      })

      await rejects(ctx.body(), (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        return true
      })
    })

    test('buffer() should be alias for body()', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      const bodyPromise = ctx.body()
      const bufferPromise = ctx.buffer()

      strictEqual(bodyPromise, bufferPromise)

      res.pushData(Buffer.from([1, 2]), true)

      const bodyResult = await ctx.body()
      const bufferResult = await ctx.buffer()

      strictEqual(bodyResult, bufferResult)
    })
  })

  describe('json()/text()', () => {
    test('json() with empty buffer should return null', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '0' } })

      ctx.reset(res, req)

      const result = await ctx.json()

      strictEqual(result, null)
    })

    test('json() with valid JSON should return object', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, null, 100)

      const jsonPromise = ctx.json()

      res.pushData('{"a":1,"b":"test"}', true)

      const result = await jsonPromise

      deepStrictEqual(result, { a: 1, b: 'test' })
    })

    test('json() with invalid JSON should throw Error Invalid JSON', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, null, 100)

      const jsonPromise = ctx.json()

      res.pushData('{invalid json}', true)

      await rejects(jsonPromise, (err) => {
        strictEqual(err.message.startsWith('Invalid JSON'), true)
        return true
      })
    })

    test('text() should return utf8 string from body', async () => {
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, null, 100)

      const textPromise = ctx.text()

      res.pushData('hello', false)
      res.pushData(' world', true)

      const result = await textPromise

      strictEqual(result, 'hello world')
    })
  })

  describe('streaming (startStreaming/write/tryEnd/end/onWritable/getWriteOffset/stream)', () => {
    describe('startStreaming()', () => {
      test('should set replied=true, streaming=true, and write status+headers inside cork', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.startStreaming(200, TEXT_PLAIN_HEADER)

        strictEqual(ctx.replied, true)
        strictEqual(ctx.streaming, true)
        strictEqual(ctx.streamingStarted, false)

        strictEqual(res.calls[0][0], 'cork')
        strictEqual(res.calls.filter((c) => c[0] === 'cork').length, 1)
        strictEqual(
          res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[200]),
          true
        )
        strictEqual(
          res.calls.some(
            ([name, ...args]) =>
              name === 'writeHeader' && args[0] === 'content-type' && args[1] === 'text/plain; charset=utf-8'
          ),
          true
        )
      })

      test('should no-op if ctx.replied=true', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.replied = true
        ctx.startStreaming(200, TEXT_PLAIN_HEADER)

        strictEqual(ctx.streaming, false)
        strictEqual(res.calls.length, 0)
      })

      test('should no-op if ctx.aborted=true', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.aborted = true
        ctx.startStreaming(200, TEXT_PLAIN_HEADER)

        strictEqual(ctx.streaming, false)
        strictEqual(res.calls.length, 0)
      })
    })

    describe('write()', () => {
      test('should throw if startStreaming() not called', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)

        throws(
          () => {
            ctx.write('x')
          },
          {
            message: 'Must call startStreaming() before write()'
          }
        )
      })

      test('should return false and not write if aborted', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.aborted = true

        const result = ctx.write('x')

        strictEqual(result, false)
        strictEqual(res.calls.filter((c) => c[0] === 'write').length, 0)
      })

      test('should call res.write inside cork and return its boolean', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.startStreaming(200)

        res.setWriteResultSequence([false, true])

        const result1 = ctx.write('a')

        strictEqual(result1, false)
        strictEqual(ctx.streamingStarted, true)

        const result2 = ctx.write('b')

        strictEqual(result2, true)

        const writeCalls = res.calls.filter((c) => c[0] === 'write')

        strictEqual(writeCalls.length, 2)
        deepStrictEqual(writeCalls[0], ['write', 'a'])
        deepStrictEqual(writeCalls[1], ['write', 'b'])
      })
    })

    describe('tryEnd()', () => {
      test('should throw if startStreaming not called', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)

        throws(
          () => {
            ctx.tryEnd('x')
          },
          {
            message: 'Must call startStreaming() before tryEnd()'
          }
        )
      })

      test('aborted -> [false,false] and no calls', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.aborted = true

        const result = ctx.tryEnd('x')

        deepStrictEqual(result, [false, false])
        strictEqual(res.calls.filter((c) => c[0] === 'tryEnd').length, 0)
      })

      test('should pass correct totalSize = getWriteOffset() + chunkLen', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.startStreaming(200)

        res.setWriteOffset(10)
        res.setTryEndResultSequence([[true, false]])

        ctx.tryEnd('abc')

        const tryEndCall = res.calls.find(([name, ...args]) => name === 'tryEnd' && args[0] === 'abc')

        strictEqual(tryEndCall !== undefined, true)
        strictEqual(tryEndCall[2], 13) // 10 + 3
      })

      test('when done=true -> streaming becomes false and finalize called', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()
        let finalizeCallCount = 0
        const finalize = () => {
          finalizeCallCount++
        }

        ctx.reset(res, req, finalize)
        ctx.startStreaming(200)

        res.setTryEndResultSequence([[true, true]])

        ctx.tryEnd('x')

        strictEqual(ctx.streaming, false)
        strictEqual(finalizeCallCount, 1)
      })
    })

    describe('end()', () => {
      test('should throw if startStreaming not called', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)

        throws(
          () => {
            ctx.end()
          },
          {
            message: 'Must call startStreaming() before end()'
          }
        )
      })

      test('should end with chunk and call finalize, streaming=false', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()
        let finalizeCallCount = 0
        const finalize = () => {
          finalizeCallCount++
        }

        ctx.reset(res, req, finalize)
        ctx.startStreaming(200)

        ctx.end('bye')

        strictEqual(
          res.calls.some(([name, ...args]) => name === 'end' && args[0] === 'bye'),
          true
        )
        strictEqual(ctx.streaming, false)
        strictEqual(finalizeCallCount, 1)
      })

      test('end() with no chunk should call res.end() without args', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.startStreaming(200)

        ctx.end()

        const endCalls = res.calls.filter((c) => c[0] === 'end')

        strictEqual(endCalls.length, 1)
        strictEqual(endCalls[0].length, 1) // only ['end'], no body
      })
    })

    describe('onWritable()', () => {
      test('should register onWritable wrapper and call provided callback once, then disable itself', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()
        let cbCallCount = 0
        let lastOffset = null
        const cbSpy = (offset) => {
          cbCallCount++
          lastOffset = offset
        }

        ctx.reset(res, req)
        ctx.startStreaming(200)
        ctx.onWritable(cbSpy)

        strictEqual(res.calls.filter((c) => c[0] === 'onWritable').length, 1)

        const result1 = res.triggerWritable(123)

        strictEqual(cbCallCount, 1)
        strictEqual(lastOffset, 123)
        strictEqual(result1, false) // handler returns false

        const result2 = res.triggerWritable(456)

        strictEqual(cbCallCount, 1) // not called again
        strictEqual(result2, true) // handler returns true when no callback
      })

      test('aborted -> onWritable should no-op and not register', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.aborted = true

        ctx.onWritable(() => {})

        strictEqual(res.calls.filter((c) => c[0] === 'onWritable').length, 0)
      })
    })

    describe('getWriteOffset()', () => {
      test('aborted -> 0', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        ctx.aborted = true
        res.setWriteOffset(100)

        strictEqual(ctx.getWriteOffset(), 0)
      })

      test('otherwise -> proxy to res.getWriteOffset()', () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        res.setWriteOffset(42)

        strictEqual(ctx.getWriteOffset(), 42)

        const getWriteOffsetCalls = res.calls.filter((c) => c[0] === 'getWriteOffset')

        strictEqual(getWriteOffsetCalls.length, 1)
      })
    })

    describe('stream(readable)', () => {
      /**
       *
       */
      function createMockReadable() {
        const listeners = {}
        let pauseCallCount = 0
        let resumeCallCount = 0
        let destroyCallCount = 0

        return {
          on(event, cb) {
            if (!listeners[event]) {
              listeners[event] = []
            }
            listeners[event].push(cb)
          },
          emit(event, arg) {
            if (listeners[event]) {
              for (const cb of listeners[event]) {
                cb(arg)
              }
            }
          },
          pause() {
            pauseCallCount++
          },
          resume() {
            resumeCallCount++
          },
          destroy() {
            destroyCallCount++
          },
          getPauseCallCount() {
            return pauseCallCount
          },
          getResumeCallCount() {
            return resumeCallCount
          },
          getDestroyCallCount() {
            return destroyCallCount
          }
        }
      }

      test('happy path, write always true', async () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        res.setWriteResultSequence([true, true, true])

        const readable = createMockReadable()
        const p = ctx.stream(readable, 200, TEXT_PLAIN_HEADER)

        readable.emit('data', Buffer.from('a'))
        readable.emit('data', Buffer.from('b'))
        readable.emit('end')

        await p

        strictEqual(readable.getPauseCallCount(), 0)
        strictEqual(readable.getResumeCallCount(), 0)

        const writeCalls = res.calls.filter((c) => c[0] === 'write')

        strictEqual(writeCalls.length, 2)
        strictEqual(res.calls.filter((c) => c[0] === 'writeStatus').length, 1)
        strictEqual(res.calls.filter((c) => c[0] === 'writeHeader').length, 1)
        strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
      })

      test('backpressure', async () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        res.setWriteResultSequence([false, true])

        const readable = createMockReadable()
        const p = ctx.stream(readable, 200)

        readable.emit('data', 'a') // write returns false, should pause

        strictEqual(readable.getPauseCallCount(), 1)
        strictEqual(readable.getResumeCallCount(), 0)

        res.triggerWritable(100) // trigger writable, should resume

        strictEqual(readable.getResumeCallCount(), 1)

        readable.emit('data', 'b') // write returns true
        readable.emit('end')

        await p

        strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
      })

      test('aborted mid-stream', async () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()

        ctx.reset(res, req)
        res.setWriteResultSequence([true])

        const readable = createMockReadable()
        const p = ctx.stream(readable, 200)

        ctx.aborted = true
        readable.emit('data', 'a')

        await p

        strictEqual(readable.getDestroyCallCount(), 1)
        strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
      })

      test('error event rejects and calls end() if not aborted', async () => {
        const ctx = new HttpContext(null)
        const res = createMockRes()
        const req = createMockReq()
        let finalizeCallCount = 0
        const finalize = () => {
          finalizeCallCount++
        }

        ctx.reset(res, req, finalize)
        res.setWriteResultSequence([true])

        const readable = createMockReadable()
        const p = ctx.stream(readable, 200)

        readable.emit('data', 'a')
        readable.emit('error', new Error('boom'))

        await rejects(p, (err) => {
          strictEqual(err.message, 'boom')
          return true
        })

        strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
        strictEqual(finalizeCallCount, 1)
      })
    })
  })
})
