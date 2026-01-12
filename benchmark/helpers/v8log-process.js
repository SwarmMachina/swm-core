import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * @param {string} v8logPath
 * @param {string} outPath
 * @returns {Promise<{ok: boolean, error?: string, exitCode?: number}>}
 */
export async function processV8LogToTxt(v8logPath, outPath) {
  if (!fs.existsSync(v8logPath)) {
    return { ok: false, error: `V8 log file not found: ${v8logPath}` }
  }

  const outDir = path.dirname(outPath)

  fs.mkdirSync(outDir, { recursive: true })

  return new Promise((resolve) => {
    const outStream = fs.createWriteStream(outPath)

    const proc = spawn(process.execPath, ['--prof-process', v8logPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdoutError = null

    proc.stdout.on('data', (chunk) => {
      try {
        outStream.write(chunk)
      } catch (err) {
        stdoutError = err.message
      }
    })

    proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })

    proc.on('error', (err) => {
      outStream.end()
      resolve({ ok: false, error: `Failed to spawn prof-process: ${err.message}`, exitCode: -1 })
    })

    proc.on('close', (code, signal) => {
      outStream.end()

      if (code !== 0) {
        if (fs.existsSync(outPath)) {
          fs.unlinkSync(outPath)
        }

        resolve({
          ok: false,
          error: `prof-process exited with code ${code}${signal ? `, signal ${signal}` : ''}`,
          exitCode: code
        })

        return
      }

      if (stdoutError) {
        if (fs.existsSync(outPath)) {
          fs.unlinkSync(outPath)
        }

        resolve({
          ok: false,
          error: `Write error: ${stdoutError}`,
          exitCode: code || 0
        })

        return
      }

      resolve({ ok: true, exitCode: code || 0 })
    })
  })
}

/**
 * @param {string} v8logPath
 * @param {string} baseDir
 * @param {string} baseName
 * @returns {Promise<{ok: boolean, processedTxt?: string, exitCode?: number, error?: string}>}
 */
export default async function processV8Log(v8logPath, baseDir, baseName) {
  const processedTxtPath = path.join(baseDir, `${baseName}.processed.txt`)

  try {
    const result = await processV8LogToTxt(v8logPath, processedTxtPath)

    if (!result.ok) {
      return {
        ok: false,
        processedTxt: null,
        exitCode: result.exitCode,
        error: result.error
      }
    }

    return {
      ok: true,
      processedTxt: processedTxtPath,
      exitCode: result.exitCode || 0
    }
  } catch (error) {
    return {
      ok: false,
      processedTxt: null,
      exitCode: -1,
      error: error.message
    }
  }
}
