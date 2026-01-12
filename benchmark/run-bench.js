import path from 'node:path'
import url from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import { once } from 'node:events'
import { collectResults, printComparisonTable } from './helpers/compare-results.js'
import { getTest, listTests } from './tests.js'
import { nowLocalForDir } from './helpers/time.js'
import { getMax, getMedian, getMin } from './helpers/math.js'
import runLoad from './helpers/run-load.js'
import delay from './helpers/delay.js'
import runWithProfiling from './helpers/run-with-profiling.js'
import resolveV8LogFile from './helpers/resolve-v8log.js'
import processV8Log from './helpers/v8log-process.js'
import getGitInfo from './helpers/get-git-info.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

/**
 * Parse CLI arguments
 * @returns {{testName: string, mode: string, profile: boolean, outDir: string, warmup: number, runs: number, listTests: boolean}}
 */
function parseArgs() {
  const args = {
    testName: 'base',
    mode: 'core',
    profile: false,
    outDir: './benchmark-results',
    warmup: 0,
    runs: 1,
    listTests: false
  }

  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--list-tests') {
      args.listTests = true
    } else if (arg === 'all') {
      args.mode = 'all'
    } else if (arg === '--profile') {
      args.profile = true
    } else if (arg === '--out' && i + 1 < argv.length) {
      args.outDir = argv[++i]
    } else if (arg === '--warmup' && i + 1 < argv.length) {
      args.warmup = parseInt(argv[++i], 10) || 0
    } else if (arg === '--runs' && i + 1 < argv.length) {
      args.runs = parseInt(argv[++i], 10) || 1
    } else if (!arg.startsWith('--') && args.testName === 'base' && arg !== 'core') {
      if (arg !== 'all') {
        args.testName = arg
      }
    }
  }

  // Override with env vars
  if (process.env.PROFILE === '1' || process.env.PROFILE === 'true') {
    args.profile = true
  }

  if (process.env.RESULTS_DIR) {
    args.outDir = process.env.RESULTS_DIR
  }

  return args
}

/**
 * Create manifest.json
 * @param {string} runId
 * @param {string} runFolderName
 * @param {string} testName
 * @param {number} duration
 * @param {number} connections
 * @param {string} url
 * @param {boolean} profileEnabled
 * @param {number} runs
 * @param {number} warmup
 * @returns {object}
 */
function createManifest(runId, runFolderName, testName, duration, connections, url, profileEnabled, runs, warmup) {
  const gitInfo = getGitInfo()

  return {
    runId,
    runFolderName,
    timestamp: new Date().toISOString(),
    testName,
    duration,
    connections,
    url,
    runs,
    warmup,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    memTotal: os.totalmem(),
    gitCommitSha: gitInfo.commitSha,
    gitDirty: gitInfo.dirty,
    profileEnabled
  }
}

/**
 * Calculate bytes per request
 * @param {object} result
 * @returns {number|null}
 */
function calculateBytesPerRequest(result) {
  if (!result.throughput || !result.throughput.average) {
    return null
  }

  if (!result.requests || !result.requests.average || result.requests.average === 0) {
    return null
  }

  return result.throughput.average / result.requests.average
}

/**
 * Aggregate results from multiple runs
 * @param {Array} runResults
 * @returns {object | null}
 */
function aggregateResults(runResults) {
  if (runResults.length === 0) {
    return null
  }

  if (runResults.length === 1) {
    return runResults[0]
  }

  const rpsValues = runResults.map((r) => r.rps).filter((v) => v != null)
  const latencyAvgValues = runResults.map((r) => r.latency?.average).filter((v) => v != null)
  const latencyP99Values = runResults.map((r) => r.latency?.p99).filter((v) => v != null)
  const throughputAvgValues = runResults.map((r) => r.throughput?.average).filter((v) => v != null)
  const bytesPerRequestValues = runResults.map((r) => r.bytesPerRequest).filter((v) => v != null)
  const v8logProcessResults = runResults.map((r) => r.v8logProcess).filter((v) => v != null)
  const v8logProcess = v8logProcessResults.length > 0 ? v8logProcessResults[0] : null
  const eventLoopStopAckResults = runResults.map((r) => r.eventLoopStopAck).filter((v) => v != null)
  const eventLoopStopAck = eventLoopStopAckResults.length > 0 ? eventLoopStopAckResults[0] : null

  return {
    ...runResults[0], // Use first run as base
    rps: getMedian(rpsValues),
    rpsMin: getMin(rpsValues),
    rpsMax: getMax(rpsValues),
    latency: runResults[0].latency
      ? {
          ...runResults[0].latency,
          average: getMedian(latencyAvgValues),
          p99: getMedian(latencyP99Values)
        }
      : null,
    throughput: runResults[0].throughput
      ? {
          ...runResults[0].throughput,
          average: getMedian(throughputAvgValues)
        }
      : null,
    bytesPerRequest: bytesPerRequestValues.length > 0 ? getMedian(bytesPerRequestValues) : null,
    v8logProcess,
    eventLoopStopAck
  }
}

