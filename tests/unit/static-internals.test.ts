import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import ByteBoundedLru from '../../src/static/byte-bounded-lru.js'
import InflightBudget from '../../src/static/inflight-budget.js'

test('ByteBoundedLru refreshes a hit and evicts by byte budget', () => {
  const cache = new ByteBoundedLru<string, { readonly byteLength: number; readonly value: string }>(3, 4)
  const first = { byteLength: 2, value: 'first' }
  const second = { byteLength: 2, value: 'second' }
  const third = { byteLength: 2, value: 'third' }

  cache.set('first', first)
  cache.set('second', second)
  assert.strictEqual(cache.get('first'), first)

  cache.set('third', third)

  assert.strictEqual(cache.get('first'), first)
  assert.strictEqual(cache.get('second'), undefined)
  assert.strictEqual(cache.get('third'), third)
})

test('InflightBudget independently bounds file and byte reservations', () => {
  const budget = new InflightBudget(3, 1)

  assert.strictEqual(budget.tryReserveFile(), true)
  assert.strictEqual(budget.tryReserveFile(), false)
  assert.strictEqual(budget.tryReserveBytes(2), true)
  assert.strictEqual(budget.tryReserveBytes(2), false)

  budget.releaseBytes(2)
  budget.releaseFile()

  assert.strictEqual(budget.tryReserveFile(), true)
  assert.strictEqual(budget.tryReserveBytes(3), true)
})
