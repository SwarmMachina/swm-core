import { fork } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nowForFile } from './time.js'

/**
 * @param {string} scriptPath
 * @param {string} testName
 * @param {string} resultPath
 * @param {(string|number)[]} args
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {boolean} [options.profile]
 * @param {string} [options.v8LogFile]
 * @param {string} [options.eventLoopLogFile]
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export default function runWithProfiling(scriptPath, testName, resultPath, args = [], options = {}) {
  const { timeout = 30 * 1000, profile = false, v8LogFile = null, eventLoopLogFile = null } = options

  return new Promise((resolve, reject) => {
    const benchmarkDir = path.resolve(resultPath)

    fs.mkdirSync(benchmarkDir, { recursive: true })

    const eventLoopProfilerPath = fileURLToPath(new URL('./eventloop-profiler.js', import.meta.url))

    if (profile) {
      if (v8LogFile || eventLoopLogFile) {
        //
      } else {
        const ts = nowForFile()
        const v8Log = path.join(benchmarkDir, `v8log-${testName}-${ts}.log`)
        const elLog = path.join(benchmarkDir, `eventloop-${testName}-${ts}.json`)

        options.v8LogFile = v8Log
        options.eventLoopLogFile = elLog
      }
    }

    const finalV8LogFile = profile ? v8LogFile || options.v8LogFile : null
    const finalElLogFile = profile ? eventLoopLogFile || options.eventLoopLogFile : null

    const env = { ...process.env }
    const execArgv = []

    if (profile && finalElLogFile) {
      env.EVENTLOOP_PROFILE_FILE = finalElLogFile
      execArgv.push(`--import=${eventLoopProfilerPath}`)
    }

    if (profile && finalV8LogFile) {
      execArgv.push('--prof', '--log-source-position', `--logfile=${finalV8LogFile}`)
    }

    const childCwd = profile ? benchmarkDir : process.cwd()

    const child = fork(path.resolve(scriptPath), args, {
      cwd: childCwd,
      env,
      execArgv: execArgv.length > 0 ? execArgv : undefined,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    })

    const timeoutId = setTimeout(() => {
      console.log(`Timeout id ${timeoutId}, kill process`)
      child.kill('SIGTERM')

      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }, 2_000).unref()

      reject(new Error(`Timeout: ${testName} benchmark did not send 'ready' message within ${timeout}ms`))
    }, timeout)

    timeoutId.unref()

    child.once('error', (error) => {
      console.error(`Failed to start ${testName} benchmark:`, error)
      clearTimeout(timeoutId)
      reject(error)
    })

    child.on('message', (msg) => {
      if (msg === 'ready') {
        clearTimeout(timeoutId)
        resolve(child)
      }
    })

    child.once('close', (code, signal) => {
      if (code === 0) {
        if (profile && (finalV8LogFile || finalElLogFile)) {
          //
        }

        return
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`

      console.error(`${testName} benchmark exited with ${reason}`)
      reject(new Error(`Benchmark exited with ${reason}`))
    })
  })
}
