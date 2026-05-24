import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import delay from '../helpers/delay.js'
import { getFreePort } from '../helpers/ports.js'
import { getTest } from './tests.js'
import runLoad from './helpers/run-load.js'
import { spawn } from 'child_process'
import shuffle from './helpers/shuffle.js'
import ensureDir from './helpers/ensure-dir.js'
import { formatYmdHms, msToHuman } from './helpers/format.js'
import timed from './helpers/timed-fn.js'
import median from './helpers/median.js'
import parseArgs from './helpers/parse-args.js'
import waitForMessage from './helpers/wait-for-message.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BASE_ORDER = ['core', 'micro', 'fastify', 'express']
const WANTED = new Set(BASE_ORDER)
const SERVER_READY_TIMEOUT_MS = 60_000

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseBenchArgs(argv) {
  return parseArgs(
    argv,
    {
      testName: 'base',
      frameworks: [...BASE_ORDER],
      runs: 1,
      warmup: 10,
      sampleMs: 250,
      v8prof: false,
      duration: null,
      connections: null,
      pipelining: null,
      jsonOut: null
    },
    {
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
      '--json-out': (out, v) => {
        out.jsonOut = String(v)
      }
    }
  )
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function pickNewestLog(dir) {
  const items = await fs.readdir(dir)
  const logs = items.filter((f) => f.startsWith('isolate-') && f.endsWith('-v8.log'))

  if (!logs.length) {
    return null
  }

  let best = null

  for (const f of logs) {
    const st = await fs.stat(path.join(dir, f))

    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { f, mtimeMs: st.mtimeMs, size: st.size }
    }
  }

  return best?.f || null
}

/**
 * @param {string} profileDir
 * @returns {object}
 */
async function processV8Profile(profileDir) {
  const logName = await pickNewestLog(profileDir)

  if (!logName) {
    return null
  }

  const logPath = path.join(profileDir, logName)
  const outPath = path.join(profileDir, 'profile.txt')

  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', '--prof-process', logPath], {
      stdio: ['ignore', 'pipe', 'inherit']
    })

    const out = createWriteStream(outPath)

    p.stdout.pipe(out)

    p.on('error', reject)
    p.on('exit', (code) => {
      out.end()
      if (code === 0) {
        resolve(true)
      } else {
        reject(new Error(`prof-process failed with code ${code}`))
      }
    })
  })

  return { logPath, processedPath: outPath }
}

/**
 * @param {object} o
 * @param {string} o.fw
 * @param {string} o.testName
 * @param {number} o.runIndex
 * @param {boolean} o.v8prof
 * @param {string} o.runStamp
 * @returns {object}
 */
async function startServer({ fw, testName, runIndex, v8prof, runStamp }) {
  const serverPath = path.join(__dirname, 'server.js')
  const port = await getFreePort()

  const profileDir = await ensureDir(
    path.join(__dirname, 'profiles', `${testName}-${runStamp}`, `run-${runIndex + 1}`, fw)
  )

  const nodeArgs = []

  if (v8prof) {
    nodeArgs.push('--prof')
  }

  nodeArgs.push(serverPath, '--fw', fw, '--port', port)

  const p = spawn(process.execPath, nodeArgs, {
    cwd: profileDir,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })

  const msg = await waitForMessage(p, (m) => m && m.type === 'ready', SERVER_READY_TIMEOUT_MS).catch((e) => {
    p.kill('SIGKILL')
    throw e
  })

  if (!msg || msg.type !== 'ready' || !msg.port) {
    p.kill('SIGKILL')
    throw new Error(`bad ready from ${fw}`)
  }

  return { proc: p, port: msg.port, profileDir }
}

/**
 * @param {ChildProcess} p
 */
