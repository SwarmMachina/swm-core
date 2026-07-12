import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const swmVersion = process.argv[2]
const upstreamTag = process.argv[3]

if (!/^\d+\.\d+\.\d+$/.test(swmVersion || '') || !/^v20\.\d+\.0$/.test(upstreamTag || '')) {
  throw new Error('Usage: node scripts/update-bindings.js <swm-uws-version> <uWebSockets.js-tag>')
}

const packagePath = resolve(root, 'package.json')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const previousSwmVersion = packageJson.devDependencies['@swarmmachina/swm-uws']
const previousUpstream = packageJson.dependencies['uwebsockets.js']

packageJson.devDependencies['@swarmmachina/swm-uws'] = swmVersion
packageJson.dependencies['uwebsockets.js'] = `github:uNetworking/uWebSockets.js#${upstreamTag}`
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

try {
  execFileSync('npm', ['install', '--package-lock-only'], { cwd: root, stdio: 'inherit' })
} catch (error) {
  packageJson.devDependencies['@swarmmachina/swm-uws'] = previousSwmVersion
  packageJson.dependencies['uwebsockets.js'] = previousUpstream
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  throw error
}

const readmePath = resolve(root, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
  .replaceAll(`@swarmmachina/swm-uws@${previousSwmVersion}`, `@swarmmachina/swm-uws@${swmVersion}`)
  .replaceAll(previousUpstream.replace('github:', ''), `uNetworking/uWebSockets.js#${upstreamTag}`)
writeFileSync(readmePath, readme)

console.log(`Updated @swarmmachina/swm-uws=${swmVersion}, uWebSockets.js=${upstreamTag}`)
