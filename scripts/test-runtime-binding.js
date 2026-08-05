import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REQUIRED_BINDING_CAPABILITIES, resolveBindingCandidate } from './binding-candidate.js'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * @param {string} directory
 * @returns {string[]}
 */
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      return testFiles(target)
    }

    return entry.isFile() && entry.name.endsWith('.test.js') ? [target] : []
  })
}

/**
 * Validate and run the complete HTTP/WebSocket runtime contract against an
 * unpacked sibling or release-candidate binding.
 */
async function main() {
  const sibling = path.resolve(ROOT, '../swm-uws')
  const input = process.env.SWM_UWS_CANDIDATE || (existsSync(sibling) ? sibling : null)

  assert.ok(input, 'Set SWM_UWS_CANDIDATE to an unpacked @swarmmachina/swm-uws candidate')

  const candidate = resolveBindingCandidate(input)
  const coreManifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const expectedVersion = coreManifest.dependencies['@swarmmachina/swm-uws']

  assert.equal(
    candidate.manifest.version,
    expectedVersion,
    `Candidate version ${candidate.manifest.version} does not match swm-core dependency ${expectedVersion}`
  )

  const binding = await import(pathToFileURL(candidate.entry).href)
  const advertised = binding.capabilities()

  for (const capability of REQUIRED_BINDING_CAPABILITIES) {
    assert.equal(advertised[capability], true, `Candidate is missing capability: ${capability}`)
  }

  assert.match(binding.version(), new RegExp(`^${expectedVersion.replaceAll('.', '\\.')}(?:\\+|$)`))

  console.log(`[binding-candidate] package=${candidate.manifest.name}@${candidate.manifest.version}`)
  console.log(`[binding-candidate] root=${candidate.root}`)
  console.log(`[binding-candidate] capabilities=${REQUIRED_BINDING_CAPABILITIES.join(',')}`)

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(ROOT, 'tests/helpers/register-candidate-binding-loader.js'),
      '--test',
      ...testFiles(path.join(ROOT, 'tests/e2e')).sort()
    ],
    {
      cwd: ROOT,
      env: { ...process.env, SWM_UWS_CANDIDATE_ENTRY: candidate.entry },
      stdio: 'inherit'
    }
  )

  if (result.error) {
    throw result.error
  }

  assert.equal(result.signal, null, `Candidate e2e was terminated by ${result.signal}`)
  assert.equal(result.status, 0, `Candidate e2e exited with code ${result.status}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
