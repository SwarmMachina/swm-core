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

for (const prefetch of [false, true]) {
  const mode = prefetch ? 'prefetch' : 'lazy'

  test(`aggregate body budget covers ${mode} collection and recovers after release`, { timeout: 5000 }, async () => {
    const firstCollected = Promise.withResolvers()
    const releaseFirst = Promise.withResolvers()
    const body = 'x'.repeat(700 * 1024)

    server = await startHttpServer({
      prefetch,
      maxBodySize: 1,
      maxBodyBudget: 1,
      onRequest: async (ctx) => {
        const data = await ctx.body()

        if (ctx.header('x-hold') === 'yes') {
          firstCollected.resolve()
          await releaseFirst.promise
        }

        return String(data.length)
      }
    })

    const first = reqText(server.baseUrl, { method: 'POST', body, headers: { 'x-hold': 'yes' } })

    await firstCollected.promise

    const rejected = await reqText(server.baseUrl, { method: 'POST', body })

    assert.strictEqual(rejected.status, 503)
    assert.strictEqual(rejected.text, 'Request body capacity exceeded')

    releaseFirst.resolve()

    const completed = await first

    assert.strictEqual(completed.status, 200)
    assert.strictEqual(completed.text, String(body.length))

    const recovered = await reqText(server.baseUrl, { method: 'POST', body })

    assert.strictEqual(recovered.status, 200)
    assert.strictEqual(recovered.text, String(body.length))
  })
}

test('request timeout returns 408 and releases prefetched body capacity', { timeout: 5000 }, async () => {
  const handlerBlocked = Promise.withResolvers()
  const releaseHandler = Promise.withResolvers()
  const body = 'x'.repeat(700 * 1024)

  server = await startHttpServer({
    prefetch: true,
    maxBodySize: 1,
    maxBodyBudget: 1,
    requestTimeoutMs: 100,
    onRequest: async (ctx) => {
      const data = await ctx.text()

      if (ctx.url() === '/slow') {
        handlerBlocked.resolve()
        await releaseHandler.promise
      }

      return String(data.length)
    }
  })

  const timedOut = reqText(`${server.baseUrl}/slow`, { method: 'POST', body })

  await handlerBlocked.promise

  const timeoutResponse = await timedOut

  assert.strictEqual(timeoutResponse.status, 408)
  assert.strictEqual(timeoutResponse.text, 'Request Timeout')

  const next = await reqText(`${server.baseUrl}/next`, { method: 'POST', body })

  assert.strictEqual(next.status, 200)
  assert.strictEqual(next.text, String(body.length))

  releaseHandler.resolve()
  await new Promise((resolve) => setImmediate(resolve))
})
