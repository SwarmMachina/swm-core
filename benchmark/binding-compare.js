import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import median from './helpers/median.js'
import runChild from './helpers/run-child.js'
import { appendStepSummary, fmt, mdTable, round } from './helpers/step-summary.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CANDIDATE = 'core-swm-uws'
const REFERENCE = 'core-uwebsockets'
const FRAMEWORKS = `${CANDIDATE},${REFERENCE}`

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
  runs: numEnv('BINDING_BENCH_RUNS', 4),
  order: 'balanced',
  warmup: numEnv('BINDING_BENCH_WARMUP', 2),
  duration: numEnv('BINDING_BENCH_DURATION', 6),
  httpConnections: numEnv('BINDING_BENCH_HTTP_CONNECTIONS', 100),
  httpPipelining: numEnv('BINDING_BENCH_HTTP_PIPELINING', 10),
  wsConnections: numEnv('BINDING_BENCH_WS_CONNECTIONS', 50),
  wsMessageBytes: numEnv('BINDING_BENCH_WS_MESSAGE_BYTES', 64),
  sampleMs: numEnv('BINDING_BENCH_SAMPLE_MS', 250)
}
const GUARDS = {
  maxThroughputRegressionPct: numEnv('BINDING_BENCH_MAX_THROUGHPUT_REGRESSION_PCT', 5),
  maxLatencyRegressionPct: numEnv('BINDING_BENCH_MAX_LATENCY_REGRESSION_PCT', 20),
  latencySlackMs: numEnv('BINDING_BENCH_LATENCY_SLACK_MS', 0.25),
  maxRssRegressionPct: numEnv('BINDING_BENCH_MAX_RSS_REGRESSION_PCT', 15),
  rssSlackMB: numEnv('BINDING_BENCH_RSS_SLACK_MB', 5)
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * Read the versions that this process will actually load, and fail before a
 * long benchmark if node_modules is stale relative to package.json.
 * @returns {Promise<{candidate: string, reference: string}>}
 */
async function readBindingLabels() {
  const manifest = await readJson(path.join(ROOT, 'package.json'))
  const candidatePackage = await readJson(path.join(ROOT, 'node_modules', '@swarmmachina', 'swm-uws', 'package.json'))
  const referencePackage = await readJson(path.join(ROOT, 'node_modules', 'uwebsockets.js', 'package.json'))
  const requestedCandidate = manifest.dependencies?.['@swarmmachina/swm-uws']
  const requestedReference = manifest.devDependencies?.['uwebsockets.js']
  const requestedReferenceVersion = /#v?(\d+\.\d+\.\d+)$/.exec(requestedReference || '')?.[1]

  if (requestedCandidate !== candidatePackage.version) {
    throw new Error(
      `Installed @swarmmachina/swm-uws@${candidatePackage.version} does not match package.json (${requestedCandidate})`
    )
  }

  if (requestedReferenceVersion !== referencePackage.version) {
    throw new Error(
      `Installed uWebSockets.js@${referencePackage.version} does not match package.json (${requestedReference})`
    )
  }

  return {
    candidate: `${candidatePackage.name}@${candidatePackage.version}`,
    reference: `${referencePackage.name}@${referencePackage.version}`
  }
}

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values) {
  const nums = values.filter(Number.isFinite)

  return nums.length ? Number(median(nums).toFixed(3)) : null
}

/**
 * @param {object} bench
 * @param {string} fw
 * @param {string} throughputKey
 * @returns {object}
 */
function aggregate(bench, fw, throughputKey) {
  const medianRow = bench.median.find((row) => row.fw === fw)
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === fw))

  if (!medianRow || !rows.length) {
    throw new Error(`Missing ${fw} results for ${bench.test?.name || 'benchmark'}`)
  }

  return {
    binding: fw,
    throughput: medianRow[throughputKey],
    latencyP95Ms: medianRow.latP95Ms,
    latencyP97_5Ms: medianRow.latP97_5Ms,
    latencyP99Ms: medianRow.latP99Ms,
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    eluPct: medianNullable(rows.map((row) => row.eluPct)),
    rssMB: medianNullable(rows.map((row) => row.rssMB)),
    heapMB: medianNullable(rows.map((row) => row.heapMB))
  }
}

