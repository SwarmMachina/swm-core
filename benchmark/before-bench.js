import path from 'node:path'
import { fileURLToPath } from 'node:url'
import runLoad from './helpers/run-load.js'
import { formatYmdHms } from './helpers/format.js'
import timed from './helpers/timed-fn.js'
import median from './helpers/median.js'
import parseArgs from './helpers/parse-args.js'
import waitForMessage from './helpers/wait-for-message.js'
import { startServer, stopServer } from './helpers/server-proc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 'plain' = native route, handler only; 'before' = same route plus a synchronous no-op hook.
const VARIANTS = ['plain', 'before']

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseBeforeArgs(argv) {
  return parseArgs(
    argv,
    { runs: 4, warmup: 3, duration: 6, connections: 100, pipelining: 10, sampleMs: 250 },
    {
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
      '--pipelining': (out, v) => {
        out.pipelining = Number(v)
      },
      '--sample-ms': (out, v) => {
        out.sampleMs = Number(v)
      }
    }
  )
}

/**
 * @param {object} params
 * @param {string} params.variant
 * @param {number} params.warmupSec
 * @param {number} params.durationSec
 * @param {number} params.connections
 * @param {number} params.pipelining
 * @param {number} params.runIndex
 * @param {number} params.sampleMs
 * @param {string} params.runStamp
 * @returns {Promise<object>}
 */
async function runOne({ variant, warmupSec, durationSec, connections, pipelining, runIndex, sampleMs, runStamp }) {
  const { proc, port } = await startServer({
    benchDir: __dirname,
    serverName: 'before-server.js',
    fw: variant,
    testName: 'before',
    runIndex,
    v8prof: false,
    runStamp
  })
  const url = `http://127.0.0.1:${port}/`
  const baseOpts = {
    method: 'GET',
    url,
    duration: durationSec,
    connections,
    pipelining,
    verbose: false,
    safe: false
  }

  if (warmupSec > 0) {
    await runLoad(`${variant}-warmup`, { ...baseOpts, duration: warmupSec }, { track: false })
  }

  proc.send?.({ type: 'metrics:start', sampleMs })

  const runTimed = await timed(() => runLoad(variant, baseOpts, { track: false }))

  proc.send?.({ type: 'metrics:stop' })
  const metricsMsg = await waitForMessage(proc, (m) => m && m.type === 'metrics', 15_000)

  await stopServer(proc)

  const r = runTimed.result.result
  const m = metricsMsg?.data || null

  return {
    variant,
    rps: r.requests?.average || 0,
    latAvgMs: r.latency?.average ?? null,
    latP97_5Ms: r.latency?.p97_5 ?? null,
    latP99Ms: r.latency?.p99 ?? null,
    errors: r.errors || 0,
    rssMB: m?.memMB?.rssPeak ?? null,
    heapMB: m?.memMB?.heapUsedPeak ?? null,
    cpuCorePct: m?.cpuCorePct ?? null,
    eluPct: m?.eluPct ?? null
  }
}

/**
 *
 */
async function main() {
  const args = parseBeforeArgs(process.argv)
  const runStamp = formatYmdHms()
  const per = Object.fromEntries(VARIANTS.map((v) => [v, []]))

  console.log(
    `Run before-hook bench: variants:${VARIANTS.join(',')}, connections:${args.connections}, ` +
      `pipelining:${args.pipelining}, duration:${args.duration}, runs:${args.runs}`
  )

  for (let i = 0; i < args.runs; i++) {
    console.log(`\n== run ${i + 1}/${args.runs} ==`)

    const order = i % 2 === 0 ? VARIANTS : VARIANTS.slice().reverse()

    for (const variant of order) {
      const row = await runOne({
        variant,
        warmupSec: args.warmup,
        durationSec: args.duration,
        connections: args.connections,
        pipelining: args.pipelining,
        runIndex: i,
        sampleMs: args.sampleMs,
        runStamp
      })

      per[variant].push(row)

      console.log(
        `[before-bench] ${variant}: rps=${Math.round(row.rps)} ` +
          `p99=${row.latP99Ms != null ? row.latP99Ms.toFixed(2) : 'n/a'}ms ` +
          `heap=${row.heapMB != null ? row.heapMB.toFixed(0) : 'n/a'}MB errors=${row.errors}`
      )
    }
  }

  const medians = VARIANTS.map((variant) => {
    const arr = per[variant]
    const med = (key) => {
      const values = arr.map((x) => x[key]).filter((v) => v != null)

      return values.length ? median(values) : null
    }
    const round = (v, digits) => (v != null ? Number(v.toFixed(digits)) : null)

    return {
      variant,
      rps: med('rps') != null ? Math.round(med('rps')) : null,
      latAvgMs: round(med('latAvgMs'), 3),
      latP97_5Ms: round(med('latP97_5Ms'), 3),
      latP99Ms: round(med('latP99Ms'), 3),
      rssMB: round(med('rssMB'), 1),
      heapMB: round(med('heapMB'), 1),
      cpuCorePct: round(med('cpuCorePct'), 1),
      eluPct: round(med('eluPct'), 1)
    }
  })

  console.log('\n== median ==')
  console.table(medians)

  const plain = medians.find((m) => m.variant === 'plain')
  const before = medians.find((m) => m.variant === 'before')

  if (plain?.rps && before?.rps) {
    const rpsDelta = ((before.rps - plain.rps) / plain.rps) * 100
    const heapDelta = plain.heapMB != null && before.heapMB != null ? before.heapMB - plain.heapMB : null

    console.log(
      `\nbefore-hook overhead vs plain: rps ${rpsDelta >= 0 ? '+' : ''}${rpsDelta.toFixed(1)}%` +
        (heapDelta != null ? `, heap ${heapDelta >= 0 ? '+' : ''}${heapDelta.toFixed(1)}MB` : '')
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
