import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatYmdHms, msToHuman } from './helpers/format.js'
import median from './helpers/median.js'
import parseArgs from './helpers/parse-args.js'
import shuffle from './helpers/shuffle.js'
import timed from './helpers/timed-fn.js'
import waitForMessage from './helpers/wait-for-message.js'
import wsLoad from './helpers/ws-load.js'
import wsLoadOpen from './helpers/ws-load-open.js'
import { startServer, stopServer } from './helpers/server-proc.js'
import { processV8Profile } from './helpers/v8-prof-run.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const KNOWN_FRAMEWORKS = new Set(['core', 'ws'])

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
      v8prof: false,
      jsonOut: null
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
      '--v8prof': (out, v) => {
        out.v8prof = v == null ? true : v === '1' || v === 'true' || v === 'on'
      },
      '--json-out': (out, v) => {
        out.jsonOut = String(v)
      }
    }
  )
}

/**
 * @param {object} params
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
  runStamp
}) {
  console.log(`\n[ws-bench] ${fw}: start (run=${runIndex + 1})`)

  const tAll0 = performance.now()

  const runLoad = (durationSecArg) =>
    mode === 'open'
      ? wsLoadOpen({ url, connections, durationSec: durationSecArg, payloadBytes: msgSize, depth })
      : wsLoad({ url, connections, durationSec: durationSecArg, payloadBytes: msgSize })

  const { proc, port, profileDir } = await startServer({
    benchDir: __dirname,
    serverName: 'ws-server.js',
    fw,
    testName: 'ws-echo',
    runIndex,
    v8prof,
    runStamp
  })

  const url = `ws://127.0.0.1:${port}/`

  let warmupMs = 0

  if (warmupSec > 0) {
    const w = await timed(() => runLoad(warmupSec))

    warmupMs = w.ms
    console.log(`[ws-bench] ${fw}: warmup done in ${msToHuman(warmupMs)}`)
  }

  proc.send?.({ type: 'metrics:start', sampleMs })

  const runTimed = await timed(() => runLoad(durationSec))

  proc.send?.({ type: 'metrics:stop' })
  const metricsMsg = await waitForMessage(proc, (m) => m && m.type === 'metrics', 15_000)

  await stopServer(proc)

  const prof = v8prof ? await processV8Profile(profileDir).catch(() => null) : null

  const res = runTimed.result
  const m = metricsMsg?.data || null
  const totalMs = performance.now() - tAll0

  const row = {
    fw,
    msgPerSec: res.msgPerSec,
    latAvgMs: res.latencyAvgMs,
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

  for (const fw of args.frameworks) {
    if (!KNOWN_FRAMEWORKS.has(fw)) {
      throw new Error(`Unknown --fw=${fw} (ws-bench supports: ${[...KNOWN_FRAMEWORKS].join(', ')})`)
    }
  }

  if (args.mode !== 'closed' && args.mode !== 'open') {
    throw new Error(`Unknown --mode=${args.mode} (ws-bench supports: closed, open)`)
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
    const order = shuffle(args.frameworks.slice())

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
        runStamp
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
    const p97 = arr.map((x) => x.latP97_5Ms).filter((v) => v != null)
    const p99 = arr.map((x) => x.latP99Ms).filter((v) => v != null)

    return {
      fw,
      msgPerSec: msg.length ? Math.round(median(msg)) : null,
      latAvgMs: avg.length ? Number(median(avg).toFixed(3)) : null,
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
      v8prof: args.v8prof,
      frameworks: args.frameworks
    },
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