async function stopServer(p) {
  if (p.exitCode != null) {
    return
  }

  p.kill('SIGTERM')

  const ok = await Promise.race([
    once(p, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
  ])

  if (!ok) {
    p.kill('SIGKILL')
    await Promise.race([once(p, 'exit'), delay(2000)])
  }
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
 * @returns {object}
 */
async function runOne({ fw, test, warmupSec, runIndex, sampleMs, v8prof, runStamp }) {
  console.log(`\n[bench] ${fw}: start (run=${runIndex + 1}, test=${test.name})`)

  const tAll0 = performance.now()

  const { proc, port, profileDir } = await startServer({ fw, testName: test.name, runIndex, v8prof, runStamp })

  const url = `http://127.0.0.1:${port}${test.path}`

  const baseOpts = {
    method: test.method,
    url,
    duration: test.duration,
    connections: test.connections,
    pipelining: test.pipelining || 1,
    headers: test.headers || {},
    body: test.body || undefined,
    verbose: false,
    safe: false,
    filePath: null
  }

  let warmupMs = 0

  if (warmupSec > 0) {
    const w = await timed(() =>
      runLoad(`${fw}-${test.name}-warmup`, { ...baseOpts, duration: warmupSec }, { profile: false, track: false })
    )

    warmupMs = w.ms
    console.log(`[bench] ${fw}: warmup done in ${msToHuman(warmupMs)}`)
  }

  proc.send?.({ type: 'metrics:start', sampleMs })

  const runTimed = await timed(() => runLoad(`${fw}-${test.name}`, baseOpts, { profile: false, track: false }))

  proc.send?.({ type: 'metrics:stop' })
  const metricsMsg = await waitForMessage(proc, (m) => m && m.type === 'metrics', 15_000)

  await stopServer(proc)

  const prof = v8prof ? await processV8Profile(profileDir).catch(() => null) : null

  const r = runTimed.result.result
  const totalMs = performance.now() - tAll0

  const out = {
    rps: r.requests?.average || 0,
    latencyP97_5: r.latency?.p97_5 ?? null,
    latencyP99: r.latency?.p99 ?? null,
    latencyAvg: r.latency?.average ?? null,
    errors: r.errors || 0,
    metrics: metricsMsg?.data || null,
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

  if (Number.isFinite(args.duration) && args.duration > 0) {
    test.duration = args.duration
  }

  if (Number.isFinite(args.connections) && args.connections > 0) {
    test.connections = args.connections
  }

  if (Number.isFinite(args.pipelining) && args.pipelining > 0) {
    test.pipelining = args.pipelining
  }

  const runStamp = formatYmdHms()
  const perFw = Object.fromEntries(args.frameworks.map((fw) => [fw, []]))
  const runRows = []

  console.log(
    `Run load name: ${test.name}, method:${test.method}, url:${test.path}, duration:${test.duration}, connections:${test.connections}, pipelining:${test.pipelining}`
  )

  for (let i = 0; i < args.runs; i++) {
    const rows = []
    const order = shuffle(args.frameworks.slice())

    console.log(`\n== run ${i + 1}/${args.runs}: ${order.join(', ')} ==`)

    for (const fw of order) {
      const res = await runOne({
        fw,
        test,
        warmupSec: args.warmup,
        runIndex: i,
        sampleMs: args.sampleMs,
        v8prof: args.v8prof,
        runStamp
      })

      perFw[fw].push(res)

      const m = res.metrics

      rows.push({
        fw,

        load1: m?.loadAvg?.[0] ?? null,
        load5: m?.loadAvg?.[1] ?? null,
        load15: m?.loadAvg?.[2] ?? null,

        rssMB: m?.memMB?.rssPeak ?? null,
        heapMB: m?.memMB?.heapUsedPeak ?? null,

        cpuCorePct: m?.cpuCorePct ?? null,
        cpuHostPct: m?.cpuHostPct ?? null,
        eluPct: m?.eluPct ?? null,
        eldP99ms: m?.eventLoopDelayMs?.p99 ?? null,

        rps: res.rps || 0,
        latAvgMs: res.latencyAvg ?? null,
        latP97_5Ms: res.latencyP97_5 ?? null,
        latP99Ms: res.latencyP99 ?? null,
        errors: res.errors || 0,
        v8prof: res.v8prof
      })
    }

    const byFw = Object.create(null)

    for (const r of rows) {
      byFw[r.fw] = r
    }

    const extra = rows.filter((r) => !WANTED.has(r.fw))
    const ordered = [...BASE_ORDER.map((fw) => byFw[fw]).filter(Boolean), ...extra]

    console.table(
      ordered.map((r) => ({
        fw: r.fw,
        load: r.load1 != null ? `${r.load1.toFixed(2)}/${r.load5.toFixed(2)}/${r.load15.toFixed(2)}` : 'n/a',
        rss: r.rssMB != null ? `${r.rssMB.toFixed(0)}MB` : 'n/a',
        heap: r.heapMB != null ? `${r.heapMB.toFixed(0)}MB` : 'n/a',
        cpuCore: r.cpuCorePct != null ? `${r.cpuCorePct.toFixed(1)}%` : 'n/a',
        cpuHost: r.cpuHostPct != null ? `${r.cpuHostPct.toFixed(1)}%` : 'n/a',
        ELU: r.eluPct != null ? `${r.eluPct.toFixed(1)}%` : 'n/a',
        ELDp99: r.eldP99ms != null ? `${r.eldP99ms.toFixed(2)}ms` : 'n/a',
        rps: Math.round(r.rps),
        latAvg: r.latAvgMs != null ? `${r.latAvgMs.toFixed(2)}ms` : 'n/a',
        latP97_5: r.latP97_5Ms != null ? `${r.latP97_5Ms.toFixed(2)}ms` : 'n/a',
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
    const arr = perFw[fw] || []
    const rps = arr.map((x) => x.rps)
    const p97_5 = arr.map((x) => x.latencyP97_5).filter((v) => v != null)
    const p99 = arr.map((x) => x.latencyP99).filter((v) => v != null)
    const avg = arr.map((x) => x.latencyAvg).filter((v) => v != null)

    return {
      fw,
      rps: rps.length ? Math.round(median(rps)) : null,
      latAvgMs: avg.length ? Number(median(avg).toFixed(2)) : null,
      latP97_5Ms: p97_5.length ? Number(median(p97_5).toFixed(2)) : null,
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
      frameworks: args.frameworks
    },
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
