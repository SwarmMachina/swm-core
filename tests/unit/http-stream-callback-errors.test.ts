import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import Server from '../../src/server/server.js'
import { createMockReq } from '../helpers/mock-http.js'
import { createMockHttpResponse } from '../helpers/mock-uws.js'

for (const failedClose of [false, true]) {
  test(`a piped write failure is contained and reported once when close ${failedClose ? 'throws' : 'succeeds'}`, async (t) => {
    const errors: Error[] = []
    const original = new Error('native write failed')
    const server = new Server({
      http: {
        onRequest: () => 'ok',
        onError: (_event, error) => {
          errors.push(error)
        }
      }
    })
    const response = createMockHttpResponse()
    const source = new Readable({ read() {} })

    t.after(() => {
      response.triggerAborted()
      source.destroy()
    })
    response.write = () => {
      throw original
    }

    if (failedClose) {
      response.close = () => {
        throw new Error('native response is no longer valid')
      }
    }

    server.handleWithContext(response, createMockReq(), (ctx) => ctx.stream(source))
    assert.doesNotThrow(() => source.emit('data', Buffer.from('body')))
    await nextTurn()
    assert.equal(source.destroyed, true)
    assert.deepEqual(errors, [original])
    assert.equal(server.activeHttp, 0)
  })
}

test('a throwing manual writable callback is contained and releases the request', async (t) => {
  const errors: Error[] = []
  const original = new Error('application writable failed')
  const server = new Server({
    http: {
      onRequest: () => 'ok',
      onError: (_event, error) => {
        errors.push(error)
      }
    }
  })
  const response = createMockHttpResponse()

  let writable: ((offset: number) => boolean) | undefined

  response.onWritable = (callback) => {
    writable = callback

    return response
  }
  t.after(() => response.triggerAborted())
  server.handleWithContext(response, createMockReq(), (ctx) => {
    ctx.startStreaming()
    ctx.onWritable(() => {
      throw original
    })
  })
  assert.ok(writable)
  assert.doesNotThrow(() => writable!(0))
  await nextTurn()
  assert.deepEqual(errors, [original])
  assert.equal(server.activeHttp, 0)
})
