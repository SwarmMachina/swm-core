import fs from 'node:fs/promises'
import path from 'node:path'
import { runWebSocketLoad } from '@swarmmachina/benchkit/load/websocket'
import type { WebSocketLoadResult } from '@swarmmachina/benchkit/load/websocket'
import { timed, type MetricsSummary, type TimedResult } from '@swarmmachina/benchkit/measurement'
import { parseArgs, shuffle } from '@swarmmachina/benchkit/orchestration'
import { processV8Profile, type ProcessedV8Profile } from '@swarmmachina/benchkit/profiling'
import { formatYmdHms, msToHuman } from '@swarmmachina/benchkit/reporting'
import { median } from '@swarmmachina/benchkit/statistics'
import {
  assertNonEmpty,
  assertNonNegativeFinite,
  assertPositiveFinite,
  assertPositiveSafeInteger
} from './helpers/bench-args.js'
import { TargetController } from './helpers/target-controller.js'
import { TARGET_ARG_HANDLERS, targetDefaults, targetUrl } from './helpers/target-session.js'
import { REPOSITORY_ROOT, RUNTIME_BENCHMARK_DIR } from './runtime-paths.js'
import type { TargetArgs } from './types.js'

const KNOWN_FRAMEWORKS = new Set([
  'core',
  'core-swm-uws',
  'core-uwebsockets',
  'raw-swm-uws',
  'raw-uwebsockets',
  'hyperexpress',
  'ws'
])

/**
 * @param {string[]} argv
 * @returns {object}
 */
interface WsBenchArgs extends TargetArgs {
  frameworks: string[]
  runs: number
  warmup: number
  duration: number
  connections: number
  workers: number
  sampleMs: number
  msgSize: number
  mode: string
  depth: number
  order: string
  v8prof: boolean
  jsonOut: string | null
}

