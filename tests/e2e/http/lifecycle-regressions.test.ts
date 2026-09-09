import assert from 'node:assert/strict'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { startHttpServer } from '../../helpers/e2e-server.js'

for (const method of ['end', 'tryEnd'] as const) {
  test(
    `native ${method} isolates a completed response from its pending async continuation`,
    { timeout: 5_000 },
    async (t) => {
      const firstGate = Promise.withResolvers<void>()
      const firstContinued = Promise.withResolvers<string>()
      const secondGate = Promise.withResolvers<void>()
      const secondStarted = Promise.withResolvers<void>()
      const handle = await startHttpServer({
        onRequest: async (ctx) => {
          const path = ctx.getUrl()

          if (path === '/first') {
            ctx.startStreaming()

            if (method === 'end') {
              ctx.end('first')
            } else {
              ctx.tryEnd('first', 5)
            }

            await firstGate.promise
            firstContinued.resolve(ctx.getUrl())

            return 'must not reach second request'
          }

          secondStarted.resolve()
          await secondGate.promise

          return 'second'
        }
      })

      t.after(async () => {
        firstGate.resolve()
        secondGate.resolve()
        await handle.close()
      })
      assert.equal(await (await fetch(`${handle.baseUrl}/first`)).text(), 'first')
      const second = fetch(`${handle.baseUrl}/second`)

      await secondStarted.promise
      firstGate.resolve()
      assert.equal(await firstContinued.promise, '/first')
      await nextTurn()
      assert.equal(handle.server.activeHttp, 1)
      secondGate.resolve()
      assert.equal(await (await second).text(), 'second')
      assert.equal(handle.server.activeHttp, 0)
    }
  )
}

test('native requests do not inherit user fields from a previous pooled context', { timeout: 5_000 }, async (t) => {
  const handle = await startHttpServer({
    onRequest: (ctx) => {
      if (ctx.getUrl() === '/authenticated') {
        Object.assign(ctx, { user: { role: 'admin' } })

        return 'authenticated'
      }

      return { inheritedUser: Object.hasOwn(ctx, 'user') }
    }
  })

  t.after(handle.close)
  assert.equal(await (await fetch(`${handle.baseUrl}/authenticated`)).text(), 'authenticated')
  assert.deepEqual(await (await fetch(`${handle.baseUrl}/anonymous`)).json(), { inheritedUser: false })
})

test(
  'native response-header validation fails with a complete 500 and preserves following requests',
  { timeout: 5_000 },
  async (t) => {
    const handle = await startHttpServer({
      onRequest: (ctx) => {
        if (ctx.getUrl() === '/invalid') {
          ctx.reply(200, { 'x-result': 'bad\r\nvalue' }, 'invalid')

          return
        }

        return 'healthy'
      }
    })

    t.after(handle.close)
    const invalid = await fetch(`${handle.baseUrl}/invalid`)

    assert.equal(invalid.status, 500)
    assert.equal(await invalid.text(), 'Internal Server Error')
    assert.equal(await (await fetch(`${handle.baseUrl}/healthy`)).text(), 'healthy')
    assert.equal(handle.server.activeHttp, 0)
  }
)

test('native early reply releases the body budget without failing a live request', { timeout: 5_000 }, async (t) => {
  const gate = Promise.withResolvers<void>()
  const reported: number[] = []
  const handle = await startHttpServer({
    maxBodyBudget: 4,
    requestTimeoutMs: 100,
    onError: (event) => reported.push(event.status),
    onRequest: async (ctx) => {
      await ctx.body()
      ctx.sendText('accepted')
      await gate.promise
    }
  })

  t.after(async () => {
    gate.resolve()
    await handle.close()
  })
  const response = await fetch(handle.baseUrl, { method: 'POST', body: 'body' })

  assert.equal(await response.text(), 'accepted')

  while (handle.server.httpBodyBudget!.usedBytes !== 0) {
    await delay(25)
  }

  assert.equal(handle.server.httpBodyBudget!.activeReservations, 0)

  // The deadline reclaims body bytes only. The answered request is not
  // reported as a failure and stays active until its handler finishes.
  assert.deepEqual(reported, [])
  assert.equal(handle.server.activeHttp, 1)
  gate.resolve()
  await delay(50)
  assert.equal(handle.server.activeHttp, 0)
  assert.deepEqual(reported, [])
})

test('native streaming handler rejection terminates an incomplete download', { timeout: 5_000 }, async (t) => {
  const reported = Promise.withResolvers<void>()
  const handle = await startHttpServer({
    onError: () => reported.resolve(),
    onRequest: async (ctx) => {
      ctx.startStreaming()
      ctx.write('prefix')
      await nextTurn()
      throw new Error('handler failed after headers')
    }
  })

  t.after(handle.close)
  await assert.rejects(async () => {
    const response = await fetch(handle.baseUrl)

    await response.text()
  })
  await reported.promise
  assert.equal(handle.server.activeHttp, 0)
})

test(
  'shutdown before listen leaves no timer that can close a subsequent native listener',
  { timeout: 5_000 },
  async (t) => {
    const handle = await startHttpServer({ onRequest: () => 'healthy' })

    t.after(handle.close)
    const stopped = handle.server.shutdown(0)

    assert.ok(stopped instanceof Promise)
    await stopped
    await handle.server.shutdown(50)
    await handle.server.listen()
    assert.equal(await (await fetch(handle.baseUrl)).text(), 'healthy')
    await delay(100)
    assert.equal(await (await fetch(handle.baseUrl)).text(), 'healthy')
  }
)
