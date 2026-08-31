import { afterEach, test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import http from 'node:http'

import { startHttpServer } from '../../helpers/e2e-server.js'
import type { HttpServerHandle } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'
import type RequestBodyStream from '../../../src/http/request-body-stream.js'

let server: HttpServerHandle | null = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

function chunkedRequest(port: number, chunks: readonly string[]): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/upload',
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked' }
      },
      (response) => {
        let text = ''

        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
      }
    )

    request.on('error', reject)

    for (const chunk of chunks) {
      request.write(chunk)
    }

    request.end()
  })
}

test('body stream uses an explicit ceiling above maxBodySize', async () => {
  server = await startHttpServer({
    maxBodySize: 1024,
    maxStreamBodySize: 2 * 1024 * 1024,
    routes: [
      {
        method: 'post',
        path: '/upload',
        handler: async (ctx) => {
          const stream = ctx.bodyStream(2 * 1024 * 1024)

          let size = 0

          for await (const chunk of stream) {
            size += chunk.length
          }

          return `${size}`
        }
      }
    ]
  })

  const body = Buffer.alloc(1024 * 1024 + 1, 1)
  const { status, text } = await reqText(`${server.baseUrl}/upload`, { method: 'POST', body })

  assert.strictEqual(status, 200)
  assert.strictEqual(text, `${body.length}`)
})

test('body stream can be created before delayed authorization and consumed afterwards', async () => {
  const uploads = new WeakMap<object, RequestBodyStream>()

  server = await startHttpServer({
    maxStreamBodySize: 2 * 1024 * 1024,
    routes: [
      {
        method: 'post',
        path: '/upload',
        prefetch: false,
        before: async (ctx) => {
          uploads.set(ctx, ctx.bodyStream())
          await new Promise((resolve) => setTimeout(resolve, 25))
        },
        handler: async (ctx) => {
          const upload = uploads.get(ctx)

          uploads.delete(ctx)

          if (!upload) {
            throw new Error('Upload stream was not initialized')
          }

          const hash = createHash('sha256')

          for await (const chunk of upload) {
            hash.update(chunk)
          }

          return `${upload.contentLength}:${hash.digest('hex')}`
        }
      }
    ]
  })

  const body = Buffer.allocUnsafe(512 * 1024)

  for (let i = 0; i < body.length; i++) {
    body[i] = (i * 31) % 251
  }

  const expectedHash = createHash('sha256').update(body).digest('hex')
  const { status, text } = await reqText(`${server.baseUrl}/upload`, { method: 'POST', body })

  assert.strictEqual(status, 200)
  assert.strictEqual(text, `${body.length}:${expectedHash}`)
})

test('body stream enforces its explicit request limit', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'post',
        path: '/upload',
        handler: async (ctx) => {
          for await (const chunk of ctx.bodyStream(4)) {
            void chunk
          }

          return 'ok'
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/upload`, { method: 'POST', body: '12345' })

  assert.strictEqual(status, 413)
  assert.strictEqual(text, 'Request body too large')
})

test('body stream enforces its limit for a chunked request without Content-Length', async () => {
  server = await startHttpServer({
    maxStreamBodySize: 4,
    routes: [
      {
        method: 'post',
        path: '/upload',
        handler: async (ctx) => {
          for await (const chunk of ctx.bodyStream()) {
            void chunk
          }

          return 'ok'
        }
      }
    ]
  })

  const response = await chunkedRequest(server.port, ['12', '34', '5'])

  assert.strictEqual(response.status, 413)
  assert.strictEqual(response.text, 'Request body too large')
})
