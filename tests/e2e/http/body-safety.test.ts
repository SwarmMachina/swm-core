import { afterEach, test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { startHttpServer } from '../../helpers/e2e-server.js'
import type { HttpServerHandle } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'

let server: HttpServerHandle | null = null

interface HttpError extends Error {
  status?: number
}

function requireHttpConfig(handle: HttpServerHandle) {
  if (!handle.server.effectiveConfig.http) {
    throw new Error('Expected HTTP configuration')
  }

  return handle.server.effectiveConfig.http
}

function requireBodyBudget(handle: HttpServerHandle) {
  if (!handle.server.httpBodyBudget) {
    throw new Error('Expected HTTP body budget')
  }

  return handle.server.httpBodyBudget
}

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

for (const prefetch of [false, true]) {
  const mode = prefetch ? 'prefetch' : 'lazy'

  test(`aggregate body budget covers ${mode} collection and recovers after release`, { timeout: 5000 }, async () => {
    const firstCollected = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const body = 'x'.repeat(700 * 1024)

    server = await startHttpServer({
      prefetch,
      maxBodySize: 1024 * 1024,
      maxBodyBudget: 1024 * 1024,
      onRequest: async (ctx) => {
        const hold = ctx.header('x-hold') === 'yes'
        const data = await ctx.body()

        if (hold) {
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
  const handlerBlocked = Promise.withResolvers<void>()
  const releaseHandler = Promise.withResolvers<void>()
  const body = 'x'.repeat(700 * 1024)

  server = await startHttpServer({
    prefetch: true,
    maxBodySize: 1024 * 1024,
    maxBodyBudget: 1024 * 1024,
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
  await new Promise<void>((resolve) => setImmediate(resolve))
})

test(
  'default HTTP body budget admits an exact deterministic reservation count and recovers',
  { timeout: 5000 },
  async () => {
    const budgetRejected = Promise.withResolvers<void>()
    const declaredLength = 48 * 1024 * 1024
    const defaultBudget = 256 * 1024 * 1024
    const admittedReservations = Math.floor(defaultBudget / declaredLength)

    server = await startHttpServer({
      prefetch: true,
      maxBodySize: 48 * 1024 * 1024,
      onRequest: async (ctx) => String((await ctx.body()).length),
      onError: (_ctx, error) => {
        if ((error as HttpError).status === 503) {
          budgetRejected.resolve()
        }
      }
    })

    assert.strictEqual(requireHttpConfig(server).maxBodyBudget, defaultBudget)

    const open = (): Promise<Socket> =>
      new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: server!.port })

        socket.once('error', reject)
        socket.once('connect', () => {
          socket.write(
            [
              'POST / HTTP/1.1',
              'Host: localhost',
              `Content-Length: ${declaredLength}`,
              'Connection: close',
              '',
              ''
            ].join('\r\n')
          )
          resolve(socket)
        })
      })
    const acceptedSockets: Socket[] = []

    for (let index = 0; index < admittedReservations; index++) {
      acceptedSockets.push(await open())

      for (let attempt = 0; attempt < 100 && requireBodyBudget(server).activeReservations !== index + 1; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      assert.strictEqual(requireBodyBudget(server).activeReservations, index + 1)
    }

    const rejectedSocket = await open()

    await budgetRejected.promise
    assert.strictEqual(requireBodyBudget(server).activeReservations, admittedReservations)
    assert.strictEqual(requireBodyBudget(server).usedBytes, admittedReservations * declaredLength)

    rejectedSocket.destroy()

    for (const socket of acceptedSockets) {
      socket.destroy()
    }

    for (let attempt = 0; attempt < 100 && requireBodyBudget(server).usedBytes !== 0; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    assert.strictEqual(requireBodyBudget(server).usedBytes, 0)
    assert.strictEqual(requireBodyBudget(server).activeReservations, 0)
  }
)
