import fs from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { copyCpuProfiles } from '@swarmmachina/benchkit/profiling'
import { cpuGuard, metricGuard } from '@swarmmachina/benchkit/regression'
import { median } from '@swarmmachina/benchkit/statistics'
import { requireFiniteNumber, type ProfiledBenchmarkSummary, type SuiteOptions } from '../types.js'

const SCENARIOS = ['sync', 'async']

/**
 *
 * @param {string} file
 * @returns {Promise<object>}
 */
interface WsUpgradeBaseline {
  parameters?: {
    runs?: number
    warmupSec?: number
    durationSec?: number
    concurrency?: number
    sampleMs?: number
    cpuProfile?: boolean
  }
  tests: Record<string, { guards?: Record<string, { min?: number; max?: number }> }>
  cpuProfileGuard?: {
    profileRequired?: boolean
    minTotalTicks?: number
    maxGcPct?: number
    maxUnaccountedPct?: number
  }
}

function isScenarioRow(row: { scenario?: string }, scenario: string): boolean {
  return row.scenario === scenario
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/**
 *
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianRequired(values: Array<number | null | undefined>, label: string): number {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  if (!numbers.length) {
    throw new Error(`ws-upgrade benchmark has no finite ${label} sample`)
  }

  return Number(median(numbers).toFixed(2))
}

/**
 *
 * @param {object} bench
 * @param {string} scenario
 * @returns {object}
 */
function summarize(bench: ProfiledBenchmarkSummary, scenario: string): Record<string, number> {
  const medianRow = bench.median.find((row) => isScenarioRow(row, scenario))
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => isScenarioRow(row, scenario)))

  if (!medianRow || !rows.length) {
    throw new Error(`ws-upgrade benchmark has no ${scenario} result`)
  }

  return {
    upgradesPerSec: requireFiniteNumber(medianRow.upgradesPerSec, `${scenario} median upgrades`),
    latAvgMs: requireFiniteNumber(medianRow.latAvgMs, `${scenario} median average latency`),
    latP95Ms: requireFiniteNumber(medianRow.latP95Ms, `${scenario} median p95 latency`),
    latP99Ms: requireFiniteNumber(medianRow.latP99Ms, `${scenario} median p99 latency`),
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    eluPct: medianRequired(
      rows.map((row) => row.eluPct),
      'ELU'
    ),
    eventLoopDelayP99Ms: medianRequired(
      rows.map((row) => row.eldP99ms),
      'event-loop delay'
    ),
    rssMB: medianRequired(
      rows.map((row) => row.rssMB),
      'RSS'
    ),
    heapMB: medianRequired(
      rows.map((row) => row.heapMB),
      'heap'
    ),
    externalMB: medianRequired(
      rows.map((row) => row.externalMB),
      'external memory'
    ),
    arrayBuffersMB: medianRequired(
      rows.map((row) => row.arrayBuffersMB),
      'array buffer memory'
    )
  }
}

/**
 *
 * @param {object} options
 * @param {string} options.sourceBenchDir
 * @param {string} options.runtimeBenchDir
 * @param {string} options.repoRoot
 * @param {string} options.outRoot
 * @returns {Promise<object>}
 */
export default async function runWsUpgradeSuite({ sourceBenchDir, runtimeBenchDir, repoRoot, outRoot }: SuiteOptions) {
  const baseline = await readJson<WsUpgradeBaseline>(path.join(sourceBenchDir, 'baselines', 'ws-upgrade.json'))
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
    path.join(runtimeBenchDir, 'ws-upgrade-bench.js'),
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

  const bench = await readJson<ProfiledBenchmarkSummary>(jsonOut)
  const results: Record<string, Record<string, number>> = Object.fromEntries(
    SCENARIOS.map((scenario) => [scenario, summarize(bench, scenario)])
  )
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
    guard: params.cpuProfile ? baseline.cpuProfileGuard : undefined,
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
