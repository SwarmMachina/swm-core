import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { startHttpServer } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'

let server = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

test('body limits: POST /big with body > maxBodySize => 413', async () => {
  server = await startHttpServer({
    maxBodySize: 1024 * 1024,
    routes: [
      {
        method: 'post',
        path: '/big',
        handler: async (ctx) => {
          await ctx.body()

          return 'ok'
        }
      }
    ]
  })

  const largeBody = 'x'.repeat(1024 * 1024 + 1)
  const { status, text } = await reqText(`${server.baseUrl}/big`, {
    method: 'POST',
    body: largeBody,
    headers: { 'content-type': 'text/plain' }
  })

  assert.strictEqual(status, 413)
  assert.strictEqual(text, 'Request body too large')
})

test('body limits: chunked body without Content-Length is bounded while streaming', async () => {
  server = await startHttpServer({
    maxBodySize: 4,
    routes: [
      {
        method: 'post',
        path: '/chunked',
        handler: async (ctx) => {
          await ctx.body()

          return 'ok'
        }
      }
    ]
  })

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: '/chunked',
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked' }
      },
      (res) => {
        const chunks = []

        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }))
      }
    )

    req.once('error', reject)
    req.write('1234')
    req.end('5')
  })

  assert.deepStrictEqual(result, { status: 413, text: 'Request body too large' })
})
