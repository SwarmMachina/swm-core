import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const REQUIRED_BINDING_CAPABILITIES = [
  'beginWrite',
  'collectBody',
  'httpTransportConfig',
  'requestPause',
  'requestPrefetch',
  'responseBatch'
]

/**
 * @param {object} pkg
 * @returns {string}
 */
function packageEntry(pkg) {
  const rootExport = pkg.exports?.['.']

  if (typeof rootExport === 'string') {
    return rootExport
  }

  if (rootExport && typeof rootExport === 'object') {
    return rootExport.import || rootExport.default
  }

  return pkg.main
}

/**
 * Resolve an unpacked sibling or release-candidate package.
 * @param {string} input
 * @returns {{entry: string, manifest: object, root: string}}
 */
export function resolveBindingCandidate(input) {
  const target = realpathSync(input)
  const root = statSync(target).isDirectory() ? target : path.dirname(target)
  const manifestPath = path.join(root, 'package.json')

  assert.ok(existsSync(manifestPath), `Candidate package manifest not found: ${manifestPath}`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = statSync(target).isDirectory() ? path.resolve(root, packageEntry(manifest)) : target

  assert.equal(manifest.name, '@swarmmachina/swm-uws', 'Candidate package name mismatch')
  assert.ok(existsSync(entry), `Candidate binding entry not found: ${entry}`)

  return { entry, manifest, root }
}
