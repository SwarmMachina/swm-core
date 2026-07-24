import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { createTargetRuntime } from '@swarmmachina/benchkit/target'

const RUNTIME = createTargetRuntime({ metrics: true })
const { fw, host, port } = parseArgs(
  process.argv,
  { fw: 'core', host: '127.0.0.1', port: 3000 },
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

/**
 * @param {number} port
 */
function sendReady(port) {
  RUNTIME.ready({ port })
}

/**
 * @param {number} port
 */
async function runCore(port) {
  const { default: Server } = await import('../src/index.js')
  const server = new Server({
    host,
    port,
    http: null,
    ws: {
      onMessage: (ctx, message, isBinary) => ctx.send(message, isBinary)
    }
  })

  await server.listen()
  RUNTIME.registerShutdown(() => server.shutdown())
  sendReady(server.port)
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

  app.listen(host, port, (token) => {
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

  RUNTIME.registerShutdown(shutdown)
}

/**
 *
 */
async function main() {
  if (fw === 'core' || fw === 'core-swm-uws' || fw === 'core-uwebsockets') {
    await runCore(port)

    return
  }

  if (fw === 'raw-swm-uws' || fw === 'raw-uwebsockets') {
    await runRawBinding(port)

    return
  }

  if (fw === 'ws') {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ host, port, perMessageDeflate: false })

    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
    })

    wss.on('listening', () => sendReady(wss.address().port))

    const shutdown = () => new Promise((resolve) => wss.close(() => resolve()))

    RUNTIME.registerShutdown(shutdown)

    return
  }

  throw new Error(`Unknown --fw=${fw}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
