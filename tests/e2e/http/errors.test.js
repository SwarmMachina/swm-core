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

test('error handling: throw error with status 403 => 403', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/err-status',
        handler: () => {
          throw Object.assign(new Error('nope'), { status: 403 })
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/err-status`)

  assert.strictEqual(status, 403)
  assert.strictEqual(text, 'nope')
})

test('error handling: throw error without status => 500', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/err-500',
        handler: () => {
          throw new Error('boom')
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/err-500`)

  assert.strictEqual(status, 500)
  assert.strictEqual(text, 'Internal Server Error')
})
