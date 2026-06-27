import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { getFreePort } from '../../../helpers/ports.js'
import Server, { cors } from '../../../src/index.js'
import { reqText } from '../../helpers/http-client.js'

let server = null

/**
 * @param {(ctx: import('../../../src/http-context.js').default) => boolean} applyCors
 * @returns {Promise<string>}
 */
async function start(applyCors) {
  const port = await getFreePort()
  server = new Server({
    port,
    routes: [
      {
        method: 'any',
        path: '/*',
        handler: (ctx) => {
          if (applyCors(ctx)) {
            return
          }

          return 'ok'
        }
      }
    ]
  })

  await server.listen()
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server) {
    await server.shutdown(1000)
    server = null
  }
})

test('cors: normal GET carries allow-origin header and body', async () => {
  const baseUrl = await start(cors({ origin: '*' }))

  const { status, headers, text } = await reqText(`${baseUrl}/data`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'ok')
  assert.strictEqual(headers.get('access-control-allow-origin'), '*')
})

test('cors: OPTIONS preflight short-circuits with 204 and preflight headers', async () => {
  const baseUrl = await start(cors({ origin: 'https://app.example', credentials: true, maxAge: 600 }))

  const { status, headers, text } = await reqText(`${baseUrl}/data`, { method: 'OPTIONS' })

  assert.strictEqual(status, 204)
  assert.strictEqual(text, '')
  assert.strictEqual(headers.get('access-control-allow-origin'), 'https://app.example')
  assert.strictEqual(headers.get('access-control-allow-credentials'), 'true')
  assert.strictEqual(headers.get('access-control-allow-methods'), 'GET,HEAD,PUT,PATCH,POST,DELETE')
  assert.strictEqual(headers.get('access-control-allow-headers'), 'Content-Type, Authorization')
  assert.strictEqual(headers.get('access-control-max-age'), '600')
  assert.strictEqual(headers.get('vary'), 'Origin')
})
