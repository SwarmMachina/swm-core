import fs from 'node:fs/promises'
import path from 'node:path'
import copyCpuProfiles from '../helpers/copy-cpu-profiles.js'
import cpuGuard from '../helpers/cpu-guard.js'
import median from '../helpers/median.js'
import metricGuard from '../helpers/metric-guard.js'
import runChild from '../helpers/run-child.js'

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values) {
  const nums = values.filter((v) => Number.isFinite(v))

  return nums.length ? Number(median(nums).toFixed(2)) : null
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * @param {object} bench
 * @returns {object}
 */
function summarizeWs(bench) {
  const medianRow = bench.median.find((row) => row.fw === 'core')
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === 'core'))

  if (!medianRow || !rows.length) {
    throw new Error('ws benchmark has no core result')
  }

  return {
    msgPerSec: medianRow.msgPerSec,
    latencyAvgMs: medianRow.latAvgMs,
    latencyP97_5Ms: medianRow.latP97_5Ms,
    latencyP99Ms: medianRow.latP99Ms,
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
 * @param {{ benchDir: string, repoRoot: string, outRoot: string }} o
 * @returns {Promise<{ suite: string, failures: string[], metricRows: object[], cpuRows: object[] }>}
 */
export default async function runWsSuite({ benchDir, repoRoot, outRoot }) {
  const baseline = await readJson(path.join(benchDir, 'baselines', 'ws.json'))
  const p = baseline.parameters || {}
  const params = {
    runs: p.runs ?? 3,
    warmup: p.warmupSec ?? 2,
    duration: p.durationSec ?? 6,
    connections: p.connections ?? 50,
    sampleMs: p.sampleMs ?? 250,
    msgSize: p.msgSize ?? 64,
    cpuProfile: p.cpuProfile ?? true,
    framework: 'core'
  }

  const outDir = path.join(outRoot, 'ws')

  await fs.mkdir(outDir, { recursive: true })

  const jsonOut = path.join(outDir, 'ws-echo.json')

  await runChild([
    path.join(benchDir, 'ws-bench.js'),
    '--fw',
    'core',
    '--runs',
    String(params.runs),
    '--warmup',
    String(params.warmup),
    '--duration',
    String(params.duration),
    '--connections',
    String(params.connections),
    '--sample-ms',
    String(params.sampleMs),
    '--msg-size',
    String(params.msgSize),
    '--v8prof',
    String(params.cpuProfile),
    '--json-out',
    jsonOut
  ])

  const bench = await readJson(jsonOut)
  const results = { echo: summarizeWs(bench) }
  const cpuProfiles = await copyCpuProfiles(bench, 'echo', outDir, repoRoot)

  const { failures: metricFailures, rows: metricRows } = metricGuard({
    cases: ['echo'],
    results,
    baselineTests: baseline.tests
  })

  const expectedKeys = []

  if (params.cpuProfile) {
    for (let run = 1; run <= params.runs; run++) {
      expectedKeys.push(`echo:${run}:core`)
    }
  }

  const { failures: cpuFailures, rows: cpuRows } = cpuGuard({
    cpuProfiles,
    guard: params.cpuProfile ? baseline.cpuProfileGuard : null,
    expectedKeys
  })

  const summary = {
    suite: 'ws',
    createdAt: new Date().toISOString(),
    node: process.version,
    parameters: params,
    results,
    cpuProfiles
  }

  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  return { suite: 'ws', failures: [...metricFailures, ...cpuFailures], metricRows, cpuRows }
}
