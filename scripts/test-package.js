import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'

import { bindingRoot, makeTempDir, pack, root } from './package-test-helpers.js'

const temp = makeTempDir('swm-package-')

/**
 * @param {string} path
 * @returns {string}
 */
function normalized(path) {
  return path.replace(/^\.\//, '')
}

/**
 * @param {object} pkg
 * @returns {string[]}
 */
function metadataPaths(pkg) {
  const paths = [pkg.main, pkg.types]
  const rootExport = pkg.exports?.['.']

  if (typeof rootExport === 'string') {
    paths.push(rootExport)
  } else if (rootExport) {
    paths.push(...Object.values(rootExport))
  }

  return [...new Set(paths.filter(Boolean).map(normalized))]
}

try {
  for (const [repo, required] of [
    [root, ['package.json', 'src/index.js', 'src/index.d.ts', 'src/remote-address.js']],
    [bindingRoot, ['package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/load-native.js']]
  ]) {
    const result = pack(repo, temp)
    const pkg = JSON.parse(readFileSync(`${repo}/package.json`, 'utf8'))
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
  }

  console.log('package metadata and tarball contents: ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
