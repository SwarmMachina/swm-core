import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import {
  finiteMedian,
  percentageDelta,
  positiveEnvNumber,
  rowsForFramework,
  summarizeHttpBenchmark
} from '../../benchmark/harness/summary.js'

test('benchmark summary helpers preserve environment and finite-number rules', () => {
  const env = { POSITIVE: '12.5', ZERO: '0', INVALID: 'not-a-number' }

  strictEqual(positiveEnvNumber('POSITIVE', 1, env), 12.5)
  strictEqual(positiveEnvNumber('ZERO', 1, env), 1)
  strictEqual(positiveEnvNumber('INVALID', 1, env), 1)
  strictEqual(finiteMedian([null, 1, Number.NaN, 5]), 3)
  strictEqual(finiteMedian([null, undefined, Number.NaN]), null)
  strictEqual(percentageDelta(110, 100), 10)
  strictEqual(percentageDelta(1, 0), null)
})

test('HTTP benchmark summary keeps median throughput and aggregates run telemetry', () => {
  const bench = {
    median: [{ fw: 'core', rps: 1000, latP95Ms: 2, latP99Ms: 4 }],
    runs: [
      {
        run: 1,
        rows: [{ fw: 'core', errors: 1, eluPct: 80, rssMB: 100 }]
      },
      {
        run: 2,
        rows: [{ fw: 'core', errors: 2, eluPct: 90, rssMB: 120 }]
      }
    ]
  }

  deepStrictEqual(rowsForFramework(bench, 'core'), [
    { fw: 'core', errors: 1, eluPct: 80, rssMB: 100 },
    { fw: 'core', errors: 2, eluPct: 90, rssMB: 120 }
  ])
  deepStrictEqual(summarizeHttpBenchmark(bench, 'core'), {
    rps: 1000,
    p95Ms: 2,
    p99Ms: 4,
    errors: 3,
    eluPct: 85,
    rssMB: 110
  })
})
