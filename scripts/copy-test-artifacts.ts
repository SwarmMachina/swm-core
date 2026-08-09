import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const autobahnSource = path.join(root, 'tests', 'autobahn', 'fuzzingclient.json')
const autobahnTarget = path.join(root, '.test-dist', 'tests', 'autobahn', 'fuzzingclient.json')
const testManifest = path.join(root, '.test-dist', 'package.json')

mkdirSync(path.dirname(autobahnTarget), { recursive: true })
cpSync(autobahnSource, autobahnTarget)

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
