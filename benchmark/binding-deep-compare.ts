import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { appendStepSummary, fmt, mdTable, round } from '@swarmmachina/benchkit/reporting'
import { median } from '@swarmmachina/benchkit/statistics'
import { BENCHMARK_PROFILES_DIR, REPOSITORY_ROOT } from './runtime-paths.js'
import { requireMetric, type BenchmarkRow, type BenchmarkSummary, type PackageManifest } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = REPOSITORY_ROOT

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])

  return Number.isFinite(value) && value > 0 ? value : fallback
}

const PARAMS = {
  runs: numEnv('DEEP_BINDING_RUNS', 6),
  warmup: numEnv('DEEP_BINDING_WARMUP', 2),
  duration: numEnv('DEEP_BINDING_DURATION', 5),
  sampleMs: numEnv('DEEP_BINDING_SAMPLE_MS', 250)
}
const CORE = { candidate: 'core-swm-uws', reference: 'core-uwebsockets' }
const RAW = { candidate: 'raw-swm-uws', reference: 'raw-uwebsockets' }

interface BindingPair {
  candidate: string
  reference: string
}

interface HttpScenario {
  name: string
  kind: 'http'
  test: string
  pair: BindingPair
  connections: number
  pipelining: number
}

interface WsScenario {
  name: string
  kind: 'ws'
  pair: BindingPair
  connections: number
  mode: 'closed' | 'open'
  depth: number
}

type Scenario = HttpScenario | WsScenario

const SCENARIOS: Scenario[] = [
  { name: 'http-core-c10-p1', kind: 'http', test: 'base-sync', pair: CORE, connections: 10, pipelining: 1 },
  { name: 'http-core-c100-p1', kind: 'http', test: 'base-sync', pair: CORE, connections: 100, pipelining: 1 },
  { name: 'http-core-c100-p10', kind: 'http', test: 'base-sync', pair: CORE, connections: 100, pipelining: 10 },
  { name: 'http-raw-c100-p1', kind: 'http', test: 'base-sync', pair: RAW, connections: 100, pipelining: 1 },
  { name: 'http-raw-c100-p10', kind: 'http', test: 'base-sync', pair: RAW, connections: 100, pipelining: 10 },
  { name: 'http-headers-c100-p10', kind: 'http', test: 'headers', pair: CORE, connections: 100, pipelining: 10 },
  { name: 'http-post-c100-p1', kind: 'http', test: 'post-base', pair: CORE, connections: 100, pipelining: 1 },
  { name: 'ws-core-closed-c50', kind: 'ws', pair: CORE, connections: 50, mode: 'closed', depth: 1 },
  { name: 'ws-raw-closed-c50', kind: 'ws', pair: RAW, connections: 50, mode: 'closed', depth: 1 },
  { name: 'ws-core-open-c50-d16', kind: 'ws', pair: CORE, connections: 50, mode: 'open', depth: 16 },
  { name: 'ws-raw-open-c50-d16', kind: 'ws', pair: RAW, connections: 50, mode: 'open', depth: 16 }
]

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/**
 * @param {number[]} values
 * @param {number} q
 * @returns {number|null}
 */
function quantile(values: number[], q: number): number | null {
  if (!values.length) {
    return null
  }

  const sorted = values.slice().sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)

  if (lower === upper) {
    return sorted[lower]!
  }

  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

/**
 * @param {number[]} values
 * @returns {{median: number|null, q1: number|null, q3: number|null, values: number[]}}
 */
interface Distribution {
  median: number | null
  q1: number | null
  q3: number | null
  values: number[]
}

function distribution(values: number[]): Distribution {
  const finite = values.filter(Number.isFinite)
  const q1 = quantile(finite, 0.25)
  const q3 = quantile(finite, 0.75)

  return {
    median: finite.length ? round(median(finite)) : null,
    q1: q1 === null ? null : round(q1),
    q3: q3 === null ? null : round(q3),
    values: finite.map(round)
  }
}

function formatOptional(value: number | null, unit?: string): string {
  return value === null ? 'n/a' : fmt(value, unit)
}

/**
 * @param {number} candidate
 * @param {number} reference
 * @returns {number|null}
 */
function deltaPct(candidate: number, reference: number): number | null {
  return Number.isFinite(candidate) && Number.isFinite(reference) && reference !== 0
    ? ((candidate - reference) / reference) * 100
    : null
}

/**
 * @param {object} bench
 * @param {object} scenario
 * @returns {object}
 */
interface BindingSummary {
  throughput: number
  tailMs: number
  p99Ms: number
  eluPct: number
  rssMB: number
  heapMB: number
  errors: number
}

interface PairedRun {
  run: number
  throughputDeltaPct: number | null
  tailDeltaPct: number | null
  p99DeltaPct: number | null
}

