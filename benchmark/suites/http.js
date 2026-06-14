import fs from 'node:fs/promises'
import path from 'node:path'
import copyCpuProfiles from '../helpers/copy-cpu-profiles.js'
import cpuGuard from '../helpers/cpu-guard.js'
import median from '../helpers/median.js'
import metricGuard from '../helpers/metric-guard.js'
import runChild from '../helpers/run-child.js'

const TESTS = ['base', 'headers', 'post-base']

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numEnv(name, fallback) {
  const v = Number(process.env[name])

  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolEnv(name, fallback) {
  const v = process.env[name]

  if (v == null || v === '') {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase())
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
  const params = {
    tests: TESTS,
    runs: numEnv('HTTP_PROFILE_RUNS', 3),
    warmup: numEnv('HTTP_PROFILE_WARMUP', 2),
    duration: numEnv('HTTP_PROFILE_DURATION', 6),
    connections: numEnv('HTTP_PROFILE_CONNECTIONS', 100),
    sampleMs: numEnv('HTTP_PROFILE_SAMPLE_MS', 250),
    cpuProfile: boolEnv('HTTP_CPU_PROFILE', true),
    framework: 'core'
  }

  const outDir = path.join(outRoot, 'http')

  await fs.mkdir(outDir, { recursive: true })

  const baseline = await readJson(path.join(benchDir, 'baselines', 'http.json'))
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
