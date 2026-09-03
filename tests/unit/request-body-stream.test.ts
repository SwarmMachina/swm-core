import { once } from 'node:events'
import { describe, test } from 'node:test'
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'

import RequestBodyStream from '../../src/http/request-body-stream.js'
import { CACHED_ERRORS } from '../../src/http/status.js'
import { createMockRes } from '../helpers/mock-http.js'

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

describe('RequestBodyStream', () => {
  test('should expose an empty declared body', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(0, 0)

    stream.start(res)

    strictEqual(stream.contentLength, 0)
    deepStrictEqual(await readStream(stream), Buffer.alloc(0))
    deepStrictEqual(res.calls, [['onData']])
  })

  test('should copy transport-owned chunks before exposing them', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(4, 4)
    const body = readStream(stream)
    const first = Uint8Array.from(Buffer.from('ab'))

    stream.start(res)
    res.onDataCb!(first.buffer, false)
    first.fill(0)
    res.pushData('cd', true)

    strictEqual(stream.contentLength, 4)
    strictEqual((await body).toString(), 'abcd')
  })

  test("should keep small owned chunks outside Node's shared Buffer pool", async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(1, 1)
    const chunks: Buffer[] = []
    const ended = once(stream, 'end')

    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.start(res)
    res.pushData('x', true)

    await ended

    strictEqual(chunks.length, 1)
    strictEqual(chunks[0]!.byteOffset, 0)
    strictEqual(chunks[0]!.buffer.byteLength, 1)
  })

  test('should preserve chunks delivered after transport backpressure', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(null, 2 * 1024 * 1024)
    const first = Buffer.alloc(1024 * 1024, 1)
    const second = Buffer.alloc(1024 * 1024, 2)

    stream.start(res)
    res.pushData(first, false)
    res.pushData(second, false)

    strictEqual(
      res.calls.some(([method]) => method === 'pause'),
      true
    )

    const body = readStream(stream)

    await new Promise((resolve) => setImmediate(resolve))
    res.pushData(Buffer.alloc(0), true)

    const result = await body

    strictEqual(result.length, first.length + second.length)
    strictEqual(result[0], 1)
    strictEqual(result[first.length], 2)
    strictEqual(
      res.calls.some(([method]) => method === 'resume'),
      true
    )
  })

  test('should reject oversized and mismatched bodies', async () => {
    const oversizedRes = createMockRes()
    const oversizedStream = new RequestBodyStream(null, 4)

    oversizedStream.start(oversizedRes)
    oversizedRes.pushData('12345', true)

    await rejects(readStream(oversizedStream), (error) => error === CACHED_ERRORS.bodyTooLarge)

    const longRes = createMockRes()
    const longStream = new RequestBodyStream(4, 8)

    longStream.start(longRes)
    longRes.pushData('12345', true)

    await rejects(readStream(longStream), (error) => error === CACHED_ERRORS.sizeMismatch)

    const shortRes = createMockRes()
    const shortStream = new RequestBodyStream(4, 8)

    shortStream.start(shortRes)
    shortRes.pushData('123', true)

    await rejects(readStream(shortStream), (error) => error === CACHED_ERRORS.sizeMismatch)
  })

  test('should preserve an error until a consumer attaches', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(null, 4)

    stream.start(res)
    res.pushData('12345', true)
    await new Promise((resolve) => setImmediate(resolve))

    await rejects(readStream(stream), (error) => error === CACHED_ERRORS.bodyTooLarge)
  })

  test('should discard an unread body and release transport backpressure', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(null, 1024 * 1024)
    const closed = once(stream, 'close')

    stream.start(res)
    res.pushData(Buffer.alloc(64 * 1024), false)
    stream.destroy()
    await closed

    strictEqual(
      res.calls.some(([method]) => method === 'discardBody'),
      true
    )
    strictEqual(
      res.calls.some(([method]) => method === 'resume'),
      true
    )
  })

  test('should resume a paused baseline transport when discardBody is unavailable', async () => {
    const res = createMockRes()

    delete (res as Partial<typeof res>).discardBody

    const stream = new RequestBodyStream(null, 1024 * 1024)
    const closed = once(stream, 'close')

    stream.start(res)
    res.pushData(Buffer.alloc(64 * 1024), false)
    stream.destroy()
    await closed

    strictEqual(res.calls.filter(([method]) => method === 'onData').length, 1)
    strictEqual(
      res.calls.some(([method]) => method === 'resume'),
      true
    )
  })

  test('should resume the transport when its final callback arrives after pause', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(null, 1024 * 1024)

    stream.start(res)
    res.pushData(Buffer.alloc(64 * 1024), false)
    res.pushData(Buffer.alloc(0), true)

    strictEqual(
      res.calls.some(([method]) => method === 'pause'),
      true
    )
    strictEqual(
      res.calls.some(([method]) => method === 'resume'),
      true
    )
    strictEqual((await readStream(stream)).length, 64 * 1024)
  })

  test('should normalize resume failures to a controlled stream error', async () => {
    const res = createMockRes()
    const stream = new RequestBodyStream(null, 1024 * 1024)

    let resumeCalls = 0

    res.resume = () => {
      resumeCalls++

      throw new Error('native resume failure')
    }

    stream.start(res)
    res.pushData(Buffer.alloc(64 * 1024), false)

    const failed = once(stream, 'error')

    stream.read()

    const [error] = await failed

    strictEqual(error, CACHED_ERRORS.serverError)
    strictEqual(resumeCalls, 2)
  })

  test('should reject a second start', () => {
    const stream = new RequestBodyStream(null, 4)

    stream.start(createMockRes())

    throws(() => stream.start(createMockRes()), {
      name: 'Error',
      message: 'Request body stream already started'
    })
  })
})
