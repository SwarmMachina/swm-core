import fs from 'node:fs/promises'
import path from 'node:path'
import { timed, type MetricsSummary, type TimedResult } from '@swarmmachina/benchkit/measurement'
import { parseArgs, shuffle } from '@swarmmachina/benchkit/orchestration'
import { processV8Profile, type ProcessedV8Profile } from '@swarmmachina/benchkit/profiling'
import { formatYmdHms, msToHuman } from '@swarmmachina/benchkit/reporting'
import { median } from '@swarmmachina/benchkit/statistics'
import { getTest, type TestDefinition } from './tests.js'
import runLoad from './helpers/run-load.js'
import { TargetController } from './helpers/target-controller.js'
import { TARGET_ARG_HANDLERS, targetDefaults, targetUrl } from './helpers/target-session.js'
import { REPOSITORY_ROOT, RUNTIME_BENCHMARK_DIR } from './runtime-paths.js'
import type { LoadRun, TargetArgs } from './types.js'

const BASE_ORDER = ['core', 'hyperexpress', 'micro', 'fastify', 'express']
const WANTED = new Set(BASE_ORDER)

/**
 * @param {string[]} argv
 * @returns {object}
 */
interface BenchArgs extends TargetArgs {
  testName: string
  frameworks: string[]
  runs: number
  warmup: number
  sampleMs: number
  v8prof: boolean
  duration: number | null
  connections: number | null
  pipelining: number | null
  order: string
  jsonOut: string | null
}

function parseBenchArgs(argv: string[]): BenchArgs {
  const defaults: BenchArgs = {
    testName: 'base-sync',
    frameworks: [...BASE_ORDER],
    runs: 1,
    warmup: 10,
    sampleMs: 250,
    v8prof: false,
    duration: null,
    connections: null,
    pipelining: null,
    order: 'random',
    jsonOut: null,
    ...targetDefaults()
  }

  return parseArgs(argv, defaults, {
    '--test': (out, v) => {
      out.testName = String(v)
    },
    '--runs': (out, v) => {
      out.runs = Number(v)
    },
    '--warmup': (out, v) => {
      out.warmup = Number(v)
    },
    '--fw': (out, v) => {
      out.frameworks = String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },
    '--sample-ms': (out, v) => {
      out.sampleMs = Number(v)
    },
    '--v8prof': (out, v) => {
      out.v8prof = v == null ? true : v === '1' || v === 'true' || v === 'on'
    },
    '--duration': (out, v) => {
      out.duration = Number(v)
    },
    '--connections': (out, v) => {
      out.connections = Number(v)
    },
    '--pipelining': (out, v) => {
      out.pipelining = Number(v)
    },
    '--order': (out, v) => {
      out.order = String(v)
    },
    '--json-out': (out, v) => {
      out.jsonOut = String(v)
    },
    ...TARGET_ARG_HANDLERS
  })
}

interface BenchRunResult {
  rps: number
  latencyP97_5: number | null
  latencyP95: number | null
  latencyP99: number | null
  latencyAvg: number | null
  errors: number
  metrics: MetricsSummary | null
  v8prof: ProcessedV8Profile | null
}

interface BenchRow {
  fw: string
  load1: number | null
  load5: number | null
  load15: number | null
  rssMB: number | null
  heapMB: number | null
  externalMB: number | null
  arrayBuffersMB: number | null
  cpuCorePct: number | null
  cpuHostPct: number | null
  eluPct: number | null
  eldP99ms: number | null
  rps: number
  latAvgMs: number | null
  latP97_5Ms: number | null
  latP95Ms: number | null
  latP99Ms: number | null
  errors: number
  v8prof: ProcessedV8Profile | null
}

interface RunOneOptions {
  fw: string
  test: TestDefinition
  warmupSec: number
  runIndex: number
  sampleMs: number
  v8prof: boolean
  runStamp: string
  targetController: TargetController
}

/**
 * @param {object} params
 * @param {string} params.fw
 * @param {object} params.test
 * @param {number} params.warmupSec
 * @param {number} params.runIndex
 * @param {number} params.sampleMs
 * @param {boolean} params.v8prof
 * @param {string} params.runStamp
 * @param {object} params.targetController
 * @returns {object}
 */
