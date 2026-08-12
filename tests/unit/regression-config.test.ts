import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { resolveHttpParams } from '../../benchmark/regression/suites/http.js'

const baseline = {
  parameters: {
    runs: 5,
    warmupSec: 4,
    durationSec: 12,
    connections: 80,
    sampleMs: 500,
    cpuProfile: false
  }
}

test('HTTP regression parameters default to the baseline configuration', () => {
  deepStrictEqual(resolveHttpParams(baseline, {}), {
    tests: [
      'base-sync',
      'base-async',
      'headers',
      'headers-prepared',
      'static-cache-hit',
      'static-cache-miss',
      'stream',
      'stream-backpressure',
      'post-base'
    ],
    runs: 5,
    warmup: 4,
    duration: 12,
    connections: 80,
    sampleMs: 500,
    cpuProfile: false,
    framework: 'core'
  })
})

test('HTTP regression parameters allow explicit experiment overrides', () => {
  const params = resolveHttpParams(baseline, {
    HTTP_PROFILE_RUNS: '7',
    HTTP_CPU_PROFILE: 'true'
  })

  strictEqual(params.runs, 7)
  strictEqual(params.cpuProfile, true)
  strictEqual(params.duration, 12)
})
