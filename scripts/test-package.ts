import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'

import { bindingRoot, makeTempDir, pack, root } from './package-test-helpers.js'

const temp = makeTempDir('swm-package-')

interface PackageManifest {
  name: string
  main?: string
  types?: string
  exports?: { '.': string | Record<string, string> }
  imports?: Record<string, string | Record<string, string>>
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
function metadataPaths(pkg: PackageManifest): string[] {
  const paths = [pkg.main, pkg.types]
  const rootExport = pkg.exports?.['.']

  if (typeof rootExport === 'string') {
    paths.push(rootExport)
  } else if (rootExport && typeof rootExport === 'object') {
    paths.push(...Object.values(rootExport).filter((value): value is string => typeof value === 'string'))
  }

  return [...new Set(paths.filter((value): value is string => typeof value === 'string').map(normalized))]
}

try {
  const packages: Array<[string, string[]]> = [
    [root, ['package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/remote-address.js']],
    [bindingRoot, ['package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/load-native.js']]
  ]

  for (const [repo, required] of packages) {
    const result = pack(repo, temp)
    const pkg: PackageManifest = JSON.parse(readFileSync(`${repo}/package.json`, 'utf8'))
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

    if (pkg.name === 'swm-core') {
      const bindingImport = pkg.imports?.['#uws-binding']

      assert.ok(bindingImport && typeof bindingImport === 'object', 'swm-core package is missing #uws-binding')
      assert.equal(
        Object.hasOwn(bindingImport, 'swm-core-test'),
        false,
        'swm-core tarball must not reference the disposable test build'
      )
    }
  }

  console.log('package metadata and tarball contents: ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
