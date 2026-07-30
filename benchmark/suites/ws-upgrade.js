import fs from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { copyCpuProfiles } from '@swarmmachina/benchkit/profiling'
import { cpuGuard, metricGuard } from '@swarmmachina/benchkit/regression'
import { median } from '@swarmmachina/benchkit/statistics'

const SCENARIOS = ['sync', 'async']

/**
 *
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 *
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianNullable(values) {
  const numbers = values.filter(Number.isFinite)

  return numbers.length ? Number(median(numbers).toFixed(2)) : null
}

/**
 *
 * @param {object} bench
 * @param {string} scenario
 * @returns {object}
 */
function summarize(bench, scenario) {
  const medianRow = bench.median.find((row) => row.scenario === scenario)
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.scenario === scenario))

  if (!medianRow || !rows.length) {
    throw new Error(`ws-upgrade benchmark has no ${scenario} result`)
  }

  return {
    upgradesPerSec: medianRow.upgradesPerSec,
    latencyAvgMs: medianRow.latencyAvgMs,
    latencyP95Ms: medianRow.latencyP95Ms,
    latencyP99Ms: medianRow.latencyP99Ms,
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
 *
 * @param {object} options
 * @param {string} options.benchDir
 * @param {string} options.repoRoot
 * @param {string} options.outRoot
 * @returns {Promise<object>}
 */
export default async function runWsUpgradeSuite({ benchDir, repoRoot, outRoot }) {
  const baseline = await readJson(path.join(benchDir, 'baselines', 'ws-upgrade.json'))
  const parameters = baseline.parameters || {}
  const params = {
    runs: parameters.runs ?? 3,
    warmup: parameters.warmupSec ?? 2,
    duration: parameters.durationSec ?? 6,
    concurrency: parameters.concurrency ?? 50,
    sampleMs: parameters.sampleMs ?? 250,
    cpuProfile: parameters.cpuProfile ?? true
  }
  const outDir = path.join(outRoot, 'ws-upgrade')
  const jsonOut = path.join(outDir, 'ws-upgrade.json')

  await fs.mkdir(outDir, { recursive: true })
  await runChild([
    path.join(benchDir, 'ws-upgrade-bench.js'),
    '--fw',
    'core',
    '--scenario',
    SCENARIOS.join(','),
    '--runs',
    String(params.runs),
    '--warmup',
    String(params.warmup),
    '--duration',
    String(params.duration),
    '--concurrency',
    String(params.concurrency),
    '--sample-ms',
    String(params.sampleMs),
    '--v8prof',
    String(params.cpuProfile),
    '--json-out',
    jsonOut
  ])

  const bench = await readJson(jsonOut)
  const results = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, summarize(bench, scenario)]))
  const cpuProfiles = await copyCpuProfiles(bench, 'upgrade', outDir, repoRoot)
  const { failures: metricFailures, rows: metricRows } = metricGuard({
    cases: SCENARIOS,
    results,
    baselineTests: baseline.tests
  })
  const expectedKeys = []

  if (params.cpuProfile) {
    for (let run = 1; run <= params.runs; run++) {
      expectedKeys.push(`upgrade:${run}:core`)
    }
  }

  const { failures: cpuFailures, rows: cpuRows } = cpuGuard({
    cpuProfiles,
    guard: params.cpuProfile ? baseline.cpuProfileGuard : null,
    expectedKeys
  })
  const summary = {
    suite: 'ws-upgrade',
    createdAt: new Date().toISOString(),
    node: process.version,
    parameters: params,
    results,
    cpuProfiles
  }

  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  return {
    suite: 'ws-upgrade',
    failures: [...metricFailures, ...cpuFailures],
    metricRows,
    cpuRows
  }
}