/**
 * Create summary.json
 * @param {string} runId
 * @param {string} runFolderName
 * @param {string} testName
 * @param {Array<string>} frameworks
 * @param {Array} allRunResults
 * @param {boolean} profileEnabled
 * @returns {object}
 */
function createSummary(runId, runFolderName, testName, frameworks, allRunResults, profileEnabled) {
  const summary = {
    runId,
    runFolderName,
    testName,
    timestamp: new Date().toISOString(),
    profileEnabled,
    frameworks: {},
    artifacts: {
      manifest: 'manifest.json',
      rawResults: [],
      eventLoop: [],
      v8Log: [],
      v8LogProcessedTxt: []
    }
  }

  for (const framework of frameworks) {
    const frameworkResults = allRunResults.map((run) => run[framework]).filter((r) => r != null)

    if (frameworkResults.length === 0) {
      continue
    }

    const aggregated = aggregateResults(frameworkResults)

    summary.frameworks[framework] = {
      rps: {
        median: aggregated.rps,
        min: aggregated.rpsMin,
        max: aggregated.rpsMax
      },
      latency: aggregated.latency
        ? {
            avg: aggregated.latency.average,
            p50: aggregated.latency.p50,
            p90: aggregated.latency.p90,
            p99: aggregated.latency.p99
          }
        : null,
      throughput: aggregated.throughput
        ? {
            average: aggregated.throughput.average
          }
        : null,
      bytesPerRequest: aggregated.bytesPerRequest,
      errorCount: aggregated.errors || 0
    }

    if (profileEnabled && aggregated.v8logProcess) {
      summary.frameworks[framework].v8logProcess = {
        ok: aggregated.v8logProcess.ok,
        error: aggregated.v8logProcess.error || null,
        processedTxt: aggregated.v8logProcess.processedTxt || null,
        exitCode: aggregated.v8logProcess.exitCode,
        v8logSize: aggregated.v8logProcess.v8logSize,
        processingStartAt: aggregated.v8logProcess.processingStartAt,
        processingFinishedAt: aggregated.v8logProcess.processingFinishedAt,
        processingDurationMs: aggregated.v8logProcess.processingDurationMs,
        v8logResolveOk: aggregated.v8logProcess.v8logResolveOk,
        v8logResolvedFrom: aggregated.v8logProcess.v8logResolvedFrom || null,
        v8logResolveError: aggregated.v8logProcess.v8logResolveError || null
      }
    }

    if (profileEnabled && aggregated.eventLoopStopAck) {
      summary.frameworks[framework].eventLoopStopAck = {
        ok: aggregated.eventLoopStopAck.ok,
        error: aggregated.eventLoopStopAck.error || null
      }
    }

    if (allRunResults.length === 1) {
      summary.artifacts.rawResults.push(`${framework}-${testName}.json`)

      if (profileEnabled) {
        summary.artifacts.eventLoop.push(`eventloop-${framework}-${testName}.json`)
        summary.artifacts.v8Log.push(`v8log-${framework}-${testName}.log`)
        const v8logProcess = frameworkResults[0]?.v8logProcess

        if (v8logProcess?.ok && v8logProcess.processedTxt) {
          summary.artifacts.v8LogProcessedTxt.push(path.basename(v8logProcess.processedTxt))
        }
      }
    } else {
      for (let i = 0; i < allRunResults.length; i++) {
        summary.artifacts.rawResults.push(`runs/${i}/${framework}-${testName}.json`)

        if (profileEnabled) {
          summary.artifacts.eventLoop.push(`runs/${i}/eventloop-${framework}-${testName}.json`)
          summary.artifacts.v8Log.push(`runs/${i}/v8log-${framework}-${testName}.log`)
          const runResult = allRunResults[i]?.[framework]
          const v8logProcess = runResult?.v8logProcess

          if (v8logProcess?.ok && v8logProcess.processedTxt) {
            summary.artifacts.v8LogProcessedTxt.push(`runs/${i}/${path.basename(v8logProcess.processedTxt)}`)
          }
        }
      }
    }
  }

  return summary
}

