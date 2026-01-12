import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} resultsBasePath
 * @param {string} [testName]
 * @returns {string}
 */
function findRunDir(resultsBasePath, testName = null) {
  if (!fs.existsSync(resultsBasePath)) {
    return resultsBasePath
  }

  if (fs.existsSync(path.join(resultsBasePath, 'manifest.json'))) {
    return resultsBasePath
  }

  const entries = fs
    .readdirSync(resultsBasePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(resultsBasePath, entry.name),
      mtime: fs.statSync(path.join(resultsBasePath, entry.name)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime)

  let filtered = entries

  if (testName) {
    filtered = entries.filter((entry) => entry.name.endsWith(`_${testName}`))
  }

  if (filtered.length > 0) {
    return filtered[0].path
  }

  if (entries.length > 0) {
    return entries[0].path
  }

  return resultsBasePath
}

/**
 * @param {string} filePath
 * @param {string} frameworkName
 * @param {string} testName
 * @param {string} runId
 * @returns {object|null}
 */
function loadEventLoopData(filePath, frameworkName, testName, runId) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content)

    if (!data.eventLoopDelayMs || !data.meta) {
      return null
    }

    if (runId && data.meta.runId && data.meta.runId !== runId) {
      return null
    }

    if (frameworkName && data.meta.framework && data.meta.framework !== frameworkName) {
      return null
    }

    if (testName && data.meta.testName && data.meta.testName !== testName) {
      return null
    }

    return {
      mean: data.eventLoopDelayMs.mean,
      p50: data.eventLoopDelayMs.p50,
      p90: data.eventLoopDelayMs.p90,
      p99: data.eventLoopDelayMs.p99,
      utilization: data.eventLoopUtilization?.utilization
    }
  } catch {
    return null
  }
}

/**
 * @param {string} resultPath
 * @param {string} frameworkName
 * @param {string} testName
 * @param {string} runId
 * @returns {string|null}
 */
function findEventLoopFile(resultPath, frameworkName, testName, runId) {
  if (!fs.existsSync(resultPath)) {
    return null
  }

  const pattern = `eventloop-${frameworkName}-${testName}`
  const searchPaths = [resultPath]

  const runsDir = path.join(resultPath, 'runs')

  if (fs.existsSync(runsDir)) {
    const runDirs = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runsDir, entry.name))

    searchPaths.push(...runDirs)
  }

  const eventLoopFiles = []

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) {
      continue
    }

    const files = fs.readdirSync(searchPath).filter((file) => file.endsWith('.json') && file.startsWith(pattern))

    for (const file of files) {
      const filePath = path.join(searchPath, file)

      eventLoopFiles.push({
        name: file,
        path: filePath,
        mtime: fs.statSync(filePath).mtime
      })
    }
  }

  if (eventLoopFiles.length === 0) {
    return null
  }

  eventLoopFiles.sort((a, b) => b.mtime - a.mtime)

  for (const file of eventLoopFiles) {
    const data = loadEventLoopData(file.path, frameworkName, testName, runId)

    if (data) {
      return file.path
    }
  }

  return eventLoopFiles.length > 0 ? eventLoopFiles[0].path : null
}

/**
 * @param {string} resultPath
 * @param {string[]} frameworkNames
 * @returns {Promise<Record<string, {rps: number, title: string, duration: number, connections: number, latency?: object, throughput?: object, bytesPerRequest?: number, eventLoop?: object}>>}
 */
export async function collectResults(resultPath, frameworkNames) {
  const results = {}

  const runDir = findRunDir(resultPath)

  if (!fs.existsSync(runDir)) {
    return results
  }

  const summaryPath = path.join(runDir, 'summary.json')

  if (fs.existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
      const manifestPath = path.join(runDir, 'manifest.json')
      let manifest = null

      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      }

      const testName = summary.testName || manifest?.testName || 'base'

      for (const frameworkName of frameworkNames) {
        const frameworkData = summary.frameworks[frameworkName]

        if (!frameworkData) {
          continue
        }

        const result = {
          rps: frameworkData.rps?.median || frameworkData.rps || 0,
          title: `${frameworkName}-${testName}`,
          duration: manifest?.duration || 60,
          connections: manifest?.connections || 1500
        }

        if (frameworkData.latency) {
          result.latency = {
            average: frameworkData.latency.avg,
            p50: frameworkData.latency.p50,
            p90: frameworkData.latency.p90,
            p99: frameworkData.latency.p99
          }
        }

        if (frameworkData.throughput) {
          result.throughput = {
            average: frameworkData.throughput.average
          }
        }

        if (frameworkData.bytesPerRequest != null) {
          result.bytesPerRequest = frameworkData.bytesPerRequest
        }

        const eventLoopFile = findEventLoopFile(runDir, frameworkName, testName, manifest?.runId)

        if (eventLoopFile) {
          const eventLoopData = loadEventLoopData(eventLoopFile, frameworkName, testName, manifest?.runId)

          if (eventLoopData) {
            result.eventLoop = eventLoopData
          }
        }

        results[frameworkName] = result
      }

      return results
    } catch {
      //
    }
  }

  return results
}

