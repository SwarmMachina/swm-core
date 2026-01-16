import { describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import BodyParser from '../src/body-parser.js'
import { createMockReq, createMockRes } from './helpers/mock-http.js'
import HttpContext from '../src/http-context.js'

describe('BodyParser', () => {
  describe('reset()', () => {
    test('should reset all state and set ctx and maxSize', () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 5000)

      const promise = parser.body()

      strictEqual(promise instanceof Promise, true)
    })

    test('should use default maxSize if not provided', () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from('1234567890'), true)
      strictEqual(promise instanceof Promise, true)
    })

    test('should reset state after previous use', async () => {
      const parser = new BodyParser()
      const ctx1 = new HttpContext(null)
      const res1 = createMockRes()
      const req1 = createMockReq({ headers: { 'content-length': '2' } })

      ctx1.reset(res1, req1)

      parser.reset(ctx1)
      const promise1 = parser.body()

      res1.pushData(Buffer.from([1, 2]), true)
      await promise1

      const ctx2 = new HttpContext(null)
      const res2 = createMockRes()
      const req2 = createMockReq({ headers: { 'content-length': '3' } })

      ctx2.reset(res2, req2)

      parser.reset(ctx2)
      const promise2 = parser.body()

      res2.pushData(Buffer.from([3, 4, 5]), true)
      const result = await promise2

      strictEqual(result.length, 3)
      deepStrictEqual(Array.from(result), [3, 4, 5])
    })
  })

  describe('clear()', () => {
    test('should clear all state including ctx', () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx)
      parser.clear()

      return rejects(parser.body(), (err) => {
        strictEqual(err.message, 'Internal Server Error')
        return true
      })
    })
  })

  describe('body() - known length mode', () => {
    test('should resolve with correct buffer when content-length matches', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2, 3, 4]), true)

      const result = await promise

      strictEqual(Buffer.isBuffer(result), true)
      strictEqual(result.length, 4)
      deepStrictEqual(Array.from(result), [1, 2, 3, 4])
    })

    test('should handle multiple chunks in known length mode', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '6' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2]), false)
      res.pushData(Buffer.from([3, 4]), false)
      res.pushData(Buffer.from([5, 6]), true)

      const result = await promise

      strictEqual(result.length, 6)
      deepStrictEqual(Array.from(result), [1, 2, 3, 4, 5, 6])
    })

    test('should reject if chunk exceeds expected size', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2, 3]), true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        strictEqual(err.status, 400)
        return true
      })
    })

    test('should reject if isLast is true but size does not match', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2]), true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        strictEqual(err.status, 400)
        return true
      })
    })

    test('should reject if content-length > maxSize', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      await rejects(parser.body(), (err) => {
        strictEqual(err.message, 'Request body too large')
        strictEqual(err.status, 413)
        return true
      })
    })

    test('should reject if aborted before data arrives', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      ctx.aborted = true
      res.pushData(Buffer.from([1, 2]), true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request aborted')
        strictEqual(err.status, 418)
        return true
      })
    })

    test('should reject if aborted during data reception', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2]), false)
      ctx.aborted = true
      res.pushData(Buffer.from([3, 4]), true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request aborted')
        strictEqual(err.status, 418)
        return true
      })
    })

    test('should ignore data after done flag is set', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2]), true)
      const result1 = await promise

      res.pushData(Buffer.from([3, 4]), true)

      const result2 = await parser.body()

      strictEqual(result1, result2)
      strictEqual(result1.length, 2)
    })
  })

  describe('body() - unknown length mode', () => {
    test('should resolve with buffer when no content-length header', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.body()

      res.pushData('hello', true)

      const result = await promise

      strictEqual(Buffer.isBuffer(result), true)
      strictEqual(result.toString('utf8'), 'hello')
    })

    test('should handle multiple chunks in unknown length mode', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.body()

      res.pushData('hello', false)
      res.pushData(' ', false)
      res.pushData('world', true)

      const result = await promise

      strictEqual(result.toString('utf8'), 'hello world')
    })

    test('should reject if total size exceeds limit', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      const promise = parser.body()

      res.pushData('hello', false)
      res.pushData('x', true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request body too large')
        strictEqual(err.status, 413)
        return true
      })
    })

    test('should grow buffer capacity as needed', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 1000)

      const promise = parser.body()

      const chunk1 = 'a'.repeat(100)
      const chunk2 = 'b'.repeat(200)
      const chunk3 = 'c'.repeat(300)

      res.pushData(chunk1, false)
      res.pushData(chunk2, false)
      res.pushData(chunk3, true)

      const result = await promise

      strictEqual(result.length, 600)
      strictEqual(result.toString('utf8'), chunk1 + chunk2 + chunk3)
    })

    test('should optimize buffer size when capacity is much larger than length', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 10000)

      const promise = parser.body()

      res.pushData('x', true)

      const result = await promise

      strictEqual(result.length, 1)
      strictEqual(result.toString('utf8'), 'x')
    })

    test('should reject if aborted in unknown length mode', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.body()

      ctx.aborted = true
      res.pushData('hello', true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request aborted')
        strictEqual(err.status, 418)
        return true
      })
    })
  })

  describe('body() - content-length = 0', () => {
    test('should resolve with empty buffer immediately', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '0' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const result = await parser.body()

      strictEqual(Buffer.isBuffer(result), true)
      strictEqual(result.length, 0)
      strictEqual(res.calls.filter((c) => c[0] === 'onData').length, 1)
    })
  })

  describe('body() - memoization', () => {
    test('should return same promise for multiple calls before resolve', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise1 = parser.body()
      const promise2 = parser.body()

      strictEqual(promise1, promise2)

      res.pushData(Buffer.from([1, 2]), true)
      await promise1
    })

    test('should return resolved promise with same buffer after resolve', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise1 = parser.body()

      res.pushData(Buffer.from([1, 2]), true)
      const result1 = await promise1

      const promise2 = parser.body()
      const result2 = await promise2

      strictEqual(result1, result2)
      strictEqual(Buffer.isBuffer(result2), true)
    })

    test('should return rejected promise with same error after reject', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise1 = parser.body()

      res.pushData(Buffer.from([1, 2, 3]), true)

      await rejects(promise1, (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        return true
      })

      await rejects(parser.body(), (err) => {
        strictEqual(err.message, 'Request body size mismatch')
        return true
      })
    })
  })

  describe('body() - maxSize parameter', () => {
    test('should use provided maxSize parameter instead of instance maxSize', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise1 = parser.body(20)

      res.pushData(Buffer.from('1234567890'), true)
      await promise1

      parser.reset(ctx, 100)

      await rejects(parser.body(5), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })

    test('should use instance maxSize when parameter is not provided', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      await rejects(parser.body(), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })
  })

  describe('body() - error cases', () => {
    test('should reject with serverError if ctx is null', async () => {
      const parser = new BodyParser()

      await rejects(parser.body(), (err) => {
        strictEqual(err.message, 'Internal Server Error')
        strictEqual(err.status, 500)
        return true
      })
    })

    test('should reject if aborted before body() call', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.aborted = true

      parser.reset(ctx)

      await rejects(parser.body(), (err) => {
        strictEqual(err.message, 'Request aborted')
        strictEqual(err.status, 418)
        return true
      })
    })
  })

  describe('buffer()', () => {
    test('should be alias for body()', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const bodyPromise = parser.body()
      const bufferPromise = parser.buffer()

      strictEqual(bodyPromise, bufferPromise)

      res.pushData(Buffer.from([1, 2]), true)

      const bodyResult = await parser.body()
      const bufferResult = await parser.buffer()

      strictEqual(bodyResult, bufferResult)
    })
  })

  describe('text()', () => {
    test('should return utf8 string from buffer', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.text()

      res.pushData('hello world', true)

      const result = await promise

      strictEqual(typeof result, 'string')
      strictEqual(result, 'hello world')
    })

    test('should return empty string for empty buffer', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '0' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const result = await parser.text()

      strictEqual(result, '')
    })

    test('should handle multi-byte UTF-8 characters', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.text()

      res.pushData('привет 🚀', true)

      const result = await promise

      strictEqual(result, 'привет 🚀')
    })

    test('should propagate errors from body()', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      await rejects(parser.text(), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })
  })

  describe('json()', () => {
    test('should parse valid JSON and return object', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.json()

      res.pushData('{"a":1,"b":"test","c":true}', true)

      const result = await promise

      deepStrictEqual(result, { a: 1, b: 'test', c: true })
    })

    test('should return null for empty buffer', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '0' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const result = await parser.json()

      strictEqual(result, null)
    })

    test('should parse JSON arrays', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.json()

      res.pushData('[1,2,3,"test"]', true)

      const result = await promise

      deepStrictEqual(result, [1, 2, 3, 'test'])
    })

    test('should reject with invalidJSON error for invalid JSON', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.json()

      res.pushData('{invalid json}', true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Invalid JSON')
        strictEqual(err.status, 400)
        return true
      })
    })

    test('should reject with invalidJSON error for incomplete JSON', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.json()

      res.pushData('{"a":1', true)

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Invalid JSON')
        strictEqual(err.status, 400)
        return true
      })
    })

    test('should propagate errors from body()', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      await rejects(parser.json(), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })
  })

  describe('abort()', () => {
    test('should reject pending promise with aborted error', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      parser.abort()

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request aborted')
        strictEqual(err.status, 418)
        return true
      })
    })

    test('should do nothing if already done', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '2' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1, 2]), true)
      await promise

      parser.abort()

      const result = await parser.body()

      strictEqual(result.length, 2)
    })

    test('should work in unknown length mode', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const promise = parser.body()

      res.pushData('hello', false)
      parser.abort()

      await rejects(promise, (err) => {
        strictEqual(err.message, 'Request aborted')
        strictEqual(err.status, 418)
        return true
      })
    })
  })

  describe('edge cases', () => {
    test('should handle very large known-length body', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const size = 10000
      const req = createMockReq({ headers: { 'content-length': String(size) } })

      ctx.reset(res, req)

      parser.reset(ctx, size + 1000)

      const promise = parser.body()
      const data = Buffer.alloc(size, 42)

      res.pushData(data, true)

      const result = await promise

      strictEqual(result.length, size)
      strictEqual(result[0], 42)
      strictEqual(result[size - 1], 42)
    })

    test('should handle single byte chunks', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '5' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const promise = parser.body()

      res.pushData(Buffer.from([1]), false)
      res.pushData(Buffer.from([2]), false)
      res.pushData(Buffer.from([3]), false)
      res.pushData(Buffer.from([4]), false)
      res.pushData(Buffer.from([5]), true)

      const result = await promise

      strictEqual(result.length, 5)
      deepStrictEqual(Array.from(result), [1, 2, 3, 4, 5])
    })

    test('should handle maxSize parameter in text()', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      await rejects(parser.text(5), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })

    test('should handle maxSize parameter in json()', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      await rejects(parser.json(5), (err) => {
        strictEqual(err.message, 'Request body too large')
        return true
      })
    })
  })
})
