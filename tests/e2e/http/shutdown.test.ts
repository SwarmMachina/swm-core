import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { delay } from '@swarmmachina/benchkit'
import { startHttpServer } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'

test('shutdown: rejects all conections while stopping', async () => {
  let inFlightResolve: () => void

  const inFlight = new Promise<void>((resolve) => (inFlightResolve = resolve))
  const server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/slow',
        handler: async () => {
          inFlightResolve()
          await delay(150)

          return 'ok'
        }
      },
      {
        method: 'get',
        path: '/ping',
        handler: () => {
          return 'ok'
        }
      }
    ]
  })
  const reqP = reqText(`${server.baseUrl}/slow`)

  await inFlight

  let closeResolved = false

  const closeP = server.close().then(() => {
    closeResolved = true
  })

  assert.strictEqual(closeResolved, false)

  const ping = await reqText(`${server.baseUrl}/ping`)

  assert.strictEqual(ping.status, 503)
  assert.strictEqual(ping.headers.get('connection'), 'close')

  await delay(30)

  const { status, text } = await reqP

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'ok')

  await closeP
})

test('shutdown: finalizes context after async handler replies itself (no leak)', async () => {
  const server = await startHttpServer({
    routes: [
      {
        method: 'get',
        path: '/self-reply',
        handler: async (ctx) => {
          ctx.setStatus(401).send('nope')
        }
      }
    ]
  })
  const { status } = await reqText(`${server.baseUrl}/self-reply`)

  assert.strictEqual(status, 401)

  const startedAt = Date.now()

  await server.close()

  // A leaked context keeps #activeHttp > 0, so graceful shutdown would hang until
  // the 1000ms force-close timeout. A finalized context lets it resolve promptly.
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 500, `graceful shutdown took ${elapsed}ms (context leaked)`)
})

test('shutdown: drains accepted HTTP error delivery before resolving', async () => {
  const delivery = Promise.withResolvers<void>()
  const server = await startHttpServer({
    onRequest: () => {
      throw new Error('delivery probe')
    },
    errorDelivery: { timeoutMs: 5_000 },
    onError: () => delivery.promise
  })
  const response = await reqText(`${server.baseUrl}/failed`)

  assert.strictEqual(response.status, 500)
  assert.strictEqual(server.server.httpErrorDeliveryStats.inFlight, 1)

  let resolved = false

  const shutdown = server.server.shutdown(1_000).then(() => {
    resolved = true
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.strictEqual(resolved, false)

  delivery.resolve()
  await shutdown

  assert.strictEqual(server.server.httpErrorDeliveryStats.inFlight, 0)
  assert.strictEqual(server.server.httpErrorDeliveryStats.completed, 1)
})

test('shutdown: aborts HTTP error delivery at the shared deadline', async () => {
  let deliverySignal: AbortSignal | null = null

  const server = await startHttpServer({
    onRequest: () => {
      throw new Error('delivery probe')
    },
    errorDelivery: { timeoutMs: 5_000 },
    onError: (_event, _error, { signal }) => {
      deliverySignal = signal

      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
  })
  const response = await reqText(`${server.baseUrl}/failed`)

  assert.strictEqual(response.status, 500)

  const startedAt = Date.now()

  await server.server.shutdown(20)
  await Promise.resolve()

  const elapsed = Date.now() - startedAt

  assert.strictEqual((deliverySignal as AbortSignal | null)?.aborted, true)
  assert.strictEqual((deliverySignal as AbortSignal | null)?.reason?.code, 'ERR_HTTP_ERROR_DELIVERY_SHUTDOWN')
  assert.ok(elapsed < 500, `forced shutdown took ${elapsed}ms`)
  assert.strictEqual(server.server.httpErrorDeliveryStats.inFlight, 0)
  assert.strictEqual(server.server.httpErrorDeliveryStats.timedOut, 0)
  assert.strictEqual(server.server.httpErrorDeliveryStats.aborted, 1)
  assert.strictEqual(server.server.httpErrorDeliveryStats.completed, 0)
  assert.strictEqual(server.server.httpErrorDeliveryStats.rejected, 0)
})
