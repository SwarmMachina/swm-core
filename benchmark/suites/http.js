import fs from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { copyCpuProfiles } from '@swarmmachina/benchkit/profiling'
import { cpuGuard, metricGuard } from '@swarmmachina/benchkit/regression'
import { median } from '@swarmmachina/benchkit/statistics'

const TESTS = ['base-sync', 'base-async', 'headers', 'headers-prepared', 'post-base']

/**
 * @param {string} name
 * @param {number} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function numEnv(name, fallback, env = process.env) {
  const v = Number(env[name])

  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * @param {string} name
 * @param {boolean} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function boolEnv(name, fallback, env = process.env) {
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
export function resolveHttpParams(baseline, env = process.env) {
  const p = baseline.parameters || {}

  return {
    tests: TESTS,
    runs: numEnv('HTTP_PROFILE_RUNS', p.runs ?? 3, env),
    warmup: numEnv('HTTP_PROFILE_WARMUP', p.warmupSec ?? 2, env),
    duration: numEnv('HTTP_PROFILE_DURATION', p.durationSec ?? 6, env),
    connections: numEnv('HTTP_PROFILE_CONNECTIONS', p.connections ?? 100, env),
    sampleMs: numEnv('HTTP_PROFILE_SAMPLE_MS', p.sampleMs ?? 250, env),
    cpuProfile: boolEnv('HTTP_CPU_PROFILE', p.cpuProfile ?? true, env),
    framework: 'core'
  }
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
function summarizeCore(bench) {
  const medianRow = bench.median.find((row) => row.fw === 'core')
  const rows = bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === 'core'))

  if (!medianRow || !rows.length) {
    throw new Error(`benchmark ${bench.test?.name || 'unknown'} has no core result`)
  }

  return {
    rps: medianRow.rps,
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
export default async function runHttpSuite({ benchDir, repoRoot, outRoot }) {
  const baseline = await readJson(path.join(benchDir, 'baselines', 'http.json'))
  const params = resolveHttpParams(baseline)
  const outDir = path.join(outRoot, 'http')

  await fs.mkdir(outDir, { recursive: true })

  const results = {}
  const cpuProfiles = []

  for (const test of params.tests) {
    const jsonOut = path.join(outDir, `${test}.json`)

    await runChild([
      path.join(benchDir, 'bench.js'),
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
      String(params.connections),
      '--sample-ms',
      String(params.sampleMs),
      '--v8prof',
      String(params.cpuProfile),
      '--json-out',
      jsonOut
    ])

    const bench = await readJson(jsonOut)

    results[test] = summarizeCore(bench)
    cpuProfiles.push(...(await copyCpuProfiles(bench, test, outDir, repoRoot)))
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
    guard: params.cpuProfile ? baseline.cpuProfileGuard : null,
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