/**
 * @param {string} serverPath
 * @param {string} serverName
 * @param {number} port
 * @param {object} test
 * @param {object} options
 * @param {boolean} options.enableProfile
 * @param {string} options.runId
 * @param {string} options.runDir
 * @param {number} options.warmup
 * @param {number|null} options.runIndex
 * @returns {Promise<object>}
 */
async function runBenchmark(serverPath, serverName, port, test, options) {
  const { enableProfile, enableTrack = false, runId, runDir, warmup, runIndex } = options

  const scenarioId = `${serverName}-${test.name}`
  const v8LogFile = enableProfile ? path.join(runDir, `v8log-${scenarioId}.log`) : null
  const eventLoopLogFile = enableProfile ? path.join(runDir, `eventloop-${scenarioId}.json`) : null

  const v8StartTimeMs = enableProfile ? Date.now() : null

  const serverProcess = await runWithProfiling(serverPath, scenarioId, runDir, [port], {
    profile: enableProfile,
    v8LogFile,
    eventLoopLogFile
  })

  const testOpts = {
    method: test.method,
    url: `http://localhost:${port}${test.path}`,
    duration: test.duration,
    connections: test.connections,
    pipelining: test.pipelining || 1,
    headers: test.headers || {},
    body: test.body || undefined,
    verbose: false,
    safe: false,
    filePath: runDir,
    fileName: `${scenarioId}.json`
  }

  if (warmup > 0) {
    if (runIndex == null || runIndex === 0) {
      const warmupOpts = {
        ...testOpts,
        duration: warmup,
        filePath: null,
        verbose: false
      }

      await runLoad(`${scenarioId}-warmup`, warmupOpts, {
        profile: false,
        track: false,
        childProcess: serverProcess,
        framework: serverName,
        runId,
        testName: test.name
      })

      await delay(1000)
    }
  }

  const loadResult = await runLoad(scenarioId, testOpts, {
    profile: enableProfile,
    track: enableTrack,
    childProcess: serverProcess,
    framework: serverName,
    runId,
    testName: test.name
  })

  const result = loadResult.result
  const eventLoopStopAck = loadResult.eventLoopStopAck

  if (enableProfile && eventLoopStopAck && !eventLoopStopAck.ok) {
    console.warn(`Warning: Eventloop stop ACK failed for ${scenarioId}: ${eventLoopStopAck.error || 'unknown'}`)
  }

  serverProcess.kill('SIGTERM')

  try {
    await Promise.race([
      once(serverProcess, 'exit'),
      once(serverProcess, 'close'),
      new Promise((resolve) => setTimeout(resolve, 5000)) // Fallback timeout
    ])
  } catch (err) {
    console.warn(`Warning: Error waiting for server exit: ${err.message}`)
  }

  let v8logProcessResult = null
  let v8logResolveResult = null

  if (enableProfile && v8LogFile) {
    await delay(500)

    v8logResolveResult = resolveV8LogFile({
      expectedPath: v8LogFile,
      runDir,
      startTimeMs: v8StartTimeMs,
      extraSearchDirs: [process.cwd()]
    })

    if (v8logResolveResult.ok && v8logResolveResult.path) {
      const resolvedV8LogPath = v8logResolveResult.path
      const stats = fs.statSync(resolvedV8LogPath)
      const baseName = path.basename(resolvedV8LogPath, path.extname(resolvedV8LogPath))

      const processingStart = Date.now()

      v8logProcessResult = await processV8Log(resolvedV8LogPath, runDir, baseName)
      const processingEnd = Date.now()

      v8logProcessResult.v8logSize = stats.size
      v8logProcessResult.processingStartAt = new Date(processingStart).toISOString()
      v8logProcessResult.processingFinishedAt = new Date(processingEnd).toISOString()
      v8logProcessResult.processingDurationMs = processingEnd - processingStart

      v8logProcessResult.v8logResolveOk = true

      if (v8logResolveResult.movedFrom) {
        v8logProcessResult.v8logResolvedFrom = v8logResolveResult.movedFrom
      }
    } else {
      v8logProcessResult = {
        ok: false,
        error: v8logResolveResult.error || `V8 log file not found: ${v8LogFile}`,
        v8logResolveOk: false,
        v8logResolveError: v8logResolveResult.error,
        v8logSearchedDirs: v8logResolveResult.searchedDirs,
        v8logCandidates: v8logResolveResult.candidates
      }
    }
  }

  return {
    ...result,
    v8logProcess: v8logProcessResult,
    eventLoopStopAck,
    v8logResolve: v8logResolveResult
  }
}

