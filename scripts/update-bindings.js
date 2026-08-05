import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getBindingLockIntegrity, verifyBindingLockIntegrity } from './verify-release.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const swmVersion = process.argv[2]
const upstreamTag = process.argv[3]
const bindingName = '@swarmmachina/swm-uws'

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

/**
 * @param {string} lockfile
 * @param {string} version
 * @param {string} integrity
 * @returns {string}
 */
function addBindingIntegrity(lockfile, version, integrity) {
  const header = `  '${bindingName}@${version}':`
  const start = lockfile.indexOf(header)

  if (start === -1) {
    throw new Error(`pnpm-lock.yaml is missing ${bindingName}@${version}`)
  }

  const next = lockfile.indexOf("\n  '", start + header.length)
  const end = next === -1 ? lockfile.length : next
  const block = lockfile.slice(start, end)

  let updatedBlock

  if (/\n\s+resolution:\s*\{\s*\}/u.test(block)) {
    updatedBlock = block.replace(/(\n\s+resolution:)\s*\{\s*\}/u, `$1 { integrity: ${integrity} }`)
  } else if (!/\n\s+resolution:/u.test(block)) {
    updatedBlock = `${header}\n    resolution: { integrity: ${integrity} }${block.slice(header.length)}`
  } else {
    throw new Error(`Cannot safely add registry integrity to ${bindingName}@${version}`)
  }

  return lockfile.slice(0, start) + updatedBlock + lockfile.slice(end)
}

/**
 * @param {string} version
 * @returns {string}
 */
function getPublishedBindingIntegrity(version) {
  const output = execFileSync('npm', ['view', `${bindingName}@${version}`, 'dist.integrity', '--json'], {
    cwd: root,
    encoding: 'utf8'
  })
  const integrity = JSON.parse(output)

  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/u.test(integrity)) {
    throw new Error(`Registry returned invalid integrity for ${bindingName}@${version}`)
  }

  return integrity
}

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

  const publishedIntegrity = getPublishedBindingIntegrity(swmVersion)

  let nextLock = readFileSync(lockPath, 'utf8')

  const lockedIntegrity = getBindingLockIntegrity({ manifest: packageJson, lockfile: nextLock })

  if (lockedIntegrity === null) {
    nextLock = addBindingIntegrity(nextLock, swmVersion, publishedIntegrity)
    writeFileSync(lockPath, nextLock)
  } else if (lockedIntegrity !== publishedIntegrity) {
    throw new Error(
      `Registry integrity mismatch for ${bindingName}@${swmVersion}: lock=${lockedIntegrity}, registry=${publishedIntegrity}`
    )
  }

  verifyBindingLockIntegrity({ manifest: packageJson, lockfile: readFileSync(lockPath, 'utf8') })

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
