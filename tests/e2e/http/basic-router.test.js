import { afterEach, test } from 'node:test'
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

test('router mode: GET /ping => 200 "pong"', async () => {
  server = await startHttpServer({
    router: (ctx) => {
      if (ctx.url() === '/ping') {
        return 'pong'
      }
    }
  })

  const { status, text } = await reqText(`${server.baseUrl}/ping`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'pong')
})

test('router mode: GET /echo?q=1 => 200 "1"', async () => {
  server = await startHttpServer({
    router: (ctx) => {
      if (ctx.url().startsWith('/echo')) {
        return ctx.query('q') || ''
      }
    }
  })

  const { status, text } = await reqText(`${server.baseUrl}/echo?q=1`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, '1')
})
