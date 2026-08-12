import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { resolveBindingCandidate } from '../../scripts/binding-candidate.js'
import { BENCHMARK_PROFILES_DIR, REPOSITORY_ROOT } from '../harness/runtime-paths.js'
import {
  finiteMedian,
  percentageDelta,
  positiveEnvNumber,
  summarizeHttpBenchmark,
  type HttpBenchmarkSummary
} from '../harness/summary.js'
import type { BenchmarkSummary } from '../harness/types.js'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(BENCHMARK_PROFILES_DIR, 'response-batch')
const BASELINE = 'core-response-batch-off'
const ENABLED = 'core-response-batch-on'
const CASES = ['base-sync', 'headers-prepared']
const MIN_GAIN_PCT = 1
const MAX_P99_REGRESSION_PCT = 5
const MAX_RSS_REGRESSION_PCT = 5

interface ComparisonResult {
  baseline: HttpBenchmarkSummary
  enabled: HttpBenchmarkSummary
  delta: { pairedRpsPct: number | null; p95Pct: number | null; p99Pct: number | null; rssPct: number | null }
  pass: boolean
}

function pairedRpsDelta(bench: BenchmarkSummary): number | null {
  const deltas = bench.runs.map((run) => {
    const baseline = run.rows.find((row) => row.fw === BASELINE)?.rps
    const enabled = run.rows.find((row) => row.fw === ENABLED)?.rps

    return percentageDelta(enabled, baseline)
  })

  return finiteMedian(deltas)
}

/**
 * @param {object} result
 * @returns {boolean}
 */
function passes(result: ComparisonResult): boolean {
  const { pairedRpsPct, p99Pct, rssPct } = result.delta

  return (
    result.baseline.errors + result.enabled.errors === 0 &&
    pairedRpsPct !== null &&
    p99Pct !== null &&
    rssPct !== null &&
    pairedRpsPct >= MIN_GAIN_PCT &&
    p99Pct <= MAX_P99_REGRESSION_PCT &&
    rssPct <= MAX_RSS_REGRESSION_PCT
  )
}

/**
 * Run a fixed responseBatch off/on comparison and write auditable reports.
 */
