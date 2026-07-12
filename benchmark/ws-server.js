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
 * @param {number} port
 * @param {'uws'|'node'} backend
 */
async function runCore(port, backend) {
  const { default: Server } = await import('../src/index.js')

  const server = new Server({
    port,
    backend,
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
}

/**
 * Run a raw binding echo server so the deep comparison can separate native
 * binding cost from swm-core's WSContext lifecycle.
 * @param {number} port
 */
async function runRawBinding(port) {
  const { App, us_listen_socket_close } = await import('#uws-binding')
  const app = App()

  app.ws('/*', {
    message: (ws, message, isBinary) => ws.send(message, isBinary)
  })

  let socket = null

  app.listen(port, (token) => {
    if (!token) {
      throw new Error(`Raw binding failed to listen on port ${port}`)
    }

    socket = token
    sendReady(port)
  })

  const shutdown = () => {
    if (socket) {
      us_listen_socket_close(socket)
      socket = null
    }

    app.close?.()
  }

  process.on('SIGTERM', () => {
    shutdown()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    shutdown()
    process.exit(0)
  })
}

/**
 *
 */
async function main() {
  if (fw === 'core' || fw === 'core-swm-uws' || fw === 'core-uwebsockets') {
    await runCore(port, 'uws')
    return
  }

  if (fw === 'core-node') {
    await runCore(port, 'node')
    return
  }

  if (fw === 'raw-swm-uws' || fw === 'raw-uwebsockets') {
    await runRawBinding(port)
    return
  }

  if (fw === 'ws') {
    const { WebSocketServer } = await import('ws')

    const wss = new WebSocketServer({ port, perMessageDeflate: false })

    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
    })

    wss.on('listening', () => sendReady(wss.address().port))

    const shutdown = () => new Promise((resolve) => wss.close(() => resolve()))

    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))

    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))

    return
  }

  throw new Error(`Unknown --fw=${fw} (ws-server supports: core, core-node, ws)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
