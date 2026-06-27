import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startHttpServer } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'
import delay from '../../../helpers/delay.js'

test('shutdown: rejects all conections while stopping', async () => {
  let inFlightResolve
  const inFlight = new Promise((resolve) => (inFlightResolve = resolve))

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

  await delay(30)

  let closeResolved = false

  const closeP = server.close().then(() => {
    closeResolved = true
  })

  assert.strictEqual(closeResolved, false)

  const ping = await reqText(`${server.baseUrl}/ping`)

  assert.strictEqual(ping.status, 503)
  assert.strictEqual(ping.headers.get('connection'), 'close')

  await inFlight
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
          ctx.status(401).send('nope')
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