async function main() {
  const sibling = path.resolve(REPOSITORY_ROOT, '../swm-uws')
  const candidate = resolveBindingCandidate(process.env.SWM_UWS_CANDIDATE || sibling)
  const binding = await import(pathToFileURL(candidate.entry).href)

  if (binding.capabilities().responseBatch !== true) {
    throw new Error(`Candidate ${candidate.manifest.version} does not advertise responseBatch`)
  }

  process.env.SWM_UWS_CANDIDATE_ENTRY = candidate.entry

  const parameters = {
    runs: positiveEnvNumber('RESPONSE_BATCH_RUNS', 4),
    warmupSec: positiveEnvNumber('RESPONSE_BATCH_WARMUP', 2),
    durationSec: positiveEnvNumber('RESPONSE_BATCH_DURATION', 6),
    connections: positiveEnvNumber('RESPONSE_BATCH_CONNECTIONS', 100),
    pipelining: positiveEnvNumber('RESPONSE_BATCH_PIPELINING', 10),
    sampleMs: positiveEnvNumber('RESPONSE_BATCH_SAMPLE_MS', 250)
  }

  await fs.mkdir(OUT_DIR, { recursive: true })

  const results: Record<string, ComparisonResult> = {}

  for (const name of CASES) {
    const jsonOut = path.join(OUT_DIR, `${name}.json`)

    await runChild([
      path.join(BENCH_DIR, 'runner.js'),
      '--test',
      name,
      '--fw',
      `${BASELINE},${ENABLED}`,
      '--runs',
      String(parameters.runs),
      '--warmup',
      String(parameters.warmupSec),
      '--duration',
      String(parameters.durationSec),
      '--connections',
      String(parameters.connections),
      '--pipelining',
      String(parameters.pipelining),
      '--sample-ms',
      String(parameters.sampleMs),
      '--order',
      'balanced',
      '--json-out',
      jsonOut
    ])

    const bench = JSON.parse(await fs.readFile(jsonOut, 'utf8')) as BenchmarkSummary
    const baseline = summarizeHttpBenchmark(bench, BASELINE)
    const enabled = summarizeHttpBenchmark(bench, ENABLED)
    const result: ComparisonResult = {
      baseline,
      enabled,
      delta: {
        pairedRpsPct: pairedRpsDelta(bench),
        p95Pct: percentageDelta(enabled.p95Ms, baseline.p95Ms),
        p99Pct: percentageDelta(enabled.p99Ms, baseline.p99Ms),
        rssPct: percentageDelta(enabled.rssMB, baseline.rssMB)
      },
      pass: false
    }

    result.pass = passes(result)
    results[name] = result
  }

  const decision = Object.values(results).every((result) => result.pass) ? 'eligible-for-default' : 'keep-experimental'
  const summary = {
    createdAt: new Date().toISOString(),
    node: process.version,
    binding: {
      package: `${candidate.manifest.name}@${candidate.manifest.version}`,
      native: binding.version(),
      root: candidate.root
    },
    parameters,
    thresholds: {
      minPairedRpsGainPct: MIN_GAIN_PCT,
      maxP99RegressionPct: MAX_P99_REGRESSION_PCT,
      maxRssRegressionPct: MAX_RSS_REGRESSION_PCT,
      errors: 0
    },
    decision,
    results
  }
  const rows = Object.entries(results).map(([name, result]) => ({
    case: name,
    offRps: result.baseline.rps,
    onRps: result.enabled.rps,
    pairedRpsDelta: `${result.delta.pairedRpsPct}%`,
    offP95: result.baseline.p95Ms,
    onP95: result.enabled.p95Ms,
    offP99: result.baseline.p99Ms,
    onP99: result.enabled.p99Ms,
    offELU: result.baseline.eluPct,
    onELU: result.enabled.eluPct,
    offRssMB: result.baseline.rssMB,
    onRssMB: result.enabled.rssMB,
    errors: result.baseline.errors + result.enabled.errors,
    gate: result.pass ? 'PASS' : 'FAIL'
  }))
  const report = [
    '# responseBatch performance gate',
    '',
    `Generated: ${summary.createdAt}`,
    `Binding: ${summary.binding.package} (${summary.binding.native})`,
    '',
    `Parameters: runs=${parameters.runs}, balanced AB/BA order, warmup=${parameters.warmupSec}s, duration=${parameters.durationSec}s, connections=${parameters.connections}, pipelining=${parameters.pipelining}, sample=${parameters.sampleMs}ms.`,
    '',
    `Default eligibility requires every case to have at least +${MIN_GAIN_PCT}% paired median throughput, no p99 regression above ${MAX_P99_REGRESSION_PCT}%, no RSS regression above ${MAX_RSS_REGRESSION_PCT}%, and zero errors.`,
    '',
    '| Case | Off rps | On rps | Paired Δ rps | Off p95 | On p95 | Off p99 | On p99 | Off ELU | On ELU | Off RSS MB | On RSS MB | Errors | Gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| ${row.case} | ${row.offRps} | ${row.onRps} | ${row.pairedRpsDelta} | ${row.offP95} | ${row.onP95} | ${row.offP99} | ${row.onP99} | ${row.offELU} | ${row.onELU} | ${row.offRssMB} | ${row.onRssMB} | ${row.errors} | ${row.gate} |`
    ),
    '',
    `Decision: **${decision}**.`,
    ''
  ].join('\n')

  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await fs.writeFile(path.join(OUT_DIR, 'report.md'), report)

  console.table(rows)
  console.log(`[response-batch] decision=${decision}`)
  console.log(`[response-batch] wrote ${path.join(OUT_DIR, 'summary.json')}`)
  console.log(`[response-batch] wrote ${path.join(OUT_DIR, 'report.md')}`)

  if (process.argv.includes('--check') && decision !== 'eligible-for-default') {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
