import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { median } from '@swarmmachina/benchkit/statistics'
import { BENCHMARK_PROFILES_DIR } from './runtime-paths.js'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(BENCHMARK_PROFILES_DIR, 'body-prefetch')
const CASES = ['prefetch-get', 'prefetch-body-used', 'prefetch-body-unused', 'prefetch-body-large']

interface BenchRow {
  fw: string
  rps?: number
  latP95Ms?: number
  latP99Ms?: number
  errors?: number
  eluPct?: number
  eldP99ms?: number
  rssMB?: number
  heapMB?: number
  externalMB?: number
  arrayBuffersMB?: number
}

interface BenchData {
  median: BenchRow[]
  runs: Array<{ rows: BenchRow[] }>
}

interface BenchmarkSummary {
  rps: number | null
  p95Ms: number | null
  p99Ms: number | null
  errors: number
  eluPct: number | null
  eventLoopDelayP99Ms: number | null
  rssMB: number | null
  heapMB: number | null
  externalMB: number | null
  arrayBuffersMB: number | null
}

interface ComparisonResult {
  lazy: BenchmarkSummary
  prefetch: BenchmarkSummary
  delta: { rpsPct: number | null; p95Pct: number | null; p99Pct: number | null; rssPct: number | null }
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])

  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  return finite.length ? Number(median(finite).toFixed(2)) : null
}

/**
 * @param {object} bench
 * @param {string} framework
 * @returns {object}
 */
function summarize(bench: BenchData, framework: string): BenchmarkSummary {
  const load = bench.median.find((row) => row.fw === framework)
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === framework))

  return {
    rps: load?.rps ?? null,
    p95Ms: load?.latP95Ms ?? null,
    p99Ms: load?.latP99Ms ?? null,
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    eluPct: medianNullable(rows.map((row) => row.eluPct)),
    eventLoopDelayP99Ms: medianNullable(rows.map((row) => row.eldP99ms)),
    rssMB: medianNullable(rows.map((row) => row.rssMB)),
    heapMB: medianNullable(rows.map((row) => row.heapMB)),
    externalMB: medianNullable(rows.map((row) => row.externalMB)),
    arrayBuffersMB: medianNullable(rows.map((row) => row.arrayBuffersMB))
  }
}

/**
 * @param {number|null} value
 * @param {number|null} baseline
 * @returns {number|null}
 */
function percentDelta(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null || !Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return null
  }

  return Number((((value - baseline) / baseline) * 100).toFixed(2))
}

/**
 * Run the fixed lazy/prefetch comparison matrix and write JSON/Markdown reports.
 */
