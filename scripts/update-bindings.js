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
const lockPath = resolve(root, 'pnpm-lock.yaml')
const workspacePath = resolve(root, 'pnpm-workspace.yaml')
const previousPackage = readFileSync(packagePath, 'utf8')
const packageJson = JSON.parse(previousPackage)
const previousLock = readFileSync(lockPath, 'utf8')
const previousWorkspace = readFileSync(workspacePath, 'utf8')
const previousSwmVersion = packageJson.dependencies['@swarmmachina/swm-uws']
const previousUpstream = packageJson.devDependencies['uwebsockets.js']
const previousUpstreamTag = /#(v20\.\d+\.0)$/.exec(previousUpstream)?.[1]

packageJson.dependencies['@swarmmachina/swm-uws'] = swmVersion
packageJson.devDependencies['uwebsockets.js'] = `github:uNetworking/uWebSockets.js#${upstreamTag}`
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
writeFileSync(
  workspacePath,
  previousWorkspace.replaceAll(`'@swarmmachina/swm-uws@${previousSwmVersion}'`, `'@swarmmachina/swm-uws@${swmVersion}'`)
)

try {
  execFileSync('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit'
  })
  const [lockedProject] = JSON.parse(
    execFileSync(
      'pnpm',
      ['list', '@swarmmachina/swm-uws', 'uwebsockets.js', '--depth', '0', '--json', '--lockfile-only'],
      { cwd: root, encoding: 'utf8' }
    )
  )
  const lockedSwmVersion = lockedProject?.dependencies?.['@swarmmachina/swm-uws']?.version
  const lockedUpstreamVersion = lockedProject?.devDependencies?.['uwebsockets.js']?.version

  if (lockedSwmVersion !== swmVersion || lockedUpstreamVersion !== upstreamTag.slice(1)) {
    throw new Error(
      `Lockfile resolution mismatch: swm-uws=${lockedSwmVersion}, uWebSockets.js=${lockedUpstreamVersion}`
    )
  }
} catch (error) {
  writeFileSync(packagePath, previousPackage)
  writeFileSync(lockPath, previousLock)
  writeFileSync(workspacePath, previousWorkspace)
  throw error
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
