// bench/bench.mjs
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTest } from './tests.js'
import runLoad from './helpers/run-load.js'
import { spawn } from 'child_process'
import delay from './helpers/delay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const out = {
    testName: 'base',
    frameworks: ['core', 'express', 'fastify', 'micro'],
    runs: 1,
    warmup: 10,
    sampleMs: 250,
    v8prof: false
  }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]

    if (a === '--test') {
      i++
      out.testName = String(v)
    } else if (a === '--runs') {
      i++
      out.runs = Number(v)
    } else if (a === '--warmup') {
      i++
      out.warmup = Number(v)
    } else if (a === '--fw') {
      i++
      out.frameworks = String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (a === '--sample-ms') {
      i++
      out.sampleMs = Number(v)
    } else if (a === '--v8prof') {
      i++
      out.v8prof = v == null ? true : v === '1' || v === 'true' || v === 'on'
    }
  }

  return out
}

/**
 * @param {string[]} arr
 * @returns {string[]}
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0

    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * @param {ChildProcess} p
 * @param {Function} predicate
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function waitForMessage(p, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      try {
        if (predicate(msg)) {
          cleanup()
          resolve(msg)
        }
      } catch (e) {
        cleanup()
        reject(e)
      }
    }

    const t = setTimeout(() => {
      cleanup()
      reject(new Error('timeout waiting for IPC message'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(t)
      p.off('message', onMessage)
    }

    p.on('message', onMessage)
  })
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
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
 * @param {Date} d
 * @returns {string}
 */
function makeRunStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')

  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
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

  const profileDir = await ensureDir(
    path.join(__dirname, 'profiles', `${testName}-${runStamp}`, `run-${runIndex + 1}`, fw)
  )

  const nodeArgs = []

  if (v8prof) {
    nodeArgs.push('--prof')
  }

  nodeArgs.push(serverPath, '--fw', fw, '--port', '3000')

  const p = spawn(process.execPath, nodeArgs, {
    cwd: profileDir,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })

  const [msg] = await once(p, 'message')

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
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const a = values.slice().sort((x, y) => x - y)
  const mid = (a.length / 2) | 0

  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
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

  if (warmupSec > 0) {
    await runLoad(`${fw}-${test.name}-warmup`, { ...baseOpts, duration: warmupSec }, { profile: false, track: false })
  }

  proc.send?.({ type: 'metrics:start', sampleMs })

  const load = await runLoad(`${fw}-${test.name}`, baseOpts, { profile: false, track: false })

  proc.send?.({ type: 'metrics:stop' })
  const metricsMsg = await waitForMessage(proc, (m) => m && m.type === 'metrics', 15_000)

  await stopServer(proc)

  const prof = v8prof ? await processV8Profile(profileDir).catch(() => null) : null

  const r = load.result

  return {
    rps: r.requests?.average || 0,
    latencyP99: r.latency?.p99 || null,
    latencyAvg: r.latency?.average || null,
    errors: r.errors || 0,
    metrics: metricsMsg?.data || null,
    v8prof: prof
  }
}

/**
 *
 */
async function main() {
  const args = parseArgs(process.argv)
  const test = getTest(args.testName)

  const runStamp = makeRunStamp()
  const perFw = Object.fromEntries(args.frameworks.map((fw) => [fw, []]))

  console.log(
    `Run load name: ${test.name}, method:${test.method}, url:${test.path}, duration:${test.duration}, connections:${test.connections}, pipelining:${test.pipelining}`
  )

  for (let i = 0; i < args.runs; i++) {
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
      const loadAvg = m?.loadAvg
        ? `${m.loadAvg[0].toFixed(2)}/${m.loadAvg[1].toFixed(2)}/${m.loadAvg[2].toFixed(2)}`
        : 'n/a'
      const rss = m?.memMB?.rssPeak != null ? `${m.memMB.rssPeak.toFixed(0)}MB` : 'n/a'
      const heap = m?.memMB?.heapUsedPeak != null ? `${m.memMB.heapUsedPeak.toFixed(0)}MB` : 'n/a'
      const elu = m?.eluPct != null ? `${m.eluPct.toFixed(1)}%` : 'n/a'
      const cpuCore = m?.cpuCorePct != null ? `${m.cpuCorePct.toFixed(1)}%` : 'n/a'
      const cpuHost = m?.cpuHostPct != null ? `${m.cpuHostPct.toFixed(1)}%` : 'n/a'
      const eldP99 = m?.eventLoopDelayMs?.p99 != null ? `${m.eventLoopDelayMs.p99.toFixed(2)}ms` : 'n/a'

      console.log(
        `${fw}: load=${loadAvg} rss=${rss} heap=${heap} cpuCore=${cpuCore} cpuHost=${cpuHost} ELU=${elu} ELDp99=${eldP99} rps=${res.rps.toFixed(0)} p99=${res.latencyP99 ?? 'n/a'}ms errors=${res.errors}`
      )
    }
  }

  console.log('\n== median ==')
  for (const fw of args.frameworks) {
    const rps = perFw[fw].map((x) => x.rps)
    const p99 = perFw[fw].map((x) => x.latencyP99).filter((v) => v != null)

    console.log(
      `${fw}: rps=${median(rps).toFixed(0)} p99=${p99.length ? median(p99).toFixed(2) : 'n/a'}ms (n=${perFw[fw].length})`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
