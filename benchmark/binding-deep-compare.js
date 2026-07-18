import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import median from './helpers/median.js'
import runChild from './helpers/run-child.js'
import { appendStepSummary, fmt, mdTable, round } from './helpers/step-summary.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name, fallback) {
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
const SCENARIOS = [
  { name: 'http-core-c10-p1', kind: 'http', test: 'base', pair: CORE, connections: 10, pipelining: 1 },
  { name: 'http-core-c100-p1', kind: 'http', test: 'base', pair: CORE, connections: 100, pipelining: 1 },
  { name: 'http-core-c100-p10', kind: 'http', test: 'base', pair: CORE, connections: 100, pipelining: 10 },
  { name: 'http-raw-c100-p1', kind: 'http', test: 'base', pair: RAW, connections: 100, pipelining: 1 },
  { name: 'http-raw-c100-p10', kind: 'http', test: 'base', pair: RAW, connections: 100, pipelining: 10 },
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
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * @param {number[]} values
 * @param {number} q
 * @returns {number|null}
 */
function quantile(values, q) {
  if (!values.length) {
    return null
  }

  const sorted = values.slice().sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)

  if (lower === upper) {
    return sorted[lower]
  }

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

/**
 * @param {number[]} values
 * @returns {{median: number|null, q1: number|null, q3: number|null, values: number[]}}
 */
function distribution(values) {
  const finite = values.filter(Number.isFinite)

  return {
    median: finite.length ? round(median(finite)) : null,
    q1: finite.length ? round(quantile(finite, 0.25)) : null,
    q3: finite.length ? round(quantile(finite, 0.75)) : null,
    values: finite.map(round)
  }
}

/**
 * @param {number} candidate
 * @param {number} reference
 * @returns {number|null}
 */
function deltaPct(candidate, reference) {
  return Number.isFinite(candidate) && Number.isFinite(reference) && reference !== 0
    ? ((candidate - reference) / reference) * 100
    : null
}

/**
 * @param {object} bench
 * @param {object} scenario
 * @returns {object}
 */
function aggregate(bench, scenario) {
  const throughputKey = scenario.kind === 'http' ? 'rps' : 'msgPerSec'
  const tailKey = scenario.kind === 'http' ? 'latP97_5Ms' : 'latP95Ms'
  const paired = []
  const rowsByBinding = { candidate: [], reference: [] }

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
      throughputDeltaPct: deltaPct(candidate[throughputKey], reference[throughputKey]),
      tailDeltaPct: deltaPct(candidate[tailKey], reference[tailKey]),
      p99DeltaPct: deltaPct(candidate.latP99Ms, reference.latP99Ms)
    })
  }

  const summarizeBinding = (rows) => ({
    throughput: median(rows.map((row) => row[throughputKey])),
    tailMs: median(rows.map((row) => row[tailKey])),
    p99Ms: median(rows.map((row) => row.latP99Ms)),
    eluPct: median(rows.map((row) => row.eluPct)),
    rssMB: median(rows.map((row) => row.rssMB)),
    heapMB: median(rows.map((row) => row.heapMB)),
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0)
  })

  return {
    name: scenario.name,
    kind: scenario.kind,
    parameters: scenario,
    candidate: summarizeBinding(rowsByBinding.candidate),
    reference: summarizeBinding(rowsByBinding.reference),
    paired: {
      throughputDeltaPct: distribution(paired.map((row) => row.throughputDeltaPct)),
      tailDeltaPct: distribution(paired.map((row) => row.tailDeltaPct)),
      p99DeltaPct: distribution(paired.map((row) => row.p99DeltaPct)),
      runs: paired
    }
  }
}

/**
 * @param {object} scenario
 * @param {string} jsonOut
 * @returns {Promise<void>}
 */
async function runScenario(scenario, jsonOut) {
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
function reportRow(result) {
  const tail = result.kind === 'http' ? 'p97.5' : 'p95'
  const throughput = result.kind === 'http' ? 'req/s' : 'msg/s'
  const pairedThroughput = result.paired.throughputDeltaPct
  const pairedTail = result.paired.tailDeltaPct

  return [
    result.name,
    throughput,
    fmt(result.candidate.throughput),
    fmt(result.reference.throughput),
    `${fmt(pairedThroughput.median, '%')} [${fmt(pairedThroughput.q1, '%')}, ${fmt(pairedThroughput.q3, '%')}]`,
    `${tail} ${fmt(result.candidate.tailMs, 'ms')} / ${fmt(result.reference.tailMs, 'ms')}`,
    `${fmt(pairedTail.median, '%')} [${fmt(pairedTail.q1, '%')}, ${fmt(pairedTail.q3, '%')}]`,
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

  const outDir = path.join(__dirname, 'profiles', 'binding-deep')
  const candidatePackage = await readJson(path.join(ROOT, 'node_modules', '@swarmmachina', 'swm-uws', 'package.json'))
  const referencePackage = await readJson(path.join(ROOT, 'node_modules', 'uwebsockets.js', 'package.json'))
  const systemBefore = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model || 'unknown',
    logicalCpus: os.cpus().length,
    loadAvg: os.loadavg()
  }
  const results = []

  await fs.mkdir(outDir, { recursive: true })

  for (const scenario of SCENARIOS) {
    console.log(`\n[deep-binding] scenario ${scenario.name}`)
    const jsonOut = path.join(outDir, `${scenario.name}.json`)

    await runScenario(scenario, jsonOut)
    results.push(aggregate(await readJson(jsonOut), scenario))
  }

  const summary = {
    schemaVersion: 'binding-deep-compare/v1',
    createdAt: new Date().toISOString(),
    bindings: {
      candidate: `${candidatePackage.name}@${candidatePackage.version}`,
      reference: `${referencePackage.name}@${referencePackage.version}`
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
