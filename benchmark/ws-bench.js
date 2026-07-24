import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { timed } from '@swarmmachina/benchkit/measurement'
import { parseArgs, shuffle } from '@swarmmachina/benchkit/orchestration'
import { processV8Profile } from '@swarmmachina/benchkit/profiling'
import { formatYmdHms, msToHuman } from '@swarmmachina/benchkit/reporting'
import { median } from '@swarmmachina/benchkit/statistics'
import wsLoad from './helpers/ws-load.js'
import wsLoadOpen from './helpers/ws-load-open.js'
import { TargetController } from './helpers/target-controller.js'
import { TARGET_ARG_HANDLERS, targetDefaults, targetUrl } from './helpers/target-session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KNOWN_FRAMEWORKS = new Set(['core', 'core-swm-uws', 'core-uwebsockets', 'raw-swm-uws', 'raw-uwebsockets', 'ws'])

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseWsBenchArgs(argv) {
  return parseArgs(
    argv,
    {
      frameworks: ['core'],
      runs: 1,
      warmup: 2,
      duration: 6,
      connections: 50,
      sampleMs: 250,
      msgSize: 64,
      mode: 'closed',
      depth: 16,
      order: 'random',
      v8prof: false,
      jsonOut: null,
      ...targetDefaults()
    },
    {
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
    }
  )
}

/**
 * @param {object} params
 * @param {string} params.fw
 * @param {number} params.warmupSec
 * @param {number} params.durationSec
 * @param {number} params.connections
 * @param {number} params.msgSize
 * @param {'open'|'closed'} params.mode
 * @param {number} params.depth
 * @param {number} params.runIndex
 * @param {number} params.sampleMs
 * @param {boolean} params.v8prof
 * @param {string} params.runStamp
 * @param {object} params.targetController
 * @returns {Promise<object>}
 */
async function runOne({
  fw,
  warmupSec,
  durationSec,
  connections,
  msgSize,
  mode,
  depth,
  runIndex,
  sampleMs,
  v8prof,
  runStamp,
  targetController
}) {
  console.log(`\n[ws-bench] ${fw}: start (run=${runIndex + 1})`)

  const tAll0 = performance.now()
  const runLoad = (durationSecArg) =>
    mode === 'open'
      ? wsLoadOpen({ url, connections, durationSec: durationSecArg, payloadBytes: msgSize, depth })
      : wsLoad({ url, connections, durationSec: durationSecArg, payloadBytes: msgSize })
  const { session, profileDir } = await targetController.start({
    benchDir: __dirname,
    serverName: 'ws-server.js',
    fw,
    testName: 'ws-echo',
    runIndex,
    v8prof,
    runStamp
  })
  const url = targetUrl('ws', session, '/')

  let runTimed
  let m

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

  const prof = v8prof ? await processV8Profile(profileDir).catch(() => null) : null
  const res = runTimed.result
  const totalMs = performance.now() - tAll0
  const row = {
    fw,
    msgPerSec: res.msgPerSec,
    latAvgMs: res.latencyAvgMs,
    latP95Ms: res.latencyP95Ms,
    latP97_5Ms: res.latencyP97_5Ms,
    latP99Ms: res.latencyP99Ms,
    errors: res.errors,
    eluPct: m?.eluPct ?? null,
    eldP99ms: m?.eventLoopDelayMs?.p99 ?? null,
    rssMB: m?.memMB?.rssPeak ?? null,
    heapMB: m?.memMB?.heapUsedPeak ?? null,
    externalMB: m?.memMB?.externalPeak ?? null,
    arrayBuffersMB: m?.memMB?.arrayBuffersPeak ?? null,
    v8prof: prof
  }

  console.log(
    `[ws-bench] ${fw}: done in ${msToHuman(totalMs)} ` +
      `msg/s=${Math.round(row.msgPerSec)} p99=${row.latP99Ms != null ? row.latP99Ms.toFixed(2) : 'n/a'}ms errors=${row.errors}`
  )

  return row
}

/**
 *
 */
async function main() {
  const args = parseWsBenchArgs(process.argv)
  const targetController = new TargetController(args, path.dirname(__dirname))

  for (const fw of args.frameworks) {
    if (!KNOWN_FRAMEWORKS.has(fw)) {
      throw new Error(`Unknown --fw=${fw} (ws-bench supports: ${[...KNOWN_FRAMEWORKS].join(', ')})`)
    }
  }

  if (args.mode !== 'closed' && args.mode !== 'open') {
    throw new Error(`Unknown --mode=${args.mode} (ws-bench supports: closed, open)`)
  }

  if (args.order !== 'random' && args.order !== 'balanced') {
    throw new Error(`Unknown --order=${args.order} (expected: random, balanced)`)
  }

  const runStamp = formatYmdHms()
  const perFw = Object.fromEntries(args.frameworks.map((fw) => [fw, []]))
  const runRows = []
  const modeLabel = args.mode === 'open' ? `open(depth=${args.depth})` : 'closed'

  console.log(
    `Run ws-echo: frameworks:${args.frameworks.join(',')}, mode:${modeLabel}, connections:${args.connections}, duration:${args.duration}, msgSize:${args.msgSize}`
  )

  for (let i = 0; i < args.runs; i++) {
    const rows = []
    const order =
      args.order === 'balanced'
        ? i % 2 === 0
          ? args.frameworks.slice()
          : args.frameworks.slice().reverse()
        : shuffle(args.frameworks.slice())

    console.log(`\n== run ${i + 1}/${args.runs}: ${order.join(', ')} ==`)

    for (const fw of order) {
      const row = await runOne({
        fw,
        warmupSec: args.warmup,
        durationSec: args.duration,
        connections: args.connections,
        msgSize: args.msgSize,
        mode: args.mode,
        depth: args.depth,
        runIndex: i,
        sampleMs: args.sampleMs,
        v8prof: args.v8prof,
        runStamp,
        targetController
      })

      perFw[fw].push(row)
      rows.push(row)
    }

    const ordered = args.frameworks.map((fw) => rows.find((r) => r.fw === fw)).filter(Boolean)

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
        errors: r.errors
      }))
    )

    runRows.push({ run: i + 1, rows: ordered })
  }

  console.log('\n== median ==')

  const medians = args.frameworks.map((fw) => {
    const arr = perFw[fw] || []
    const msg = arr.map((x) => x.msgPerSec).filter((v) => v != null)
    const avg = arr.map((x) => x.latAvgMs).filter((v) => v != null)
    const p95 = arr.map((x) => x.latP95Ms).filter((v) => v != null)
    const p97 = arr.map((x) => x.latP97_5Ms).filter((v) => v != null)
    const p99 = arr.map((x) => x.latP99Ms).filter((v) => v != null)

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
      duration: args.duration,
      msgSize: args.msgSize
    },
    options: {
      runs: args.runs,
      warmup: args.warmup,
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
