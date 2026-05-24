import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import median from './helpers/median.js'
import parseArgs from './helpers/parse-args.js'
import parseV8Profile from './helpers/v8-prof-parser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(__dirname)
const DEFAULT_TESTS = ['base', 'headers', 'post-base']

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseHttpCiArgs(argv) {
  return parseArgs(
    argv,
    {
      tests: DEFAULT_TESTS,
      runs: numberFromEnv('HTTP_PROFILE_RUNS', 3),
      warmup: numberFromEnv('HTTP_PROFILE_WARMUP', 2),
      duration: numberFromEnv('HTTP_PROFILE_DURATION', 6),
      connections: numberFromEnv('HTTP_PROFILE_CONNECTIONS', 100),
      sampleMs: numberFromEnv('HTTP_PROFILE_SAMPLE_MS', 250),
      cpuProfile: boolFromEnv('HTTP_CPU_PROFILE', true),
      outDir: path.join(__dirname, 'profiles', 'http-ci'),
      baseline: path.join(__dirname, 'baselines', 'http-ci.json')
    },
    {
      '--test': (out, v) => {
        out.tests = String(v)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      },
      '--runs': (out, v) => {
        out.runs = Number(v)
      },
      '--warmup': (out, v) => {
        out.warmup = Number(v)
      },
      '--duration': (out, v) => {
        out.duration = Number(v)
      },
      '--connections': (out, v) => {
        out.connections = Number(v)
      },
      '--sample-ms': (out, v) => {
        out.sampleMs = Number(v)
      },
      '--cpu-profile': (out, v) => {
        out.cpuProfile = parseBool(v, true)
      },
      '--no-cpu-profile': (out) => {
        out.cpuProfile = false
        return false
      },
      '--out-dir': (out, v) => {
        out.outDir = path.resolve(String(v))
      },
      '--baseline': (out, v) => {
        out.baseline = path.resolve(String(v))
      },
      '--no-baseline': (out) => {
        out.baseline = null
        return false
      }
    }
  )
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])

  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolFromEnv(name, fallback) {
  return parseBool(process.env[name], fallback)
}

/**
 * @param {string|undefined} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBool(value, fallback) {
  if (value == null || value === '') {
    return fallback
  }

  const normalized = String(value).trim().toLowerCase()

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }

  return fallback
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
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
 * @param {number|null} value
 * @param {string} unit
 * @returns {string}
 */
function formatNullable(value, unit) {
  return Number.isFinite(value) ? `${value}${unit}` : 'n/a'
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
    heapMB: medianNullable(rows.map((row) => row.heapMB))
  }
}

/**
 * @param {object} bench
 * @param {string} test
 * @param {string} outDir
 * @returns {Promise<Array<object>>}
 */
async function copyCpuProfiles(bench, test, outDir) {
  const copied = []
  const cpuDir = path.join(outDir, 'cpu')

  await fs.mkdir(cpuDir, { recursive: true })

  for (const run of bench.runs) {
    for (const row of run.rows) {
      if (!row.v8prof) {
        continue
      }

      const dir = await fs.mkdtemp(path.join(cpuDir, `${test}-run-${run.run}-${row.fw}-`))
      const item = { test, run: run.run, fw: row.fw }

      if (row.v8prof.processedPath) {
        const dest = path.join(dir, 'profile.txt')

        await fs.copyFile(row.v8prof.processedPath, dest)
        item.processedPath = path.relative(outDir, dest)
        item.profile = parseV8Profile(await fs.readFile(dest, 'utf8'), { cwd: REPO_ROOT })
      }

      if (row.v8prof.logPath) {
        const dest = path.join(dir, path.basename(row.v8prof.logPath))

        await fs.copyFile(row.v8prof.logPath, dest)
        item.logPath = path.relative(outDir, dest)
      }

      copied.push(item)
    }
  }

  return copied
}

/**
 * @param {object} current
 * @param {object} baseline
 * @returns {Array<string>}
 */
function compareCpuProfiles(current, baseline) {
  const guard = baseline.cpuProfileGuard

  if (!guard) {
    return []
  }

  const failures = []
  const rows = []
  const expected = new Set()

  if (guard.profileRequired) {
    for (const test of current.tests) {
      for (let run = 1; run <= current.parameters.runs; run++) {
        expected.add(`${test}:${run}:core`)
      }
    }
  }

  for (const item of current.cpuProfiles || []) {
    const key = `${item.test}:${item.run}:${item.fw}`
    const profile = item.profile

    expected.delete(key)

    if (!profile) {
      failures.push(`${key}: missing parsed CPU profile`)
      continue
    }

    const gcPct = profile.summary.gc?.totalPct ?? null
    const unaccountedPct = profile.summary.unaccounted?.totalPct ?? null

    rows.push({
      key,
      ticks: profile.totalTicks,
      jsPct: profile.summary.javascript?.totalPct ?? null,
      cppPct: profile.summary.c?.totalPct ?? null,
      gcPct,
      unaccountedPct
    })

    if (!Number.isFinite(profile.totalTicks)) {
      failures.push(`${key}: missing CPU profile tick count`)
    }

    if (
      guard.minTotalTicks != null &&
      Number.isFinite(profile.totalTicks) &&
      profile.totalTicks < guard.minTotalTicks
    ) {
      failures.push(`${key}: CPU profile ticks ${profile.totalTicks} < ${guard.minTotalTicks}`)
    }

    if (guard.maxGcPct != null && Number.isFinite(gcPct) && gcPct > guard.maxGcPct) {
      failures.push(`${key}: GC ${gcPct}% > ${guard.maxGcPct}%`)
    }

    if (
      guard.maxUnaccountedPct != null &&
      Number.isFinite(unaccountedPct) &&
      unaccountedPct > guard.maxUnaccountedPct
    ) {
      failures.push(`${key}: unaccounted ${unaccountedPct}% > ${guard.maxUnaccountedPct}%`)
    }
  }

  for (const missing of expected) {
    failures.push(`${missing}: missing CPU profile`)
  }

  if (guard.profileRequired || rows.length) {
    console.log('\n[http-ci] CPU profile guard')
    console.table(
      rows.map((row) => ({
        profile: row.key,
        ticks: row.ticks,
        JS: formatNullable(row.jsPct, '%'),
        CPP: formatNullable(row.cppPct, '%'),
        GC: formatNullable(row.gcPct, '%'),
        unaccounted: formatNullable(row.unaccountedPct, '%')
      }))
    )
  }

  return failures
}

