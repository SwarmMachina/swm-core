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

test('body parsing: POST /text with await ctx.text()', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'post',
        path: '/text',
        handler: async (ctx) => {
          const text = await ctx.text()

          return text
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/text`, {
    method: 'POST',
    body: 'hello world',
    headers: { 'content-type': 'text/plain' }
  })

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'hello world')
})

test('body parsing: POST /json with await ctx.json()', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'post',
        path: '/json',
        handler: async (ctx) => {
          const obj = await ctx.json()

          return obj.ok
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/json`, {
    method: 'POST',
    body: JSON.stringify({ ok: 'test' }),
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'test')
})

test('body parsing: POST /badjson with invalid JSON => 400', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'post',
        path: '/badjson',
        handler: async (ctx) => {
          await ctx.json()
          return 'ok'
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/badjson`, {
    method: 'POST',
    body: '{invalid json}',
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(status, 400)
  assert.strictEqual(text, 'Invalid JSON')
})
