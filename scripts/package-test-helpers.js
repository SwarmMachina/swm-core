import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
const siblingBindingRoot = resolve(root, '../swm-uws')

export const bindingRoot = existsSync(join(siblingBindingRoot, 'package.json'))
  ? siblingBindingRoot
  : resolve(root, 'node_modules/@swarmmachina/swm-uws')

/**
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * @param {string} repo
 * @param {string} destination
 * @returns {object}
 */
export function pack(repo, destination) {
  const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: repo,
    encoding: 'utf8'
  })
  const result = JSON.parse(output)

  return {
    ...result,
    path: join(destination, basename(result.filename))
  }
}
