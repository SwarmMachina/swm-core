// tests/leak/harness.leak.test.js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { forceGC, makeCollector, makeMarker, assertCollected } from './helpers/leak-harness.js'

/**
 * @param {{collect: (obj: object) => void}} collector
 * @param {number} count
 */
function allocateAndTrack(collector: { collect(value: object): void }, count: number): void {
  for (let i = 0; i < count; i++) {
    collector.collect(makeMarker(i))
  }
}

test('harness sanity: unreferenced markers are collected', async () => {
  const collector = makeCollector()

  allocateAndTrack(collector, 100)
  await new Promise((resolve) => setTimeout(resolve, 0))

  await assertCollected(collector.refs, 'sanity-collected')
})

test('harness sanity: strongly-referenced marker is reported alive', async () => {
  const keep = makeMarker(0)
  const collector = makeCollector()

  collector.collect(keep)
  await forceGC()

  assert.strictEqual(collector.refs.at(0)?.deref(), keep)
})
