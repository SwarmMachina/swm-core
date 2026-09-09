import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { startHttpServer } from '../../helpers/e2e-server.js'

test(
  'a native piped write failure rejects stream() without escaping its Readable callback',
  { timeout: 5000 },
  async (t) => {
    const errors: Error[] = []
    const source = Readable.from([{ unsupported: true }])

    let rejected: unknown

    const handle = await startHttpServer({
      onError: (_event, error) => {
        errors.push(error)
      },
      onRequest: async (ctx) => {
        try {
          await ctx.stream(source)
        } catch (error) {
          rejected = error
          throw error
        }
      }
    })

    t.after(handle.close)
    await assert.rejects(async () => (await fetch(handle.baseUrl)).text())
    await nextTurn()
    assert.equal(errors.length, 1)
    assert.equal(errors[0], rejected)
    assert.equal(source.destroyed, true)
    assert.equal(handle.server.activeHttp, 0)
  }
)

test(
  'an onWritable application failure closes an incomplete response and releases the request',
  { timeout: 5000 },
  async (t) => {
    const original = new Error('writable callback failed')
    const errors: Error[] = []
    const chunk = Buffer.alloc(8 * 1024 * 1024)

    let backpressured = false
    let called = false

    const handle = await startHttpServer({
      onError: (_event, error) => {
        errors.push(error)
      },
      onRequest: (ctx) => {
        ctx.startStreaming()
        backpressured = !ctx.write(chunk)
        ctx.onWritable(() => {
          called = true
          throw original
        })
      }
    })

    t.after(handle.close)
    await assert.rejects(async () => (await fetch(handle.baseUrl)).text())
    await nextTurn()
    assert.equal(backpressured, true)
    assert.equal(called, true)
    assert.deepEqual(errors, [original])
    assert.equal(handle.server.activeHttp, 0)
  }
)
