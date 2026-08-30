// noinspection JSCheckFunctionSignatures

import { describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'
import BodyParser, { nextBodyCapacity } from '../../src/http/body-parser.js'
import BodyBudget from '../../src/http/body-budget.js'
import { CACHED_ERRORS } from '../../src/http/status.js'
import { createMockReq, createMockRes } from '../helpers/mock-http.js'
import HttpContext from '../../src/http/context.js'

interface HttpError extends Error {
  status?: number
}

function httpError(error: unknown): HttpError {
  if (!(error instanceof Error)) {
    throw new TypeError('Expected an Error rejection')
  }

  return error as HttpError
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError('Expected a Buffer chunk')
    }

    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

describe('BodyParser', () => {
  describe('bodyStream()', () => {
    test('should enforce the configured stream ceiling and only allow per-call narrowing', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()

      ctx.reset(res, createMockReq({ headers: { 'content-length': '5' } }))
      parser.reset(ctx, 16, 4)

      throws(
        () => parser.bodyStream(100),
        (error) => error === CACHED_ERRORS.bodyTooLarge
      )

      const nextCtx = new HttpContext(null)
      const nextRes = createMockRes()

      nextCtx.reset(nextRes, createMockReq({ headers: { 'content-length': '4' } }))
      parser.reset(nextCtx, 16, 4)

      const body = readStream(parser.bodyStream(100))

      nextRes.pushData('test', true)
      strictEqual((await body).toString(), 'test')
    })

    test('should reject invalid per-call stream limits', () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()

      ctx.reset(res, createMockReq())
      parser.reset(ctx, 16, 16)

      for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        throws(() => parser.bodyStream(value), {
          name: 'TypeError',
          message: 'maxSize must be specified in bytes as a non-negative safe integer'
        })
      }
    })

    test('should reject streaming after another body reader or prefetch', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()

      ctx.reset(res, createMockReq({ headers: { 'content-length': '4' } }))
      parser.reset(ctx, 16, 16)
      parser.prefetch()

      throws(() => parser.bodyStream(), {
        name: 'Error',
        message: 'Request body already has a reader'
      })

      res.pushData('test', true)
      strictEqual((await parser.body()).toString(), 'test')

      throws(() => parser.bodyStream(), {
        name: 'Error',
        message: 'Request body already has a reader'
      })
    })

    test('should reject buffered readers and prefetch after streaming starts', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()

      ctx.reset(res, createMockReq())
      parser.reset(ctx, 16, 16)
      parser.bodyStream()

      await rejects(parser.body(), (error) => {
        strictEqual(httpError(error).message, 'Request body already has a reader')
        strictEqual(httpError(error).status, undefined)

        return true
      })

      const prefetchError = parser.prefetch()

      strictEqual(prefetchError?.message, 'Request body already has a reader')
      strictEqual(httpError(prefetchError).status, undefined)
    })

    test('should preserve abort state when streaming is requested too late', () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()

      ctx.reset(res, createMockReq())
      parser.reset(ctx, 16, 16)
      ctx.aborted = true

      throws(
        () => parser.bodyStream(),
        (error) => error === CACHED_ERRORS.aborted
      )
    })

    test('should retain a synchronously completed stream until request cleanup', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()

      res.onData = (callback) => {
        callback(Uint8Array.from(Buffer.from('test')).buffer, true)

        return res
      }

      ctx.reset(res, createMockReq({ headers: { 'content-length': '4' } }))
      parser.reset(ctx, 16, 16)

      const stream = parser.bodyStream()

      parser.timeout()
      await rejects(readStream(stream), (error) => error === CACHED_ERRORS.requestTimeout)
    })

    test('should detach callbacks from a previous parser generation', async () => {
      const parser = new BodyParser()
      const oldCtx = new HttpContext(null)
      const oldRes = createMockRes()

      oldCtx.reset(oldRes, createMockReq())
      parser.reset(oldCtx, 16, 16)

      const oldStream = parser.bodyStream()
      const oldCallback = oldRes.onDataCb!
      const oldFailure = readStream(oldStream)
      const nextCtx = new HttpContext(null)
      const nextRes = createMockRes()

      nextCtx.reset(nextRes, createMockReq({ headers: { 'content-length': '3' } }))
      parser.reset(nextCtx, 16, 16)

      const nextBody = readStream(parser.bodyStream())

      oldCallback(Uint8Array.from(Buffer.from('old')).buffer, true)
      nextRes.pushData('new', true)

      await rejects(oldFailure, (error) => error === CACHED_ERRORS.aborted)
      strictEqual((await nextBody).toString(), 'new')
    })
  })

  describe('reset()', () => {
    test('should reset all state and set ctx and maxSize', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      const p = parser.body()

      res.pushData('123456', true)

      await rejects(p, (err) => {
        strictEqual(httpError(err).message, 'Request body too large')
        strictEqual(httpError(err).status, 413)

        return true
      })
    })

    test('should use default maxSize if not provided', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx)

      const p = parser.body()

      res.pushData(Buffer.from('1234567890'), true)
      const result = await p

      strictEqual(result.length, 10)
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
        strictEqual(httpError(err).message, 'Internal Server Error')

        return true
      })
    })

    test('should reject pending promise with aborted error', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)

      parser.reset(ctx)

      const p = parser.body()

      parser.clear()

      await rejects(p, (err) => {
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

        return true
      })

      await rejects(parser.body(), (err) => {
        strictEqual(httpError(err).message, 'Internal Server Error')

        return true
      })
    })
  })

  describe('prefetch()', () => {
    test('should attach the collector before a body accessor is called', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)
      parser.reset(ctx, 16)
      parser.prefetch()

      strictEqual(res.calls.filter((call) => call[0] === 'onData').length, 1)

      res.pushData('test', true)
      strictEqual((await parser.text()).toString(), 'test')
    })

    test('should let an accessor wait for an in-flight prefetched body', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)
      parser.reset(ctx, 16)
      parser.prefetch()

      const body = parser.body()

      res.pushData('test', true)
      deepStrictEqual(await body, Buffer.from('test'))
    })

    test('should enforce a smaller accessor limit after prefetch', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)
      parser.reset(ctx, 16)
      parser.prefetch()
      res.pushData('test', true)

      await rejects(parser.body(3), (err) => err === CACHED_ERRORS.bodyTooLarge)
      deepStrictEqual(await parser.body(4), Buffer.from('test'))
    })

    test('should ignore a late native callback from a previous generation', async () => {
      const parser = new BodyParser()
      const server = {
        bindingCapabilities: { collectBody: true },
        finalizeHttpContext() {}
      }
      const oldCtx = new HttpContext(null)
      const oldRes = createMockRes()
      const oldReq = createMockReq({ headers: { 'content-length': '3' } })

      oldCtx.reset(oldRes, oldReq, server)
      parser.reset(oldCtx, 16)
      parser.prefetch()

      const nextCtx = new HttpContext(null)
      const nextRes = createMockRes()
      const nextReq = createMockReq({ headers: { 'content-length': '3' } })

      nextCtx.reset(nextRes, nextReq, server)
      parser.reset(nextCtx, 16)
      parser.prefetch()

      oldRes.pushCollectedBody(Buffer.from('old'))
      nextRes.pushCollectedBody(Buffer.from('new'))

      strictEqual(await parser.text(), 'new')
    })

    test('should remember an abort without creating an unhandled rejection', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req)
      parser.reset(ctx, 16)
      parser.prefetch()
      parser.abort()

      await rejects(parser.body(), (err) => err === CACHED_ERRORS.aborted)
    })

    test('should reserve known body bytes and release them on clear', async () => {
      const parser = new BodyParser()
      const budget = new BodyBudget(16)
      const server = { bindingCapabilities: {}, httpBodyBudget: budget }
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req, server)
      parser.reset(ctx, 16)
      parser.prefetch()

      strictEqual(budget.usedBytes, 4)

      res.pushData('test', true)
      strictEqual(await parser.text(), 'test')
      strictEqual(budget.usedBytes, 4)

      parser.clear()
      strictEqual(budget.usedBytes, 0)
    })

    test('should not resize an unchanged known-body reservation', async () => {
      const calls: string[] = []
      const budget = {
        tryReserve(bytes: number): boolean {
          calls.push(`reserve:${bytes}`)

          return true
        },
        resize(bytes: number): boolean {
          calls.push(`resize:${bytes}`)

          return true
        },
        release(): void {
          calls.push('release')
        }
      }
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req, { bindingCapabilities: {}, httpBodyBudget: budget })
      parser.reset(ctx, 16)
      const body = parser.body()

      res.pushData('test', true)
      strictEqual((await body).toString(), 'test')
      deepStrictEqual(calls, ['reserve:4'])

      parser.clear()
      deepStrictEqual(calls, ['reserve:4', 'release'])
    })

    test('should reject when aggregate capacity cannot be reserved', async () => {
      const parser = new BodyParser()
      const server = {
        bindingCapabilities: {},
        httpBodyBudget: new BodyBudget(0)
      }
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '4' } })

      ctx.reset(res, req, server)
      parser.reset(ctx, 16)

      strictEqual(parser.prefetch(), CACHED_ERRORS.bodyBudgetExceeded)
      await rejects(parser.body(), (err) => err === CACHED_ERRORS.bodyBudgetExceeded)
      strictEqual(
        res.calls.some((call) => call[0] === 'onData'),
        true
      )
    })

    test('should release the body reservation on request timeout', async () => {
      const parser = new BodyParser()
      const budget = new BodyBudget(16)
      const server = { bindingCapabilities: {}, httpBodyBudget: budget }
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, server)
      parser.reset(ctx, 16)
      parser.prefetch()

      strictEqual(budget.usedBytes, 16)

      const body = parser.body()

      parser.timeout()

      await rejects(body, (err) => err === CACHED_ERRORS.requestTimeout)
      strictEqual(budget.usedBytes, 0)
    })
  })

  describe('body() - known length mode', () => {
    function startLengthAwareBody(declaredLength: number | undefined, limit = 16, budget?: BodyBudget) {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '999' } })
      const server = {
        bindingCapabilities: { collectBodyLength: true },
        httpBodyBudget: budget ?? null,
        finalizeHttpContext() {}
      }

      res.setCollectedBodyLength(declaredLength)
      ctx.reset(res, req, server)
      parser.reset(ctx, limit)

      return { body: parser.body(), parser, req, res }
    }

    test('should use native collectBody when advertised by the backend', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '3' } })
      const server = {
        bindingCapabilities: { collectBody: true },
        finalizeHttpContext() {}
      }

      ctx.reset(res, req, server)
      parser.reset(ctx, 16)
      const body = parser.body()

      res.pushCollectedBody([1, 2, 3])

      deepStrictEqual(await body, Buffer.from([1, 2, 3]))
      deepStrictEqual(res.calls, [['collectBody', 16]])
    })

    test('should map native collectBody overflow to bodyTooLarge', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      const server = {
        bindingCapabilities: { collectBody: true },
        finalizeHttpContext() {}
      }

      ctx.reset(res, req, server)
      parser.reset(ctx, 4)
      const body = parser.body()

      res.pushCollectedBody(null)

      await rejects(body, (error) => httpError(error).message === 'Request body too large')
    })

    test('should use transport-provided body length and validate its contract', async () => {
      const exact = startLengthAwareBody(3)

      exact.res.pushCollectedBody([1, 2, 3])
      deepStrictEqual(await exact.body, Buffer.from([1, 2, 3]))
      deepStrictEqual(exact.res.calls, [['collectBodyWithLength', 16]])
      deepStrictEqual(exact.req.calls, [])

      const empty = startLengthAwareBody(0)

      deepStrictEqual(await empty.body, Buffer.alloc(0))
      deepStrictEqual(empty.res.calls, [['collectBodyWithLength', 16], ['discardBody']])

      const oversized = startLengthAwareBody(17)

      await rejects(oversized.body, (error) => error === CACHED_ERRORS.bodyTooLarge)
      deepStrictEqual(oversized.res.calls, [['collectBodyWithLength', 16], ['discardBody']])

      for (const [declaredLength, received] of [
        [4, [1, 2, 3]],
        [3, [1, 2, 3, 4]]
      ] as const) {
        const mismatched = startLengthAwareBody(declaredLength)

        mismatched.res.pushCollectedBody(received)
        await rejects(mismatched.body, (error) => error === CACHED_ERRORS.sizeMismatch)
      }
    })

    test('should retain abort and BodyBudget behavior with transport-provided length', async () => {
      const aborted = startLengthAwareBody(3)

      aborted.parser.abort()
      aborted.res.pushCollectedBody([1, 2, 3])
      await rejects(aborted.body, (error) => error === CACHED_ERRORS.aborted)

      const chunkedBudget = new BodyBudget(32)
      const chunked = startLengthAwareBody(undefined, 16, chunkedBudget)

      strictEqual(chunkedBudget.usedBytes, 16)
      chunked.res.pushCollectedBody([1, 2, 3])
      deepStrictEqual(await chunked.body, Buffer.from([1, 2, 3]))
      strictEqual(chunkedBudget.usedBytes, 3)

      const rejectedBudget = new BodyBudget(2)
      const rejected = startLengthAwareBody(3, 16, rejectedBudget)

      await rejects(rejected.body, (error) => error === CACHED_ERRORS.bodyBudgetExceeded)
      strictEqual(rejectedBudget.usedBytes, 0)
      deepStrictEqual(rejected.res.calls, [['collectBodyWithLength', 16], ['discardBody']])
      throws(() => rejected.res.pushCollectedBody([1, 2, 3]), /collectBody not called yet/)
    })

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
        strictEqual(httpError(err).message, 'Request body size mismatch')
        strictEqual(httpError(err).status, 400)

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
        strictEqual(httpError(err).message, 'Request body size mismatch')
        strictEqual(httpError(err).status, 400)

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
        strictEqual(httpError(err).message, 'Request body too large')
        strictEqual(httpError(err).status, 413)

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
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

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
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

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
        strictEqual(httpError(err).message, 'Request body too large')
        strictEqual(httpError(err).status, 413)

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
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

        return true
      })
    })

    test('should resolve with empty buffer when body is empty and no content-length', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)

      parser.reset(ctx, 100)

      const p = parser.body()

      res.pushData(Buffer.alloc(0), true)

      const result = await p

      strictEqual(Buffer.isBuffer(result), true)
      strictEqual(result.length, 0)
    })

    test('should treat invalid content-length as unknown length mode', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': 'abc' } })

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      const p = parser.body()

      res.pushData('123456', true)

      await rejects(p, (err) => {
        strictEqual(httpError(err).message, 'Request body too large')
        strictEqual(httpError(err).status, 413)

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
        strictEqual(httpError(err).message, 'Request body size mismatch')

        return true
      })

      await rejects(parser.body(), (err) => {
        strictEqual(httpError(err).message, 'Request body size mismatch')

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
        strictEqual(httpError(err).message, 'Request body too large')

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
        strictEqual(httpError(err).message, 'Request body too large')

        return true
      })
    })

    test('should not let a per-call maxSize raise the configured server limit', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)
      parser.reset(ctx, 5)

      await rejects(parser.body(20), (err) => {
        strictEqual(httpError(err).message, 'Request body too large')

        return true
      })
    })
  })

  describe('body() - error cases', () => {
    test('should reject with serverError if ctx is null', async () => {
      const parser = new BodyParser()

      await rejects(parser.body(), (err) => {
        strictEqual(httpError(err).message, 'Internal Server Error')
        strictEqual(httpError(err).status, 500)

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
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

        return true
      })
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

      res.pushData('hello 🚀', true)

      const result = await promise

      strictEqual(result, 'hello 🚀')
    })

    test('should propagate errors from body()', async () => {
      const parser = new BodyParser()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq({ headers: { 'content-length': '10' } })

      ctx.reset(res, req)

      parser.reset(ctx, 5)

      await rejects(parser.text(), (err) => {
        strictEqual(httpError(err).message, 'Request body too large')

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
        strictEqual(httpError(err).message, 'Invalid JSON')
        strictEqual(httpError(err).status, 400)

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
        strictEqual(httpError(err).message, 'Invalid JSON')
        strictEqual(httpError(err).status, 400)

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
        strictEqual(httpError(err).message, 'Request body too large')

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
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

        return true
      })
    })

    test('should invalidate materialized storage and release it on abort', async () => {
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

      await rejects(parser.body(), (error) => error === CACHED_ERRORS.aborted)
      strictEqual(parser.diagnostics.state, 'aborted')
      strictEqual(parser.diagnostics.reservedBytes, 0)
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
        strictEqual(httpError(err).message, 'Request aborted')
        strictEqual(httpError(err).status, 418)

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
        strictEqual(httpError(err).message, 'Request body too large')

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
        strictEqual(httpError(err).message, 'Request body too large')

        return true
      })
    })
  })
})

