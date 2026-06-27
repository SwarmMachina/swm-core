import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import parseArgs from './helpers/parse-args.js'
import runChild from './helpers/run-child.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Runs ws-bench.js across a list of connection counts and prints one combined
// table, to see where each framework wins as concurrency grows. Each count is a
// separate child process; results are read back from its --json-out summary.

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseSweepArgs(argv) {
  return parseArgs(
    argv,
    {
      frameworks: 'core,ws',
      connectionsList: [50, 500, 5000],
      runs: 2,
      warmup: 2,
      duration: 5,
      msgSize: 64,
      mode: 'closed',
      depth: 16,
      outDir: null
    },
    {
      '--fw': (out, v) => {
        out.frameworks = String(v)
      },
      '--connections-list': (out, v) => {
        out.connectionsList = String(v)
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
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
      '--msg-size': (out, v) => {
        out.msgSize = Number(v)
      },
      '--mode': (out, v) => {
        out.mode = String(v)
      },
      '--depth': (out, v) => {
        out.depth = Number(v)
      },
      '--out-dir': (out, v) => {
        out.outDir = String(v)
      }
    }
  )
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 *
 */
async function main() {
  const args = parseSweepArgs(process.argv)
  const frameworks = args.frameworks
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (!args.connectionsList.length) {
    throw new Error('--connections-list must contain at least one positive number')
  }

  const outDir = args.outDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sweep-')))

  await fs.mkdir(outDir, { recursive: true })

  const modeLabel = args.mode === 'open' ? `open(depth=${args.depth})` : 'closed'

  console.log(
    `Run ws-sweep: frameworks:${frameworks.join(',')}, mode:${modeLabel}, ` +
      `connections:[${args.connectionsList.join(', ')}], duration:${args.duration}, msgSize:${args.msgSize}`
  )

  const table = []

  for (const connections of args.connectionsList) {
    const jsonOut = path.join(outDir, `ws-echo-c${connections}.json`)

    console.log(`\n== connections=${connections} ==`)

    await runChild([
      path.join(__dirname, 'ws-bench.js'),
      '--fw',
      frameworks.join(','),
      '--runs',
      String(args.runs),
      '--warmup',
      String(args.warmup),
      '--duration',
      String(args.duration),
      '--connections',
      String(connections),
      '--msg-size',
      String(args.msgSize),
      '--mode',
      args.mode,
      '--depth',
      String(args.depth),
      '--v8prof',
      'false',
      '--json-out',
      jsonOut
    ])

    const bench = await readJson(jsonOut)
    const row = { connections }

    for (const fw of frameworks) {
      const median = bench.median.find((r) => r.fw === fw)

      row[`${fw} msg/s`] = median ? Math.round(median.msgPerSec) : null
      row[`${fw} p99`] = median?.latP99Ms != null ? `${median.latP99Ms.toFixed(2)}ms` : 'n/a'
    }

    table.push(row)
  }

  console.log('\n== sweep summary ==')
  console.table(table)
  console.log(`\n[ws-sweep] per-connection json summaries in: ${outDir}`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
