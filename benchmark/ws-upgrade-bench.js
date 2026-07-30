import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { timed } from '@swarmmachina/benchkit/measurement'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { processV8Profile } from '@swarmmachina/benchkit/profiling'
import { formatYmdHms, msToHuman } from '@swarmmachina/benchkit/reporting'
import { median } from '@swarmmachina/benchkit/statistics'
import wsUpgradeLoad from './helpers/ws-upgrade-load.js'
import { TargetController } from './helpers/target-controller.js'
import { TARGET_ARG_HANDLERS, targetDefaults, targetUrl } from './helpers/target-session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCENARIOS = new Set(['sync', 'async'])

/**
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseBenchArgs(argv) {
  return parseArgs(
    argv,
    {
      frameworks: ['core', 'hyperexpress'],
      scenarios: ['sync', 'async'],
      runs: 3,
      warmup: 2,
      duration: 6,
      concurrency: 50,
      sampleMs: 250,
      v8prof: false,
      jsonOut: null,
      ...targetDefaults()
    },
    {
      '--fw': (out, value) => {
        out.frameworks = String(value)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      },
      '--scenario': (out, value) => {
        out.scenarios = String(value)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      },
      '--runs': (out, value) => {
        out.runs = Number(value)
      },
      '--warmup': (out, value) => {
        out.warmup = Number(value)
      },
      '--duration': (out, value) => {
        out.duration = Number(value)
      },
      '--concurrency': (out, value) => {
        out.concurrency = Number(value)
      },
      '--sample-ms': (out, value) => {
        out.sampleMs = Number(value)
      },
      '--v8prof': (out, value) => {
        out.v8prof = value == null ? true : value === '1' || value === 'true' || value === 'on'
      },
      '--json-out': (out, value) => {
        out.jsonOut = String(value)
      },
      ...TARGET_ARG_HANDLERS
    }
  )
}

/**
 *
 * @param {object} options
 * @param {object} options.args
 * @param {string} options.scenario
 * @param {object} options.session
 * @returns {Promise<object>}
 */
async function runScenario({ args, scenario, session }) {
  const url = targetUrl('ws', session, `/${scenario}`)
  const runLoad = (durationSec) => wsUpgradeLoad({ url, concurrency: args.concurrency, durationSec })

  if (args.warmup > 0) {
    const warmup = await timed(() => runLoad(args.warmup))

    console.log(`[ws-upgrade] ${scenario}: warmup done in ${msToHuman(warmup.ms)}`)
  }

  await session.startMetrics({ sampleMs: args.sampleMs })
  const measured = await timed(() => runLoad(args.duration))
  const metrics = await session.stopMetrics()
  const result = measured.result

  return {
    fw: 'core',
    scenario,
    upgradesPerSec: result.upgradesPerSec,
    latencyAvgMs: result.latencyAvgMs,
    latencyP95Ms: result.latencyP95Ms,
    latencyP97_5Ms: result.latencyP97_5Ms,
    latencyP99Ms: result.latencyP99Ms,
    errors: result.errors,
    eluPct: metrics?.eluPct ?? null,
    eldP99ms: metrics?.eventLoopDelayMs?.p99 ?? null,
    rssMB: metrics?.memMB?.rssPeak ?? null,
    heapMB: metrics?.memMB?.heapUsedPeak ?? null,
    externalMB: metrics?.memMB?.externalPeak ?? null,
    arrayBuffersMB: metrics?.memMB?.arrayBuffersPeak ?? null,
    v8prof: null
  }
}

/**
 *
 * @param {string} framework
 * @param {string} scenario
 * @param {object[]} rows
 * @returns {object}
 */
function medianRow(framework, scenario, rows) {
  const value = (key) => {
    const values = rows.map((row) => row[key]).filter(Number.isFinite)

    return values.length ? Number(median(values).toFixed(3)) : null
  }

  return {
    fw: framework,
    scenario,
    upgradesPerSec: value('upgradesPerSec'),
    latencyAvgMs: value('latencyAvgMs'),
    latencyP95Ms: value('latencyP95Ms'),
    latencyP97_5Ms: value('latencyP97_5Ms'),
    latencyP99Ms: value('latencyP99Ms'),
    n: rows.length
  }
}

/**
 *
 */
async function main() {
  const args = parseBenchArgs(process.argv)
  const targetController = new TargetController(args, path.dirname(__dirname))

  for (const scenario of args.scenarios) {
    if (!SCENARIOS.has(scenario)) {
      throw new Error(`Unknown --scenario=${scenario} (expected: sync, async)`)
    }
  }

  const runStamp = formatYmdHms()
  const resultKey = (framework, scenario) => `${framework}:${scenario}`
  const byCase = Object.fromEntries(
    args.frameworks.flatMap((framework) => args.scenarios.map((scenario) => [resultKey(framework, scenario), []]))
  )
  const runs = []
  const pendingProfiles = []

  console.log(
    `Run ws-upgrade: frameworks:${args.frameworks.join(',')}, scenarios:${args.scenarios.join(',')}, ` +
      `concurrency:${args.concurrency}, duration:${args.duration}`
  )

  for (let runIndex = 0; runIndex < args.runs; runIndex++) {
    const rows = []

    for (const framework of args.frameworks) {
      const frameworkRows = []
      const { session, profileDir } = await targetController.start({
        benchDir: __dirname,
        serverName: 'ws-server.js',
        fw: framework,
        testName: 'ws-upgrade',
        runIndex,
        v8prof: args.v8prof,
        runStamp
      })

      try {
        for (const scenario of args.scenarios) {
          const row = await runScenario({ args, scenario, session })

          row.fw = framework
          byCase[resultKey(framework, scenario)].push(row)
          frameworkRows.push(row)
          rows.push(row)
          console.log(
            `[ws-upgrade] ${framework}/${scenario}: upgrades/s=${Math.round(row.upgradesPerSec)} ` +
              `p99=${row.latencyP99Ms?.toFixed(2) ?? 'n/a'}ms errors=${row.errors}`
          )
        }
      } finally {
        await session.stop()
      }

      if (args.v8prof && frameworkRows.length) {
        pendingProfiles.push({ row: frameworkRows[0], profileDir })
      }
    }

    console.table(rows)
    runs.push({ run: runIndex + 1, rows })
  }

  for (const profile of pendingProfiles) {
    profile.row.v8prof = await processV8Profile(profile.profileDir).catch(() => null)
  }

  const medians = args.frameworks.flatMap((framework) =>
    args.scenarios.map((scenario) => medianRow(framework, scenario, byCase[resultKey(framework, scenario)]))
  )

  console.log('\n== median ==')
  console.table(medians)

  const summary = {
    createdAt: new Date().toISOString(),
    test: { name: 'ws-upgrade', concurrency: args.concurrency, duration: args.duration },
    options: {
      runs: args.runs,
      warmup: args.warmup,
      sampleMs: args.sampleMs,
      v8prof: args.v8prof,
      frameworks: args.frameworks,
      scenarios: args.scenarios
    },
    ...targetController.metadata,
    runs,
    median: medians
  }

  if (args.jsonOut) {
    await fs.mkdir(path.dirname(args.jsonOut), { recursive: true })
    await fs.writeFile(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`[ws-upgrade] wrote json summary: ${args.jsonOut}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
