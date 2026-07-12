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
const lockPath = resolve(root, 'package-lock.json')
const previousPackage = readFileSync(packagePath, 'utf8')
const packageJson = JSON.parse(previousPackage)
const previousLock = readFileSync(lockPath, 'utf8')
const previousSwmVersion = packageJson.devDependencies['@swarmmachina/swm-uws']
const previousUpstream = packageJson.dependencies['uwebsockets.js']
const previousUpstreamTag = /#(v20\.\d+\.0)$/.exec(previousUpstream)?.[1]

packageJson.devDependencies['@swarmmachina/swm-uws'] = swmVersion
packageJson.dependencies['uwebsockets.js'] = `github:uNetworking/uWebSockets.js#${upstreamTag}`
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

try {
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--save-exact',
      `uwebsockets.js@github:uNetworking/uWebSockets.js#${upstreamTag}`
    ],
    { cwd: root, stdio: 'inherit' }
  )
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--save-dev', '--save-exact', `@swarmmachina/swm-uws@${swmVersion}`],
    { cwd: root, stdio: 'inherit' }
  )
} catch (error) {
  writeFileSync(packagePath, previousPackage)
  writeFileSync(lockPath, previousLock)
  throw error
}

const lockJson = JSON.parse(readFileSync(lockPath, 'utf8'))
const lockedSwmVersion = lockJson.packages?.['node_modules/@swarmmachina/swm-uws']?.version
const lockedUpstreamVersion = lockJson.packages?.['node_modules/uwebsockets.js']?.version

if (lockedSwmVersion !== swmVersion || lockedUpstreamVersion !== upstreamTag.slice(1)) {
  writeFileSync(packagePath, previousPackage)
  writeFileSync(lockPath, previousLock)
  throw new Error(`Lockfile resolution mismatch: swm-uws=${lockedSwmVersion}, uWebSockets.js=${lockedUpstreamVersion}`)
}

const readmePath = resolve(root, 'README.md')
let readme = readFileSync(readmePath, 'utf8')
  .replaceAll(`@swarmmachina/swm-uws@${previousSwmVersion}`, `@swarmmachina/swm-uws@${swmVersion}`)
  .replaceAll(previousUpstream.replace('github:', ''), `uNetworking/uWebSockets.js#${upstreamTag}`)

if (previousUpstreamTag) {
  readme = readme.replaceAll(`uWebSockets.js@${previousUpstreamTag.slice(1)}`, `uWebSockets.js@${upstreamTag.slice(1)}`)
}
writeFileSync(readmePath, readme)

console.log(`Updated @swarmmachina/swm-uws=${swmVersion}, uWebSockets.js=${upstreamTag}`)
