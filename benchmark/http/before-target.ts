import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { TargetRuntime } from '@swarmmachina/benchkit/target'
import { getTest } from './scenarios.js'
import type { Route } from '../../src/server/options.js'

const RUNTIME = new TargetRuntime({ metrics: true })
const { fw, host, port } = parseArgs(
  process.argv,
  { fw: 'plain', host: '127.0.0.1', port: 3000 },
  {
    '--fw': (out, v) => {
      out.fw = String(v)
    },
    '--port': (out, v) => {
      out.port = Number(v)
    },
    '--host': (out, v) => {
      out.host = String(v)
    }
  }
)
const payload = getTest('base-sync').payload
const noop = () => {}

/**
 *
 */
async function main() {
  if (fw !== 'plain' && fw !== 'before') {
    throw new Error(`Unknown --fw=${fw} (before-server supports: plain, before)`)
  }

  const { default: Server } = await import('../../src/index.js')
  // Same native route both ways; the 'before' variant only adds a synchronous
  // no-op hook so the measured delta isolates sync composition overhead.
  const route: Route = { method: 'get', path: '/', handler: () => payload }

  if (fw === 'before') {
    route.before = noop
  }

  const server = new Server({ host, port, http: { routes: [route], onError: console.error } })

  await server.listen()
  RUNTIME.registerShutdown(() => server.shutdown())
  RUNTIME.ready({ port: server.port })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
