import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import median from './helpers/median.js'
import runChild from './helpers/run-child.js'
import { appendStepSummary, fmt, mdTable } from './helpers/step-summary.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HTTP_TESTS = ['base', 'headers', 'post-base']
const HTTP_FRAMEWORKS = 'core,micro,fastify,express'
const HTTP_ORDER = ['core', 'micro', 'fastify', 'express']
const WS_FRAMEWORKS = 'core,ws'
const WS_ORDER = ['core', 'ws']

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name, fallback) {
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
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values) {
  const nums = values.filter((v) => Number.isFinite(v))

  return nums.length ? Number(median(nums).toFixed(2)) : null
}

/**
 * @param {object} bench
 * @param {string} fw
 * @returns {object|null}
 */
function aggregateFw(bench, fw) {
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

/**
 * @param {string} title
 * @param {string} metricHeader
 * @param {string} metricKey
 * @param {string[]} order
 * @param {object} bench
 * @returns {string}
 */
function renderComparison(title, metricHeader, metricKey, order, bench) {
  const rows = order
    .map((fw) => aggregateFw(bench, fw))
    .filter(Boolean)
    .map((a) => [
      a.fw,
      fmt(a.median[metricKey]),
      fmt(a.median.latAvgMs, 'ms'),
      fmt(a.median.latP99Ms, 'ms'),
      fmt(a.rssMB, 'MB'),
      fmt(a.heapMB, 'MB'),
      fmt(a.eluPct, '%'),
      a.errors
    ])

  return [
    `## Framework comparison — ${title}`,
    '',
    mdTable(['fw', metricHeader, 'latAvg', 'p99', 'rss', 'heap', 'ELU', 'errors'], rows),
    ''
  ].join('\n')
}

/**
 *
 */
async function main() {
  const outDir = path.join(__dirname, 'profiles', 'compare-ci')

  await fs.mkdir(outDir, { recursive: true })

  const sections = []

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

      const bench = await readJson(jsonOut)

      sections.push(renderComparison(`http / ${test}`, 'rps', 'rps', HTTP_ORDER, bench))
    } catch (e) {
      sections.push(`## Framework comparison — http / ${test}\n\n⚠️ run failed: ${e.message}\n`)
      console.error(`[compare-ci] http/${test} failed:`, e.message)
    }
  }

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

    const bench = await readJson(wsJsonOut)

    sections.push(renderComparison('ws / echo', 'msg/s', 'msgPerSec', WS_ORDER, bench))
  } catch (e) {
    sections.push(`## Framework comparison — ws / echo\n\n⚠️ run failed: ${e.message}\n`)
    console.error('[compare-ci] ws/echo failed:', e.message)
  }

  await appendStepSummary(sections.join('\n'))
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
