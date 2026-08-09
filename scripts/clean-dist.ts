import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const allowedArtifacts = new Set(['dist', '.scripts-dist', '.test-dist', '.benchmark-dist'])
const artifacts = process.argv.slice(2)

if (artifacts.length === 0) {
  artifacts.push('dist')
}

for (const artifact of artifacts) {
  if (!allowedArtifacts.has(artifact)) {
    throw new Error(`Unknown build artifact: ${artifact}`)
  }

  rmSync(resolve(root, artifact), { force: true, recursive: true })
}
