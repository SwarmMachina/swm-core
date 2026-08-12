import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { BENCHMARK_PROFILES_DIR } from '../harness/runtime-paths.js'
import {
  percentageDelta,
  positiveEnvNumber,
  summarizeHttpBenchmark,
  type HttpBenchmarkSummary
} from '../harness/summary.js'
import type { BenchmarkSummary } from '../harness/types.js'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(BENCHMARK_PROFILES_DIR, 'body-safety')
const COMPARISONS = [
  {
    name: 'aggregate-budget',
    test: 'prefetch-body-used',
    baseline: 'core-prefetch',
    enabled: 'core-prefetch-budget',
    pipelining: 1
  },
  {
    name: 'request-timeout',
    test: 'base-async',
    baseline: 'core-lazy',
    enabled: 'core-timeout',
    pipelining: 10
  }
]

interface ComparisonResult {
  test: string
  baseline: HttpBenchmarkSummary
  enabled: HttpBenchmarkSummary
  delta: { rpsPct: number | null; p99Pct: number | null; rssPct: number | null }
}

/**
 * Run fixed enabled/disabled comparisons for both HTTP safety controls.
 */
async function main() {
  const parameters = {
    runs: positiveEnvNumber('BODY_SAFETY_RUNS', 3),
    warmupSec: positiveEnvNumber('BODY_SAFETY_WARMUP', 2),
    durationSec: positiveEnvNumber('BODY_SAFETY_DURATION', 6),
    connections: positiveEnvNumber('BODY_SAFETY_CONNECTIONS', 100),
    sampleMs: positiveEnvNumber('BODY_SAFETY_SAMPLE_MS', 250)
  }

  await fs.mkdir(OUT_DIR, { recursive: true })

  const results: Record<string, ComparisonResult> = {}

  for (const comparison of COMPARISONS) {
    const jsonOut = path.join(OUT_DIR, `${comparison.name}.json`)

    await runChild([
      path.join(BENCH_DIR, 'runner.js'),
      '--test',
      comparison.test,
      '--fw',
      `${comparison.baseline},${comparison.enabled}`,
      '--runs',
      String(parameters.runs),
      '--warmup',
      String(parameters.warmupSec),
      '--duration',
      String(parameters.durationSec),
      '--connections',
      String(parameters.connections),
      '--pipelining',
      String(comparison.pipelining),
      '--sample-ms',
      String(parameters.sampleMs),
      '--order',
      'balanced',
      '--json-out',
      jsonOut
    ])

    const bench = JSON.parse(await fs.readFile(jsonOut, 'utf8')) as BenchmarkSummary
    const baseline = summarizeHttpBenchmark(bench, comparison.baseline)
    const enabled = summarizeHttpBenchmark(bench, comparison.enabled)

    results[comparison.name] = {
      test: comparison.test,
      baseline,
      enabled,
      delta: {
        rpsPct: percentageDelta(enabled.rps, baseline.rps),
        p99Pct: percentageDelta(enabled.p99Ms, baseline.p99Ms),
        rssPct: percentageDelta(enabled.rssMB, baseline.rssMB)
      }
    }
  }

  const summary = { createdAt: new Date().toISOString(), node: process.version, parameters, results }
  const rows = Object.entries(results).map(([name, result]) => ({
    case: name,
    baselineRps: result.baseline.rps,
    enabledRps: result.enabled.rps,
    rpsDelta: result.delta.rpsPct == null ? 'n/a' : `${result.delta.rpsPct}%`,
    baselineP99: result.baseline.p99Ms,
    enabledP99: result.enabled.p99Ms,
    baselineELU: result.baseline.eluPct,
    enabledELU: result.enabled.eluPct,
    baselineRssMB: result.baseline.rssMB,
    enabledRssMB: result.enabled.rssMB,
    errors: result.baseline.errors + result.enabled.errors
  }))
  const report = [
    '# HTTP body safety benchmark',
    '',
    `Generated: ${summary.createdAt}`,
    '',
    `Parameters: runs=${parameters.runs}, warmup=${parameters.warmupSec}s, duration=${parameters.durationSec}s, connections=${parameters.connections}, sample=${parameters.sampleMs}ms.`,
    '',
    'Aggregate budget compares explicit unlimited (`maxBodyBudget: null`) against `256 * 1024 * 1024` bytes on a prefetched workload. Request timeout compares async handlers with `requestTimeoutMs: 0` against `30000`.',
    '',
    '| Case | Baseline rps | Enabled rps | Δ rps | Baseline p99 | Enabled p99 | Baseline ELU | Enabled ELU | Baseline RSS MB | Enabled RSS MB | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.case} | ${row.baselineRps} | ${row.enabledRps} | ${row.rpsDelta} | ${row.baselineP99} | ${row.enabledP99} | ${row.baselineELU} | ${row.enabledELU} | ${row.baselineRssMB} | ${row.enabledRssMB} | ${row.errors} |`
    ),
    '',
    'Compare only runs made with identical parameters on an otherwise idle host.',
    ''
  ].join('\n')

  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await fs.writeFile(path.join(OUT_DIR, 'report.md'), report)

  console.table(rows)
  console.log(`[body-safety] wrote ${path.join(OUT_DIR, 'summary.json')}`)
  console.log(`[body-safety] wrote ${path.join(OUT_DIR, 'report.md')}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