async function main() {
  const parameters = {
    runs: numEnv('BODY_PREFETCH_RUNS', 3),
    warmupSec: numEnv('BODY_PREFETCH_WARMUP', 2),
    durationSec: numEnv('BODY_PREFETCH_DURATION', 6),
    connections: numEnv('BODY_PREFETCH_CONNECTIONS', 100),
    getPipelining: numEnv('BODY_PREFETCH_GET_PIPELINING', 10),
    bodyPipelining: numEnv('BODY_PREFETCH_BODY_PIPELINING', 1),
    sampleMs: numEnv('BODY_PREFETCH_SAMPLE_MS', 250)
  }

  await fs.mkdir(OUT_DIR, { recursive: true })

  const results: Record<string, ComparisonResult> = {}

  for (const name of CASES) {
    const jsonOut = path.join(OUT_DIR, `${name}.json`)
    const isGet = name === 'prefetch-get'
    const connections = name === 'prefetch-body-large' ? Math.min(parameters.connections, 25) : parameters.connections

    await runChild([
      path.join(BENCH_DIR, 'bench.js'),
      '--test',
      name,
      '--fw',
      'core-lazy,core-prefetch',
      '--runs',
      String(parameters.runs),
      '--warmup',
      String(parameters.warmupSec),
      '--duration',
      String(parameters.durationSec),
      '--connections',
      String(connections),
      '--pipelining',
      String(isGet ? parameters.getPipelining : parameters.bodyPipelining),
      '--sample-ms',
      String(parameters.sampleMs),
      '--order',
      'balanced',
      '--json-out',
      jsonOut
    ])

    const bench = JSON.parse(await fs.readFile(jsonOut, 'utf8')) as BenchData
    const lazy = summarize(bench, 'core-lazy')
    const prefetch = summarize(bench, 'core-prefetch')

    results[name] = {
      lazy,
      prefetch,
      delta: {
        rpsPct: percentDelta(prefetch.rps, lazy.rps),
        p95Pct: percentDelta(prefetch.p95Ms, lazy.p95Ms),
        p99Pct: percentDelta(prefetch.p99Ms, lazy.p99Ms),
        rssPct: percentDelta(prefetch.rssMB, lazy.rssMB)
      }
    }
  }

  const summary = {
    createdAt: new Date().toISOString(),
    node: process.version,
    parameters,
    results
  }
  const table = Object.entries(results).map(([name, result]) => ({
    case: name,
    lazyRps: result.lazy.rps,
    prefetchRps: result.prefetch.rps,
    rpsDelta: result.delta.rpsPct == null ? 'n/a' : `${result.delta.rpsPct}%`,
    lazyP95: result.lazy.p95Ms,
    prefetchP95: result.prefetch.p95Ms,
    lazyP99: result.lazy.p99Ms,
    prefetchP99: result.prefetch.p99Ms,
    lazyELU: result.lazy.eluPct,
    prefetchELU: result.prefetch.eluPct,
    lazyRssMB: result.lazy.rssMB,
    prefetchRssMB: result.prefetch.rssMB,
    errors: result.lazy.errors + result.prefetch.errors
  }))
  const worstRps = table.reduce<{ case: string; value: number } | null>((worst, row) => {
    const value = Number.parseFloat(row.rpsDelta)

    if (!Number.isFinite(value)) {
      return worst
    }

    return !worst || value < worst.value ? { case: row.case, value } : worst
  }, null)
  const worstP99 = Object.entries(results).reduce<{ case: string; value: number } | null>((worst, [name, result]) => {
    const value = result.delta.p99Pct

    if (value === null || !Number.isFinite(value)) {
      return worst
    }

    return !worst || value > worst.value ? { case: name, value } : worst
  }, null)
  const totalErrors = table.reduce((sum, row) => sum + row.errors, 0)
  const report = [
    '# Body prefetch benchmark',
    '',
    `Generated: ${summary.createdAt}`,
    '',
    `Parameters: runs=${parameters.runs}, warmup=${parameters.warmupSec}s, duration=${parameters.durationSec}s, connections=${parameters.connections}, GET pipelining=${parameters.getPipelining}, body pipelining=${parameters.bodyPipelining}, sample=${parameters.sampleMs}ms.`,
    '',
    '| Case | Lazy rps | Prefetch rps | Δ rps | Lazy p95 | Prefetch p95 | Lazy p99 | Prefetch p99 | Lazy ELU | Prefetch ELU | Lazy RSS MB | Prefetch RSS MB | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...table.map(
      (row) =>
        `| ${row.case} | ${row.lazyRps} | ${row.prefetchRps} | ${row.rpsDelta} | ${row.lazyP95} | ${row.prefetchP95} | ${row.lazyP99} | ${row.prefetchP99} | ${row.lazyELU} | ${row.prefetchELU} | ${row.lazyRssMB} | ${row.prefetchRssMB} | ${row.errors} |`
    ),
    '',
    '## Conclusion',
    '',
    `Worst prefetch throughput delta in this run: ${worstRps?.value ?? 'n/a'}% (${worstRps?.case ?? 'n/a'}).`,
    `Worst prefetch p99 delta in this run: ${worstP99?.value ?? 'n/a'}% (${worstP99?.case ?? 'n/a'}).`,
    `Total load-generator errors: ${totalErrors}. Compare only runs made with the same fixed parameters and an otherwise idle host.`,
    ''
  ].join('\n')

  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await fs.writeFile(path.join(OUT_DIR, 'report.md'), report)

  console.table(table)
  console.log(`[body-prefetch] wrote ${path.join(OUT_DIR, 'summary.json')}`)
  console.log(`[body-prefetch] wrote ${path.join(OUT_DIR, 'report.md')}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
