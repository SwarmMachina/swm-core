import { afterEach, test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startHttpServer } from '../../helpers/e2e-server.js'
import { reqJson, reqText } from '../../helpers/http-client.js'

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

test('router mode: POST /echo => 404 {ok:false}', async () => {
  server = await startHttpServer({
    router: async (ctx) => {
      if (ctx.url().startsWith('/echo') && ctx.method() === 'post') {
        const body = await ctx.json()

        return ctx.sendJson({ ok: false, body }, 404)
      }
    }
  })

  const { status, json } = await reqJson(`${server.baseUrl}/echo`, {
    method: 'POST',
    body: JSON.stringify({ req: 'test' })
  })

  assert.strictEqual(status, 404)
  assert.deepEqual(json, { ok: false, body: { req: 'test' } })
})

test('router mode: req access after async boundary', async () => {
  server = await startHttpServer({
    router: async (ctx) => {
      if (ctx.url().startsWith('/req-after-await')) {
        await new Promise((resolve) => setTimeout(resolve, 5))

        return {
          method: ctx.method(),
          url: ctx.url(),
          query: ctx.query('q'),
          header: ctx.header('x-test')
        }
      }
    }
  })

  const { status, json } = await reqJson(`${server.baseUrl}/req-after-await?q=42`, {
    method: 'POST',
    headers: {
      'x-test': 'ok'
    }
  })

  assert.strictEqual(status, 200)
  assert.deepEqual(json, {
    method: 'post',
    url: '/req-after-await',
    query: '42',
    header: 'ok'
  })
})

test('routes mode: custom 404', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'any',
        path: '/*',
        handler: (ctx) => {
          console.log(ctx.url())
          ctx.sendJson(
            {
              ok: false,
              error: 'Not found',
              url: ctx.url()
            },
            404
          )
        }
      }
    ]
  })

  const { status, json } = await reqJson(`${server.baseUrl}/echo`, {
    method: 'POST',
    body: JSON.stringify({ req: 'test' })
  })

  assert.strictEqual(status, 404)
  assert.deepEqual(json, {
    ok: false,
    error: 'Not found',
    url: '/echo'
  })
})
