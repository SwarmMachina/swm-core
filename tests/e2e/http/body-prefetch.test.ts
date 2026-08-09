import { afterEach, test } from 'node:test'
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { startHttpServer } from '../../helpers/e2e-server.js'
import type { HttpServerHandle } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'

let server: HttpServerHandle | null = null

interface UserContext {
  userId?: number
}

const delay = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * @param {number} port
 * @param {string[]} chunks
 * @returns {Promise<{status: number, text: string}>}
 */
function chunkedRequest(port: number, chunks: string[]): Promise<{ status: number; text: string }> {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/chunked', method: 'POST', headers: { 'content-type': 'text/plain' } },
      (res) => {
        const body: Buffer[] = []

        res.on('data', (chunk) => body.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(body).toString('utf8') }))
      }
    )

    req.on('error', reject)
    req.write(chunks[0])

    setTimeout(() => {
      for (let i = 1; i < chunks.length; i++) {
        req.write(chunks[i])
      }

      req.end()
    }, 20)
  })
}

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

test('server prefetch: onRequest can await a database check before ctx.json()', { timeout: 3000 }, async () => {
  server = await startHttpServer({
    prefetch: true,
    onRequest: async (ctx) => {
      const token = ctx.header('authorization')

      await delay(30)

      if (token !== 'Bearer allowed') {
        ctx.status(401)

        return { error: 'unauthorized' }
      }

      return ctx.json()
    }
  })

  const { status, text } = await reqText(server.baseUrl, {
    method: 'POST',
    body: JSON.stringify({ ok: true }),
    headers: {
      authorization: 'Bearer allowed',
      'content-type': 'application/json'
    }
  })

  assert.strictEqual(status, 200)
  assert.deepStrictEqual(JSON.parse(text), { ok: true })
})

test('route prefetch: body is available after an asynchronous before hook', { timeout: 3000 }, async () => {
  server = await startHttpServer({
    routes: [
      {
        method: 'post',
        path: '/users',
        prefetch: true,
        before: async (ctx) => {
          await delay(30)
          ;(ctx as typeof ctx & UserContext).userId = 42
        },
        handler: async (ctx) => ({ userId: (ctx as typeof ctx & UserContext).userId, data: await ctx.json() })
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/users`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada' }),
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(status, 200)
  assert.deepStrictEqual(JSON.parse(text), { userId: 42, data: { name: 'Ada' } })
})

test('route prefetch overrides a lazy server', { timeout: 3000 }, async () => {
  server = await startHttpServer({
    prefetch: false,
    routes: [
      {
        method: 'post',
        path: '/override',
        prefetch: true,
        handler: async (ctx) => {
          await delay(30)

          return ctx.text()
        }
      }
    ]
  })

  const { status, text } = await reqText(`${server.baseUrl}/override`, {
    method: 'POST',
    body: 'prefetched'
  })

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'prefetched')
})

test('prefetch keeps per-accessor body limits', async () => {
  server = await startHttpServer({
    prefetch: true,
    onRequest: async (ctx) => {
      await delay(10)
      await ctx.body(3)

      return 'unreachable'
    }
  })

  const { status, text } = await reqText(server.baseUrl, {
    method: 'POST',
    body: 'four'
  })

  assert.strictEqual(status, 413)
  assert.strictEqual(text, 'Request body too large')
})

test('prefetch can reject a user without consuming body in application code', async () => {
  server = await startHttpServer({
    prefetch: true,
    onRequest: async (ctx) => {
      await delay(10)
      ctx.status(401)

      return { error: 'unauthorized' }
    }
  })

  const first = await reqText(server.baseUrl, {
    method: 'POST',
    body: JSON.stringify({ ignored: true }),
    headers: { 'content-type': 'application/json' }
  })
  const second = await reqText(server.baseUrl, {
    method: 'POST',
    body: JSON.stringify({ ignored: 'again' }),
    headers: { 'content-type': 'application/json' }
  })

  assert.strictEqual(first.status, 401)
  assert.strictEqual(second.status, 401)
})

test('prefetch collects a chunked body while application code awaits', { timeout: 3000 }, async () => {
  server = await startHttpServer({
    prefetch: true,
    onRequest: async (ctx) => {
      await delay(50)

      return ctx.text()
    }
  })

  const response = await chunkedRequest(server.port, ['hello ', 'chunked ', 'world'])

  assert.strictEqual(response.status, 200)
  assert.strictEqual(response.text, 'hello chunked world')
})

test('aborted prefetch does not poison the next pooled request', { timeout: 3000 }, async () => {
  server = await startHttpServer({
    prefetch: true,
    onRequest: async (ctx) => {
      if (ctx.url() === '/health') {
        return 'ok'
      }

      await delay(30)

      return ctx.text()
    }
  })

  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: server!.port, path: '/abort', method: 'POST' })

    req.on('error', resolve)
    req.write('partial')
    setTimeout(() => req.destroy(), 10)
  })

  await delay(50)

  const response = await reqText(`${server.baseUrl}/health`)

  assert.strictEqual(response.status, 200)
  assert.strictEqual(response.text, 'ok')
})
