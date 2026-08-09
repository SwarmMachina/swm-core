import fs from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { copyCpuProfiles } from '@swarmmachina/benchkit/profiling'
import { cpuGuard, metricGuard } from '@swarmmachina/benchkit/regression'
import { median } from '@swarmmachina/benchkit/statistics'
import { requireMetric, type ProfiledBenchmarkSummary, type SuiteOptions } from '../types.js'

interface WsBaseline {
  parameters?: {
    runs?: number
    warmupSec?: number
    durationSec?: number
    connections?: number
    sampleMs?: number
    msgSize?: number
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

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianRequired(values: Array<number | null | undefined>, label: string): number {
  const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  if (!nums.length) {
    throw new Error(`ws benchmark has no finite ${label} sample`)
  }

  return Number(median(nums).toFixed(2))
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/**
 * @param {object} bench
 * @returns {object}
 */
function summarizeWs(bench: ProfiledBenchmarkSummary): Record<string, number> {
  const medianRow = bench.median.find((row) => row.fw === 'core')
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === 'core'))

  if (!medianRow || !rows.length) {
    throw new Error('ws benchmark has no core result')
  }

  return {
    msgPerSec: requireMetric(medianRow, 'msgPerSec', 'ws median'),
    latencyAvgMs: requireMetric(medianRow, 'latAvgMs', 'ws median'),
    latencyP97_5Ms: requireMetric(medianRow, 'latP97_5Ms', 'ws median'),
    latencyP99Ms: requireMetric(medianRow, 'latP99Ms', 'ws median'),
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
 * @param {{ sourceBenchDir: string, runtimeBenchDir: string, repoRoot: string, outRoot: string }} o
 * @returns {Promise<{ suite: string, failures: string[], metricRows: object[], cpuRows: object[] }>}
 */
export default async function runWsSuite({ sourceBenchDir, runtimeBenchDir, repoRoot, outRoot }: SuiteOptions) {
  const baseline = await readJson<WsBaseline>(path.join(sourceBenchDir, 'baselines', 'ws.json'))
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
    path.join(runtimeBenchDir, 'ws-bench.js'),
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

  const bench = await readJson<ProfiledBenchmarkSummary>(jsonOut)
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
    guard: params.cpuProfile ? baseline.cpuProfileGuard : undefined,
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
