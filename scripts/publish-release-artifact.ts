import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ARTIFACT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * @param {string} output
 * @returns {boolean}
 */
export function isMissingPublishedPackage(output: string): boolean {
  return /\bE404\b/.test(output)
}

/**
 * @param {string} spec
 * @returns {{ found: boolean, integrity?: string }}
 */
function readPublishedIntegrity(spec: string): { found: boolean; integrity?: string } {
  const result = spawnSync('npm', ['view', spec, 'dist.integrity', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout)

    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
      throw new Error(`registry returned invalid integrity for ${spec}`)
    }

    return { found: true, integrity }
  }

  const errorOutput = `${result.stdout}\n${result.stderr}`

  if (isMissingPublishedPackage(errorOutput)) {
    return { found: false }
  }

  throw new Error(`could not determine whether ${spec} is already published: ${errorOutput.trim()}`)
}

/**
 * Publish once, or treat an identical package already present in npm as success.
 * @returns {Promise<void>}
 */
async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(ARTIFACT_DIR, 'release-manifest.json'), 'utf8'))

  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.filename !== 'string' ||
    path.basename(manifest.filename) !== manifest.filename
  ) {
    throw new Error('release manifest contains an invalid package identity')
  }

  const tarballPath = path.join(ARTIFACT_DIR, manifest.filename)
  const tarball = await fs.readFile(tarballPath)
  const sha256 = createHash('sha256').update(tarball).digest('hex')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const spec = `${manifest.name}@${manifest.version}`

  if (tarball.length !== manifest.size || sha256 !== manifest.sha256 || integrity !== manifest.integrity) {
    throw new Error(`release artifact integrity mismatch for ${manifest.filename}`)
  }

  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) {
    throw new Error(`release tag does not match artifact version ${manifest.version}`)
  }

  const published = readPublishedIntegrity(spec)

  if (published.found) {
    if (published.integrity !== integrity) {
      throw new Error(`${spec} already exists with different content`)
    }

    console.log(`[release] ${spec} is already published with the verified integrity`)

    return
  }

  execFileSync('npm', ['publish', tarballPath, '--provenance', '--access', 'public', '--ignore-scripts'], {
    stdio: 'inherit'
  })
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  main().catch((error) => {
    console.error(`[release] ${error.message}`)
    process.exitCode = 1
  })
}
