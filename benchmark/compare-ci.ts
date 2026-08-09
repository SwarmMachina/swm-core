import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { appendStepSummary, fmt, mdTable } from '@swarmmachina/benchkit/reporting'
import { median } from '@swarmmachina/benchkit/statistics'
import { BENCHMARK_PROFILES_DIR } from './runtime-paths.js'
import { requireMetric, type BenchmarkRow, type BenchmarkSummary } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTTP_TESTS = ['base-sync', 'base-async', 'headers', 'headers-prepared', 'post-base']
const HTTP_FRAMEWORKS = 'core,core-uwebsockets,hyperexpress,micro,fastify,express'
const HTTP_ORDER = ['core', 'core-uwebsockets', 'hyperexpress', 'micro', 'fastify', 'express']
const WS_FRAMEWORKS = 'core,core-uwebsockets,hyperexpress,ws'
const WS_ORDER = ['core', 'core-uwebsockets', 'hyperexpress', 'ws']

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])

  return Number.isFinite(v) && v > 0 ? v : fallback
}

const PARAMS = {
  runs: numEnv('COMPARE_RUNS', 2),
  warmup: numEnv('COMPARE_WARMUP', 2),
  duration: numEnv('COMPARE_DURATION', 6),
  httpConnections: numEnv('COMPARE_HTTP_CONNECTIONS', 100),
  wsConnections: numEnv('COMPARE_WS_CONNECTIONS', 50),
  sampleMs: numEnv('COMPARE_SAMPLE_MS', 250),
  msgSize: numEnv('COMPARE_MSG_SIZE', 64)
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  return nums.length ? Number(median(nums).toFixed(2)) : null
}

/**
 * @param {object} bench
 * @param {string} fw
 * @returns {object|null}
 */
interface FrameworkAggregate {
  fw: string
  median: BenchmarkRow
  rssMB: number | null
  heapMB: number | null
  eluPct: number | null
  errors: number
}

function aggregateFw(bench: BenchmarkSummary, fw: string): FrameworkAggregate | null {
  const medianRow = bench.median.find((row) => row.fw === fw)

  if (!medianRow) {
    return null
  }

  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === fw))

  return {
    fw,
    median: medianRow,
    rssMB: medianNullable(rows.map((r) => r.rssMB)),
    heapMB: medianNullable(rows.map((r) => r.heapMB)),
    eluPct: medianNullable(rows.map((r) => r.eluPct)),
    errors: rows.reduce((sum, r) => sum + (r.errors || 0), 0)
  }
}

function formatOptional(value: number | null, unit?: string): string {
  return value === null ? 'n/a' : fmt(value, unit)
}

function renderComparison(
  title: string,
  metricHeader: string,
  metricKey: 'rps' | 'msgPerSec',
  order: string[],
  bench: BenchmarkSummary
): string {
  const rows = order
    .map((fw) => aggregateFw(bench, fw))
    .filter((aggregate): aggregate is FrameworkAggregate => aggregate !== null)
    .map((a) => [
      a.fw,
      fmt(requireMetric(a.median, metricKey, `${a.fw} median`)),
      fmt(requireMetric(a.median, 'latAvgMs', `${a.fw} median`), 'ms'),
      fmt(requireMetric(a.median, 'latP99Ms', `${a.fw} median`), 'ms'),
      formatOptional(a.rssMB, 'MB'),
      formatOptional(a.heapMB, 'MB'),
      formatOptional(a.eluPct, '%'),
      a.errors
    ])

  return [
    `## Framework comparison — ${title}`,
    '',
    mdTable(['fw', metricHeader, 'latAvg', 'p99', 'rss', 'heap', 'ELU', 'errors'], rows),
    ''
  ].join('\n')
}

const SUITES = ['http', 'ws', 'all']

/**
 * @param {string[]} argv
 * @returns {string}
 */
function parseSuite(argv: string[]): (typeof SUITES)[number] {
  const i = argv.indexOf('--suite')

  if (i === -1) {
    return 'all'
  }

  const v = argv[i + 1]

  if (v === undefined || !SUITES.includes(v as (typeof SUITES)[number])) {
    throw new Error(`Unknown --suite=${v} (expected: ${SUITES.join(', ')})`)
  }

  return v as (typeof SUITES)[number]
}

/**
 * @param {string} outDir
 * @returns {Promise<string[]>}
 */
async function runHttp(outDir: string): Promise<string[]> {
  const sections: string[] = []

  for (const test of HTTP_TESTS) {
    const jsonOut = path.join(outDir, `http-${test}.json`)

    try {
      await runChild([
        path.join(__dirname, 'bench.js'),
        '--test',
        test,
        '--fw',
        HTTP_FRAMEWORKS,
        '--runs',
        String(PARAMS.runs),
        '--warmup',
        String(PARAMS.warmup),
        '--duration',
        String(PARAMS.duration),
        '--connections',
        String(PARAMS.httpConnections),
        '--sample-ms',
        String(PARAMS.sampleMs),
        '--v8prof',
        'false',
        '--json-out',
        jsonOut
      ])

      const bench = await readJson<BenchmarkSummary>(jsonOut)

      sections.push(renderComparison(`http / ${test}`, 'rps', 'rps', HTTP_ORDER, bench))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      sections.push(`## Framework comparison — http / ${test}\n\n⚠️ run failed: ${message}\n`)
      console.error(`[compare-ci] http/${test} failed:`, message)
    }
  }

  return sections
}

/**
 * @param {string} outDir
 * @returns {Promise<string[]>}
 */
async function runWs(outDir: string): Promise<string[]> {
  const sections: string[] = []
  const wsJsonOut = path.join(outDir, 'ws-echo.json')

  try {
    await runChild([
      path.join(__dirname, 'ws-bench.js'),
      '--fw',
      WS_FRAMEWORKS,
      '--runs',
      String(PARAMS.runs),
      '--warmup',
      String(PARAMS.warmup),
      '--duration',
      String(PARAMS.duration),
      '--connections',
      String(PARAMS.wsConnections),
      '--sample-ms',
      String(PARAMS.sampleMs),
      '--msg-size',
      String(PARAMS.msgSize),
      '--v8prof',
      'false',
      '--json-out',
      wsJsonOut
    ])

    const bench = await readJson<BenchmarkSummary>(wsJsonOut)

    sections.push(renderComparison('ws / echo', 'msg/s', 'msgPerSec', WS_ORDER, bench))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    sections.push(`## Framework comparison — ws / echo\n\n⚠️ run failed: ${message}\n`)
    console.error('[compare-ci] ws/echo failed:', message)
  }

  return sections
}

/**
 *
 */
async function main() {
  const suite = parseSuite(process.argv.slice(2))
  const outDir = path.join(BENCHMARK_PROFILES_DIR, 'compare-ci')

  await fs.mkdir(outDir, { recursive: true })

  const sections = []

  if (suite === 'http' || suite === 'all') {
    sections.push(...(await runHttp(outDir)))
  }

  if (suite === 'ws' || suite === 'all') {
    sections.push(...(await runWs(outDir)))
  }

  await appendStepSummary(sections.join('\n'))
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
