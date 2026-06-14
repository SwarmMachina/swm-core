import { spawn } from 'node:child_process'

/**
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
export default function runChild(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', ...opts })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`node ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
}
