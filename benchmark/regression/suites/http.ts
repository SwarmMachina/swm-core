import fs from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { copyCpuProfiles } from '@swarmmachina/benchkit/profiling'
import { cpuGuard, metricGuard } from '@swarmmachina/benchkit/regression'
import { median } from '@swarmmachina/benchkit/statistics'
import { positiveEnvNumber } from '../../harness/summary.js'
import { requireMetric, type ProfiledBenchmarkSummary, type SuiteOptions } from '../../harness/types.js'

const TESTS = [
  'base-sync',
  'base-async',
  'headers',
  'headers-prepared',
  'static-cache-hit',
  'static-cache-miss',
  'stream',
  'stream-backpressure',
  'post-base'
]
const RPS_RATIO_TESTS = ['static-cache-hit', 'static-cache-miss', 'stream', 'stream-backpressure']

/**
 * @param {string} name
 * @param {number} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
interface HttpBaseline {
  parameters?: {
    runs?: number
    warmupSec?: number
    durationSec?: number
    connections?: number
    sampleMs?: number
    cpuProfile?: boolean
    testConnections?: Record<string, number>
  }
  tests?: Record<string, { guards?: Record<string, { min?: number; max?: number }> }>
  cpuProfileGuard?: {
    profileRequired?: boolean
    minTotalTicks?: number
    maxGcPct?: number
    maxUnaccountedPct?: number
  }
}

/**
 * @param {string} name
 * @param {boolean} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function boolEnv(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[name]

  if (v == null || v === '') {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase())
}

/**
 * Resolve the load parameters from the same baseline as the metric guards.
 * Environment overrides remain available for explicit local experiments.
 * @param {object} baseline
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function resolveHttpParams(baseline: HttpBaseline, env: NodeJS.ProcessEnv = process.env) {
  const p = baseline.parameters ?? {}

  return {
    tests: TESTS,
    runs: positiveEnvNumber('HTTP_PROFILE_RUNS', p.runs ?? 3, env),
    warmup: positiveEnvNumber('HTTP_PROFILE_WARMUP', p.warmupSec ?? 2, env),
    duration: positiveEnvNumber('HTTP_PROFILE_DURATION', p.durationSec ?? 6, env),
    connections: positiveEnvNumber('HTTP_PROFILE_CONNECTIONS', p.connections ?? 100, env),
    sampleMs: positiveEnvNumber('HTTP_PROFILE_SAMPLE_MS', p.sampleMs ?? 250, env),
    cpuProfile: boolEnv('HTTP_CPU_PROFILE', p.cpuProfile ?? true, env),
    framework: 'core'
  }
}

/**
 * @param {Array<number|null|undefined>} values
 * @returns {number|null}
 */
function medianRequired(values: Array<number | null | undefined>, label: string): number {
  const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  if (!nums.length) {
    throw new Error(`http benchmark has no finite ${label} sample`)
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
function summarizeCore(bench: ProfiledBenchmarkSummary): Record<string, number> {
  const medianRow = bench.median.find((row) => row.fw === 'core')
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === 'core'))

  if (!medianRow || !rows.length) {
    throw new Error(`benchmark ${bench.test?.name || 'unknown'} has no core result`)
  }

  const summary: Record<string, number> = {
    rps: requireMetric(medianRow, 'rps', 'http median'),
    latencyAvgMs: requireMetric(medianRow, 'latAvgMs', 'http median'),
    latencyP97_5Ms: requireMetric(medianRow, 'latP97_5Ms', 'http median'),
    latencyP99Ms: requireMetric(medianRow, 'latP99Ms', 'http median'),
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

  if (bench.test?.name === 'stream-backpressure') {
    summary.backpressurePauses = requireMetric(medianRow, 'backpressurePauses', 'http median')
    summary.backpressureResumes = requireMetric(medianRow, 'backpressureResumes', 'http median')
  }

  return summary
}

function addRpsRatios(results: Record<string, Record<string, number>>): void {
  const baseRps = results['base-sync']?.rps

  if (typeof baseRps !== 'number' || !Number.isFinite(baseRps) || baseRps <= 0) {
    throw new Error('base-sync benchmark has no positive RPS for relative HTTP guards')
  }

  for (const test of RPS_RATIO_TESTS) {
    const result = results[test]

    if (!result) {
      throw new Error(`${test}: missing result for relative HTTP guard`)
    }

    const rps = result.rps

    if (typeof rps !== 'number' || !Number.isFinite(rps)) {
      throw new Error(`${test}: missing finite RPS for relative HTTP guard`)
    }

    result.rpsRelativeToBaseSync = Number((rps / baseRps).toFixed(4))
  }
}

/**
 * @param {{ sourceBenchDir: string, runtimeBenchDir: string, repoRoot: string, outRoot: string }} o
 * @returns {Promise<{ suite: string, failures: string[], metricRows: object[], cpuRows: object[] }>}
 */
export default async function runHttpSuite({ sourceBenchDir, runtimeBenchDir, repoRoot, outRoot }: SuiteOptions) {
  const baseline = await readJson<HttpBaseline>(path.join(sourceBenchDir, 'regression', 'baselines', 'http.json'))
  const params = resolveHttpParams(baseline)
  const outDir = path.join(outRoot, 'http')

  await fs.mkdir(outDir, { recursive: true })

  const results: Record<string, Record<string, number>> = {}
  const cpuProfiles = []

  for (const test of params.tests) {
    const jsonOut = path.join(outDir, `${test}.json`)
    const connections = baseline.parameters?.testConnections?.[test] ?? params.connections

    await runChild([
      path.join(runtimeBenchDir, 'http', 'runner.js'),
      '--test',
      test,
      '--fw',
      'core',
      '--runs',
      String(params.runs),
      '--warmup',
      String(params.warmup),
      '--duration',
      String(params.duration),
      '--connections',
      String(connections),
      '--sample-ms',
      String(params.sampleMs),
      '--v8prof',
      String(params.cpuProfile),
      '--json-out',
      jsonOut
    ])

    const bench = await readJson<ProfiledBenchmarkSummary>(jsonOut)

    results[test] = summarizeCore(bench)
    cpuProfiles.push(...(await copyCpuProfiles(bench, test, outDir, repoRoot)))
  }

  addRpsRatios(results)

  if (!baseline.tests) {
    throw new Error('HTTP regression baseline is missing test guards')
  }

  const { failures: metricFailures, rows: metricRows } = metricGuard({
    cases: params.tests,
    results,
    baselineTests: baseline.tests
  })
  const expectedKeys = []

  if (params.cpuProfile) {
    for (const test of params.tests) {
      for (let run = 1; run <= params.runs; run++) {
        expectedKeys.push(`${test}:${run}:core`)
      }
    }
  }

  const { failures: cpuFailures, rows: cpuRows } = cpuGuard({
    cpuProfiles,
    guard: params.cpuProfile ? baseline.cpuProfileGuard : undefined,
    expectedKeys
  })
  const summary = {
    suite: 'http',
    createdAt: new Date().toISOString(),
    node: process.version,
    parameters: params,
    results,
    cpuProfiles
  }

  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  return { suite: 'http', failures: [...metricFailures, ...cpuFailures], metricRows, cpuRows }
}