describe('BodyParser security invariants', () => {
  test('capacity growth stays safe beyond signed 32-bit boundaries without allocating', () => {
    strictEqual(nextBodyCapacity(0, 0, 0), 0)
    strictEqual(nextBodyCapacity(0, 1, 10), 10)
    strictEqual(nextBodyCapacity(2 ** 30, 2 ** 31 - 1, 2 ** 31), 2 ** 31)
    strictEqual(nextBodyCapacity(2 ** 31, 2 ** 31 + 1, 2 ** 32), 2 ** 32)
    strictEqual(
      nextBodyCapacity(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER
    )
    strictEqual(nextBodyCapacity(8, 9, 9), 9)

    throws(() => nextBodyCapacity(8, 10, 9), RangeError)
    throws(() => nextBodyCapacity(-1, 0, 9), TypeError)
    throws(() => nextBodyCapacity(0, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER), TypeError)
  })

  test('known-length storage is not observable until isLast proves exact initialization', async () => {
    const parser = new BodyParser()
    const ctx = new HttpContext(null)
    const res = createMockRes()
    const req = createMockReq({ headers: { 'content-length': '4' } })

    ctx.reset(res, req)
    parser.reset(ctx, 4)

    let settled = false

    const body = parser.body().finally(() => {
      settled = true
    })

    res.pushData('test', false)
    await Promise.resolve()
    strictEqual(settled, false)
    strictEqual(parser.diagnostics.state, 'collecting')

    res.pushData('', true)
    deepStrictEqual(await body, Buffer.from('test'))
  })

  test('an extra chunk after the declared length rejects and retains no partial body', async () => {
    const parser = new BodyParser()
    const ctx = new HttpContext(null)
    const res = createMockRes()
    const req = createMockReq({ headers: { 'content-length': '4' } })

    ctx.reset(res, req)
    parser.reset(ctx, 4)

    const body = parser.body()

    res.pushData('test', false)
    res.pushData('x', true)

    await rejects(body, (error) => error === CACHED_ERRORS.sizeMismatch)
    await rejects(parser.body(), (error) => error === CACHED_ERRORS.sizeMismatch)
    strictEqual(parser.diagnostics.state, 'failed')
    strictEqual(parser.diagnostics.reservedBytes, 0)
  })

  test('reconciles unknown-length capacity and keeps it accounted until clear', async () => {
    const budget = new BodyBudget(100)
    const parser = new BodyParser()
    const server = { bindingCapabilities: {}, httpBodyBudget: budget }
    const ctx = new HttpContext(null)
    const res = createMockRes()
    const req = createMockReq()

    ctx.reset(res, req, server)
    parser.reset(ctx, 100)

    const body = parser.body()

    strictEqual(budget.usedBytes, 100)
    res.pushData('x', true)
    strictEqual((await body).toString(), 'x')
    strictEqual(budget.usedBytes, 1)
    strictEqual(parser.diagnostics.reservedBytes, 1)

    parser.clear()
    strictEqual(budget.usedBytes, 0)
    strictEqual(budget.activeReservations, 0)
  })

  test('a stale native callback cannot release the next generation reservation', async () => {
    const budget = new BodyBudget(3)
    const server = { bindingCapabilities: { collectBody: true }, httpBodyBudget: budget }
    const parser = new BodyParser()
    const firstCtx = new HttpContext(null)
    const firstRes = createMockRes()

    firstCtx.reset(firstRes, createMockReq({ headers: { 'content-length': '3' } }), server)
    parser.reset(firstCtx, 3)
    parser.prefetch()
    strictEqual(budget.usedBytes, 3)

    const secondCtx = new HttpContext(null)
    const secondRes = createMockRes()

    secondCtx.reset(secondRes, createMockReq({ headers: { 'content-length': '3' } }), server)
    parser.reset(secondCtx, 3)
    parser.prefetch()
    strictEqual(budget.usedBytes, 3)

    firstRes.pushCollectedBody(Buffer.from('old'))
    strictEqual(budget.usedBytes, 3)
    strictEqual(parser.diagnostics.state, 'collecting')

    secondRes.pushCollectedBody(Buffer.from('new'))
    strictEqual(await parser.text(), 'new')
    strictEqual(budget.usedBytes, 3)

    parser.clear()
    strictEqual(budget.usedBytes, 0)
  })

  test('rejects invalid per-call body byte limits without coercion', async () => {
    const parser = new BodyParser()
    const ctx = new HttpContext(null)

    ctx.reset(createMockRes(), createMockReq())
    parser.reset(ctx)

    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1', null, {}, Object(1)]) {
      await rejects(parser.body(value), /maxSize must be specified in bytes/)
    }
  })
})
