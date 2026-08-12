import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { appendStepSummary, fmt, mdTable, round } from '@swarmmachina/benchkit/reporting'
import { BENCHMARK_PROFILES_DIR, REPOSITORY_ROOT } from '../harness/runtime-paths.js'
import { finiteMedian, positiveEnvNumber, rowsForFramework } from '../harness/summary.js'
import { requireMetric, type BenchmarkSummary, type PackageManifest } from '../harness/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = REPOSITORY_ROOT
const CANDIDATE = 'core-swm-uws'
const REFERENCE = 'core-uwebsockets'
const FRAMEWORKS = `${CANDIDATE},${REFERENCE}`

const PARAMS = {
  runs: positiveEnvNumber('BINDING_BENCH_RUNS', 4),
  order: 'balanced',
  warmup: positiveEnvNumber('BINDING_BENCH_WARMUP', 2),
  duration: positiveEnvNumber('BINDING_BENCH_DURATION', 6),
  httpConnections: positiveEnvNumber('BINDING_BENCH_HTTP_CONNECTIONS', 100),
  httpPipelining: positiveEnvNumber('BINDING_BENCH_HTTP_PIPELINING', 10),
  wsConnections: positiveEnvNumber('BINDING_BENCH_WS_CONNECTIONS', 50),
  wsMessageBytes: positiveEnvNumber('BINDING_BENCH_WS_MESSAGE_BYTES', 64),
  sampleMs: positiveEnvNumber('BINDING_BENCH_SAMPLE_MS', 250)
}
const GUARDS = {
  maxThroughputRegressionPct: positiveEnvNumber('BINDING_BENCH_MAX_THROUGHPUT_REGRESSION_PCT', 5),
  maxLatencyRegressionPct: positiveEnvNumber('BINDING_BENCH_MAX_LATENCY_REGRESSION_PCT', 20),
  latencySlackMs: positiveEnvNumber('BINDING_BENCH_LATENCY_SLACK_MS', 0.25),
  maxRssRegressionPct: positiveEnvNumber('BINDING_BENCH_MAX_RSS_REGRESSION_PCT', 15),
  rssSlackMB: positiveEnvNumber('BINDING_BENCH_RSS_SLACK_MB', 5)
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

function packageField(pkg: PackageManifest, field: 'name' | 'version', source: string): string {
  const value = pkg[field]

  if (!value) {
    throw new Error(`${source}: package ${field} is missing`)
  }

  return value
}

/**
 * Read the versions that this process will actually load, and fail before a
 * long benchmark if node_modules is stale relative to package.json.
 * @returns {Promise<{candidate: string, reference: string}>}
 */
async function readBindingLabels() {
  const manifest = await readJson<PackageManifest>(path.join(ROOT, 'package.json'))
  const candidatePackage = await readJson<PackageManifest>(
    path.join(ROOT, 'node_modules', '@swarmmachina', 'swm-uws', 'package.json')
  )
  const referencePackage = await readJson<PackageManifest>(
    path.join(ROOT, 'node_modules', 'uwebsockets.js', 'package.json')
  )
  const requestedCandidate = manifest.dependencies?.['@swarmmachina/swm-uws']
  const requestedReference = manifest.devDependencies?.['uwebsockets.js']
  const requestedReferenceVersion = /#v?(\d+\.\d+\.\d+)$/.exec(requestedReference || '')?.[1]
  const candidateVersion = packageField(candidatePackage, 'version', '@swarmmachina/swm-uws')
  const referenceVersion = packageField(referencePackage, 'version', 'uWebSockets.js')

  if (requestedCandidate !== candidateVersion) {
    throw new Error(
      `Installed @swarmmachina/swm-uws@${candidateVersion} does not match package.json (${requestedCandidate})`
    )
  }

  if (requestedReferenceVersion !== referenceVersion) {
    throw new Error(`Installed uWebSockets.js@${referenceVersion} does not match package.json (${requestedReference})`)
  }

  return {
    candidate: `${packageField(candidatePackage, 'name', '@swarmmachina/swm-uws')}@${candidateVersion}`,
    reference: `${packageField(referencePackage, 'name', 'uWebSockets.js')}@${referenceVersion}`
  }
}

/**
 * @param {object} bench
 * @param {string} fw
 * @param {string} throughputKey
 * @returns {object}
 */
type TailKey = 'latencyP95Ms' | 'latencyP97_5Ms'
interface BindingAggregate {
  binding: string
  throughput: number
  latencyP95Ms: number
  latencyP97_5Ms: number
  latencyP99Ms: number
  errors: number
  eluPct: number | null
  rssMB: number | null
  heapMB: number | null
}

function aggregate(bench: BenchmarkSummary, fw: string, throughputKey: 'rps' | 'msgPerSec'): BindingAggregate {
  const medianRow = bench.median.find((row) => row.fw === fw)
  const rows = rowsForFramework(bench, fw)

  if (!medianRow || !rows.length) {
    throw new Error(`Missing ${fw} results for ${bench.test?.name || 'benchmark'}`)
  }

  return {
    binding: fw,
    throughput: requireMetric(medianRow, throughputKey, `${fw} median`),
    latencyP95Ms: requireMetric(medianRow, 'latP95Ms', `${fw} median`),
    latencyP97_5Ms: requireMetric(medianRow, 'latP97_5Ms', `${fw} median`),
    latencyP99Ms: requireMetric(medianRow, 'latP99Ms', `${fw} median`),
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    eluPct: finiteMedian(
      rows.map((row) => row.eluPct),
      3
    ),
    rssMB: finiteMedian(
      rows.map((row) => row.rssMB),
      3
    ),
    heapMB: finiteMedian(
      rows.map((row) => row.heapMB),
      3
    )
  }
}

/**
 * @param {number} candidate
 * @param {number} reference
 * @returns {number|null}
 */
function deltaPct(candidate: number | null, reference: number | null): number | null {
  return candidate !== null &&
    reference !== null &&
    Number.isFinite(candidate) &&
    Number.isFinite(reference) &&
    reference !== 0
    ? round(((candidate - reference) / reference) * 100)
    : null
}

function formatOptional(value: number | null, unit?: string): string {
  return value === null ? 'n/a' : fmt(value, unit)
}

/**
 * @param {string} suite
 * @param {object} candidate
 * @param {object} reference
 * @param {'latencyP95Ms'|'latencyP97_5Ms'} tailKey
 * @param {string} tailLabel
 * @returns {string[]}
 */
function guard(
  suite: string,
  candidate: BindingAggregate,
  reference: BindingAggregate,
  tailKey: TailKey,
  tailLabel: string
): string[] {
  const failures: string[] = []
  const minThroughput = reference.throughput * (1 - GUARDS.maxThroughputRegressionPct / 100)
  const maxTail = reference[tailKey] * (1 + GUARDS.maxLatencyRegressionPct / 100) + GUARDS.latencySlackMs
  const maxP99 = reference.latencyP99Ms * (1 + GUARDS.maxLatencyRegressionPct / 100) + GUARDS.latencySlackMs

  if (candidate.errors !== 0 || reference.errors !== 0) {
    failures.push(`${suite}: errors candidate=${candidate.errors}, reference=${reference.errors}`)
  }

  if (candidate.throughput < minThroughput) {
    failures.push(
      `${suite}: throughput ${fmt(candidate.throughput)} is below ${fmt(minThroughput)} ` +
        `(-${GUARDS.maxThroughputRegressionPct}% guard)`
    )
  }

  if (candidate[tailKey] > maxTail) {
    failures.push(`${suite}: ${tailLabel} ${fmt(candidate[tailKey], 'ms')} exceeds ${fmt(maxTail, 'ms')}`)
  }

  if (candidate.latencyP99Ms > maxP99) {
    failures.push(`${suite}: p99 ${fmt(candidate.latencyP99Ms, 'ms')} exceeds ${fmt(maxP99, 'ms')}`)
  }

  if (candidate.rssMB === null || reference.rssMB === null) {
    failures.push(`${suite}: RSS sample is missing`)
  } else {
    const maxRss = reference.rssMB * (1 + GUARDS.maxRssRegressionPct / 100) + GUARDS.rssSlackMB

    if (candidate.rssMB > maxRss) {
      failures.push(`${suite}: RSS ${fmt(candidate.rssMB, 'MB')} exceeds ${fmt(maxRss, 'MB')}`)
    }
  }

  return failures
}

/**
 * @param {string} suite
 * @param {string} throughputLabel
 * @param {object} candidate
 * @param {object} reference
 * @param {'latencyP95Ms'|'latencyP97_5Ms'} tailKey
 * @param {string} tailLabel
 * @returns {string}
 */
function renderSuite(
  suite: string,
  throughputLabel: string,
  candidate: BindingAggregate,
  reference: BindingAggregate,
  tailKey: TailKey,
  tailLabel: string
): string {
  const rows = [reference, candidate].map((row) => [
    row.binding,
    fmt(row.throughput),
    fmt(row[tailKey], 'ms'),
    fmt(row.latencyP99Ms, 'ms'),
    formatOptional(row.eluPct, '%'),
    formatOptional(row.rssMB, 'MB'),
    formatOptional(row.heapMB, 'MB'),
    row.errors
  ])
  const deltas = [
    ['throughput', formatOptional(deltaPct(candidate.throughput, reference.throughput), '%')],
    [tailLabel, formatOptional(deltaPct(candidate[tailKey], reference[tailKey]), '%')],
    ['p99', formatOptional(deltaPct(candidate.latencyP99Ms, reference.latencyP99Ms), '%')],
    ['RSS', formatOptional(deltaPct(candidate.rssMB, reference.rssMB), '%')]
  ]

  return [
    `## Native binding comparison — ${suite}`,
    '',
    mdTable(['binding', throughputLabel, tailLabel, 'p99', 'ELU', 'RSS', 'heap', 'errors'], rows),
    '',
    'Candidate delta vs uWebSockets.js:',
    '',
    mdTable(['metric', 'delta'], deltas),
    ''
  ].join('\n')
}

/**
 * @param {string} outDir
 * @returns {Promise<object>}
 */
async function runHttp(outDir: string): Promise<{ candidate: BindingAggregate; reference: BindingAggregate }> {
  const jsonOut = path.join(outDir, 'http-base-sync.json')

  await runChild([
    path.join(__dirname, '..', 'http', 'runner.js'),
    '--test',
    'base-sync',
    '--fw',
    FRAMEWORKS,
    '--runs',
    String(PARAMS.runs),
    '--warmup',
    String(PARAMS.warmup),
    '--duration',
    String(PARAMS.duration),
    '--connections',
    String(PARAMS.httpConnections),
    '--pipelining',
    String(PARAMS.httpPipelining),
    '--order',
    PARAMS.order,
    '--sample-ms',
    String(PARAMS.sampleMs),
    '--v8prof',
    'false',
    '--json-out',
    jsonOut
  ])

  const bench = await readJson<BenchmarkSummary>(jsonOut)

  return {
    candidate: aggregate(bench, CANDIDATE, 'rps'),
    reference: aggregate(bench, REFERENCE, 'rps')
  }
}

/**
 * @param {string} outDir
 * @returns {Promise<object>}
 */
async function runWs(outDir: string): Promise<{ candidate: BindingAggregate; reference: BindingAggregate }> {
  const jsonOut = path.join(outDir, 'ws-echo.json')

  await runChild([
    path.join(__dirname, '..', 'ws', 'runner.js'),
    '--fw',
    FRAMEWORKS,
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
    String(PARAMS.wsMessageBytes),
    '--order',
    PARAMS.order,
    '--v8prof',
    'false',
    '--json-out',
    jsonOut
  ])

  const bench = await readJson<BenchmarkSummary>(jsonOut)

  return {
    candidate: aggregate(bench, CANDIDATE, 'msgPerSec'),
    reference: aggregate(bench, REFERENCE, 'msgPerSec')
  }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const outDir = path.join(BENCHMARK_PROFILES_DIR, 'binding-compare')

  if (PARAMS.runs % 2 !== 0) {
    throw new Error('BINDING_BENCH_RUNS must be even for balanced AB/BA ordering')
  }

  const bindings = await readBindingLabels()

  await fs.mkdir(outDir, { recursive: true })

  const http = await runHttp(outDir)
  const ws = await runWs(outDir)
  const failures = [
    ...guard('http/base-sync', http.candidate, http.reference, 'latencyP97_5Ms', 'p97.5'),
    ...guard('ws/echo', ws.candidate, ws.reference, 'latencyP95Ms', 'p95')
  ]
  const status = failures.length ? 'fail' : 'pass'
  const summary = {
    schemaVersion: 'binding-compare/v1',
    createdAt: new Date().toISOString(),
    node: process.version,
    candidate: bindings.candidate,
    reference: bindings.reference,
    parameters: PARAMS,
    guards: GUARDS,
    status,
    failures,
    results: { http, ws }
  }

  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  const report = [
    `# Binding migration gate: ${status.toUpperCase()}`,
    '',
    `Bindings: candidate=${bindings.candidate}, reference=${bindings.reference}, Node=${process.version}.`,
    '',
    `Parameters: runs=${PARAMS.runs}, warmup=${PARAMS.warmup}s, duration=${PARAMS.duration}s, ` +
      `HTTP connections=${PARAMS.httpConnections}, pipelining=${PARAMS.httpPipelining}, ` +
      `WS connections=${PARAMS.wsConnections}, message=${PARAMS.wsMessageBytes}B, sample=${PARAMS.sampleMs}ms.`,
    '',
    renderSuite('http / base-sync', 'req/s', http.candidate, http.reference, 'latencyP97_5Ms', 'p97.5'),
    renderSuite('ws / echo', 'msg/s', ws.candidate, ws.reference, 'latencyP95Ms', 'p95'),
    failures.length ? `Failures:\n\n${failures.map((failure) => `- ${failure}`).join('\n')}` : 'All guards passed.'
  ].join('\n')

  await appendStepSummary(report)

  if (failures.length) {
    throw new Error(`Binding migration gate failed with ${failures.length} regression(s)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
