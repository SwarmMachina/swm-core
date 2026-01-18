// noinspection JSCheckFunctionSignatures

import { describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'
import { createMockReq, createMockRes, createMockReadable } from '../helpers/mock-http.js'
import HttpContext from '../../src/http-context.js'
import ResStreamer from '../../src/res-streamer.js'
import { CACHED_ERRORS, STATUS_TEXT, TEXT_PLAIN_HEADER } from '../../src/constants.js'

describe('ResStreamer', () => {
  describe('reset()', () => {
    test('should set ctx and res', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      strictEqual(streamer.reset(ctx, res), streamer)
    })

    test('should use ctx.res if res not provided', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx)

      strictEqual(streamer.reset(ctx), streamer)
    })

    test('should reject pending stream promise if exists', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      streamer.reset(ctx, res)

      await rejects(promise, (err) => {
        strictEqual(err, CACHED_ERRORS.aborted)
        return true
      })
    })

    test('should cleanup stream state', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      streamer.reset(ctx, res)

      await rejects(promise, (err) => {
        strictEqual(err, CACHED_ERRORS.aborted)
        return true
      })

      strictEqual(readable.getDestroyCallCount(), 0)
    })

    test('should reset started flag', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      streamer.reset(ctx, res)

      throws(
        () => {
          streamer.write('test')
        },
        {
          message: 'Must call begin() before write()'
        }
      )
    })
  })

  describe('clear()', () => {
    test('should nullify ctx and res', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.clear()

      throws(
        () => {
          streamer.begin(200)
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should reject pending stream promise if exists', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      streamer.clear()

      await rejects(promise, (err) => {
        strictEqual(err, CACHED_ERRORS.aborted)
        return true
      })
    })

    test('should cleanup stream state', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      streamer.clear()

      await rejects(promise, (err) => {
        strictEqual(err, CACHED_ERRORS.aborted)
        return true
      })

      strictEqual(readable.getDestroyCallCount(), 0)
    })
  })

  describe('abort()', () => {
    test('should destroy readable if exists', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()

      streamer.stream(readable, 200)

      streamer.abort()

      strictEqual(readable.getDestroyCallCount(), 1)
    })

    test('should handle readable.destroy() throwing', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()
      let destroyCallCount = 0

      readable.destroy = () => {
        destroyCallCount++
        throw new Error('destroy error')
      }
      streamer.stream(readable, 200)

      streamer.abort()

      strictEqual(destroyCallCount, 1)
    })

    test('should clear onWritableCallback and started flag', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)
      streamer.onWritable(() => {})

      streamer.abort()

      throws(
        () => {
          streamer.write('test')
        },
        {
          message: 'Must call begin() before write()'
        }
      )
    })

    test('should settle promise', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      streamer.abort()

      await promise
    })
  })

  describe('begin()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()

      throws(
        () => {
          streamer.begin(200)
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should throw if already started', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      throws(
        () => {
          streamer.begin(200)
        },
        {
          message: 'Response streaming already started'
        }
      )
    })

    test('should allow begin() again after end()', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      streamer.begin(200)
      streamer.end()

      streamer.begin(200)

      strictEqual(res.calls.filter((c) => c[0] === 'writeStatus').length, 2)
    })

    test('should throw if ctx.aborted', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.aborted = true
      streamer.reset(ctx, res)

      throws(
        () => {
          streamer.begin(200)
        },
        {
          message: 'Request aborted'
        }
      )
    })

    test('should write status and headers in cork', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200, TEXT_PLAIN_HEADER)

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

    test('should use string status if provided', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin('200 OK')

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === '200 OK'),
        true
      )
    })

    test('should use ctx.getStatus() for numeric status', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      ctx.status(404)
      streamer.reset(ctx, res)
      streamer.begin(200)

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[404]),
        true
      )
    })

    test('should install onWritable handler only once per begin() call', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      strictEqual(res.calls.filter((c) => c[0] === 'onWritable').length, 1)

      streamer.reset(ctx, res)
      streamer.begin(200)

      strictEqual(res.calls.filter((c) => c[0] === 'onWritable').length, 2)
    })

    test('should return this', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      strictEqual(streamer.begin(200), streamer)
    })
  })

  describe('write()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()

      throws(
        () => {
          streamer.write('test')
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should throw if begin() not called', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      throws(
        () => {
          streamer.write('test')
        },
        {
          message: 'Must call begin() before write()'
        }
      )
    })

    test('should return false if ctx.aborted', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)
      ctx.aborted = true

      const result = streamer.write('test')

      strictEqual(result, false)
      strictEqual(res.calls.filter((c) => c[0] === 'write').length, 0)
    })

    test('should call res.write() and return result', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)
      res.setWriteResultSequence([false, true])

      const result1 = streamer.write('a')
      const result2 = streamer.write('b')

      strictEqual(result1, false)
      strictEqual(result2, true)
      strictEqual(res.calls.filter((c) => c[0] === 'write').length, 2)
      deepStrictEqual(res.calls.filter((c) => c[0] === 'write')[0], ['write', 'a'])
      deepStrictEqual(res.calls.filter((c) => c[0] === 'write')[1], ['write', 'b'])
    })

    test('should handle Buffer chunks', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      const buf = Buffer.from('test')

      streamer.write(buf)

      strictEqual(res.calls.filter((c) => c[0] === 'write' && c[1] === buf).length, 1)
    })
  })

  describe('tryEnd()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()

      throws(
        () => {
          streamer.tryEnd('test', 4)
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should throw if begin() not called', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      throws(
        () => {
          streamer.tryEnd('test', 4)
        },
        {
          message: 'Must call begin() before tryEnd()'
        }
      )
    })

    test('should return [false, false] if ctx.aborted', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)
      ctx.aborted = true

      const result = streamer.tryEnd('test', 4)

      deepStrictEqual(result, [false, false])
      strictEqual(res.calls.filter((c) => c[0] === 'tryEnd').length, 0)
    })

    test('should throw if totalSize is invalid', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      throws(
        () => {
          streamer.tryEnd('test', NaN)
        },
        {
          message: 'tryEnd(chunk, totalSize): totalSize is required'
        }
      )

      throws(
        () => {
          streamer.tryEnd('test', -1)
        },
        {
          message: 'tryEnd(chunk, totalSize): totalSize is required'
        }
      )

      throws(
        () => {
          streamer.tryEnd('test', Infinity)
        },
        {
          message: 'tryEnd(chunk, totalSize): totalSize is required'
        }
      )
    })

    test('should call res.tryEnd() in cork and return result', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      streamer.begin(200)
      res.setTryEndResultSequence([
        [true, false],
        [true, true]
      ])

      const result1 = streamer.tryEnd('a', 1)
      const result2 = streamer.tryEnd('b', 2)

      deepStrictEqual(result1, [true, false])
      deepStrictEqual(result2, [true, true])
      strictEqual(res.calls.filter((c) => c[0] === 'tryEnd').length, 2)
    })

    test('should set streaming=false and call finalize when done=true', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      let finalizeCallCount = 0

      ctx.reset(res, req, {
        finalizeHttpContext() {
          finalizeCallCount++
        }
      })
      ctx.streaming = true
      streamer.reset(ctx, res)
      streamer.begin(200)
      res.setTryEndResultSequence([[true, true]])

      const chunk = 'x'
      const chunkLen = Buffer.byteLength(chunk)
      const totalSize = streamer.getWriteOffset() + chunkLen

      streamer.tryEnd(chunk, totalSize)

      strictEqual(ctx.streaming, false)
      strictEqual(finalizeCallCount, 1)
    })

    test('should not call finalize when done=false', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      let finalizeCallCount = 0

      ctx.reset(res, req, {
        finalizeHttpContext() {
          finalizeCallCount++
        }
      })
      ctx.streaming = true
      streamer.reset(ctx, res)
      streamer.begin(200)
      res.setTryEndResultSequence([[true, false]])

      const chunk = 'x'
      const chunkLen = Buffer.byteLength(chunk)
      const totalSize = streamer.getWriteOffset() + chunkLen

      streamer.tryEnd(chunk, totalSize)

      strictEqual(ctx.streaming, true)
      strictEqual(finalizeCallCount, 0)
    })

    test('should allow begin() again after tryEnd done=true', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      streamer.begin(200)
      res.setTryEndResultSequence([[true, true]])

      const chunk = 'x'
      const chunkLen = Buffer.byteLength(chunk)
      const totalSize = streamer.getWriteOffset() + chunkLen

      streamer.tryEnd(chunk, totalSize)

      streamer.begin(200)

      strictEqual(res.calls.filter((c) => c[0] === 'writeStatus').length, 2)
    })
  })

  describe('end()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()

      throws(
        () => {
          streamer.end('test')
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should no-op if begin() not called', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      streamer.end('test')

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
    })

    test('should no-op if ctx.aborted', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)
      ctx.aborted = true

      streamer.end('test')

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
      strictEqual(ctx.streaming, false)
    })

    test('should call res.end(chunk) if chunk provided', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      let finalizeCallCount = 0

      ctx.reset(res, req, {
        finalizeHttpContext() {
          finalizeCallCount++
        }
      })
      ctx.streaming = true
      streamer.reset(ctx, res)
      streamer.begin(200)

      streamer.end('bye')

      strictEqual(
        res.calls.some(([name, ...args]) => name === 'end' && args[0] === 'bye'),
        true
      )
      strictEqual(ctx.streaming, false)
      strictEqual(finalizeCallCount, 1)
    })

    test('should call res.end() without args if chunk is null', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      streamer.begin(200)

      streamer.end(null)

      const endCalls = res.calls.filter((c) => c[0] === 'end')

      strictEqual(endCalls.length, 1)
      strictEqual(endCalls[0].length, 1)
    })

    test('should call res.end() without args if chunk is undefined', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      streamer.begin(200)

      streamer.end(undefined)

      const endCalls = res.calls.filter((c) => c[0] === 'end')

      strictEqual(endCalls.length, 1)
      strictEqual(endCalls[0].length, 1)
    })

    test('should set streaming=false and call finalize', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      let finalizeCallCount = 0

      ctx.reset(res, req, {
        finalizeHttpContext() {
          finalizeCallCount++
        }
      })
      ctx.streaming = true
      streamer.reset(ctx, res)
      streamer.begin(200)

      streamer.end()

      strictEqual(ctx.streaming, false)
      strictEqual(finalizeCallCount, 1)
    })
  })

  describe('onWritable()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()

      throws(
        () => {
          streamer.onWritable(() => {})
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should throw if begin() not called', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      throws(
        () => {
          streamer.onWritable(() => {})
        },
        {
          message: 'Must call begin() before onWritable()'
        }
      )
    })

    test('should register callback and call it once via onUwsWritable', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      let cbCallCount = 0
      let lastOffset = null

      const cb = (offset) => {
        cbCallCount++
        lastOffset = offset
      }

      streamer.onWritable(cb)

      strictEqual(res.calls.filter((c) => c[0] === 'onWritable').length, 1)

      const result1 = res.triggerWritable(123)

      strictEqual(cbCallCount, 1)
      strictEqual(lastOffset, 123)
      strictEqual(result1, false)

      const result2 = res.triggerWritable(456)

      strictEqual(cbCallCount, 1)
      strictEqual(result2, false)
    })

    test('onWritable should be overwritten by last callback', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      streamer.begin(200)

      let cb1CallCount = 0
      let cb2CallCount = 0

      const cb1 = () => {
        cb1CallCount++
      }
      const cb2 = () => {
        cb2CallCount++
      }

      streamer.onWritable(cb1)
      streamer.onWritable(cb2)

      res.triggerWritable(1)

      strictEqual(cb1CallCount, 0)
      strictEqual(cb2CallCount, 1)
    })
  })

  describe('getWriteOffset()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()

      throws(
        () => {
          streamer.getWriteOffset()
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should return res.getWriteOffset()', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      res.setWriteOffset(42)

      strictEqual(streamer.getWriteOffset(), 42)
      strictEqual(res.calls.filter((c) => c[0] === 'getWriteOffset').length, 1)
    })
  })

  describe('stream()', () => {
    test('should throw if not initialized', () => {
      const streamer = new ResStreamer()
      const readable = createMockReadable()

      throws(
        () => {
          streamer.stream(readable, 200)
        },
        {
          message: 'ResStreamer is not initialized'
        }
      )
    })

    test('should throw if streaming already in progress', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)

      const readable1 = createMockReadable()
      const promise1 = streamer.stream(readable1, 200)

      const readable2 = createMockReadable()

      throws(
        () => {
          streamer.stream(readable2, 200)
        },
        {
          message: 'Streaming already in progress'
        }
      )

      readable1.emit('end')
      await promise1
    })

    test('should call begin() with status and headers', () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)

      const readable = createMockReadable()

      streamer.stream(readable, 201, TEXT_PLAIN_HEADER)

      strictEqual(res.calls.filter((c) => c[0] === 'writeStatus').length, 1)
      strictEqual(
        res.calls.some(([name, ...args]) => name === 'writeStatus' && args[0] === STATUS_TEXT[201]),
        true
      )
    })

    test('happy path - write always succeeds', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true, true, true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200, TEXT_PLAIN_HEADER)

      readable.emit('data', Buffer.from('a'))
      readable.emit('data', Buffer.from('b'))
      readable.emit('end')

      await promise

      strictEqual(readable.getPauseCallCount(), 0)
      strictEqual(readable.getResumeCallCount(), 0)
      strictEqual(res.calls.filter((c) => c[0] === 'write').length, 2)
      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
    })

    test('stream should handle immediate end without data', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('end')

      await promise

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
      strictEqual(ctx.streaming, false)
    })

    test('backpressure - pause on write=false, resume on writable', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([false, true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')

      strictEqual(readable.getPauseCallCount(), 1)
      strictEqual(readable.getResumeCallCount(), 0)

      res.triggerWritable(100)

      strictEqual(readable.getResumeCallCount(), 1)

      readable.emit('data', 'b')
      readable.emit('end')

      await promise

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
    })

    test('backpressure should pause only once until resumed', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([false, true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')

      strictEqual(readable.getPauseCallCount(), 1)

      readable.emit('data', 'b')

      strictEqual(readable.getPauseCallCount(), 1)

      res.triggerWritable(100)

      strictEqual(readable.getResumeCallCount(), 1)

      readable.emit('end')

      await promise
    })

    test('should abort if ctx.aborted during data', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      ctx.aborted = true
      readable.emit('data', 'a')

      await promise

      strictEqual(readable.getDestroyCallCount(), 1)
      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
    })

    test('should not write if ctx is null during data', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      streamer.clear()

      await rejects(promise, (err) => {
        strictEqual(err, CACHED_ERRORS.aborted)
        return true
      })

      strictEqual(readable.getDestroyCallCount(), 0)
      strictEqual(res.calls.filter((c) => c[0] === 'write').length, 1)
    })

    test('should handle end event - not aborted', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      readable.emit('end')

      await promise

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
      strictEqual(ctx.streaming, false)
    })

    test('should handle end event - aborted', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      ctx.aborted = true
      readable.emit('end')

      await promise

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
      strictEqual(ctx.streaming, false)
    })

    test('should handle error event - not aborted', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()
      let finalizeCallCount = 0

      ctx.reset(res, req, {
        finalizeHttpContext() {
          finalizeCallCount++
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      readable.emit('error', new Error('boom'))

      await rejects(promise, (err) => {
        strictEqual(err.message, 'boom')
        return true
      })

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 1)
      strictEqual(ctx.streaming, false)
      strictEqual(finalizeCallCount, 1)
    })

    test('should handle error event - aborted', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      ctx.aborted = true
      readable.emit('error', new Error('boom'))

      await rejects(promise, (err) => {
        strictEqual(err.message, 'boom')
        return true
      })

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, 0)
      strictEqual(ctx.streaming, false)
    })

    test('should reject on error even if ctx cleared, without calling end', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      streamer.clear()
      const endCallCountBefore = res.calls.filter((c) => c[0] === 'end').length

      readable.emit('error', new Error('boom'))

      await rejects(promise, (err) => {
        return err === CACHED_ERRORS.aborted || err.message === 'boom'
      })

      strictEqual(res.calls.filter((c) => c[0] === 'end').length, endCallCountBefore)
    })

    test('should handle error event - end() throws', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])
      res.end = () => {
        throw new Error('end error')
      }

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      readable.emit('error', new Error('boom'))

      await rejects(promise, (err) => {
        strictEqual(err.message, 'boom')
        return true
      })

      strictEqual(ctx.streaming, false)
    })

    test('should handle close event', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req)
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      readable.emit('close')

      await promise

      strictEqual(ctx.streaming, false)
    })

    test('should cleanup listeners on completion', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()
      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      readable.emit('end')

      await promise

      readable.emit('data', 'b')
      readable.emit('error', new Error('should not be handled'))

      strictEqual(res.calls.filter((c) => c[0] === 'write').length, 1)
    })

    test('should use removeListener if off is not available', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true])

      const readable = createMockReadable()

      delete readable.off

      const promise = streamer.stream(readable, 200)

      readable.emit('data', 'a')
      readable.emit('end')

      await promise

      strictEqual(readable.getDestroyCallCount(), 0)
    })

    test('should handle multiple streams sequentially', async () => {
      const streamer = new ResStreamer()
      const ctx = new HttpContext(null)
      const res = createMockRes()
      const req = createMockReq()

      ctx.reset(res, req, {
        finalizeHttpContext() {
          //
        }
      })
      streamer.reset(ctx, res)
      res.setWriteResultSequence([true, true])

      const readable1 = createMockReadable()
      const promise1 = streamer.stream(readable1, 200)

      readable1.emit('data', 'a')
      readable1.emit('end')

      await promise1

      const readable2 = createMockReadable()
      const promise2 = streamer.stream(readable2, 200)

      readable2.emit('data', 'b')
      readable2.emit('end')

      await promise2

      strictEqual(res.calls.filter((c) => c[0] === 'write').length, 2)
    })
  })
})
