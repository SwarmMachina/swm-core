import { writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const testManifest = path.join(root, '.test-dist', 'package.json')

// Keep test-only binding injection inside the disposable compiled test scope.
// Published package metadata never points at .test-dist.
writeFileSync(
  testManifest,
  `${JSON.stringify(
    {
      type: 'module',
      imports: {
        '#uws-binding': {
          'swm-core-test': './tests/helpers/mock-uws-module.js',
          'uwebsockets-reference': 'uwebsockets.js',
          default: '@swarmmachina/swm-uws'
        }
      }
    },
    null,
    2
  )}\n`
)
