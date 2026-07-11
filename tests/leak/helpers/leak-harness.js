// tests/leak/helpers/leak-harness.js
import { strict as assert } from 'node:assert'

/**
 * @param {number} [cycles]
 * @returns {Promise<void>}
 */
export async function forceGC(cycles = 4) {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('leak-harness requires node --expose-gc')
  }

  // Several major GC cycles with event-loop turns in between, so pending
  // callbacks and FinalizationRegistry hooks can drop references first.
  for (let i = 0; i < cycles; i++) {
    globalThis.gc()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * @returns {{collect: (obj: object) => void, refs: WeakRef<object>[]}}
 */
export function makeCollector() {
  /** @type {WeakRef<object>[]} */
  const refs = []

  return {
    collect: (obj) => {
      refs.push(new WeakRef(obj))
    },
    refs
  }
}

/**
 * @param {number} id
 * @returns {{id: number, blob: Buffer}}
 */
export function makeMarker(id) {
  return { id, blob: Buffer.alloc(1024, id & 0xff) }
}

/**
 * @param {WeakRef<object>[]} refs
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function assertCollected(refs, label) {
  // Only call after the frames that created the markers have returned:
  // a live stack reference keeps an object reachable under V8 CSS.
  await forceGC()

  const alive = refs.reduce((n, ref) => (ref.deref() === undefined ? n : n + 1), 0)

  assert.strictEqual(alive, 0, `${label}: ${alive} of ${refs.length} tracked objects still reachable after GC`)
}

/**
 * @returns {Promise<number>}
 */
export async function measureRetainedBytes() {
  await forceGC()

  const { heapUsed, arrayBuffers } = process.memoryUsage()

  // arrayBuffers is included because Buffer payloads live off-heap.
  return heapUsed + arrayBuffers
}

/**
 * @param {(i: number) => Promise<void>} iterate
 * @param {{warmup?: number, iterations?: number, maxGrowthBytes?: number, label: string}} opt
 * @returns {Promise<void>}
 */
export async function assertNoMemoryGrowth(
  iterate,
  { warmup = 50, iterations = 200, maxGrowthBytes = 1.5 * 1024 * 1024, label }
) {
  for (let i = 0; i < warmup; i++) {
    await iterate(i)
  }

  const before = await measureRetainedBytes()

  for (let i = 0; i < iterations; i++) {
    await iterate(warmup + i)
  }

  const growth = (await measureRetainedBytes()) - before

  assert.ok(
    growth < maxGrowthBytes,
    `${label}: retained memory grew by ${growth} bytes over ${iterations} iterations (limit ${maxGrowthBytes})`
  )
}
