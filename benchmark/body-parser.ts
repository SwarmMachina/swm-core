import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { fmtBytes, fmtNum } from '@swarmmachina/benchkit/reporting'
import BodyParser from '../src/body-parser.js'
import type { HttpBodyContext } from '../src/http-internal.js'

type BodyMode = 'known' | 'unknown'
type DataHandler = (chunk: ArrayBuffer, isLast: boolean) => void

interface BodyParserArgs {
  size: number
  chunk: number
  iters: number
  warm: number
  max: number
  verify: boolean
  gc: boolean
  jsonOut: string | null
}

interface BodyParserResult {
  mode: BodyMode
  ms: number
  itersPerSec: number
  mbPerSec: number
  nsPerByte: number
  bytes: number
  memMB: {
    rssPeak: number
    heapUsedPeak: number
    externalPeak: number
    arrayBuffersPeak: number
  }
}

class MockRes {
  #onData: DataHandler | null = null

  onData(fn: DataHandler): void {
    this.#onData = fn
  }

  emitData(ab: ArrayBuffer, isLast: boolean): void {
    const fn = this.#onData

    if (!fn) {
      throw new Error('onData handler is not set')
    }

    fn(ab, isLast)
  }
}

class MockCtx {
  aborted: boolean
  res: MockRes

  /** @param {number|null} contentLength */
  constructor(contentLength: number | null) {
    this.aborted = false
    this.res = new MockRes()
    this.#contentLength = contentLength
  }

  #contentLength: number | null

  getContentLength(): number | null {
    return this.#contentLength
  }
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseBodyParserArgs(argv: string[]): BodyParserArgs {
  const defaults: BodyParserArgs = {
    size: 1024 * 1024,
    chunk: 16 * 1024,
    iters: 10 * 1000,
    warm: 1000,
    max: 16 * 1024 * 1024,
    verify: true,
    gc: false,
    jsonOut: null
  }
  const out = parseArgs(argv, defaults, {
    '--size': (out, v) => {
      out.size = Number(v)
    },
    '--chunk': (out, v) => {
      out.chunk = Number(v)
    },
    '--iters': (out, v) => {
      out.iters = Number(v)
    },
    '--warm': (out, v) => {
      out.warm = Number(v)
    },
    '--max': (out, v) => {
      out.max = Number(v)
    },
    '--no-verify': (out) => {
      out.verify = false

      return false
    },
    '--gc': (out) => {
      out.gc = true

      return false
    },
    '--json-out': (out, v) => {
      out.jsonOut = String(v)
    }
  })

  if (!Number.isFinite(out.size) || out.size <= 0) {
    throw new Error('--size must be a positive number')
  }

  if (!Number.isFinite(out.chunk) || out.chunk <= 0) {
    throw new Error('bad --chunk')
  }

  if (!Number.isFinite(out.iters) || out.iters <= 0) {
    throw new Error('bad --iters')
  }

  if (!Number.isFinite(out.warm) || out.warm < 0) {
    throw new Error('bad --warm')
  }

  if (!Number.isFinite(out.max) || out.max <= 0) {
    throw new Error('bad --max')
  }

  return out
}

/**
 * @param {number} totalSize
 * @param {number} chunkSize
 * @returns {ArrayBuffer[]}
 */
function makeChunks(totalSize: number, chunkSize: number): ArrayBuffer[] {
  /** @type {Map<number, ArrayBuffer>} */
  const cache = new Map()
  /** @type {ArrayBuffer[]} */
  const chunks = []

  let left = totalSize

  while (left > 0) {
    const len = left > chunkSize ? chunkSize : left

    let ab = cache.get(len)

    if (!ab) {
      ab = new ArrayBuffer(len)
      cache.set(len, ab)
    }

    chunks.push(ab)
    left -= len
  }

  return chunks
}

/**
 * @param {BodyParser} parser
 * @param {string} mode
 * @param {number} size
 * @param {number} limit
 * @param {ArrayBuffer[]} chunks
 * @returns {Promise<Buffer>}
 */
async function runOneIteration(
  parser: BodyParser,
  mode: BodyMode,
  size: number,
  limit: number,
  chunks: ArrayBuffer[]
): Promise<Buffer> {
  const contentLength = mode === 'known' ? size : null
  const ctx = new MockCtx(contentLength)

  parser.reset(ctx as unknown as HttpBodyContext, limit)

  const p = parser.body(limit)

  for (let i = 0; i < chunks.length; i++) {
    ctx.res.emitData(chunks[i]!, i === chunks.length - 1)
  }

  return p
}

/**
 * @param {object} param
 * @param {string} param.mode
 * @param {BodyParser} param.parser
 * @param {number} param.size
 * @param {number} param.chunk
 * @param {number} param.iters
 * @param {boolean} param.warm
 * @param {number} param.max
 * @param {boolean} param.verify
 * @param {boolean} param.doGC
 * @returns {object}
 */
interface BodyModeOptions {
  mode: BodyMode
  parser: BodyParser
  size: number
  chunk: number
  iters: number
  warm: number
  max: number
  verify: boolean
  doGC: boolean
}

async function benchMode({
  mode,
  parser,
  size,
  chunk,
  iters,
  warm,
  max,
  verify,
  doGC
}: BodyModeOptions): Promise<BodyParserResult> {
  const chunks = makeChunks(size, chunk)

  // warmup
  for (let i = 0; i < warm; i++) {
    const buf = await runOneIteration(parser, mode, size, max, chunks)

    if (verify && buf.length !== size) {
      throw new Error(`${mode}: warmup bad length ${buf.length} != ${size}`)
    }
  }

  if (doGC && global.gc) {
    global.gc()
  }

  const peak = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }
  const sampleMem = () => {
    const mu = process.memoryUsage()

    if (mu.rss > peak.rss) {
      peak.rss = mu.rss
    }

    if (mu.heapUsed > peak.heapUsed) {
      peak.heapUsed = mu.heapUsed
    }

    if (mu.external > peak.external) {
      peak.external = mu.external
    }

    const ab = mu.arrayBuffers || 0

    if (ab > peak.arrayBuffers) {
      peak.arrayBuffers = ab
    }
  }
  const sampleEvery = Math.max(1, Math.floor(iters / 256))