/**
 * @param {number} candidate
 * @param {number} reference
 * @returns {number|null}
 */
function deltaPct(candidate, reference) {
  return Number.isFinite(candidate) && Number.isFinite(reference) && reference !== 0
    ? round(((candidate - reference) / reference) * 100)
    : null
}

/**
 * @param {string} suite
 * @param {object} candidate
 * @param {object} reference
 * @param {'latencyP95Ms'|'latencyP97_5Ms'} tailKey
 * @param {string} tailLabel
 * @returns {string[]}
 */
function guard(suite, candidate, reference, tailKey, tailLabel) {
  const failures = []
  const minThroughput = reference.throughput * (1 - GUARDS.maxThroughputRegressionPct / 100)
  const maxTail = reference[tailKey] * (1 + GUARDS.maxLatencyRegressionPct / 100) + GUARDS.latencySlackMs
  const maxP99 = reference.latencyP99Ms * (1 + GUARDS.maxLatencyRegressionPct / 100) + GUARDS.latencySlackMs
  const maxRss = reference.rssMB * (1 + GUARDS.maxRssRegressionPct / 100) + GUARDS.rssSlackMB

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

  if (candidate.rssMB > maxRss) {
    failures.push(`${suite}: RSS ${fmt(candidate.rssMB, 'MB')} exceeds ${fmt(maxRss, 'MB')}`)
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
function renderSuite(suite, throughputLabel, candidate, reference, tailKey, tailLabel) {
  const rows = [reference, candidate].map((row) => [
    row.binding,
    fmt(row.throughput),
    fmt(row[tailKey], 'ms'),
    fmt(row.latencyP99Ms, 'ms'),
    fmt(row.eluPct, '%'),
    fmt(row.rssMB, 'MB'),
    fmt(row.heapMB, 'MB'),
    row.errors
  ])
  const deltas = [
    ['throughput', fmt(deltaPct(candidate.throughput, reference.throughput), '%')],
    [tailLabel, fmt(deltaPct(candidate[tailKey], reference[tailKey]), '%')],
    ['p99', fmt(deltaPct(candidate.latencyP99Ms, reference.latencyP99Ms), '%')],
    ['RSS', fmt(deltaPct(candidate.rssMB, reference.rssMB), '%')]
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
async function runHttp(outDir) {
  const jsonOut = path.join(outDir, 'http-base.json')

  await runChild([
    path.join(__dirname, 'bench.js'),
    '--test',
    'base',
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

  const bench = await readJson(jsonOut)

  return {
    candidate: aggregate(bench, CANDIDATE, 'rps'),
    reference: aggregate(bench, REFERENCE, 'rps')
  }
}

/**
 * @param {string} outDir
 * @returns {Promise<object>}
 */
async function runWs(outDir) {
  const jsonOut = path.join(outDir, 'ws-echo.json')

  await runChild([
    path.join(__dirname, 'ws-bench.js'),
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

  const bench = await readJson(jsonOut)

  return {
    candidate: aggregate(bench, CANDIDATE, 'msgPerSec'),
    reference: aggregate(bench, REFERENCE, 'msgPerSec')
  }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const outDir = path.join(__dirname, 'profiles', 'binding-compare')

  if (PARAMS.runs % 2 !== 0) {
    throw new Error('BINDING_BENCH_RUNS must be even for balanced AB/BA ordering')
  }

  const bindings = await readBindingLabels()

  await fs.mkdir(outDir, { recursive: true })

  const http = await runHttp(outDir)
  const ws = await runWs(outDir)
  const failures = [
    ...guard('http/base', http.candidate, http.reference, 'latencyP97_5Ms', 'p97.5'),
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
    renderSuite('http / base', 'req/s', http.candidate, http.reference, 'latencyP97_5Ms', 'p97.5'),
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
