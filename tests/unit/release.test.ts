import { deepStrictEqual, throws } from 'node:assert'
import { describe, test } from 'node:test'
import { verifyPackedFiles } from '../../scripts/build-release-artifact.js'
import { isMissingPublishedPackage } from '../../scripts/publish-release-artifact.js'
import { verifyBindingLockIntegrity, verifyReleaseMetadata } from '../../scripts/verify-release.js'

const manifest = { name: '@swarmmachina/swm-core', version: '2.0.3', packageManager: 'pnpm@11.3.0' }

describe('release metadata', () => {
  test('accepts a valid manifest and matching tag', () => {
    deepStrictEqual(verifyReleaseMetadata({ manifest, tag: 'v2.0.3' }), {
      name: manifest.name,
      version: manifest.version,
      tag: 'v2.0.3'
    })
  })

  test('rejects a tag that does not match the package version', () => {
    throws(() => verifyReleaseMetadata({ manifest, tag: 'v2.0.2' }), /release tag mismatch/)
  })

  test('rejects a missing pnpm version pin', () => {
    throws(() => verifyReleaseMetadata({ manifest: { ...manifest, packageManager: undefined } }), /must pin pnpm/)
  })
})

describe('native binding lock', () => {
  const releaseManifest = {
    ...manifest,
    dependencies: { '@swarmmachina/swm-uws': '0.6.0' }
  }

  test('accepts an exact binding entry with registry integrity', () => {
    verifyBindingLockIntegrity({
      manifest: releaseManifest,
      lockfile: "packages:\n  '@swarmmachina/swm-uws@0.6.0':\n    resolution:\n      { integrity: sha512-YWJjZA== }\n"
    })
  })

  test('rejects a prospective binding entry without published integrity', () => {
    throws(
      () =>
        verifyBindingLockIntegrity({
          manifest: releaseManifest,
          lockfile: "packages:\n  '@swarmmachina/swm-uws@0.6.0':\n    engines: { node: 22.x || 24.x }\n"
        }),
      /missing registry integrity/
    )
  })
})

describe('release tarball contents', () => {
  const required = ['LICENSE', 'README.md', 'package.json', 'dist/index.d.ts', 'dist/index.js']

  test('accepts the public package surface', () => {
    verifyPackedFiles(required.map((path) => ({ path })))
  })

  test('rejects missing entry points', () => {
    throws(() => verifyPackedFiles(required.slice(0, -1).map((path) => ({ path }))), /missing dist\/index.js/)
  })

  test('rejects accidental non-package files', () => {
    throws(() => verifyPackedFiles([...required, 'tests/private.test.js'].map((path) => ({ path }))), /unexpected file/)
  })
})

describe('published package lookup', () => {
  test('recognizes npm missing-version errors', () => {
    deepStrictEqual(isMissingPublishedPackage('{"code":"E404"}'), true)
  })

  test('does not hide registry failures', () => {
    deepStrictEqual(isMissingPublishedPackage('{"code":"ERR_PNPM_FETCH_500"}'), false)
  })
})
