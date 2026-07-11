import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startHttpServer } from '../helpers/e2e-server.js'
import { makeHttpScenarios } from './scenarios/http.js'
import { makeCollector, assertCollected, assertNoMemoryGrowth, forceGC } from './helpers/leak-harness.js'

for (const scenario of makeHttpScenarios()) {
  test(`http leak: ${scenario.name}`, async () => {
    const collector = makeCollector()
    const handle = await startHttpServer(scenario.serverOptions(collector.collect))

    for (let i = 0; i < scenario.iterations; i++) {
      await scenario.run(handle, collector.collect, i)
    }

    await scenario.teardown?.()

    // Let in-flight abort/finalize callbacks settle before the invariants.
    await forceGC()

    const shutdownStart = performance.now()

    await handle.close()

    const shutdownMs = performance.now() - shutdownStart

    assert.ok(
      shutdownMs < 500,
      `${scenario.name}: graceful shutdown took ${shutdownMs}ms - an HTTP context is still active`
    )
    assert.ok(handle.server.httpContextPool.pool.length <= 1000, `${scenario.name}: context pool exceeded maxSize`)

    await assertCollected(collector.refs, scenario.name)
  })
}

test('http leak: retained memory does not grow across sustained churn', async () => {
  const handle = await startHttpServer({
    routes: [
      { method: 'get', path: '/ping', handler: () => ({ ok: true }) },
      { method: 'post', path: '/echo', handler: async (ctx) => ({ len: (await ctx.text()).length }) }
    ]
  })

  await assertNoMemoryGrowth(
    async (i) => {
      const getRes = await fetch(`${handle.baseUrl}/ping`)

      await getRes.arrayBuffer()

      const postRes = await fetch(`${handle.baseUrl}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: `payload-${i}-${'x'.repeat(512)}`
      })

      await postRes.arrayBuffer()
    },
    { warmup: 50, iterations: 200, maxGrowthBytes: 1.5 * 1024 * 1024, label: 'http-churn' }
  )

  await handle.close()
})
