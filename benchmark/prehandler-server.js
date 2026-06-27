import { TESTS } from './tests.js'
import Metrics from './helpers/metrics.js'
import parseArgs from './helpers/parse-args.js'

const METRICS = new Metrics()

if (process.send) {
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') {
      return
    }

    if (msg.type === 'metrics:start') {
      METRICS.start({ sampleMs: msg.sampleMs })
      return
    }

    if (msg.type === 'metrics:stop') {
      const data = METRICS.stop()

      process.send?.({ type: 'metrics', data })
    }
  })
}

const { fw, port } = parseArgs(
  process.argv,
  { fw: 'plain', port: 3000 },
  {
    '--fw': (out, v) => {
      out.fw = String(v)
    },
    '--port': (out, v) => {
      out.port = Number(v)
    }
  }
)

const payload = TESTS.get('base').payload
const noop = () => {}

/**
 *
 */
async function main() {
  if (fw !== 'plain' && fw !== 'pre') {
    throw new Error(`Unknown --fw=${fw} (prehandler-server supports: plain, pre)`)
  }

  const { default: Server } = await import('../src/index.js')

  // Same native route both ways; the 'pre' variant only adds a no-op preHandler so
  // the measured delta isolates the composed-handler (async wrapper) cost.
  const route = { method: 'get', path: '/', handler: () => payload }

  if (fw === 'pre') {
    route.preHandler = noop
  }

  const server = new Server({ port, onHttpError: console.error, routes: [route] })

  await server.listen()

  if (process.send) {
    process.send({ type: 'ready', port: server.port })
  }

  const shutdown = async () => server.shutdown()

  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))

  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
