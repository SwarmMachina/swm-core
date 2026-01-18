import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startHttpServer } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'
import delay from '../../../benchmark/helpers/delay.js'

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
