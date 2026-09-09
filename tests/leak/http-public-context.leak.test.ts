import assert from 'node:assert/strict'
import { test } from 'node:test'
import Server from '../../src/server/server.js'
import { createMockHttpRequest, createMockHttpResponse } from '../helpers/mock-uws.js'
import { assertCollected } from './helpers/leak-harness.js'

test('an active server pool retains neither completed public contexts nor their custom state', async () => {
  const server = new Server({ http: { onRequest: () => 'ok' } })
  const refs: WeakRef<object>[] = []

  for (let i = 0; i < 100; i++) {
    server.handleWithContext(createMockHttpResponse(), createMockHttpRequest(), (ctx) => {
      const payload = { body: Buffer.alloc(64 * 1024) }

      Object.defineProperty(ctx, 'user', { value: payload })
      Object.defineProperty(ctx, Symbol('payload'), { value: payload })
      Object.freeze(ctx)
      refs.push(new WeakRef(ctx), new WeakRef(payload))

      return 'ok'
    })
  }

  await assertCollected(refs, 'public HTTP context and application payload')
  const next = createMockHttpResponse()

  server.handleWithContext(next, createMockHttpRequest(), (ctx) => {
    assert.equal(Object.hasOwn(ctx, 'user'), false)

    return 'next'
  })
  assert.equal(next.isEnded(), true)
  assert.equal(server.activeHttp, 0)
})
