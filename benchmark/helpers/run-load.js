import autocannon from 'autocannon'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {import('node:child_process').ChildProcess} childProcess
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function waitForEventLoopStopAck(childProcess, timeoutMs = 5000) {
  if (!childProcess || !childProcess.send) {
    return { ok: false, error: 'Child process does not support IPC' }
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.removeListener('message', messageHandler)
      resolve({ ok: false, error: `Timeout waiting for eventloop:stopped ACK (${timeoutMs}ms)` })
    }, timeoutMs)

    const messageHandler = (msg) => {
      if (msg && typeof msg === 'object' && msg.type === 'eventloop:stopped') {
        clearTimeout(timeout)
        childProcess.removeListener('message', messageHandler)
        resolve({ ok: msg.ok === true, error: msg.error || null })
      }
    }

    childProcess.on('message', messageHandler)
  })
}

/**
 * @param {string} name
 * @param {object} opts
 * @param {object} [loadOpts]
 * @param {boolean} [loadOpts.profile]
 * @param {boolean} [loadOpts.track]
 * @param {import('node:child_process').ChildProcess} [loadOpts.childProcess]
 * @param {string} [loadOpts.framework]
 * @param {string} [loadOpts.runId]
 * @param {string} [loadOpts.testName] - Actual test name (e.g., 'base')
 * @returns {Promise<{result: object, eventLoopStopAck?: object}>}
 */
export default function runLoad(name, opts, loadOpts = {}) {
  const {
    profile = false,
    track = false,
    childProcess = null,
    framework = null,
    runId = null,
    testName = null
  } = loadOpts

  return new Promise((resolve) => {
    if (opts.verbose || track) {
      console.log(`\n=== ${name} ===`)
    }

    const actualFramework = framework || name.split('-')[0]
    const actualTestName = testName || name.split('-').slice(1).join('-') || name

    if (profile && childProcess && childProcess.send) {
      try {
        childProcess.send({
          type: 'eventloop:start',
          meta: {
            framework: actualFramework,
            testName: actualTestName,
            scenarioId: name,
            runId: runId || null
          }
        })
      } catch (err) {
        console.warn('Failed to send eventloop:start message:', err.message)
      }
    }

    const instance = autocannon({ ...opts, title: name }, async (err, result) => {
      let eventLoopStopAck = null

      if (profile && childProcess && childProcess.send) {
        try {
          childProcess.send({ type: 'eventloop:stop' })
          eventLoopStopAck = await waitForEventLoopStopAck(childProcess, 5000)

          if (!eventLoopStopAck.ok) {
            console.warn(`Eventloop stop ACK failed: ${eventLoopStopAck.error || 'unknown error'}`)
          }
        } catch (err) {
          console.warn('Failed to send eventloop:stop message:', err.message)
          eventLoopStopAck = { ok: false, error: err.message }
        }
      }

      if (err) {
        console.error(err)
        return resolve({ result, eventLoopStopAck })
      }

      if (opts.verbose) {
        console.log(`RPS: ${result.requests.average}`)
      }

      if (opts.filePath) {
        if (!fs.existsSync(opts.filePath)) {
          fs.mkdirSync(opts.filePath, { recursive: true })
        }

        const fileName = opts.fileName || `${name}.json`
        const filePath = path.join(opts.filePath, fileName)

        fs.writeFileSync(filePath, JSON.stringify(result, null, 2))

        if (opts.verbose) {
          console.log(`Save result to: ${filePath}`)
        }
      }

      resolve({ result, eventLoopStopAck })
    })

    if (track || opts.verbose) {
      autocannon.track(instance, {
        renderProgressBar: track || opts.verbose,
        renderResultsTable: opts.verbose,
        renderLatencyTable: false
      })
    }
  })
}
