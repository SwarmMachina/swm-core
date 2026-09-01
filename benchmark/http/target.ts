import http from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { TargetRuntime } from '@swarmmachina/benchkit/target'
import { getTest, type HeadersTestDefinition } from './scenarios.js'
import type HttpContext from '../../src/http/context.js'
import type { Handler } from '../../src/server/options.js'

interface RawResponse {
  writeHeader(name: string, value: string): RawResponse
  end(body?: string | Buffer): void
  cork(callback: () => void): void
  onAborted(callback: () => void): void
  onData(callback: (chunk: ArrayBuffer, isLast: boolean) => void): void
}

interface RawApp {
  get(path: string, handler: (response: RawResponse) => void): RawApp
  post(path: string, handler: (response: RawResponse) => void): RawApp
  listen(host: string, port: number, callback: (token: unknown) => void): void
  close?(): void
}

interface RawBindingModule {
  App(): RawApp
  us_listen_socket_close(socket: unknown): void
}

const RUNTIME = new TargetRuntime({ metrics: true })
const { fw, host, port, testName } = parseArgs(
  process.argv,
  { fw: 'core', host: '127.0.0.1', port: 3000, testName: 'base-sync' },
  {
    '--fw': (out, v) => {
      out.fw = String(v)
    },
    '--port': (out, v) => {
      out.port = Number(v)
    },
    '--host': (out, v) => {
      out.host = String(v)
    },
    '--test': (out, v) => {
      out.testName = String(v)
    }
  }
)
const HEADERS_TEST = getTest('headers') as HeadersTestDefinition
const BASE_SYNC_TEST = getTest('base-sync')
const BASE_ASYNC_TEST = getTest('base-async')
const STATIC_FIXTURE_ROOT = join(import.meta.dirname, 'fixtures')
const STREAM_PAYLOAD = Buffer.from('stream benchmark payload\n'.repeat(512))
const STREAM_BACKPRESSURE_CHUNKS = Array.from({ length: 16 }, () => Buffer.alloc(64 * 1024, 's'))

let streamBackpressurePauses = 0
let streamBackpressureResumes = 0

function createBackpressureReadable(): Readable {
  const readable = Readable.from(STREAM_BACKPRESSURE_CHUNKS)

  let paused = false

  readable.on('pause', () => {
    paused = true
    streamBackpressurePauses++
  })
  readable.on('resume', () => {
    if (paused) {
      paused = false
      streamBackpressureResumes++
    }
  })

  return readable
}

/**
 * @returns {Promise<unknown>}
 */
async function getAsyncPayload(): Promise<unknown> {
  return BASE_ASYNC_TEST.payload
}

/**
 * @param {import('../../src/http/context.js').default} ctx
 */
