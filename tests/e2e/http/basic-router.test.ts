import { afterEach, test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startHttpServer } from '../../helpers/e2e-server.js'
import type { HttpServerHandle } from '../../helpers/e2e-server.js'
import { reqJson, reqText } from '../../helpers/http-client.js'

let server: HttpServerHandle | null = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

test('onRequest mode: GET /ping => 200 "pong"', async () => {
  server = await startHttpServer({
    onRequest: (ctx) => {
      if (ctx.getUrl() === '/ping') {
        return 'pong'
      }
    }
  })

  const { status, text } = await reqText(`${server.baseUrl}/ping`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'pong')
})

test('onRequest mode: GET /echo?q=1 => 200 "1"', async () => {
  server = await startHttpServer({
    onRequest: (ctx) => {
      if (ctx.getUrl().startsWith('/echo')) {
        return ctx.getQuery('q') || ''
      }
    }
  })

  const { status, text } = await reqText(`${server.baseUrl}/echo?q=1`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, '1')
})

test('onRequest mode: POST /echo => 404 {ok:false}', async () => {
  server = await startHttpServer({
    onRequest: async (ctx) => {
      if (ctx.getUrl().startsWith('/echo') && ctx.getMethod() === 'post') {
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

test('onRequest mode: req access after async boundary', async () => {
  server = await startHttpServer({
    prefetchHeaders: ['x-test'],
    onRequest: async (ctx) => {
      if (ctx.getUrl().startsWith('/req-after-await')) {
        await new Promise((resolve) => setTimeout(resolve, 5))

        return {
          method: ctx.getMethod(),
          url: ctx.getUrl(),
          query: ctx.getQuery('q'),
          header: ctx.getReqHeader('x-test'),
          inheritedHeader: ctx.getReqHeader('constructor')
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
    header: 'ok',
    inheritedHeader: ''
  })
})

test('routes mode: custom 404', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'any',
        path: '/*',
        handler: (ctx) => {
          ctx.sendJson(
            {
              ok: false,
              error: 'Not found',
              url: ctx.getUrl()
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
