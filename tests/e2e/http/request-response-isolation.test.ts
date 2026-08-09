import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { startHttpServer } from '../../helpers/e2e-server.js'

import type { HttpServerHandle } from '../../helpers/e2e-server.js'

let server: HttpServerHandle | null = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

test('prefetch keeps request headers, body and response cookies isolated across async requests', async () => {
  server = await startHttpServer({
    prefetchHeaders: ['cookie'],
    routes: [
      {
        method: 'post',
        path: '/auth',
        handler: async (context) => {
          const bodyPromise = context.body()

          await new Promise((resolve) => setImmediate(resolve))

          const request = JSON.parse((await bodyPromise).toString('utf8'))
          const token = context.headers.cookie?.match(/(?:^|; )token=([^;]+)/)?.[1] ?? ''

          context.appendHeader('set-cookie', `token=${token}; Path=/; HttpOnly`)

          return { requestId: request.requestId, userId: token }
        }
      }
    ]
  })

  const requests = Array.from({ length: 256 }, async (_, index) => {
    const requestId = String(index + 1)
    const response = await fetch(`${server!.baseUrl}/auth`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `token=${requestId}`
      },
      body: JSON.stringify({ requestId })
    })
    const payload = await response.json()
    const responseToken = response.headers.get('set-cookie')?.match(/^token=([^;]+)/)?.[1]

    assert.deepEqual(payload, { requestId, userId: requestId })
    assert.equal(responseToken, requestId)
  })

  await Promise.all(requests)
})
