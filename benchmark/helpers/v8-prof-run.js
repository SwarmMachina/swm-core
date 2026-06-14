import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @param {string} dir
 * @returns {Promise<string|null>}
 */
export async function pickNewestLog(dir) {
  const items = await fs.readdir(dir)
  const logs = items.filter((f) => f.startsWith('isolate-') && f.endsWith('-v8.log'))

  if (!logs.length) {
    return null
  }

  let best = null

  for (const f of logs) {
    const st = await fs.stat(path.join(dir, f))

    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { f, mtimeMs: st.mtimeMs, size: st.size }
    }
  }

  return best?.f || null
}

/**
 * @param {string} profileDir
 * @returns {Promise<{logPath: string, processedPath: string}|null>}
 */
export async function processV8Profile(profileDir) {
  const logName = await pickNewestLog(profileDir)

  if (!logName) {
    return null
  }

  const logPath = path.join(profileDir, logName)
  const outPath = path.join(profileDir, 'profile.txt')

  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', '--prof-process', logPath], {
      stdio: ['ignore', 'pipe', 'inherit']
    })

    const out = createWriteStream(outPath)

    p.stdout.pipe(out)

    p.on('error', reject)
    p.on('exit', (code) => {
      out.end()
      if (code === 0) {
        resolve(true)
      } else {
        reject(new Error(`prof-process failed with code ${code}`))
      }
    })
  })

  return { logPath, processedPath: outPath }
}
