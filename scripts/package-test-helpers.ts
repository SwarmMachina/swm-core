import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
const siblingBindingRoot = resolve(root, '../swm-uws')

export const bindingRoot = existsSync(join(siblingBindingRoot, 'package.json'))
  ? siblingBindingRoot
  : resolve(root, 'node_modules/@swarmmachina/swm-uws')

export interface PackResult {
  filename: string
  files: Array<{ path: string }>
  path: string
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * @param {string} repo
 * @param {string} destination
 * @returns {object}
 */
export function pack(repo: string, destination: string): PackResult {
  const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: repo,
    encoding: 'utf8'
  })
  const result: unknown = JSON.parse(output)

  if (
    result == null ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof (result as { filename?: unknown }).filename !== 'string' ||
    !Array.isArray((result as { files?: unknown }).files)
  ) {
    throw new Error(`pnpm pack returned invalid metadata for ${repo}`)
  }

  const metadata = result as { filename: string; files: Array<{ path: string }> }

  return { filename: metadata.filename, files: metadata.files, path: join(destination, basename(metadata.filename)) }
}
