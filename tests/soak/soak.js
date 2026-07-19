import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    duration: { type: 'string', default: '300' },
    scenarios: { type: 'string', default: '' },
    interval: { type: 'string', default: '5' },
    // Default is a conservative 200 KB/s ceiling for post-warmup RSS growth.
    'max-slope': { type: 'string', default: '204800' }
  }
})
const { startHttpServer, startWsServer } = await import('../helpers/e2e-server.js')
const { makeHttpScenarios } = await import('../leak/scenarios/http.js')
const { makeWsScenarios } = await import('../leak/scenarios/ws.js')
const noop = () => {}
const wanted = values.scenarios ? new Set(values.scenarios.split(',')) : null
const entries = []

for (const scenario of makeHttpScenarios()) {
  if (wanted && !wanted.has(scenario.name)) {
    continue
  }

  entries.push({ scenario, handle: await startHttpServer(scenario.serverOptions(noop)) })
}

for (const scenario of makeWsScenarios()) {
  if (wanted && !wanted.has(scenario.name)) {
    continue
  }

  entries.push({ scenario, handle: await startWsServer(scenario.serverOptions(noop)) })
}

if (entries.length === 0) {
  console.error('soak: no scenarios matched --scenarios filter')
  process.exit(2)
}

const durationMs = Number(values.duration) * 1000
const intervalMs = Number(values.interval) * 1000
const maxSlope = Number(values['max-slope'])
const startedAt = performance.now()
const samples = []

let iterations = 0
let nextSampleAt = startedAt + intervalMs

console.log(`soak: duration=${values.duration}s scenarios=${entries.map((e) => e.scenario.name).join(',')}`)

/** @returns {void} */
function takeSample() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
  }

  const { rss, heapUsed, external } = process.memoryUsage()
  const t = (performance.now() - startedAt) / 1000

  samples.push({ t, rss })
  console.log(
    `[${t.toFixed(0).padStart(5)}s] rss=${(rss / 1048576).toFixed(1)}MB heapUsed=${(heapUsed / 1048576).toFixed(1)}MB external=${(external / 1048576).toFixed(1)}MB iterations=${iterations}`
  )
}

while (performance.now() - startedAt < durationMs) {
  for (const { scenario, handle } of entries) {
    await scenario.run(handle, noop, iterations)
  }

  iterations++

  if (performance.now() >= nextSampleAt) {
    takeSample()
    nextSampleAt += intervalMs
  }
}

takeSample()

for (const { scenario, handle } of entries) {
  await scenario.teardown?.()
  await handle.close()
}

// Least-squares slope of RSS over time, ignoring the warmup (first 20%).
const warmupSec = (durationMs / 1000) * 0.2
const usable = samples.filter((sample) => sample.t > warmupSec)

if (usable.length < 5) {
  console.error(`soak: only ${usable.length} post-warmup samples - run longer or lower --interval; no verdict`)
  process.exit(2)
}

const meanT = usable.reduce((acc, sample) => acc + sample.t, 0) / usable.length
const meanRss = usable.reduce((acc, sample) => acc + sample.rss, 0) / usable.length
const slope =
  usable.reduce((acc, sample) => acc + (sample.t - meanT) * (sample.rss - meanRss), 0) /
  usable.reduce((acc, sample) => acc + (sample.t - meanT) ** 2, 0)

console.log(`soak: rss slope after warmup = ${(slope / 1024).toFixed(2)} KB/s over ${usable.length} samples`)

if (slope > maxSlope) {
  console.error(`soak: LEAK VERDICT - rss slope exceeds ${(maxSlope / 1024).toFixed(0)} KB/s`)
  process.exit(1)
}

console.log('soak: OK - no significant rss growth')
