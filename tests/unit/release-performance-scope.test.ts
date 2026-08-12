import { deepStrictEqual, equal } from 'node:assert'
import { describe, test } from 'node:test'

import { classifyReleasePerformance } from '../../scripts/release-performance-scope.js'

const baseManifest = {
  name: '@swarmmachina/swm-core',
  version: '5.0.0',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js'
    }
  },
  dependencies: { '@swarmmachina/swm-uws': '0.6.2' }
}

describe('release performance scope', () => {
  test('skips performance for documentation and opt-in type declarations', () => {
    const currentManifest = {
      ...baseManifest,
      version: '5.0.1',
      exports: {
        ...baseManifest.exports,
        './global': { types: './dist/global.d.ts' }
      }
    }
    const result = classifyReleasePerformance(
      [
        '.github/workflows/ci.yml',
        'README.md',
        'package.json',
        'scripts/copy-public-types.ts',
        'scripts/release-performance-scope.ts',
        'scripts/test-package.ts',
        'src/index.d.ts',
        'tests/fixtures/types/jsdoc-consumer.js',
        'tests/unit/release-performance-scope.test.ts',
        'types/global.d.ts'
      ],
      baseManifest,
      currentManifest
    )

    deepStrictEqual(result, { reasons: [], requiresPerformance: false })
  })

  test('requires performance for runtime source changes', () => {
    const result = classifyReleasePerformance(['src/http/context.ts'], baseManifest, baseManifest)

    equal(result.requiresPerformance, true)
    deepStrictEqual(result.reasons, ['src/http/context.ts may affect runtime performance'])
  })

  test('requires performance for dependency graph changes', () => {
    const currentManifest = {
      ...baseManifest,
      dependencies: { '@swarmmachina/swm-uws': '0.6.3' }
    }
    const result = classifyReleasePerformance(['package.json', 'pnpm-lock.yaml'], baseManifest, currentManifest)

    equal(result.requiresPerformance, true)
    deepStrictEqual(result.reasons, [
      'pnpm-lock.yaml may affect runtime performance',
      'package.json:dependencies changed'
    ])
  })

  test('requires performance when the root runtime export changes', () => {
    const currentManifest = {
      ...baseManifest,
      exports: {
        '.': {
          ...baseManifest.exports['.'],
          import: './dist/other.js'
        }
      }
    }
    const result = classifyReleasePerformance(['package.json'], baseManifest, currentManifest)

    equal(result.requiresPerformance, true)
    deepStrictEqual(result.reasons, ['package.json:exports changes runtime exports'])
  })

  test('requires performance for a new runtime subpath', () => {
    const currentManifest = {
      ...baseManifest,
      exports: {
        ...baseManifest.exports,
        './runtime': { import: './dist/runtime.js' }
      }
    }
    const result = classifyReleasePerformance(['package.json'], baseManifest, currentManifest)

    equal(result.requiresPerformance, true)
    deepStrictEqual(result.reasons, ['package.json:exports changes runtime exports'])
  })
})
