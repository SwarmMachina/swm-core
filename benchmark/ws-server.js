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
  { fw: 'core', port: 3000 },
  {
    '--fw': (out, v) => {
      out.fw = String(v)
    },
    '--port': (out, v) => {
      out.port = Number(v)
    }
  }
)

/**
 * @param {number} port
 */
function sendReady(port) {
  if (process.send) {
    process.send({ type: 'ready', port })
  }
}

/**
 *
 */
async function main() {
  if (fw === 'core') {
    const { default: Server } = await import('../src/index.js')

    const server = new Server({
      port,
      onHttpError: console.error,
      router: () => 'ok',
      ws: {
        enabled: true,
        onMessage: (ctx, message, isBinary) => ctx.send(message, isBinary)
      }
    })

    await server.listen()
    sendReady(server.port)

    const shutdown = async () => server.shutdown()

    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))

    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))

    return
  }

  throw new Error(`Unknown --fw=${fw} (ws-server supports: core)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