interface DeepAggregate {
  name: string
  kind: Scenario['kind']
  parameters: Scenario
  candidate: BindingSummary
  reference: BindingSummary
  paired: {
    throughputDeltaPct: Distribution
    tailDeltaPct: Distribution
    p99DeltaPct: Distribution
    runs: PairedRun[]
  }
}

function aggregate(bench: BenchmarkSummary, scenario: Scenario): DeepAggregate {
  const throughputKey = scenario.kind === 'http' ? 'rps' : 'msgPerSec'
  const tailKey = scenario.kind === 'http' ? 'latP97_5Ms' : 'latP95Ms'
  const paired: PairedRun[] = []
  const rowsByBinding: { candidate: BenchmarkRow[]; reference: BenchmarkRow[] } = { candidate: [], reference: [] }

  for (const run of bench.runs) {
    const candidate = run.rows.find((row) => row.fw === scenario.pair.candidate)
    const reference = run.rows.find((row) => row.fw === scenario.pair.reference)

    if (!candidate || !reference) {
      throw new Error(`${scenario.name}: missing paired rows in run ${run.run}`)
    }

    rowsByBinding.candidate.push(candidate)
    rowsByBinding.reference.push(reference)
    paired.push({
      run: run.run,
      throughputDeltaPct: deltaPct(
        requireMetric(candidate, throughputKey, `${scenario.name} candidate run ${run.run}`),
        requireMetric(reference, throughputKey, `${scenario.name} reference run ${run.run}`)
      ),
      tailDeltaPct: deltaPct(
        requireMetric(candidate, tailKey, `${scenario.name} candidate run ${run.run}`),
        requireMetric(reference, tailKey, `${scenario.name} reference run ${run.run}`)
      ),
      p99DeltaPct: deltaPct(
        requireMetric(candidate, 'latP99Ms', `${scenario.name} candidate run ${run.run}`),
        requireMetric(reference, 'latP99Ms', `${scenario.name} reference run ${run.run}`)
      )
    })
  }

  const summarizeBinding = (rows: BenchmarkRow[]): BindingSummary => ({
    throughput: median(rows.map((row) => requireMetric(row, throughputKey, scenario.name))),
    tailMs: median(rows.map((row) => requireMetric(row, tailKey, scenario.name))),
    p99Ms: median(rows.map((row) => requireMetric(row, 'latP99Ms', scenario.name))),
    eluPct: median(rows.map((row) => requireMetric(row, 'eluPct', scenario.name))),
    rssMB: median(rows.map((row) => requireMetric(row, 'rssMB', scenario.name))),
    heapMB: median(rows.map((row) => requireMetric(row, 'heapMB', scenario.name))),
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0)
  })

  return {
    name: scenario.name,
    kind: scenario.kind,
    parameters: scenario,
    candidate: summarizeBinding(rowsByBinding.candidate),
    reference: summarizeBinding(rowsByBinding.reference),
    paired: {
      throughputDeltaPct: distribution(
        paired.flatMap((row) => (row.throughputDeltaPct === null ? [] : [row.throughputDeltaPct]))
      ),
      tailDeltaPct: distribution(paired.flatMap((row) => (row.tailDeltaPct === null ? [] : [row.tailDeltaPct]))),
      p99DeltaPct: distribution(paired.flatMap((row) => (row.p99DeltaPct === null ? [] : [row.p99DeltaPct]))),
      runs: paired
    }
  }
}

/**
 * @param {object} scenario
 * @param {string} jsonOut
 * @returns {Promise<void>}
 */
async function runScenario(scenario: Scenario, jsonOut: string): Promise<void> {
  const frameworks = `${scenario.pair.candidate},${scenario.pair.reference}`

  if (scenario.kind === 'http') {
    await runChild([
      path.join(__dirname, 'bench.js'),
      '--test',
      scenario.test,
      '--fw',
      frameworks,
      '--runs',
      String(PARAMS.runs),
      '--warmup',
      String(PARAMS.warmup),
      '--duration',
      String(PARAMS.duration),
      '--connections',
      String(scenario.connections),
      '--pipelining',
      String(scenario.pipelining),
      '--order',
      'balanced',
      '--sample-ms',
      String(PARAMS.sampleMs),
      '--v8prof',
      'false',
      '--json-out',
      jsonOut
    ])

    return
  }

  await runChild([
    path.join(__dirname, 'ws-bench.js'),
    '--fw',
    frameworks,
    '--runs',
    String(PARAMS.runs),
    '--warmup',
    String(PARAMS.warmup),
    '--duration',
    String(PARAMS.duration),
    '--connections',
    String(scenario.connections),
    '--msg-size',
    '64',
    '--mode',
    scenario.mode,
    '--depth',
    String(scenario.depth),
    '--order',
    'balanced',
    '--sample-ms',
    String(PARAMS.sampleMs),
    '--v8prof',
    'false',
    '--json-out',
    jsonOut
  ])
}

