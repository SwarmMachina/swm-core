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

test('routes mode: GET /users/:id => 200 with id param', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/users/:id',
        handler: (ctx) => {
          return ctx.param(0) || ''
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/users/42`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, '42')
})