/**
 * Main function
 */
async function main() {
  const args = parseArgs()

  if (args.listTests) {
    const tests = listTests()

    console.log('\nAvailable tests:')
    for (const test of tests) {
      console.log(`  ${test.name}${test.description ? ` - ${test.description}` : ''}`)
    }
    process.exit(0)
  }

  // Get test definition
  let test

  try {
    test = getTest(args.testName)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const runFolderName = `${nowLocalForDir()}_${test.name}`
  const resultsDir = path.resolve(args.outDir)
  const runDir = path.join(resultsDir, runFolderName)

  fs.mkdirSync(runDir, { recursive: true })

  const mode = args.mode
  const profile = args.profile
  const track = args.track
  const warmup = args.warmup
  const runs = args.runs

  console.log(`\n=== Benchmark Run: ${runFolderName} ===`)
  console.log(`Test: ${test.name}${test.description ? ` - ${test.description}` : ''}`)
  console.log(`Mode: ${mode}`)
  console.log(`Profile: ${profile ? 'enabled' : 'disabled'} (v8log + eventloop)`)
  console.log(`Track: ${track ? 'enabled' : 'disabled'} (autocannon progress)`)
  console.log(`Warmup: ${warmup}s`)
  console.log(`Runs: ${runs}`)
  console.log(`Results: ${runDir}\n`)

  const servers =
    mode === 'all'
      ? [
          { path: path.join(__dirname, './servers/micro.js'), name: 'micro', port: 3003 },
          { path: path.join(__dirname, './servers/express.js'), name: 'express', port: 3001 },
          { path: path.join(__dirname, './servers/fastify.js'), name: 'fastify', port: 3002 },
          { path: path.join(__dirname, './servers/core.js'), name: 'core', port: 3000 }
        ]
      : [{ path: path.join(__dirname, './servers/core.js'), name: 'core', port: 3000 }]

  const allRunResults = []

  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const runResults = {}

    if (runs > 1) {
      console.log(`\n=== Run ${runIndex + 1}/${runs} ===`)
      const runSubDir = path.join(runDir, 'runs', String(runIndex))

      fs.mkdirSync(runSubDir, { recursive: true })
    }

    for (const server of servers) {
      const result = await runBenchmark(server.path, server.name, server.port, test, {
        enableProfile: profile,
        enableTrack: track,
        runId,
        runDir: runs > 1 ? path.join(runDir, 'runs', String(runIndex)) : runDir,
        warmup: runIndex === 0 ? warmup : 0,
        runIndex: runs > 1 ? runIndex : null
      })

      runResults[server.name] = {
        rps: result.requests?.average || 0,
        latency: result.latency
          ? {
              average: result.latency.average,
              p50: result.latency.p50,
              p90: result.latency.p90,
              p99: result.latency.p99
            }
          : null,
        throughput: result.throughput
          ? {
              average: result.throughput.average
            }
          : null,
        bytesPerRequest: calculateBytesPerRequest(result),
        errors: result.errors || 0,
        v8logProcess: result.v8logProcess || null,
        eventLoopStopAck: result.eventLoopStopAck || null
      }
    }

    allRunResults.push(runResults)

    if (runs > 1) {
      const runSummaryPath = path.join(runDir, 'runs', String(runIndex), 'summary.json')
      const runSummary = createSummary(
        runId,
        runFolderName,
        test.name,
        servers.map((s) => s.name),
        [runResults],
        profile
      )

      fs.writeFileSync(runSummaryPath, JSON.stringify(runSummary, null, 2))
    }
  }

  const manifest = createManifest(
    runId,
    runFolderName,
    test.name,
    test.duration,
    test.connections,
    `http://localhost:*/${test.path}`,
    profile,
    runs,
    warmup
  )

  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const summary = createSummary(
    runId,
    runFolderName,
    test.name,
    servers.map((s) => s.name),
    allRunResults,
    profile
  )

  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  console.log(`\n=== All benchmarks completed ===`)
  console.log(`Test: ${test.name}`)
  console.log(`Results directory: ${runDir}`)
  console.log(`Manifest: manifest.json`)
  console.log(`Summary: summary.json`)
  if (runs > 1) {
    console.log(`Per-run results: runs/0/ ... runs/${runs - 1}/`)
  }
  if (profile) {
    console.log(`Profiling artifacts: v8log-*.log, eventloop-*.json`)
  }

  if (mode === 'all') {
    const latestResults = await collectResults(
      runDir,
      servers.map((s) => s.name)
    )

    printComparisonTable(latestResults, 'core')
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
