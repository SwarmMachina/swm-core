import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
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
    maxBodySize: 1,
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
