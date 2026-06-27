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

test('routes mode: any /* catch-all coexists with specific routes', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/api/ping',
        handler: () => ({ ok: 1 })
      },
      {
        method: 'any',
        path: '/*',
        handler: () => 'CATCHALL'
      }
    ]
  })

  const ping = await reqText(`${server.baseUrl}/api/ping`)
  const unknown = await reqText(`${server.baseUrl}/nope`)
  const root = await reqText(`${server.baseUrl}/`)

  assert.strictEqual(ping.status, 200)
  assert.strictEqual(ping.text, '{"ok":1}')
  assert.strictEqual(unknown.status, 200)
  assert.strictEqual(unknown.text, 'CATCHALL')
  assert.strictEqual(root.status, 200)
  assert.strictEqual(root.text, 'CATCHALL')
})
