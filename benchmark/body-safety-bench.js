import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import median from './helpers/median.js'
import runChild from './helpers/run-child.js'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(BENCH_DIR, 'profiles', 'body-safety')
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

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name, fallback) {
  const value = Number(process.env[name])

  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values) {
  const finite = values.filter(Number.isFinite)

  return finite.length ? Number(median(finite).toFixed(2)) : null
}

/**
 * @param {object} bench
 * @param {string} framework
 * @returns {object}
 */
function summarize(bench, framework) {
  const load = bench.median.find((row) => row.fw === framework)
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === framework))

  return {
    rps: load?.rps ?? null,
    p95Ms: load?.latP95Ms ?? null,
    p99Ms: load?.latP99Ms ?? null,
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    eluPct: medianNullable(rows.map((row) => row.eluPct)),
    rssMB: medianNullable(rows.map((row) => row.rssMB))
  }
}

/**
 * @param {number|null} value
 * @param {number|null} baseline
 * @returns {number|null}
 */
function percentDelta(value, baseline) {
  if (!(Number.isFinite(value) && Number.isFinite(baseline) && baseline !== 0)) {
    return null
  }

  return Number((((value - baseline) / baseline) * 100).toFixed(2))
}

/**
 * Run fixed enabled/disabled comparisons for both HTTP safety controls.
 */
async function main() {
  const parameters = {
    runs: numEnv('BODY_SAFETY_RUNS', 3),
    warmupSec: numEnv('BODY_SAFETY_WARMUP', 2),
    durationSec: numEnv('BODY_SAFETY_DURATION', 6),
    connections: numEnv('BODY_SAFETY_CONNECTIONS', 100),
    sampleMs: numEnv('BODY_SAFETY_SAMPLE_MS', 250)
  }

  await fs.mkdir(OUT_DIR, { recursive: true })

  const results = {}

  for (const comparison of COMPARISONS) {
    const jsonOut = path.join(OUT_DIR, `${comparison.name}.json`)

    await runChild([
      path.join(BENCH_DIR, 'bench.js'),
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

    const bench = JSON.parse(await fs.readFile(jsonOut, 'utf8'))
    const baseline = summarize(bench, comparison.baseline)
    const enabled = summarize(bench, comparison.enabled)

    results[comparison.name] = {
      test: comparison.test,
      baseline,
      enabled,
      delta: {
        rpsPct: percentDelta(enabled.rps, baseline.rps),
        p99Pct: percentDelta(enabled.p99Ms, baseline.p99Ms),
        rssPct: percentDelta(enabled.rssMB, baseline.rssMB)
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