  sampleMem()

  const t0 = performance.now()

  let bytes = 0

  for (let i = 0; i < iters; i++) {
    const buf = await runOneIteration(parser, mode, size, max, chunks)

    if (verify && buf.length !== size) {
      throw new Error(`${mode}: bad length ${buf.length} != ${size}`)
    }

    bytes += buf.length

    if (i % sampleEvery === 0) {
      sampleMem()
    }
  }

  const t1 = performance.now()
  const ms = t1 - t0

  sampleMem()

  const itersPerSec = (iters / ms) * 1000
  const mbPerSec = bytes / (1024 * 1024) / (ms / 1000)
  const nsPerByte = (ms * 1e6) / bytes // ms -> ns
  const toMb = (bytes: number): number => bytes / 1024 / 1024

  return {
    mode,
    ms,
    itersPerSec,
    mbPerSec,
    nsPerByte,
    bytes,
    memMB: {
      rssPeak: toMb(peak.rss),
      heapUsedPeak: toMb(peak.heapUsed),
      externalPeak: toMb(peak.external),
      arrayBuffersPeak: toMb(peak.arrayBuffers)
    }
  }
}

/**
 * @param {object} res
 * @param {object} opt
 * @param {number} opt.size
 * @param {number} opt.chunk
 * @param {number} opt.iters
 * @param {boolean} opt.warm
 */
function printResult(res: BodyParserResult, { size, chunk, iters, warm }: BodyParserArgs): void {
  console.log(`\n=== ${res.mode.toUpperCase()} ===`)
  console.log(
    `payload: ${fmtBytes(size)} | chunk: ${fmtBytes(chunk)} | warm: ${fmtNum(warm)} | iters: ${fmtNum(iters)}`
  )
  console.log(`time: ${res.ms.toFixed(2)} ms`)
  console.log(`throughput: ${fmtNum(res.itersPerSec)} iters/sec`)
  console.log(`bandwidth: ${res.mbPerSec.toFixed(2)} MiB/sec`)
  console.log(`cost: ${res.nsPerByte.toFixed(2)} ns/byte`)
}

/**
 *
 */
async function main() {
  const args = parseBodyParserArgs(process.argv)

  if (args.gc && !global.gc) {
    console.log('NOTE: --gc set but global.gc is unavailable. Run with: node --expose-gc benchmark/body-parser.js ...')
  }

  console.log('BodyParser benchmark')
  console.log(`Node: ${process.version}`)
  console.log(
    `size=${args.size} (${fmtBytes(args.size)}), chunk=${args.chunk} (${fmtBytes(args.chunk)}), iters=${args.iters}, warm=${args.warm}, max=${args.max}, verify=${args.verify}`
  )

  const parser = new BodyParser()
  const known = await benchMode({
    mode: 'known',
    parser,
    ...args,
    doGC: args.gc
  })
  const unknown = await benchMode({
    mode: 'unknown',
    parser,
    ...args,
    doGC: args.gc
  })

  printResult(known, args)
  printResult(unknown, args)

  if (args.jsonOut) {
    const toCase = (result: BodyParserResult): Record<string, number> => ({
      itersPerSec: result.itersPerSec,
      mbPerSec: result.mbPerSec,
      nsPerByte: result.nsPerByte,
      rssMB: result.memMB.rssPeak,
      heapMB: result.memMB.heapUsedPeak,
      externalMB: result.memMB.externalPeak,
      arrayBuffersMB: result.memMB.arrayBuffersPeak
    })
    const summary = {
      createdAt: new Date().toISOString(),
      node: process.version,
      parameters: {
        size: args.size,
        chunk: args.chunk,
        iters: args.iters,
        warm: args.warm,
        max: args.max,
        verify: args.verify,
        gc: args.gc
      },
      results: {
        known: toCase(known),
        unknown: toCase(unknown)
      }
    }

    await fs.mkdir(path.dirname(args.jsonOut), { recursive: true })
    await fs.writeFile(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`\n[body-parser] wrote json summary: ${args.jsonOut}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
