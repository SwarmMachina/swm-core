import fs from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '@swarmmachina/benchkit/orchestration'
import { parseV8Profile, processV8Profile } from '@swarmmachina/benchkit/profiling'
import { cpuGuard, metricGuard } from '@swarmmachina/benchkit/regression'
import type { CpuProfile } from '@swarmmachina/benchkit/regression'
import type { SuiteOptions } from '../../harness/types.js'

interface BodyParserBaseline {
  parameters?: {
    size?: number
    chunk?: number
    iters?: number
    warm?: number
    cpuProfile?: boolean
  }
  tests: Record<string, { guards?: Record<string, { min?: number; max?: number }> }>
  cpuProfileGuard?: {
    profileRequired?: boolean
    minTotalTicks?: number
    maxGcPct?: number
    maxUnaccountedPct?: number
  }
}

interface BodyParserBenchmarkResult {
  results: {
    known: Record<string, number>
    unknown: Record<string, number>
  }
}

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/**
 * @param {{ sourceBenchDir: string, runtimeBenchDir: string, repoRoot: string, outRoot: string }} o
 * @returns {Promise<{ suite: string, failures: string[], metricRows: object[], cpuRows: object[] }>}
 */
export default async function runBodyParserSuite({ sourceBenchDir, runtimeBenchDir, repoRoot, outRoot }: SuiteOptions) {
  const baseline = await readJson<BodyParserBaseline>(
    path.join(sourceBenchDir, 'regression', 'baselines', 'body-parser.json')
  )
  const p = baseline.parameters || {}
  const params = {
    size: p.size ?? 1024 * 1024,
    chunk: p.chunk ?? 16 * 1024,
    iters: p.iters ?? 10000,
    warm: p.warm ?? 1000,
    cpuProfile: p.cpuProfile ?? true,
    framework: 'core'
  }
  const outDir = path.join(outRoot, 'body-parser')
  const profileDir = path.join(outDir, 'prof')

  await fs.mkdir(profileDir, { recursive: true })

  const jsonOut = path.join(outDir, 'body-parser.json')

  await runChild(
    [
      ...(params.cpuProfile ? ['--prof'] : []),
      '--expose-gc',
      path.join(runtimeBenchDir, 'http', 'body-parser.js'),
      '--gc',
      '--size',
      String(params.size),
      '--chunk',
      String(params.chunk),
      '--iters',
      String(params.iters),
      '--warm',
      String(params.warm),
      '--json-out',
      jsonOut
    ],
    { cwd: profileDir }
  )

  const bench = await readJson<BodyParserBenchmarkResult>(jsonOut)
  const results = { known: bench.results.known, unknown: bench.results.unknown }
  const cpuProfiles: CpuProfile[] = []

  if (params.cpuProfile) {
    const prof = await processV8Profile(profileDir).catch(() => null)

    if (prof?.processedPath) {
      const cpuDir = path.join(outDir, 'cpu')

      await fs.mkdir(cpuDir, { recursive: true })

      const dest = path.join(cpuDir, 'profile.txt')

      await fs.copyFile(prof.processedPath, dest)

      const item: {
        test: string
        run: number
        fw: string
        processedPath: string
        profile: ReturnType<typeof parseV8Profile>
        logPath?: string
      } = {
        test: 'body-parser',
        run: 1,
        fw: 'core',
        processedPath: path.relative(outDir, dest),
        profile: parseV8Profile(await fs.readFile(dest, 'utf8'), { cwd: repoRoot })
      }

      if (prof.logPath) {
        const logDest = path.join(cpuDir, path.basename(prof.logPath))

        await fs.copyFile(prof.logPath, logDest)
        item.logPath = path.relative(outDir, logDest)
      }

      cpuProfiles.push(item)
    }
  }

  const { failures: metricFailures, rows: metricRows } = metricGuard({
    cases: ['known', 'unknown'],
    results,
    baselineTests: baseline.tests
  })
  const { failures: cpuFailures, rows: cpuRows } = cpuGuard({
    cpuProfiles,
    guard: params.cpuProfile ? baseline.cpuProfileGuard : undefined,
    expectedKeys: ['body-parser:1:core']
  })
  const summary = {
    suite: 'body-parser',
    createdAt: new Date().toISOString(),
    node: process.version,
    parameters: params,
    results,
    cpuProfiles
  }

  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  return { suite: 'body-parser', failures: [...metricFailures, ...cpuFailures], metricRows, cpuRows }
}