/**
 * @param {Record<string, {rps: number, title: string, duration: number, connections: number, latency?: object, throughput?: object, bytesPerRequest?: number, eventLoop?: object}>} results
 * @param {string} baselineFramework
 */
export function printComparisonTable(results, baselineFramework = 'core') {
  const baselineResult = results[baselineFramework]

  if (!baselineResult) {
    console.warn(`\n=== Benchmark Comparison ===`)
    console.warn(`Baseline framework '${baselineFramework}' not found in results`)
    return
  }

  console.log(`\n=== Benchmark Comparison ===`)

  const firstResult = Object.values(results)[0]

  if (firstResult) {
    const testName = firstResult.title.includes('-')
      ? firstResult.title.split('-').slice(1).join('-')
      : firstResult.title

    console.log(`Test: ${testName}`)
    console.log(`Duration: ${firstResult.duration.toFixed(2)}s`)
    console.log(`Connections: ${firstResult.connections}`)
  }

  const sortedFrameworks = Object.keys(results).sort((a, b) => {
    if (a === baselineFramework) {
      return -1
    }
    if (b === baselineFramework) {
      return 1
    }
    return a.localeCompare(b)
  })

  const frameworkColWidth = Math.max(9, ...sortedFrameworks.map((f) => f.length))
  const rpsColWidth = 10
  const vsColWidth = 10

  // RPS Table
  const header = `${'Framework'.padEnd(frameworkColWidth)} | ${'RPS'.padStart(rpsColWidth)} | ${'vs Core'.padStart(vsColWidth)}`
  const separator = `${'-'.repeat(frameworkColWidth)}-+-${'-'.repeat(rpsColWidth)}-+-${'-'.repeat(vsColWidth)}`

  console.log('')
  console.log('--- Throughput (RPS) ---')
  console.log(header)
  console.log(separator)

  for (const framework of sortedFrameworks) {
    const result = results[framework]
    const rps = result.rps
    const baselineRps = baselineResult.rps

    const percentageStr =
      framework === baselineFramework
        ? '-'
        : (() => {
            const percentage = ((rps - baselineRps) / baselineRps) * 100

            return percentage >= 0 ? `+${percentage.toFixed(2)}%` : `${percentage.toFixed(2)}%`
          })()

    const rpsStr = Math.round(rps).toString()
    const frameworkStr = framework.padEnd(frameworkColWidth)

    console.log(`${frameworkStr} | ${rpsStr.padStart(rpsColWidth)} | ${percentageStr.padStart(vsColWidth)}`)
  }

  // Latency Table
  const hasLatency = sortedFrameworks.some((f) => results[f].latency)

  if (hasLatency) {
    console.log('')
    console.log('--- Latency (ms) ---')
    const latencyHeader = `${'Framework'.padEnd(frameworkColWidth)} | ${'Avg'.padStart(8)} | ${'P50'.padStart(8)} | ${'P90'.padStart(8)} | ${'P99'.padStart(8)} | ${'vs Core (Avg)'.padStart(12)}`
    const latencySeparator = `${'-'.repeat(frameworkColWidth)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(12)}`

    console.log(latencyHeader)
    console.log(latencySeparator)

    for (const framework of sortedFrameworks) {
      const result = results[framework]

      if (!result.latency) {
        const frameworkStr = framework.padEnd(frameworkColWidth)

        console.log(
          `${frameworkStr} | ${'-'.padStart(8)} | ${'-'.padStart(8)} | ${'-'.padStart(8)} | ${'-'.padStart(8)} | ${'-'.padStart(12)}`
        )
        continue
      }

      const latency = result.latency
      const baselineLatency = baselineResult.latency

      const percentageStr =
        framework === baselineFramework
          ? '-'
          : baselineLatency
            ? (() => {
                const percentage = ((latency.average - baselineLatency.average) / baselineLatency.average) * 100

                return percentage >= 0 ? `+${percentage.toFixed(2)}%` : `${percentage.toFixed(2)}%`
              })()
            : '-'

      const frameworkStr = framework.padEnd(frameworkColWidth)
      const avgStr = latency.average.toFixed(2).padStart(8)
      const p50Str = latency.p50.toFixed(2).padStart(8)
      const p90Str = latency.p90.toFixed(2).padStart(8)
      const p99Str = latency.p99.toFixed(2).padStart(8)

      console.log(`${frameworkStr} | ${avgStr} | ${p50Str} | ${p90Str} | ${p99Str} | ${percentageStr.padStart(12)}`)
    }
  }

  const eventLoopCount = sortedFrameworks.filter((f) => results[f].eventLoop).length
  const hasEventLoop = eventLoopCount > 0 && (baselineResult.eventLoop || eventLoopCount >= sortedFrameworks.length / 2)

  if (hasEventLoop) {
    console.log('')
    console.log('--- Event Loop Delay (ms) ---')
    const elHeader = `${'Framework'.padEnd(frameworkColWidth)} | ${'Mean'.padStart(8)} | ${'P50'.padStart(8)} | ${'P90'.padStart(8)} | ${'P99'.padStart(8)} | ${'Utilization'.padStart(12)} | ${'vs Core (Mean)'.padStart(14)}`
    const elSeparator = `${'-'.repeat(frameworkColWidth)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-${'-'.repeat(12)}-+-${'-'.repeat(14)}`

    console.log(elHeader)
    console.log(elSeparator)

    for (const framework of sortedFrameworks) {
      const result = results[framework]

      if (!result.eventLoop) {
        const frameworkStr = framework.padEnd(frameworkColWidth)

        console.log(
          `${frameworkStr} | ${'-'.padStart(8)} | ${'-'.padStart(8)} | ${'-'.padStart(8)} | ${'-'.padStart(8)} | ${'-'.padStart(12)} | ${'-'.padStart(14)}`
        )
        continue
      }

      const el = result.eventLoop
      const baselineEl = baselineResult.eventLoop

      const percentageStr =
        framework === baselineFramework
          ? '-'
          : baselineEl
            ? (() => {
                const percentage = ((el.mean - baselineEl.mean) / baselineEl.mean) * 100

                return percentage >= 0 ? `+${percentage.toFixed(2)}%` : `${percentage.toFixed(2)}%`
              })()
            : '-'

      const frameworkStr = framework.padEnd(frameworkColWidth)
      const meanStr = el.mean.toFixed(3).padStart(8)
      const p50Str = el.p50.toFixed(3).padStart(8)
      const p90Str = el.p90.toFixed(3).padStart(8)
      const p99Str = el.p99.toFixed(3).padStart(8)
      const utilStr = el.utilization != null ? (el.utilization * 100).toFixed(2).padStart(12) : '-'.padStart(12)

      console.log(
        `${frameworkStr} | ${meanStr} | ${p50Str} | ${p90Str} | ${p99Str} | ${utilStr}${el.utilization != null ? '%' : ''} | ${percentageStr.padStart(14)}`
      )
    }
  }
}

/**
 * CLI entry point for compare-results.js
 */
export async function compareResultsCLI() {
  const argv = process.argv.slice(2)
  let resultPath = './benchmark-results'
  let testName = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--dir' && i + 1 < argv.length) {
      resultPath = argv[++i]
    } else if (!arg.startsWith('--')) {
      // First non-flag argument is testName
      testName = arg
    }
  }

  if (process.env.RESULTS_DIR) {
    resultPath = process.env.RESULTS_DIR
  }

  const runDir = findRunDir(path.resolve(resultPath), testName)
  const frameworks = ['micro', 'express', 'fastify', 'core']

  const results = await collectResults(runDir, frameworks)

  if (Object.keys(results).length === 0) {
    console.error(`No results found in ${runDir}`)
    process.exit(1)
  }

  printComparisonTable(results, 'core')
}

const currentFile = fileURLToPath(import.meta.url)
const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : null

if (mainFile && currentFile === mainFile) {
  compareResultsCLI().catch((err) => {
    console.error('Comparison failed:', err)
    process.exit(1)
  })
}
