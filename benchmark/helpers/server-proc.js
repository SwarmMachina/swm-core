import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import delay from '../../helpers/delay.js'
import { getFreePort } from '../../helpers/ports.js'
import ensureDir from './ensure-dir.js'
import waitForMessage from './wait-for-message.js'

const SERVER_READY_TIMEOUT_MS = 60_000

/**
 * @param {object} o
 * @param {string} o.benchDir
 * @param {string} o.serverName
 * @param {string} o.fw
 * @param {string} o.testName
 * @param {number} o.runIndex
 * @param {boolean} o.v8prof
 * @param {string} o.runStamp
 * @returns {Promise<{proc: import('node:child_process').ChildProcess, port: number, profileDir: string}>}
 */
export async function startServer({ benchDir, serverName, fw, testName, runIndex, v8prof, runStamp }) {
  const serverPath = path.join(benchDir, serverName)
  const port = await getFreePort()

  const profileDir = await ensureDir(
    path.join(benchDir, 'profiles', `${testName}-${runStamp}`, `run-${runIndex + 1}`, fw)
  )

  const nodeArgs = []

  if (v8prof) {
    nodeArgs.push('--prof')
  }

  nodeArgs.push(serverPath, '--fw', fw, '--port', port)

  const p = spawn(process.execPath, nodeArgs, {
    cwd: profileDir,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })

  const msg = await waitForMessage(p, (m) => m && m.type === 'ready', SERVER_READY_TIMEOUT_MS).catch((e) => {
    p.kill('SIGKILL')
    throw e
  })

  if (!msg || msg.type !== 'ready' || !msg.port) {
    p.kill('SIGKILL')
    throw new Error(`bad ready from ${fw}`)
  }

  return { proc: p, port: msg.port, profileDir }
}

/**
 * @param {import('node:child_process').ChildProcess} p
 */
export async function stopServer(p) {
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