/**
 * @param {object} current
 * @param {object} baseline
 * @returns {Array<object>}
 */
function compareToBaseline(current, baseline) {
  const failures = []
  const thresholds = baseline.thresholds || {}
  const maxRpsDropRatio = thresholds.maxRpsDropRatio ?? 0.35
  const maxLatencyP99IncreaseRatio = thresholds.maxLatencyP99IncreaseRatio ?? 0.75
  const rows = []

  for (const test of current.tests) {
    const actual = current.results[test]
    const expected = baseline.tests?.[test]

    if (!expected) {
      failures.push(`${test}: missing baseline`)
      continue
    }

    const rpsMin = expected.rpsMin ?? (expected.rps ? expected.rps * (1 - maxRpsDropRatio) : null)
    const latencyP99MaxMs =
      expected.latencyP99MaxMs ??
      (expected.latencyP99Ms ? expected.latencyP99Ms * (1 + maxLatencyP99IncreaseRatio) : null)
    const errorsMax = expected.errorsMax ?? 0

    const row = {
      test,
      rps: actual.rps,
      rpsMin,
      latencyP99Ms: actual.latencyP99Ms,
      latencyP99MaxMs,
      errors: actual.errors,
      errorsMax
    }

    rows.push(row)

    if (actual.errors > errorsMax) {
      failures.push(`${test}: errors ${actual.errors} > ${errorsMax}`)
    }

    if (rpsMin != null && actual.rps < rpsMin) {
      failures.push(`${test}: rps ${actual.rps} < ${Math.round(rpsMin)}`)
    }

    if (latencyP99MaxMs != null && !Number.isFinite(actual.latencyP99Ms)) {
      failures.push(`${test}: missing p99 latency`)
    }

    if (latencyP99MaxMs != null && Number.isFinite(actual.latencyP99Ms) && actual.latencyP99Ms > latencyP99MaxMs) {
      failures.push(`${test}: p99 ${actual.latencyP99Ms}ms > ${latencyP99MaxMs.toFixed(2)}ms`)
    }
  }

  console.log('\n[http-ci] regression guard')
  console.table(
    rows.map((row) => ({
      test: row.test,
      rps: row.rps,
      rpsMin: row.rpsMin != null ? Math.round(row.rpsMin) : 'n/a',
      p99: formatNullable(row.latencyP99Ms, 'ms'),
      p99Max: row.latencyP99MaxMs != null ? `${row.latencyP99MaxMs.toFixed(2)}ms` : 'n/a',
      errors: row.errors,
      errorsMax: row.errorsMax
    }))
  )

  return failures
}

/**
 *
 */
async function main() {
  const args = parseHttpCiArgs(process.argv)

  await fs.mkdir(args.outDir, { recursive: true })

  const results = {}
  const raw = {}
  const cpuProfiles = []

  for (const test of args.tests) {
    const jsonOut = path.join(args.outDir, `${test}.json`)

    await run(process.execPath, [
      path.join(__dirname, 'bench.js'),
      '--test',
      test,
      '--fw',
      'core',
      '--runs',
      String(args.runs),
      '--warmup',
      String(args.warmup),
      '--duration',
      String(args.duration),
      '--connections',
      String(args.connections),
      '--sample-ms',
      String(args.sampleMs),
      '--v8prof',
      String(args.cpuProfile),
      '--json-out',
      jsonOut
    ])

    const bench = await readJson(jsonOut)

    raw[test] = bench
    results[test] = summarizeCore(bench)
    cpuProfiles.push(...(await copyCpuProfiles(bench, test, args.outDir)))
  }

  const summary = {
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    tests: args.tests,
    parameters: {
      runs: args.runs,
      warmup: args.warmup,
      duration: args.duration,
      connections: args.connections,
      sampleMs: args.sampleMs,
      cpuProfile: args.cpuProfile,
      framework: 'core'
    },
    cpuProfiles,
    results,
    raw
  }

  const summaryPath = path.join(args.outDir, 'summary.json')

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

  console.log('\n[http-ci] summary')
  console.table(
    args.tests.map((test) => {
      const row = results[test]

      return {
        test,
        rps: row.rps,
        latAvg: formatNullable(row.latencyAvgMs, 'ms'),
        latP97_5: formatNullable(row.latencyP97_5Ms, 'ms'),
        latP99: formatNullable(row.latencyP99Ms, 'ms'),
        ELU: formatNullable(row.eluPct, '%'),
        ELDp99: formatNullable(row.eventLoopDelayP99Ms, 'ms'),
        rss: formatNullable(row.rssMB, 'MB'),
        heap: formatNullable(row.heapMB, 'MB'),
        errors: row.errors
      }
    })
  )
  console.log(`[http-ci] wrote summary: ${summaryPath}`)

  if (!args.baseline) {
    return
  }

  const baseline = await readJson(args.baseline)
  const failures = compareToBaseline(summary, baseline)
  failures.push(...compareCpuProfiles(summary, baseline))

  if (failures.length) {
    console.error('\n[http-ci] regression failures')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
