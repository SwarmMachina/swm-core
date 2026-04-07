import http from 'node:http'
import { TESTS } from './tests.js'
import Metrics from './helpers/metrics.js'

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

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const out = { fw: 'core', port: 3000 }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]

    if (a === '--fw') {
      i++
      out.fw = String(v)
    } else if (a === '--port') {
      i++
      out.port = Number(v)
    }
  }

  return out
}

const { fw, port } = parseArgs(process.argv)
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
 *
 */
async function main() {
  if (fw === 'core') {
    const { default: Server } = await import('../src/index.js')

    const router = async (ctx) => {
      const method = ctx.method()
      const url = ctx.url()

      if (method === 'get' && url === '/base') {
        return TESTS.get('base').payload
      }

      if (method === 'get' && url === '/headers') {
        return sendCoreHeadersBench(ctx)
      }

      if (method === 'post' && url === '/base') {
        return await ctx.json()
      }

      ctx.status(404)
      return 'Not Found'
    }

    const server = new Server({ port, onHttpError: console.error, router })

    await server.listen()
    sendReady(server.port)

    const shutdown = async () => server.shutdown()

    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)))

    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)))

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

      if (req.method === 'GET' && req.url === '/headers') {
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
  process.exitCode = 1
})