function parseWsBenchArgs(argv: string[]): WsBenchArgs {
  const defaults: WsBenchArgs = {
    frameworks: ['core'],
    runs: 1,
    warmup: 2,
    duration: 6,
    connections: 50,
    workers: 4,
    sampleMs: 250,
    msgSize: 64,
    mode: 'closed',
    depth: 16,
    order: 'random',
    v8prof: false,
    jsonOut: null,
    ...targetDefaults()
  }

  return parseArgs(argv, defaults, {
    '--fw': (out, v) => {
      out.frameworks = String(v)
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
    '--workers': (out, v) => {
      out.workers = Number(v)
    },
    '--sample-ms': (out, v) => {
      out.sampleMs = Number(v)
    },
    '--msg-size': (out, v) => {
      out.msgSize = Number(v)
    },
    '--mode': (out, v) => {
      out.mode = String(v)
    },
    '--depth': (out, v) => {
      out.depth = Number(v)
    },
    '--order': (out, v) => {
      out.order = String(v)
    },
    '--v8prof': (out, v) => {
      out.v8prof = v == null ? true : v === '1' || v === 'true' || v === 'on'
    },
    '--json-out': (out, v) => {
      out.jsonOut = String(v)
    },
    ...TARGET_ARG_HANDLERS
  })
}

function validateWsBenchArgs(args: WsBenchArgs): void {
  assertNonEmpty(args.frameworks, '--fw')
  assertPositiveSafeInteger(args.runs, '--runs')
  assertNonNegativeFinite(args.warmup, '--warmup')
  assertPositiveFinite(args.duration, '--duration')
  assertPositiveSafeInteger(args.connections, '--connections')
  assertPositiveSafeInteger(args.workers, '--workers')
  assertPositiveSafeInteger(args.sampleMs, '--sample-ms')
  assertPositiveSafeInteger(args.msgSize, '--msg-size')
  assertPositiveSafeInteger(args.depth, '--depth')
}

interface WsRow {
  fw: string
  msgPerSec: number
  latAvgMs: number | null
  latP95Ms: number | null
  latP97_5Ms: number | null
  latP99Ms: number | null
  errors: number
  eluPct: number | null
  eldP99ms: number | null
  rssMB: number | null
  heapMB: number | null
  externalMB: number | null
  arrayBuffersMB: number | null
  loadWorkers: number
  loadEluPct: number
  loadRssMB: number
  loadCpuCorePct: number
  loadSaturated: boolean
  loadBackpressureEvents: number
  loadInFlightAtStop: number
  loadDropped: number
  v8prof: ProcessedV8Profile | null
}

interface WsRunOptions {
  fw: string
  warmupSec: number
  durationSec: number
  connections: number
  workers: number
  msgSize: number
  mode: 'open' | 'closed'
  depth: number
  runIndex: number
  sampleMs: number
  v8prof: boolean
  runStamp: string
  targetController: TargetController
}

/**
 * @param {object} params
 * @param {string} params.fw
 * @param {number} params.warmupSec
 * @param {number} params.durationSec
 * @param {number} params.connections
 * @param {number} params.workers
 * @param {number} params.msgSize
 * @param {'open'|'closed'} params.mode
 * @param {number} params.depth
 * @param {number} params.runIndex
 * @param {number} params.sampleMs
 * @param {boolean} params.v8prof
 * @param {string} params.runStamp
 * @param {object} params.targetController
 * @returns {Promise<{row: object, profileDir: string|null}>}
 */
async function runOne({
  fw,
  warmupSec,
  durationSec,
  connections,
  workers,
  msgSize,
  mode,
  depth,
  runIndex,
  sampleMs,
  v8prof,
  runStamp,
  targetController
}: WsRunOptions): Promise<{ row: WsRow; profileDir: string | null }> {
  console.log(`\n[ws-bench] ${fw}: start (run=${runIndex + 1})`)

  const tAll0 = performance.now()
  const { session, profileDir } = await targetController.start({
    serverName: 'ws-server.js',
    fw,
    testName: 'ws-echo',
    runIndex,
    v8prof,
    runStamp
  })
  const url = targetUrl('ws', session, '/')
  const maxInFlight = mode === 'open' ? depth : 1
  const message = new Uint8Array(Math.max(1, msgSize)).fill(0x61)
  const runLoad = (durationSecArg: number): Promise<WebSocketLoadResult> =>
    runWebSocketLoad({
      name: `${fw} ws-echo`,
      url,
      message,
      connections,
      workers,
      maxInFlight,
      durationMs: durationSecArg * 1000,
      timeoutMs: 5000
    })

  let runTimed: TimedResult<WebSocketLoadResult> | undefined
  let m: MetricsSummary | null | undefined

  try {
    if (warmupSec > 0) {
      const w = await timed(() => runLoad(warmupSec))

      console.log(`[ws-bench] ${fw}: warmup done in ${msToHuman(w.ms)}`)
    }

    await session.startMetrics({ sampleMs })
    runTimed = await timed(() => runLoad(durationSec))
    m = await session.stopMetrics()
  } finally {
    await session.stop()
  }

  if (!runTimed) {
    throw new Error(`${fw}: measurement did not complete`)
  }

  const res = runTimed.result
  const totalMs = performance.now() - tAll0
  const row = {
    fw,
    msgPerSec: res.messages.averagePerSecond,
    latAvgMs: res.latencyMs.averageMs,
    latP95Ms: res.latencyMs.p95Ms,
    latP97_5Ms: res.latencyMs.p97_5Ms,
    latP99Ms: res.latencyMs.p99Ms,
    errors: res.errors.total,
    eluPct: m?.eluPct ?? null,
    eldP99ms: m?.eventLoopDelayMs?.p99 ?? null,
    rssMB: m?.memMB?.rssPeak ?? null,
    heapMB: m?.memMB?.heapUsedPeak ?? null,
    externalMB: m?.memMB?.externalPeak ?? null,
    arrayBuffersMB: m?.memMB?.arrayBuffersPeak ?? null,
    loadWorkers: res.parameters.workers,
    loadEluPct: res.loadGenerator.maxWorkerEluPct,
    loadRssMB: res.loadGenerator.processMemory.rss.peakBytes / (1024 * 1024),
    loadCpuCorePct: res.loadGenerator.cpuCorePct,
    loadSaturated: res.loadGenerator.saturated,
    loadBackpressureEvents: res.transport.backpressureEvents,
    loadInFlightAtStop: res.transport.inFlightAtStop,
    loadDropped: res.transport.rateDropped,
    v8prof: null
  }

  console.log(
    `[ws-bench] ${fw}: done in ${msToHuman(totalMs)} ` +
      `msg/s=${Math.round(row.msgPerSec)} p99=${row.latP99Ms != null ? row.latP99Ms.toFixed(2) : 'n/a'}ms errors=${row.errors}`
  )

  return { row, profileDir: v8prof ? profileDir : null }
}

/**
 *
 */
async function main() {
  const args = parseWsBenchArgs(process.argv)

  validateWsBenchArgs(args)

  const targetController = new TargetController(args, REPOSITORY_ROOT, RUNTIME_BENCHMARK_DIR)

  for (const fw of args.frameworks) {
    if (!KNOWN_FRAMEWORKS.has(fw)) {
      throw new Error(`Unknown --fw=${fw} (ws-bench supports: ${[...KNOWN_FRAMEWORKS].join(', ')})`)
    }
  }

  if (args.mode !== 'closed' && args.mode !== 'open') {
    throw new Error(`Unknown --mode=${args.mode} (ws-bench supports: closed, open)`)
  }

  const mode = args.mode as 'closed' | 'open'

  if (args.order !== 'random' && args.order !== 'balanced') {
    throw new Error(`Unknown --order=${args.order} (expected: random, balanced)`)
  }

  const runStamp = formatYmdHms()
  const perFw: Record<string, WsRow[]> = Object.fromEntries(args.frameworks.map((fw) => [fw, []]))
  const runRows: Array<{ run: number; rows: WsRow[] }> = []
  const pendingProfiles: Array<{ row: WsRow; profileDir: string }> = []
  const modeLabel = args.mode === 'open' ? `open(depth=${args.depth})` : 'closed'

  console.log(
    `Run ws-echo: frameworks:${args.frameworks.join(',')}, mode:${modeLabel}, connections:${args.connections}, workers:${args.workers}, duration:${args.duration}, msgSize:${args.msgSize}`
  )

  for (let i = 0; i < args.runs; i++) {
    const rows: WsRow[] = []
    const order =
      args.order === 'balanced'
        ? i % 2 === 0
          ? args.frameworks.slice()
          : args.frameworks.slice().reverse()
        : shuffle(args.frameworks.slice())

    console.log(`\n== run ${i + 1}/${args.runs}: ${order.join(', ')} ==`)

    for (const fw of order) {
      const { row, profileDir } = await runOne({
        fw,
        warmupSec: args.warmup,
        durationSec: args.duration,
        connections: args.connections,
        workers: args.workers,
        msgSize: args.msgSize,
        mode,
        depth: args.depth,
        runIndex: i,
        sampleMs: args.sampleMs,
        v8prof: args.v8prof,
        runStamp,
        targetController
      })

      perFw[fw]!.push(row)
      rows.push(row)

      if (profileDir) {
        pendingProfiles.push({ row, profileDir })
      }
    }

    const ordered = args.frameworks
      .map((fw) => rows.find((row) => row.fw === fw))
      .filter((row): row is WsRow => row !== undefined)

    console.table(
      ordered.map((r) => ({
        fw: r.fw,
        msgPerSec: Math.round(r.msgPerSec),
        latAvg: r.latAvgMs != null ? `${r.latAvgMs.toFixed(3)}ms` : 'n/a',
        latP95: r.latP95Ms != null ? `${r.latP95Ms.toFixed(3)}ms` : 'n/a',
        latP99: r.latP99Ms != null ? `${r.latP99Ms.toFixed(3)}ms` : 'n/a',
        rss: r.rssMB != null ? `${r.rssMB.toFixed(0)}MB` : 'n/a',
        heap: r.heapMB != null ? `${r.heapMB.toFixed(0)}MB` : 'n/a',
        ELU: r.eluPct != null ? `${r.eluPct.toFixed(1)}%` : 'n/a',
        loadWorkers: r.loadWorkers,
        loadELU: r.loadEluPct != null ? `${r.loadEluPct.toFixed(1)}%` : 'n/a',
        loadRSS: r.loadRssMB != null ? `${r.loadRssMB.toFixed(0)}MB` : 'n/a',
        errors: r.errors
      }))
    )

    runRows.push({ run: i + 1, rows: ordered })
  }

  for (const profile of pendingProfiles) {
    profile.row.v8prof = await processV8Profile(profile.profileDir).catch(() => null)
  }

  console.log('\n== median ==')

  const medians = args.frameworks.map((fw) => {
    const arr = perFw[fw] ?? []
    const msg = arr.map((row) => row.msgPerSec)
    const avg = arr.map((row) => row.latAvgMs).filter((value): value is number => value !== null)
    const p95 = arr.map((row) => row.latP95Ms).filter((value): value is number => value !== null)
    const p97 = arr.map((row) => row.latP97_5Ms).filter((value): value is number => value !== null)
    const p99 = arr.map((row) => row.latP99Ms).filter((value): value is number => value !== null)

    return {
      fw,
      msgPerSec: msg.length ? Math.round(median(msg)) : null,
      latAvgMs: avg.length ? Number(median(avg).toFixed(3)) : null,
      latP95Ms: p95.length ? Number(median(p95).toFixed(3)) : null,
      latP97_5Ms: p97.length ? Number(median(p97).toFixed(3)) : null,
      latP99Ms: p99.length ? Number(median(p99).toFixed(3)) : null,
      n: arr.length
    }
  })

  console.table(medians)

  const summary = {
    createdAt: new Date().toISOString(),
    test: {
      name: 'ws-echo',
      connections: args.connections,
      workers: args.workers,
      duration: args.duration,
      msgSize: args.msgSize,
      maxInFlight: args.mode === 'open' ? args.depth : 1
    },
    options: {
      runs: args.runs,
      warmup: args.warmup,
      workers: args.workers,
      sampleMs: args.sampleMs,
      mode: args.mode,
      depth: args.depth,
      order: args.order,
      v8prof: args.v8prof,
      frameworks: args.frameworks
    },
    ...targetController.metadata,
    runs: runRows,
    median: medians
  }

  if (args.jsonOut) {
    await fs.mkdir(path.dirname(args.jsonOut), { recursive: true })
    await fs.writeFile(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`[ws-bench] wrote json summary: ${args.jsonOut}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
