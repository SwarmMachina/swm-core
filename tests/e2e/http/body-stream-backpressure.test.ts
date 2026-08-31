import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { startHttpServer } from '../../helpers/e2e-server.js'
import SlowUploadSink from '../../helpers/slow-upload-sink.js'

// The upstream reference lacks the receive-loop pause fix shipped in swm-uws
// 0.7.3. Its basic streaming contract is still covered by body-stream.test.ts.
const upstreamReference = process.execArgv.includes('--conditions=uwebsockets-reference')

for (const chunked of [false, true]) {
  test(
    `body stream bounds slow ${chunked ? 'chunked' : 'fixed-length'} uploads`,
    {
      timeout: 30_000,
      skip: upstreamReference ? 'The upstream reference does not bound paused receive-loop delivery' : false
    },
    async () => {
      const sizes = [1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024]
      const observations: { peak: number; limit: number; bytes: number }[] = []
      const server = await startHttpServer({
        prefetch: false,
        maxStreamBodySize: sizes[2]!,
        onRequest: async (ctx) => {
          const stream = ctx.bodyStream()
          const sink = new SlowUploadSink()

          let peak = 0

          const push = stream.push

          stream.push = function (chunk: unknown, encoding?: BufferEncoding): boolean {
            const accepted = push.call(this, chunk, encoding)

            peak = Math.max(peak, this.readableLength)

            return accepted
          }

          await pipeline(stream, sink)
          observations.push({ peak, limit: stream.readableHighWaterMark + 512 * 1024, bytes: sink.bytes })

          return sink.digest()
        }
      })
      const agent = new http.Agent({ keepAlive: true, maxSockets: 2 })

      try {
        for (const size of sizes) {
          const body = Buffer.allocUnsafe(size)

          for (let i = 0; i < body.length; i++) {
            body[i] = (i * 31) % 251
          }

          const expected = createHash('sha256').update(body).digest('hex')

          await Promise.all(
            [0, 1].map(
              () =>
                new Promise<void>((resolve, reject) => {
                  const request = http.request(
                    {
                      host: '127.0.0.1',
                      port: server.port,
                      method: 'POST',
                      path: '/upload',
                      agent,
                      headers: chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': body.length }
                    },
                    (response) => {
                      let text = ''

                      response.setEncoding('utf8')
                      response.on('data', (chunk: string) => {
                        text += chunk
                      })
                      response.on('error', reject)
                      response.on('end', () => {
                        try {
                          assert.equal(response.statusCode, 200)
                          assert.equal(text, expected)
                          resolve()
                        } catch (error) {
                          reject(error)
                        }
                      })
                    }
                  )

                  request.on('error', reject)
                  request.setTimeout(20_000, () => request.destroy(new Error('upload timed out')))
                  request.end(body)
                })
            )
          )
        }

        assert.equal(observations.length, sizes.length * 2)

        for (const { peak, limit, bytes } of observations) {
          assert.ok(peak <= limit, `${bytes}-byte upload queued ${peak} bytes, limit ${limit}`)
        }
      } finally {
        agent.destroy()
        await server.close()
      }
    }
  )
}

test('destroying a paused upload drains it and preserves the keep-alive connection', { timeout: 10_000 }, async () => {
  let queuedBeforeDestroy = 0

  const server = await startHttpServer({
    prefetch: false,
    maxStreamBodySize: 16 * 1024 * 1024,
    onRequest: async (ctx) => {
      if (ctx.getUrl() === '/ping') {
        return 'pong'
      }

      const stream = ctx.bodyStream()

      await delay(25)
      queuedBeforeDestroy = stream.readableLength
      stream.destroy()

      return 'discarded'
    }
  })
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const request = (path: string, body?: Buffer): Promise<{ text: string; socket: http.ClientRequest['socket'] }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path,
          method: body ? 'POST' : 'GET',
          agent,
          headers: body ? { 'content-length': body.length } : {}
        },
        (res) => {
          let text = ''

          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
          })
          res.on('error', reject)
          res.on('end', () => resolve({ text, socket: req.socket }))
        }
      )

      req.on('error', reject)
      req.setTimeout(5000, () => req.destroy(new Error('request timed out')))
      req.end(body)
    })

  try {
    const upload = await request('/upload', Buffer.alloc(16 * 1024 * 1024, 37))

    assert.equal(upload.text, 'discarded')
    assert.ok(queuedBeforeDestroy >= 64 * 1024)
    const ping = await request('/ping')

    assert.equal(ping.text, 'pong')
    assert.ok(upload.socket)
    assert.equal(ping.socket, upload.socket)
  } finally {
    agent.destroy()
    await server.close()
  }
})