/**
 * @param {object} result
 * @returns {string[]}
 */
function reportRow(result: DeepAggregate): Array<string | number> {
  const tail = result.kind === 'http' ? 'p97.5' : 'p95'
  const throughput = result.kind === 'http' ? 'req/s' : 'msg/s'
  const pairedThroughput = result.paired.throughputDeltaPct
  const pairedTail = result.paired.tailDeltaPct

  return [
    result.name,
    throughput,
    fmt(result.candidate.throughput),
    fmt(result.reference.throughput),
    `${formatOptional(pairedThroughput.median, '%')} [${formatOptional(pairedThroughput.q1, '%')}, ${formatOptional(pairedThroughput.q3, '%')}]`,
    `${tail} ${fmt(result.candidate.tailMs, 'ms')} / ${fmt(result.reference.tailMs, 'ms')}`,
    `${formatOptional(pairedTail.median, '%')} [${formatOptional(pairedTail.q1, '%')}, ${formatOptional(pairedTail.q3, '%')}]`,
    `${fmt(result.candidate.p99Ms, 'ms')} / ${fmt(result.reference.p99Ms, 'ms')}`,
    `${fmt(result.candidate.eluPct, '%')} / ${fmt(result.reference.eluPct, '%')}`,
    `${fmt(result.candidate.rssMB, 'MB')} / ${fmt(result.reference.rssMB, 'MB')}`,
    result.candidate.errors + result.reference.errors
  ]
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  if (PARAMS.runs % 2 !== 0) {
    throw new Error('DEEP_BINDING_RUNS must be even for balanced AB/BA ordering')
  }

  const outDir = path.join(BENCHMARK_PROFILES_DIR, 'binding-deep')
  const candidatePackage = await readJson<PackageManifest>(
    path.join(ROOT, 'node_modules', '@swarmmachina', 'swm-uws', 'package.json')
  )
  const referencePackage = await readJson<PackageManifest>(
    path.join(ROOT, 'node_modules', 'uwebsockets.js', 'package.json')
  )
  const systemBefore = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model || 'unknown',
    logicalCpus: os.cpus().length,
    loadAvg: os.loadavg()
  }
  const results: DeepAggregate[] = []

  await fs.mkdir(outDir, { recursive: true })

  for (const scenario of SCENARIOS) {
    console.log(`\n[deep-binding] scenario ${scenario.name}`)
    const jsonOut = path.join(outDir, `${scenario.name}.json`)

    await runScenario(scenario, jsonOut)
    results.push(aggregate(await readJson<BenchmarkSummary>(jsonOut), scenario))
  }

  const summary = {
    schemaVersion: 'binding-deep-compare/v1',
    createdAt: new Date().toISOString(),
    bindings: {
      candidate: `${candidatePackage.name ?? '@swarmmachina/swm-uws'}@${candidatePackage.version ?? 'unknown'}`,
      reference: `${referencePackage.name ?? 'uWebSockets.js'}@${referencePackage.version ?? 'unknown'}`
    },
    parameters: PARAMS,
    systemBefore,
    systemAfter: { loadAvg: os.loadavg() },
    results
  }
  const report = [
    '# Deep native binding comparison',
    '',
    `Bindings: ${summary.bindings.candidate} vs ${summary.bindings.reference}.`,
    '',
    `Parameters: runs=${PARAMS.runs} (balanced AB/BA), warmup=${PARAMS.warmup}s, ` +
      `duration=${PARAMS.duration}s, sample=${PARAMS.sampleMs}ms, payload=64B for WS.`,
    '',
    `Host: ${systemBefore.cpu}, ${systemBefore.logicalCpus} logical CPUs, Node=${systemBefore.node}, ` +
      `initial load=${systemBefore.loadAvg.map((value) => value.toFixed(2)).join('/')}.`,
    '',
    mdTable(
      [
        'scenario',
        'unit',
        'candidate',
        'uWS',
        'paired throughput Δ median [IQR]',
        'tail candidate / uWS',
        'paired tail Δ median [IQR]',
        'p99 candidate / uWS',
        'ELU candidate / uWS',
        'RSS candidate / uWS',
        'errors'
      ],
      results.map(reportRow)
    ),
    '',
    'Positive throughput delta favors the candidate; negative latency delta favors the candidate.'
  ].join('\n')

  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await fs.writeFile(path.join(outDir, 'report.md'), `${report}\n`)
  await appendStepSummary(report)
  console.log(report)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
