import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { prepareHeaders } from '../../../src/index.js'
import { startHttpServer } from '../../helpers/e2e-server.js'
import { reqText, reqJson, reqBin } from '../../helpers/http-client.js'

let server = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

test('send types: return null => 204', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/null',
        handler: () => null
      }
    ]
  })

  const { status } = await reqText(`${server.baseUrl}/null`)

  assert.strictEqual(status, 204)
})

test('send types: return string => 200 text/plain', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/text',
        handler: () => 'hi'
      }
    ]
  })

  const { status, headers, text } = await reqText(`${server.baseUrl}/text`)

  assert.strictEqual(status, 200)
  assert.strictEqual(headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.strictEqual(text, 'hi')
})

test('send types: return object => 200 application/json', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/json',
        handler: () => ({ ok: true })
      }
    ]
  })

  const { status, headers, json } = await reqJson(`${server.baseUrl}/json`)

  assert.strictEqual(status, 200)
  assert.strictEqual(headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepStrictEqual(json, { ok: true })
})

test('send types: return Buffer => 200 application/octet-stream', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/bin',
        handler: () => Buffer.from([1, 2, 3])
      }
    ]
  })

  const { status, headers, buf } = await reqBin(`${server.baseUrl}/bin`)

  assert.strictEqual(status, 200)
  assert.strictEqual(headers.get('content-type'), 'application/octet-stream')
  assert.deepStrictEqual(buf, Buffer.from([1, 2, 3]))
})

test('send types: ctx.status(201).sendText("ok") => 201', async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/status',
        handler: (ctx) => {
          ctx.status(201).sendText('ok')
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/status`)

  assert.strictEqual(status, 201)
  assert.strictEqual(text, 'ok')
})

test('send types: prepared headers work across backends', async () => {
  const headers = prepareHeaders({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-prepared': 'yes'
  })

  server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/prepared',
        handler: (ctx) => ctx.reply(200, headers, 'ok')
      }
    ]
  })

  const response = await reqText(`${server.baseUrl}/prepared`)

  assert.strictEqual(response.status, 200)
  assert.strictEqual(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.strictEqual(response.headers.get('cache-control'), 'no-store')
  assert.strictEqual(response.headers.get('x-prepared'), 'yes')
  assert.strictEqual(response.text, 'ok')
})
