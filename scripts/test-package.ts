import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'

import { assertCorePackageIsolation, type PackageManifest } from './package-contract.js'
import { bindingRoot, makeTempDir, pack, root } from './package-test-helpers.js'

const temp = makeTempDir('swm-package-')

interface PackedPackageManifest extends PackageManifest {
  main?: string
  types?: string
  exports?: Record<string, string | Record<string, string>>
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalized(path: string): string {
  return path.replace(/^\.\//, '')
}

/**
 * @param {object} pkg
 * @returns {string[]}
 */
function metadataPaths(pkg: PackedPackageManifest): string[] {
  const paths = [pkg.main, pkg.types]

  for (const entry of Object.values(pkg.exports ?? {})) {
    if (typeof entry === 'string') {
      paths.push(entry)
    } else {
      paths.push(...Object.values(entry).filter((value): value is string => typeof value === 'string'))
    }
  }

  return [...new Set(paths.filter((value): value is string => typeof value === 'string').map(normalized))]
}

try {
  const packages: Array<[string, string[]]> = [
    [root, ['package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/global.d.ts', 'dist/net/remote-address.js']],
    [bindingRoot, ['package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/load-native.js']]
  ]

  for (const [repo, required] of packages) {
    const result = pack(repo, temp)
    const pkg: PackedPackageManifest = JSON.parse(readFileSync(`${repo}/package.json`, 'utf8'))
    const files = new Set(result.files.map((entry) => entry.path))

    for (const path of [...required, ...metadataPaths(pkg)]) {
      assert.ok(files.has(path), `${pkg.name} tarball is missing ${path}`)
    }

    if (pkg.name === '@swarmmachina/swm-uws') {
      assert.ok(
        [...files].some((path) => path.startsWith('prebuilds/')),
        'swm-uws tarball is missing prebuilds'
      )
    }

    assertCorePackageIsolation(pkg)
  }

  console.log('package metadata and tarball contents: ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
