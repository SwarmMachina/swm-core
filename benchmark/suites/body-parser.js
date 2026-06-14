import fs from 'node:fs/promises'
import path from 'node:path'
import cpuGuard from '../helpers/cpu-guard.js'
import metricGuard from '../helpers/metric-guard.js'
import parseV8Profile from '../helpers/v8-prof-parser.js'
import runChild from '../helpers/run-child.js'
import { processV8Profile } from '../helpers/v8-prof-run.js'

/**
 * @param {string} file
 * @returns {Promise<object>}
 */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * @param {{ benchDir: string, repoRoot: string, outRoot: string }} o
 * @returns {Promise<{ suite: string, failures: string[], metricRows: object[], cpuRows: object[] }>}
 */
export default async function runBodyParserSuite({ benchDir, repoRoot, outRoot }) {
  const baseline = await readJson(path.join(benchDir, 'baselines', 'body-parser.json'))
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
      path.join(benchDir, 'body-parser.js'),
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

  const bench = await readJson(jsonOut)
  const results = { known: bench.results.known, unknown: bench.results.unknown }

  const cpuProfiles = []

  if (params.cpuProfile) {
    const prof = await processV8Profile(profileDir).catch(() => null)

    if (prof?.processedPath) {
      const cpuDir = path.join(outDir, 'cpu')

      await fs.mkdir(cpuDir, { recursive: true })

      const dest = path.join(cpuDir, 'profile.txt')

      await fs.copyFile(prof.processedPath, dest)

      const item = {
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
    guard: params.cpuProfile ? baseline.cpuProfileGuard : null,
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
