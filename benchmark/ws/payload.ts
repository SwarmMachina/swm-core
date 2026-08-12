import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, runChild } from '@swarmmachina/benchkit/orchestration'
import { finiteMedian } from '@swarmmachina/benchkit/statistics'
import {
  assertNonEmpty,
  assertNonNegativeFinite,
  assertPositiveFinite,
  assertPositiveSafeInteger
} from '../harness/args.js'
import { BENCHMARK_PROFILES_DIR } from '../harness/runtime-paths.js'

interface PayloadArgs {
  frameworks: string[]
  sizes: number[]
  runs: number
  warmup: number
  duration: number
  connections: number
  workers: number
  depth: number
  v8prof: boolean
  outDir: string | null
}

type PayloadMetric = 'eluPct' | 'rssMB' | 'loadEluPct' | 'loadRssMB'

interface PayloadBenchmarkRow {
  fw: string
  loadWorkers?: number | null
  msgPerSec?: number | null
  latP95Ms?: number | null
  latP99Ms?: number | null
  eluPct?: number | null
  rssMB?: number | null
  loadEluPct?: number | null
  loadRssMB?: number | null
  errors?: number | null
}

interface PayloadBenchmarkSummary {
  median: PayloadBenchmarkRow[]
  runs: Array<{ rows: PayloadBenchmarkRow[] }>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parsePayloadArgs(argv: string[]): PayloadArgs {
  const defaults: PayloadArgs = {
    frameworks: ['core', 'hyperexpress'],
    sizes: [64, 1024, 16_384, 65_536],
    runs: 3,
    warmup: 2,
    duration: 6,
    connections: 50,
    workers: 4,
    depth: 16,
    v8prof: true,
    outDir: null
  }

  return parseArgs(argv, defaults, {
    '--fw': (out, value) => {
      out.frameworks = String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    },
    '--sizes': (out, value) => {
      out.sizes = String(value)
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((size) => Number.isSafeInteger(size) && size > 0)
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
    '--connections': (out, value) => {
      out.connections = Number(value)
    },
    '--workers': (out, value) => {
      out.workers = Number(value)
    },
    '--depth': (out, value) => {
      out.depth = Number(value)
    },
    '--v8prof': (out, value) => {
      out.v8prof = value == null ? true : value === '1' || value === 'true' || value === 'on'
    },
    '--out-dir': (out, value) => {
      out.outDir = String(value)
    }
  })
}

function validatePayloadArgs(args: PayloadArgs): void {
  assertNonEmpty(args.frameworks, '--fw')
  assertNonEmpty(args.sizes, '--sizes')
  assertPositiveSafeInteger(args.runs, '--runs')
  assertNonNegativeFinite(args.warmup, '--warmup')
  assertPositiveFinite(args.duration, '--duration')
  assertPositiveSafeInteger(args.connections, '--connections')
  assertPositiveSafeInteger(args.workers, '--workers')
  assertPositiveSafeInteger(args.depth, '--depth')
}

/**
 *
 */
async function main() {
  const args = parsePayloadArgs(process.argv)

  validatePayloadArgs(args)

  const outDir = args.outDir || path.join(BENCHMARK_PROFILES_DIR, 'ws-payload')
  const rows = []

  await fs.mkdir(outDir, { recursive: true })

  for (const size of args.sizes) {
    const jsonOut = path.join(outDir, `payload-${size}.json`)
    const effectiveDepth = Math.min(args.depth, Math.max(1, Math.floor((64 * 1024) / size)))

    await runChild([
      path.join(__dirname, 'runner.js'),
      '--fw',
      args.frameworks.join(','),
      '--runs',
      String(args.runs),
      '--warmup',
      String(args.warmup),
      '--duration',
      String(args.duration),
      '--connections',
      String(args.connections),
      '--workers',
      String(args.workers),
      '--msg-size',
      String(size),
      '--mode',
      'open',
      '--depth',
      String(effectiveDepth),
      '--v8prof',
      String(args.v8prof),
      '--json-out',
      jsonOut
    ])

    const result = JSON.parse(await fs.readFile(jsonOut, 'utf8')) as PayloadBenchmarkSummary

    for (const framework of args.frameworks) {
      const value = result.median.find((item) => item.fw === framework)
      const runRows = result.runs.flatMap((run) => run.rows.filter((item) => item.fw === framework))
      const metricMedian = (key: PayloadMetric): number | null => finiteMedian(runRows.map((item) => item[key]))
      const msgPerSec = value?.msgPerSec ?? null

      rows.push({
        framework,
        bytes: size,
        depth: effectiveDepth,
        loadWorkers: runRows[0]?.loadWorkers ?? null,
        msgPerSec: value?.msgPerSec ?? null,
        throughputMiBPerSec: msgPerSec === null ? null : (msgPerSec * size) / (1024 * 1024),
        latencyP95Ms: value?.latP95Ms ?? null,
        latencyP99Ms: value?.latP99Ms ?? null,
        eluPct: metricMedian('eluPct'),
        rssMB: metricMedian('rssMB'),
        loadEluPct: metricMedian('loadEluPct'),
        loadRssMB: metricMedian('loadRssMB'),
        errors: runRows.reduce((sum, item) => sum + (item.errors || 0), 0)
      })
    }
  }

  console.log('\n== WS payload profile ==')
  console.table(rows)
  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify({ parameters: args, rows }, null, 2)}\n`)
  console.log(`[ws-payload] profiles and summaries: ${outDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
