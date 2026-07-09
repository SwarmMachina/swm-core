import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { startEchoServer } from './echo-server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const reportsDir = path.join(__dirname, 'reports')
const PORT = 9001
const AGENT = 'swm-core-node'
const ACCEPT = new Set(['OK', 'NON-STRICT', 'INFORMATIONAL'])

async function main() {
  fs.mkdirSync(reportsDir, { recursive: true })

  const server = await startEchoServer(PORT)

  console.log(`echo server listening on :${PORT}`)

  const args = ['run', '--rm', '-v', `${__dirname}:/config`, '-v', `${reportsDir}:/reports`]

  if (platform() === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway')
  }

  args.push('crossbario/autobahn-testsuite', 'wstest', '-m', 'fuzzingclient', '-s', '/config/fuzzingclient.json')

  console.log('running:', 'docker', args.join(' '))

  // Use async spawn (not spawnSync) so the event loop keeps running and the
  // in-process echo server can respond to the fuzzing client's connections.
  const status = await new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: 'inherit' })

    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })

  await server.shutdown(1000)

  if (status !== 0) {
    console.error('docker/wstest run failed')
    process.exit(1)
  }

  const indexPath = path.join(reportsDir, 'index.json')

  if (!fs.existsSync(indexPath)) {
    console.error('no report at', indexPath)
    process.exit(1)
  }

  const report = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  const cases = report[AGENT] ?? Object.values(report)[0] ?? {}
  const failures = []

  for (const [caseId, res] of Object.entries(cases)) {
    if (!ACCEPT.has(res.behavior) || !ACCEPT.has(res.behaviorClose)) {
      failures.push(`${caseId}: behavior=${res.behavior} close=${res.behaviorClose}`)
    }
  }

  const total = Object.keys(cases).length

  if (failures.length) {
    console.error(`\nAutobahn: ${failures.length}/${total} cases failed:`)
    failures.forEach((f) => console.error('  ' + f))
    process.exit(1)
  }

  console.log(`\nAutobahn: all ${total} cases OK/NON-STRICT`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
