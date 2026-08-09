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

type PackageRootExport = string | { import?: string; default?: string }

export interface BindingManifest {
  name: string
  version: string
  main?: string
  exports?: { '.': PackageRootExport }
}

export interface BindingCandidate {
  entry: string
  manifest: BindingManifest
  root: string
}

/**
 * @param {object} pkg
 * @returns {string}
 */
function packageEntry(pkg: BindingManifest): string {
  const rootExport = pkg.exports?.['.']

  if (typeof rootExport === 'string') {
    return rootExport
  }

  if (rootExport && typeof rootExport === 'object') {
    if (typeof rootExport.import === 'string') {
      return rootExport.import
    }

    if (typeof rootExport.default === 'string') {
      return rootExport.default
    }
  }

  if (typeof pkg.main === 'string') {
    return pkg.main
  }

  throw new Error('Candidate package does not declare an importable entry point')
}

/**
 * Resolve an unpacked sibling or release-candidate package.
 * @param {string} input
 * @returns {{entry: string, manifest: object, root: string}}
 */
export function resolveBindingCandidate(input: string): BindingCandidate {
  const target = realpathSync(input)
  const root = statSync(target).isDirectory() ? target : path.dirname(target)
  const manifestPath = path.join(root, 'package.json')

  assert.ok(existsSync(manifestPath), `Candidate package manifest not found: ${manifestPath}`)

  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.ok(
    manifest && typeof manifest === 'object' && !Array.isArray(manifest),
    'Candidate manifest must be an object'
  )
  const typedManifest = manifest as Partial<BindingManifest>

  assert.equal(typedManifest.name, '@swarmmachina/swm-uws', 'Candidate package name mismatch')
  assert.equal(typeof typedManifest.version, 'string', 'Candidate package version must be a string')

  const completeManifest = typedManifest as BindingManifest
  const entry = statSync(target).isDirectory() ? path.resolve(root, packageEntry(completeManifest)) : target

  assert.ok(existsSync(entry), `Candidate binding entry not found: ${entry}`)

  return { entry, manifest: completeManifest, root }
}
