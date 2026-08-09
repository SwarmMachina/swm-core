import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyRepositoryRelease } from './verify-release.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'release-artifact')
const PUBLISH_SCRIPT = 'publish-release-artifact.js'
const REQUIRED_FILES = ['LICENSE', 'README.md', 'package.json', 'dist/index.d.ts', 'dist/index.js']
const ALLOWED_ROOT_FILES = new Set(['LICENSE', 'README.md', 'package.json'])
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

export interface PackedFile {
  path?: string
}

/**
 * @param {Array<{ path?: string }>} files
 */
export function verifyPackedFiles(files: PackedFile[]): void {
  const paths = new Set(files.map((file) => file.path).filter((file): file is string => typeof file === 'string'))

  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) {
      throw new Error(`release tarball is missing ${required}`)
    }
  }

  for (const file of paths) {
    if (!ALLOWED_ROOT_FILES.has(file) && !file.startsWith('dist/')) {
      throw new Error(`release tarball contains unexpected file: ${file}`)
    }
  }
}

/**
 * Refuse to mix a newly verified package with stale local artifacts.
 * @returns {Promise<void>}
 */
async function assertEmptyOutputDirectory() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const existing = await fs.readdir(OUT_DIR)

  if (existing.length !== 0) {
    throw new Error(`release artifact directory is not empty: ${OUT_DIR}`)
  }
}

/**
 * Build and describe the exact tarball that the publish job will receive.
 * @returns {Promise<void>}
 */
async function main() {
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2]
  const metadata = await verifyRepositoryRelease(tag)

  await assertEmptyOutputDirectory()

  const stdout = execFileSync('pnpm', ['pack', '--json', '--pack-destination', OUT_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const packed = JSON.parse(stdout)

  if (packed == null || typeof packed !== 'object' || Array.isArray(packed)) {
    throw new Error('pnpm pack returned invalid metadata')
  }

  if (packed.name !== metadata.name || packed.version !== metadata.version) {
    throw new Error(
      `packed identity mismatch: expected ${metadata.name}@${metadata.version}, ` +
        `got ${String(packed.name)}@${String(packed.version)}`
    )
  }

  verifyPackedFiles(packed.files || [])

  const filename = path.basename(packed.filename)
  const tarballPath = path.join(OUT_DIR, filename)
  const tarball = await fs.readFile(tarballPath)
  const sha256 = createHash('sha256').update(tarball).digest('hex')
  const sha512 = createHash('sha512').update(tarball).digest('hex')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const publishScript = await fs.readFile(path.join(SCRIPTS_DIR, PUBLISH_SCRIPT))
  const publishScriptSha256 = createHash('sha256').update(publishScript).digest('hex')
  const manifest = {
    schemaVersion: 'swm-release-artifact/v1',
    name: metadata.name,
    version: metadata.version,
    tag: metadata.tag,
    gitSha: process.env.GITHUB_SHA || null,
    filename,
    size: tarball.length,
    sha256,
    sha512,
    integrity
  }

  await Promise.all([
    fs.writeFile(path.join(OUT_DIR, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    fs.writeFile(
      path.join(OUT_DIR, 'SHA256SUMS'),
      `${sha256}  ${filename}\n${publishScriptSha256}  ${PUBLISH_SCRIPT}\n`
    ),
    fs.writeFile(path.join(OUT_DIR, PUBLISH_SCRIPT), publishScript)
  ])

  console.log(`[release] built ${filename} (${tarball.length} bytes, sha256=${manifest.sha256})`)
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  main().catch((error) => {
    console.error(`[release] ${error.message}`)
    process.exitCode = 1
  })
}
