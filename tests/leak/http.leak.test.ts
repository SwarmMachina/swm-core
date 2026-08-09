import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHttpServer } from '../helpers/e2e-server.js'
import { makeHttpScenarios } from './scenarios/http.js'
import {
  makeCollector,
  assertCollected,
  assertNoMemoryGrowth,
  forceGC,
  measureRetainedBytes
} from './helpers/leak-harness.js'
import { serveStatic } from '../../src/index.js'

function poolSize(pool: object): number {
  return (pool as { pool: unknown[] }).pool.length
}

for (const scenario of makeHttpScenarios()) {
  test(`http leak: ${scenario.name}`, async (t) => {
    const collector = makeCollector()
    const handle = await startHttpServer(
      scenario.serverOptions(collector.collect) as Parameters<typeof startHttpServer>[0]
    )

    let closed = false

    // Close the server if an assertion or scenario fails before measured shutdown.
    t.after(() => {
      if (!closed) {
        return handle.close()
      }
    })

    for (let i = 0; i < scenario.iterations; i++) {
      await scenario.run(handle, collector.collect, i)
    }

    await scenario.teardown?.()

    // Let in-flight abort/finalize callbacks settle before the invariants.
    await forceGC()

    const shutdownStart = performance.now()

    await handle.close()

    closed = true

    const shutdownMs = performance.now() - shutdownStart

    assert.ok(
      shutdownMs < 500,
      `${scenario.name}: graceful shutdown took ${shutdownMs}ms - an HTTP context is still active`
    )
    assert.ok(poolSize(handle.server.httpContextPool) <= 1000, `${scenario.name}: context pool exceeded maxSize`)

    await assertCollected(collector.refs, scenario.name)
  })
}

test('http leak: retained memory does not grow across sustained churn', async (t) => {
  const handle = await startHttpServer({
    routes: [
      { method: 'get' as const, path: '/ping', handler: () => ({ ok: true }) },
      { method: 'post' as const, path: '/echo', handler: async (ctx) => ({ len: (await ctx.text()).length }) }
    ]
  })

  let closed = false

  t.after(() => {
    if (!closed) {
      return handle.close()
    }
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

  closed = true
})

test('http leak: serveStatic cache stays bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-leak-static-'))
  const fileCount = 120
  const fileSize = 64 * 1024

  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(dir, `f${i}.txt`), Buffer.alloc(fileSize, i & 0xff))
  }

  const handle = await startHttpServer({ onRequest: serveStatic(dir, { cacheLimit: 16 }) })

  try {
    // Warmup fills the cache up to its limit.
    for (let i = 0; i < 32; i++) {
      const res = await fetch(`${handle.baseUrl}/f${i}.txt`)

      await res.arrayBuffer()
    }

    const before = await measureRetainedBytes()

    for (let i = 0; i < fileCount; i++) {
      const res = await fetch(`${handle.baseUrl}/f${i}.txt`)

      await res.arrayBuffer()
    }

    const growth = (await measureRetainedBytes()) - before

    // Bounded cache holds 16 * 64KB = 1MB; an unbounded one would retain
    // all 120 files (7.5MB).
    assert.ok(growth < 2.5 * 1024 * 1024, `serveStatic retained ${growth} bytes - cache looks unbounded`)
  } finally {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