async function runOne({
  fw,
  test,
  warmupSec,
  runIndex,
  sampleMs,
  v8prof,
  runStamp,
  targetController
}: RunOneOptions): Promise<BenchRunResult> {
  console.log(`\n[bench] ${fw}: start (run=${runIndex + 1}, test=${test.name})`)

  const tAll0 = performance.now()
  const { session, profileDir } = await targetController.start({
    serverName: 'server.js',
    fw,
    testName: test.name,
    runIndex,
    v8prof,
    runStamp
  })
  const url = targetUrl('http', session, test.path)
  const baseOpts = {
    method: test.method,
    url,
    duration: test.duration,
    connections: test.connections,
    pipelining: test.pipelining || 1,
    ...(test.headers === undefined ? {} : { headers: test.headers }),
    ...(typeof test.body === 'string' || Buffer.isBuffer(test.body) ? { body: test.body } : {}),
    verbose: false,
    safe: false,
    filePath: null
  }

  let warmupMs = 0
  let runTimed: TimedResult<LoadRun> | undefined
  let metrics: MetricsSummary | null | undefined

  try {
    if (warmupSec > 0) {
      const w = await timed(() =>
        runLoad(`${fw}-${test.name}-warmup`, { ...baseOpts, duration: warmupSec }, { track: false })
      )

      warmupMs = w.ms
      console.log(`[bench] ${fw}: warmup done in ${msToHuman(warmupMs)}`)
    }

    await session.startMetrics({ sampleMs })
    runTimed = await timed(() => runLoad(`${fw}-${test.name}`, baseOpts, { track: false }))
    metrics = await session.stopMetrics()
  } finally {
    await session.stop()
  }

  if (!runTimed) {
    throw new Error(`${fw}: measurement did not complete`)
  }

  const prof = v8prof ? await processV8Profile(profileDir).catch(() => null) : null
  const r = runTimed.result.result
  const totalMs = performance.now() - tAll0
  const out = {
    rps: r.requests?.average || 0,
    latencyP97_5: r.latency?.p97_5 ?? null,
    latencyP95: r.latency?.p95 ?? null,
    latencyP99: r.latency?.p99 ?? null,
    latencyAvg: r.latency?.average ?? null,
    errors: r.errors || 0,
    metrics: metrics ?? null,
    v8prof: prof
  }

  console.log(
    `[bench] ${fw}: done in ${msToHuman(totalMs)} (run ${msToHuman(runTimed.ms)}${warmupSec > 0 ? ` + warmup ${msToHuman(warmupMs)}` : ''}) ` +
      `rps=${Math.round(out.rps)} p99=${out.latencyP99 ?? 'n/a'}ms errors=${out.errors}`
  )

  return out
}

/**
 *
 */
