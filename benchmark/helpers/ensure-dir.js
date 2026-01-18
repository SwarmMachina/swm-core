import fs from 'node:fs/promises'

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
export default async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}
