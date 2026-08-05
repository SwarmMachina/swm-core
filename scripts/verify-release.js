import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * @param {object} params
 * @param {object} params.manifest
 * @param {string|undefined} params.tag
 * @returns {{ name: string, version: string, tag: string|null }}
 */
export function verifyReleaseMetadata({ manifest, tag }) {
  const name = manifest.name
  const version = manifest.version

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('package.json must contain a package name')
  }

  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`package.json contains an invalid release version: ${String(version)}`)
  }

  if (!/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.packageManager || '')) {
    throw new Error(`package.json must pin pnpm in packageManager, got ${String(manifest.packageManager)}`)
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
 * Read the exact native runtime dependency's registry integrity.
 * @param {object} params
 * @param {object} params.manifest
 * @param {string} params.lockfile
 * @returns {string|null}
 */
export function getBindingLockIntegrity({ manifest, lockfile }) {
  const name = '@swarmmachina/swm-uws'
  const version = manifest.dependencies?.[name]

  if (typeof version !== 'string') {
    throw new Error(`${name} must be an exact runtime dependency`)
  }

  const header = `  '${name}@${version}':`
  const start = lockfile.indexOf(header)

  if (start === -1) {
    throw new Error(`pnpm-lock.yaml is missing ${name}@${version}`)
  }

  const next = lockfile.indexOf("\n  '", start + header.length)
  const block = lockfile.slice(start, next === -1 ? lockfile.length : next)
  const match = /resolution:\s*(?:\r?\n\s*)?\{\s*integrity:\s*(sha512-[A-Za-z0-9+/=]+)\s*\}/u.exec(block)

  return match?.[1] ?? null
}

/**
 * Require the exact native runtime dependency to be locked by registry
 * integrity before a release artifact can be built.
 * @param {object} params
 * @param {object} params.manifest
 * @param {string} params.lockfile
 */
export function verifyBindingLockIntegrity({ manifest, lockfile }) {
  const name = '@swarmmachina/swm-uws'
  const version = manifest.dependencies?.[name]

  if (getBindingLockIntegrity({ manifest, lockfile }) === null) {
    throw new Error(`pnpm-lock.yaml is missing registry integrity for ${name}@${version}`)
  }
}

/**
 * @param {string|undefined} tag
 * @returns {Promise<{ name: string, version: string, tag: string|null }>}
 */
export async function verifyRepositoryRelease(tag) {
  const [manifest, lockfile] = await Promise.all([
    fs.readFile(path.join(ROOT, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  ])

  verifyBindingLockIntegrity({ manifest, lockfile })

  try {
    execFileSync('pnpm', ['install', '--lockfile-only', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: ROOT,
      stdio: 'ignore'
    })
  } catch {
    throw new Error('pnpm-lock.yaml does not match package.json')
  }

  return verifyReleaseMetadata({ manifest, tag })
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
