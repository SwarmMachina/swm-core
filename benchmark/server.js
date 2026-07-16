import http from 'node:http'
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

const HEADERS_TEST = TESTS.get('headers')

/**
 * @param {import('../src/http-context.js').default} ctx
 */
function sendCoreHeadersBench(ctx) {
  ctx.setHeader('content-type', HEADERS_TEST.responseHeaders['content-type'])
  ctx.setHeader('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
  ctx.setHeader('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
  ctx.setHeader('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
  ctx.appendHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
  ctx.appendHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
  ctx.reply(200, null, HEADERS_TEST.responseText)
}

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
  const { default: Server, prepareHeaders } = await import('../src/index.js')
  const preparedHeaders = prepareHeaders(HEADERS_TEST.responseHeaders)

  const router = async (ctx) => {
    const method = ctx.method()
    const url = ctx.url()

    if (method === 'get' && url === '/base') {
      return TESTS.get('base').payload
    }

    if (method === 'get' && url === '/headers') {
      return sendCoreHeadersBench(ctx)
    }

    if (method === 'get' && url === '/headers-prepared') {
      return ctx.reply(200, preparedHeaders, HEADERS_TEST.responseText)
    }

    if (method === 'post' && url === '/base') {
      return await ctx.json()
    }

    ctx.status(404)
    return 'Not Found'
  }

  const server = new Server({ port, onHttpError: console.error, router, backend })

  await server.listen()
  sendReady(server.port)

  const shutdown = async () => server.shutdown()

  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))

  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))
}

/**
 * Run the binding directly, without swm-core request/context overhead. Both
 * bindings execute this exact JS path; only the resolved native module
 * differs.
 * @param {number} port
 */
async function runRawBinding(port) {
  const { App, us_listen_socket_close } = await import('#uws-binding')
  const app = App()

  app.get('/base', (res) => {
    res.writeHeader('content-type', 'application/json').end('{"ok":true}')
  })

  app.get('/headers', (res) => {
    res
      .writeHeader('content-type', HEADERS_TEST.responseHeaders['content-type'])
      .writeHeader('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
      .writeHeader('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
      .writeHeader('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
      .writeHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
      .writeHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
      .end(HEADERS_TEST.responseText)
  })

  app.post('/base', (res) => {
    const chunks = []

    res.onData((chunk, isLast) => {
      chunks.push(Buffer.from(chunk))

      if (isLast) {
        res.writeHeader('content-type', 'application/json').end(Buffer.concat(chunks))
      }
    })
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

  if (fw === 'express') {
    const { default: express } = await import('express')

    const app = express()

    app.disable('x-powered-by')
    app.set('etag', false)
    app.use(express.json())

    app.get('/base', (req, res) => res.status(200).json(TESTS.get('base').payload))
    app.get('/headers', (req, res) => {
      res.set('content-type', HEADERS_TEST.responseHeaders['content-type'])
      res.set('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
      res.set('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
      res.set('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
      res.append('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
      res.append('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
      res.status(200).send(HEADERS_TEST.responseText)
    })
    app.get('/headers-prepared', (req, res) => {
      res.set(HEADERS_TEST.responseHeaders)
      res.status(200).send(HEADERS_TEST.responseText)
    })
    app.post('/base', (req, res) => res.status(200).json(req.body))
    app.use((req, res) => res.status(404).send('Not Found'))

    const srv = app.listen(port, () => sendReady(srv.address().port))

    const shutdown = () => new Promise((resolve) => srv.close(resolve))

    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))
    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))
    return
  }

  if (fw === 'fastify') {
    const { default: Fastify } = await import('fastify')
    const fastify = Fastify({ logger: false })

    fastify.get('/base', async () => TESTS.get('base').payload)
    fastify.get('/headers', async (req, reply) => {
      reply.header('content-type', HEADERS_TEST.responseHeaders['content-type'])
      reply.header('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
      reply.header('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
      reply.header('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
      reply.header('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
      reply.header('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
      reply.code(200).send(HEADERS_TEST.responseText)
    })
    fastify.get('/headers-prepared', async (req, reply) => {
      reply.headers(HEADERS_TEST.responseHeaders)
      reply.code(200).send(HEADERS_TEST.responseText)
    })
    fastify.post('/base', async (req) => req.body)

    fastify.setNotFoundHandler((req, reply) => reply.code(404).send('Not Found'))

    await fastify.listen({ port })
    sendReady(fastify.server.address().port)

    const shutdown = () => fastify.close()

    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))
    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))
    return
  }

  if (fw === 'micro') {
    const { serve, json } = await import('micro')

    const router = async (req, res) => {
      if (req.method === 'GET' && req.url === '/base') {
        return TESTS.get('base').payload
      }

      if (req.method === 'GET' && (req.url === '/headers' || req.url === '/headers-prepared')) {
        res.setHeader('Content-Type', HEADERS_TEST.responseHeaders['content-type'])
        res.setHeader('Cache-Control', HEADERS_TEST.responseHeaders['cache-control'])
        res.setHeader('X-Trace-Id', HEADERS_TEST.responseHeaders['x-trace-id'])
        res.setHeader('X-Response-Id', HEADERS_TEST.responseHeaders['x-response-id'])
        res.setHeader('Set-Cookie', HEADERS_TEST.responseHeaders['set-cookie'])
        return HEADERS_TEST.responseText
      }

      if (req.method === 'POST' && req.url === '/base') {
        return await json(req)
      }

      res.statusCode = 404
      return 'Not Found'
    }

    const server = new http.Server(serve(router))

    server.listen(port, () => sendReady(server.address().port))

    const shutdown = () => new Promise((resolve) => server.close(resolve))

    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))
    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))
    return
  }

  throw new Error(`Unknown --fw=${fw}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