function sendCoreHeadersBenchWithAppend(ctx: HttpContext): void {
  ctx.setHeader('content-type', HEADERS_TEST.responseHeaders['content-type'])
  ctx.setHeader('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
  ctx.setHeader('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
  ctx.setHeader('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
  ctx.appendHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
  ctx.appendHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
  ctx.reply(200, null, HEADERS_TEST.responseText)
}

/**
 * @param {import('../../src/http/context.js').default} ctx
 */
function sendCoreHeadersBenchWithArray(ctx: HttpContext): void {
  ctx.setHeader('content-type', HEADERS_TEST.responseHeaders['content-type'])
  ctx.setHeader('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
  ctx.setHeader('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
  ctx.setHeader('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
  ctx.setHeader('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'])
  ctx.reply(200, null, HEADERS_TEST.responseText)
}

/**
 * @param {number} port
 */
function sendReady(port: number): void {
  RUNTIME.ready({ port })
}

/**
 * @param {number} port
 * @param {{prefetch?: boolean, maxBodyBudget?: number|null, requestTimeoutMs?: number, nativeFastPaths?: string}} [options]
 */
interface CoreOptions {
  prefetch?: boolean
  maxBodyBudget?: number | null
  requestTimeoutMs?: number
  nativeFastPaths?: string
  headerMode?: 'append' | 'array'
}

async function runCore(port: number, options: CoreOptions = {}) {
  const {
    prefetch = false,
    maxBodyBudget = null,
    requestTimeoutMs = 0,
    nativeFastPaths,
    headerMode = 'append'
  } = options

  if (nativeFastPaths !== undefined) {
    process.env.SWM_UWS_NATIVE_FAST_PATHS = nativeFastPaths
  }

  const { default: Server, prepareHeaders, serveStatic } = await import('../../src/index.js')
  const preparedHeaders = prepareHeaders(HEADERS_TEST.responseHeaders)
  const streamHeaders = prepareHeaders({ 'content-type': 'text/plain; charset=utf-8' })
  const serveCached = serveStatic(STATIC_FIXTURE_ROOT, { cacheLimit: 1 })
  const serveUncached = serveStatic(STATIC_FIXTURE_ROOT, { cacheLimit: 0 })
  const sendHeadersBench = headerMode === 'array' ? sendCoreHeadersBenchWithArray : sendCoreHeadersBenchWithAppend
  const onRequest: Handler = (ctx) => {
    const method = ctx.getMethod()
    const url = ctx.getUrl()

    if (method === 'get' && url === '/base-sync') {
      return BASE_SYNC_TEST.payload
    }

    if (method === 'get' && url === '/base-async') {
      return getAsyncPayload()
    }

    if (method === 'get' && url === '/headers') {
      return sendHeadersBench(ctx)
    }

    if (method === 'get' && url === '/headers-prepared') {
      return ctx.reply(200, preparedHeaders, HEADERS_TEST.responseText)
    }

    if (method === 'get' && url === '/__bench/stream-backpressure/reset') {
      streamBackpressurePauses = 0
      streamBackpressureResumes = 0

      return { ok: true }
    }

    if (method === 'get' && url === '/__bench/stream-backpressure/stats') {
      return { pauses: streamBackpressurePauses, resumes: streamBackpressureResumes }
    }

    if (method === 'get' && url.startsWith('/static-cache-hit/')) {
      return serveCached(ctx)
    }

    if (method === 'get' && url.startsWith('/static-cache-miss/')) {
      return serveUncached(ctx)
    }

    if (method === 'get' && url === '/stream') {
      return ctx.stream(Readable.from([STREAM_PAYLOAD]), 200, streamHeaders)
    }

    if (method === 'get' && url === '/stream-backpressure') {
      return ctx.stream(createBackpressureReadable(), 200, streamHeaders)
    }

    if (method === 'post' && url === '/base') {
      return ctx.json()
    }

    if (method === 'get' && url === '/prefetch-get') {
      return BASE_SYNC_TEST.payload
    }

    if (method === 'post' && url === '/prefetch-body-used') {
      if (prefetch) {
        return Promise.resolve().then(() => ctx.json())
      }

      const body = ctx.json()

      return Promise.resolve().then(() => body)
    }

    if (method === 'post' && url === '/prefetch-body-unused') {
      return Promise.resolve('ok')
    }

    ctx.setStatus(404)

    return 'Not Found'
  }
  const server = new Server({
    host,
    port,
    http: {
      onRequest,
      onError: console.error,
      prefetch,
      maxBodySize: testName === 'prefetch-body-large' ? 2 * 1024 * 1024 : 1024 * 1024,
      maxBodyBudget,
      requestTimeoutMs
    }
  })

  await server.listen()
  RUNTIME.registerShutdown(() => server.shutdown())
  sendReady(server.port)
}

/**
 * Run the binding directly, without swm-core request/context overhead. Both
 * bindings execute this exact JS path; only the resolved native module
 * differs.
 * @param {number} port
 */
async function runRawBinding(port: number): Promise<void> {
  const { App, us_listen_socket_close } = (await import('#uws-binding')) as unknown as RawBindingModule
  const app = App()

  app.get('/base-sync', (res) => {
    res.writeHeader('content-type', 'application/json').end('{"ok":true}')
  })

  app.get('/base-async', (res) => {
    let aborted = false

    res.onAborted(() => {
      aborted = true
    })

    void Promise.resolve().then(() => {
      if (!aborted) {
        res.cork(() => {
          res.writeHeader('content-type', 'application/json').end('{"ok":true}')
        })
      }
    })
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
    const chunks: Buffer[] = []

    res.onData((chunk, isLast) => {
      chunks.push(Buffer.from(chunk))

      if (isLast) {
        res.writeHeader('content-type', 'application/json').end(Buffer.concat(chunks))
      }
    })
  })

  let socket: unknown | null = null

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
  if (fw === 'core-set-header-append') {
    await runCore(port, { headerMode: 'append' })

    return
  }

  if (fw === 'core-set-header-array') {
    await runCore(port, { headerMode: 'array' })

    return
  }

  if (fw === 'core' || fw === 'core-swm-uws' || fw === 'core-uwebsockets' || fw === 'core-lazy') {
    await runCore(port)

    return
  }

  if (fw === 'core-prefetch') {
    await runCore(port, { prefetch: true })

    return
  }

  if (fw === 'core-prefetch-budget') {
    await runCore(port, { prefetch: true, maxBodyBudget: 256 * 1024 * 1024 })

    return
  }

  if (fw === 'core-timeout') {
    await runCore(port, { requestTimeoutMs: 30_000 })

    return
  }

  if (fw === 'core-length-off') {
    await runCore(port, {
      nativeFastPaths: 'beginWrite,collectBody,httpTransportConfig,requestPrefetch'
    })

    return
  }

  if (fw === 'core-length-on') {
    await runCore(port, {
      nativeFastPaths: 'beginWrite,collectBody,collectBodyLength,httpTransportConfig,requestPrefetch'
    })

    return
  }

  if (fw === 'core-response-batch-off') {
    await runCore(port, {
      nativeFastPaths: 'beginWrite,collectBody,httpTransportConfig,requestPrefetch'
    })

    return
  }

  if (fw === 'core-response-batch-on') {
    await runCore(port, {
      nativeFastPaths: 'beginWrite,collectBody,httpTransportConfig,requestPrefetch,responseBatch'
    })

    return
  }

  if (fw === 'core-prepared-headers-off') {
    await runCore(port, {
      nativeFastPaths:
        'beginWrite,collectBody,collectBodyLength,httpTransportConfig,requestPause,requestPrefetch,responseBatch'
    })

    return
  }

  if (fw === 'core-prepared-headers-on') {
    await runCore(port, {
      nativeFastPaths:
        'beginWrite,collectBody,collectBodyLength,httpTransportConfig,preparedHeaders,requestPause,requestPrefetch,responseBatch'
    })

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

    app.get('/base-sync', (_req, res) => res.status(200).json(BASE_SYNC_TEST.payload))
    app.get('/base-async', async (_req, res) => {
      await Promise.resolve()
      res.status(200).json(BASE_ASYNC_TEST.payload)
    })
    app.get('/headers', (_req, res) => {
      res.set('content-type', HEADERS_TEST.responseHeaders['content-type'])
      res.set('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
      res.set('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
      res.set('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
      res.append('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
      res.append('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
      res.status(200).send(HEADERS_TEST.responseText)
    })
    app.get('/headers-prepared', (_req, res) => {
      res.set(HEADERS_TEST.responseHeaders)
      res.status(200).send(HEADERS_TEST.responseText)
    })
    app.post('/base', (req, res) => res.status(200).json(req.body))
    app.use((_req, res) => res.status(404).send('Not Found'))

    const srv = app.listen(port, host, () => {
      const address = srv.address()

      sendReady(typeof address === 'string' ? port : (address?.port ?? port))
    })
    const shutdown = () => new Promise<void>((resolve) => srv.close(() => resolve()))

    RUNTIME.registerShutdown(shutdown)

    return
  }

  if (fw === 'fastify') {
    const { default: Fastify } = await import('fastify')
    const fastify = Fastify({ logger: false })

    fastify.get('/base-sync', () => BASE_SYNC_TEST.payload)
    fastify.get('/base-async', async () => BASE_ASYNC_TEST.payload)
    fastify.get('/headers', (_req, reply) => {
      reply.header('content-type', HEADERS_TEST.responseHeaders['content-type'])
      reply.header('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
      reply.header('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
      reply.header('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
      reply.header('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
      reply.header('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
      reply.code(200).send(HEADERS_TEST.responseText)
    })
    fastify.get('/headers-prepared', (_req, reply) => {
      reply.headers(HEADERS_TEST.responseHeaders)
      reply.code(200).send(HEADERS_TEST.responseText)
    })
    fastify.post('/base', (req) => req.body)

    fastify.setNotFoundHandler((_req, reply) => reply.code(404).send('Not Found'))

    const shutdown = () => fastify.close()

    await fastify.listen({ host, port })
    RUNTIME.registerShutdown(shutdown)
    const address = fastify.server.address()

    sendReady(typeof address === 'string' ? port : (address?.port ?? port))

    return
  }

  if (fw === 'hyperexpress') {
    const { default: HyperExpress } = await import('hyper-express')
    const server = new HyperExpress.Server()

    server.get('/base-sync', (_req, res) => res.status(200).json(BASE_SYNC_TEST.payload))
    server.get('/base-async', async (_req, res) => {
      await Promise.resolve()
      res.status(200).json(BASE_ASYNC_TEST.payload)
    })
    server.get('/headers', (_req, res) => {
      res.header('content-type', HEADERS_TEST.responseHeaders['content-type'])
      res.header('cache-control', HEADERS_TEST.responseHeaders['cache-control'])
      res.header('x-trace-id', HEADERS_TEST.responseHeaders['x-trace-id'])
      res.header('x-response-id', HEADERS_TEST.responseHeaders['x-response-id'])
      res.header('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][0])
      res.header('set-cookie', HEADERS_TEST.responseHeaders['set-cookie'][1])
      res.status(200).send(HEADERS_TEST.responseText)
    })
    server.get('/headers-prepared', (_req, res) => {
      for (const [name, value] of Object.entries(HEADERS_TEST.responseHeaders)) {
        res.header(name, value)
      }

      res.status(200).send(HEADERS_TEST.responseText)
    })
    server.post('/base', async (req, res) => res.status(200).json(await req.json()))
    server.set_not_found_handler((_req, res) => res.status(404).send('Not Found'))

    await server.listen(port, host)
    RUNTIME.registerShutdown(async () => {
      await server.shutdown()
    })
    sendReady(server.port)

    return
  }

  if (fw === 'micro') {
    const { serve, json } = await import('micro')
    const router = (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.method === 'GET' && req.url === '/base-sync') {
        return BASE_SYNC_TEST.payload
      }

      if (req.method === 'GET' && req.url === '/base-async') {
        return Promise.resolve(BASE_ASYNC_TEST.payload)
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
        return json(req)
      }

      res.statusCode = 404

      return 'Not Found'
    }
    const server = new http.Server(serve(router))

    server.listen(port, host, () => {
      const address = server.address()

      sendReady(typeof address === 'string' ? port : (address?.port ?? port))
    })

    const shutdown = () => new Promise<void>((resolve) => server.close(() => resolve()))

    RUNTIME.registerShutdown(shutdown)

    return
  }

  throw new Error(`Unknown --fw=${fw}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
