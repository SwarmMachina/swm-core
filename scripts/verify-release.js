import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * @param {object} params
 * @param {object} params.manifest
 * @param {object} params.lockfile
 * @param {string|undefined} params.tag
 * @returns {{ name: string, version: string, tag: string|null }}
 */
export function verifyReleaseMetadata({ manifest, lockfile, tag }) {
  const name = manifest.name
  const version = manifest.version
  const locked = lockfile.packages?.['']

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('package.json must contain a package name')
  }

  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`package.json contains an invalid release version: ${String(version)}`)
  }

  if (locked?.name !== name) {
    throw new Error(`package-lock.json name mismatch: expected ${name}, got ${String(locked?.name)}`)
  }

  if (locked?.version !== version) {
    throw new Error(`package-lock.json version mismatch: expected ${version}, got ${String(locked?.version)}`)
  }

  if (tag != null && tag !== '') {
    const expectedTag = `v${version}`

    if (tag !== expectedTag) {
      throw new Error(`release tag mismatch: expected ${expectedTag}, got ${tag}`)
    }
  }

  return { name, version, tag: tag || null }
}

/**
 * @param {string|undefined} tag
 * @returns {Promise<{ name: string, version: string, tag: string|null }>}
 */
export async function verifyRepositoryRelease(tag) {
  const [manifest, lockfile] = await Promise.all([
    fs.readFile(path.join(ROOT, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8').then(JSON.parse)
  ])

  return verifyReleaseMetadata({ manifest, lockfile, tag })
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  verifyRepositoryRelease(process.argv[2])
    .then(({ name, version, tag }) => {
      console.log(`[release] metadata verified: ${name}@${version}${tag ? ` (${tag})` : ''}`)
    })
    .catch((error) => {
      console.error(`[release] ${error.message}`)
      process.exitCode = 1
    })
}
