import { deepStrictEqual, throws } from 'node:assert'
import { describe, test } from 'node:test'
import { verifyPackedFiles } from '../../scripts/build-release-artifact.js'
import { verifyReleaseMetadata } from '../../scripts/verify-release.js'

const manifest = { name: '@swarmmachina/swm-core', version: '2.0.3' }
const lockfile = { packages: { '': { ...manifest } } }

describe('release metadata', () => {
  test('accepts a synchronized manifest, lockfile and tag', () => {
    deepStrictEqual(verifyReleaseMetadata({ manifest, lockfile, tag: 'v2.0.3' }), {
      ...manifest,
      tag: 'v2.0.3'
    })
  })

  test('rejects a tag that does not match the package version', () => {
    throws(() => verifyReleaseMetadata({ manifest, lockfile, tag: 'v2.0.2' }), /release tag mismatch/)
  })

  test('rejects a stale lockfile version', () => {
    throws(
      () =>
        verifyReleaseMetadata({
          manifest,
          lockfile: { packages: { '': { ...manifest, version: '2.0.2' } } }
        }),
      /package-lock.json version mismatch/
    )
  })
})

describe('release tarball contents', () => {
  const required = ['LICENSE', 'README.md', 'package.json', 'src/index.d.ts', 'src/index.js']

  test('accepts the public package surface', () => {
    verifyPackedFiles(required.map((path) => ({ path })))
  })

  test('rejects missing entry points', () => {
    throws(() => verifyPackedFiles(required.slice(0, -1).map((path) => ({ path }))), /missing src\/index.js/)
  })

  test('rejects accidental non-package files', () => {
    throws(() => verifyPackedFiles([...required, 'tests/private.test.js'].map((path) => ({ path }))), /unexpected file/)
  })
})