async function main() {
  const args = parseBenchArgs(process.argv)
  const test = getTest(args.testName)
  const targetController = new TargetController(args, REPOSITORY_ROOT, RUNTIME_BENCHMARK_DIR)

  if (args.order !== 'random' && args.order !== 'balanced') {
    throw new Error(`Unknown --order=${args.order} (expected: random, balanced)`)
  }

  if (args.duration !== null && Number.isFinite(args.duration) && args.duration > 0) {
    test.duration = args.duration
  }

  if (args.connections !== null && Number.isFinite(args.connections) && args.connections > 0) {
    test.connections = args.connections
  }

  if (args.pipelining !== null && Number.isFinite(args.pipelining) && args.pipelining > 0) {
    test.pipelining = args.pipelining
  }

  const runStamp = formatYmdHms()
  const perFw: Record<string, BenchRunResult[]> = Object.fromEntries(args.frameworks.map((fw) => [fw, []]))
  const runRows: Array<{ run: number; rows: BenchRow[] }> = []

  console.log(
    `Run load name: ${test.name}, method:${test.method}, url:${test.path}, duration:${test.duration}, connections:${test.connections}, pipelining:${test.pipelining}`
  )

  for (let i = 0; i < args.runs; i++) {
    const rows: BenchRow[] = []
    const order =
      args.order === 'balanced'
        ? i % 2 === 0
          ? args.frameworks.slice()
          : args.frameworks.slice().reverse()
        : shuffle(args.frameworks.slice())

    console.log(`\n== run ${i + 1}/${args.runs}: ${order.join(', ')} ==`)

    for (const fw of order) {
      const res = await runOne({
        fw,
        test,
        warmupSec: args.warmup,
        runIndex: i,
        sampleMs: args.sampleMs,
        v8prof: args.v8prof,
        runStamp,
        targetController
      })

      perFw[fw]!.push(res)

      const m = res.metrics

      rows.push({
        fw,

        load1: m?.loadAvg?.[0] ?? null,
        load5: m?.loadAvg?.[1] ?? null,
        load15: m?.loadAvg?.[2] ?? null,

        rssMB: m?.memMB?.rssPeak ?? null,
        heapMB: m?.memMB?.heapUsedPeak ?? null,
        externalMB: m?.memMB?.externalPeak ?? null,
        arrayBuffersMB: m?.memMB?.arrayBuffersPeak ?? null,

        cpuCorePct: m?.cpuCorePct ?? null,
        cpuHostPct: m?.cpuHostPct ?? null,
        eluPct: m?.eluPct ?? null,
        eldP99ms: m?.eventLoopDelayMs?.p99 ?? null,

        rps: res.rps || 0,
        latAvgMs: res.latencyAvg ?? null,
        latP97_5Ms: res.latencyP97_5 ?? null,
        latP95Ms: res.latencyP95 ?? null,
        latP99Ms: res.latencyP99 ?? null,
        errors: res.errors || 0,
        v8prof: res.v8prof
      })
    }

    const byFw: Record<string, BenchRow> = {}

    for (const r of rows) {
      byFw[r.fw] = r
    }

    const extra = rows.filter((r) => !WANTED.has(r.fw))
    const ordered = [...BASE_ORDER.map((fw) => byFw[fw]).filter((row): row is BenchRow => row !== undefined), ...extra]

    console.table(
      ordered.map((r) => ({
        fw: r.fw,
        load:
          r.load1 != null && r.load5 != null && r.load15 != null
            ? `${r.load1.toFixed(2)}/${r.load5.toFixed(2)}/${r.load15.toFixed(2)}`
            : 'n/a',
        rss: r.rssMB != null ? `${r.rssMB.toFixed(0)}MB` : 'n/a',
        heap: r.heapMB != null ? `${r.heapMB.toFixed(0)}MB` : 'n/a',
        cpuCore: r.cpuCorePct != null ? `${r.cpuCorePct.toFixed(1)}%` : 'n/a',
        cpuHost: r.cpuHostPct != null ? `${r.cpuHostPct.toFixed(1)}%` : 'n/a',
        ELU: r.eluPct != null ? `${r.eluPct.toFixed(1)}%` : 'n/a',
        ELDp99: r.eldP99ms != null ? `${r.eldP99ms.toFixed(2)}ms` : 'n/a',
        rps: Math.round(r.rps),
        latAvg: r.latAvgMs != null ? `${r.latAvgMs.toFixed(2)}ms` : 'n/a',
        latP97_5: r.latP97_5Ms != null ? `${r.latP97_5Ms.toFixed(2)}ms` : 'n/a',
        latP95: r.latP95Ms != null ? `${r.latP95Ms.toFixed(2)}ms` : 'n/a',
        latP99: r.latP99Ms != null ? `${r.latP99Ms.toFixed(2)}ms` : 'n/a',
        errors: r.errors
      }))
    )

    runRows.push({ run: i + 1, rows: ordered })
  }

  console.log('\n== median ==')

  const extra = args.frameworks.filter((fw) => !WANTED.has(fw))
  const list = [...BASE_ORDER.filter((fw) => args.frameworks.includes(fw)), ...extra]
  const medians = list.map((fw) => {
    const arr = perFw[fw] ?? []
    const rps = arr.map((x) => x.rps)
    const p97_5 = arr.map((x) => x.latencyP97_5).filter((value): value is number => value !== null)
    const p95 = arr.map((x) => x.latencyP95).filter((value): value is number => value !== null)
    const p99 = arr.map((x) => x.latencyP99).filter((value): value is number => value !== null)
    const avg = arr.map((x) => x.latencyAvg).filter((value): value is number => value !== null)

    return {
      fw,
      rps: rps.length ? Math.round(median(rps)) : null,
      latAvgMs: avg.length ? Number(median(avg).toFixed(2)) : null,
      latP97_5Ms: p97_5.length ? Number(median(p97_5).toFixed(2)) : null,
      latP95Ms: p95.length ? Number(median(p95).toFixed(2)) : null,
      latP99Ms: p99.length ? Number(median(p99).toFixed(2)) : null,
      n: arr.length
    }
  })

  console.table(medians)

  const summary = {
    createdAt: new Date().toISOString(),
    test: {
      name: test.name,
      method: test.method,
      path: test.path,
      duration: test.duration,
      connections: test.connections,
      pipelining: test.pipelining || 1
    },
    options: {
      runs: args.runs,
      warmup: args.warmup,
      sampleMs: args.sampleMs,
      v8prof: args.v8prof,
      order: args.order,
      frameworks: args.frameworks
    },
    ...targetController.metadata,
    runs: runRows,
    median: medians
  }

  if (args.jsonOut) {
    await fs.mkdir(path.dirname(args.jsonOut), { recursive: true })
    await fs.writeFile(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`[bench] wrote json summary: ${args.jsonOut}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
