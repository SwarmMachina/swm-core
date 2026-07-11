import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startWsServer } from '../helpers/e2e-server.js'
import { makeWsScenarios } from './scenarios/ws.js'
import { makeCollector, assertCollected, forceGC } from './helpers/leak-harness.js'

for (const scenario of makeWsScenarios()) {
  test(`ws leak: ${scenario.name}`, async () => {
    const collector = makeCollector()
    const handle = await startWsServer(scenario.serverOptions(collector.collect))

    for (let i = 0; i < scenario.iterations; i++) {
      await scenario.run(handle, collector.collect, i)
    }

    await scenario.verify?.(handle)

    // Server-side close callbacks can lag the client 'close' event.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await forceGC()

    const shutdownStart = performance.now()

    await handle.close()

    const shutdownMs = performance.now() - shutdownStart

    assert.ok(
      shutdownMs < 500,
      `${scenario.name}: graceful shutdown took ${shutdownMs}ms - a WS context is still active`
    )

    await assertCollected(collector.refs, scenario.name)
  })
}
