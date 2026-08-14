import StaticFileStore from './file-store.js'

interface ServeStaticOptions {
  cache?: boolean
  cacheByteLimit?: number
  cacheLimit?: number
  index?: string
  maxAge?: number
  maxFileSize?: number
  maxInflightBytes?: number
  maxInflightFiles?: number
  spa?: boolean
}

interface StaticContext {
  getMethod(): string
  reply(status: number, headers: Record<string, string>, body: Buffer): unknown
  send(body: string): unknown
  setHeader(name: string, value: string): StaticContext
  setStatus(code: number): StaticContext
  getUrl(): string
}

const DEFAULT_CACHE_BYTE_LIMIT = 64 * 1024 * 1024
const DEFAULT_MAX_FILE_SIZE = 16 * 1024 * 1024
const DEFAULT_MAX_INFLIGHT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_INFLIGHT_FILES = 32

function assertByteLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`serveStatic: ${name} must be a non-negative safe integer`)
  }
}

/**
 * Creates an HTTP handler that serves files confined below a canonical root.
 * @param root Static root directory.
 * @param options Cache, file-size, and in-flight admission limits.
 * @returns An asynchronous static-file handler.
 */
export default function serveStatic(
  root: string,
  options: ServeStaticOptions = {}
): (ctx: StaticContext) => Promise<void> {
  const indexFile = options.index ?? 'index.html'
  const spa = options.spa === true
  const useCache = options.cache !== false
  const cacheLimit = options.cacheLimit ?? 128
  const cacheByteLimit = options.cacheByteLimit ?? DEFAULT_CACHE_BYTE_LIMIT
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const maxInflightBytes = options.maxInflightBytes ?? Math.max(DEFAULT_MAX_INFLIGHT_BYTES, maxFileSize)
  const maxInflightFiles = options.maxInflightFiles ?? DEFAULT_MAX_INFLIGHT_FILES
  const maxAge = options.maxAge
  const cacheControl = maxAge != null ? `public, max-age=${maxAge}` : null

  for (const [name, value] of [
    ['cacheLimit', cacheLimit],
    ['cacheByteLimit', cacheByteLimit],
    ['maxFileSize', maxFileSize],
    ['maxInflightBytes', maxInflightBytes],
    ['maxInflightFiles', maxInflightFiles]
  ] as const) {
    assertByteLimit(name, value)
  }

  if (maxInflightBytes < maxFileSize) {
    throw new TypeError('serveStatic: maxInflightBytes must be greater than or equal to maxFileSize')
  }

  const store = new StaticFileStore(root, {
    ...(useCache ? { cache: { limit: cacheLimit, byteLimit: cacheByteLimit } } : {}),
    inflight: { maxBytes: maxInflightBytes, maxFiles: maxInflightFiles },
    maxFileSize
  })

  return async function handleStatic(ctx: StaticContext): Promise<void> {
    const method = ctx.getMethod()

    if (method !== 'get' && method !== 'head') {
      ctx.setStatus(405).send('Method Not Allowed')

      return
    }

    let pathname

    try {
      pathname = decodeURIComponent(ctx.getUrl())
    } catch {
      ctx.setStatus(400).send('Bad Request')

      return
    }

    if (pathname.endsWith('/')) {
      pathname += indexFile
    }

    const rel = pathname.replace(/^\/+/, '')
    const absPath = store.resolvePath(rel)

    if (!absPath) {
      ctx.setStatus(403).send('Forbidden')

      return
    }

    let loaded = await store.load(absPath)

    if (loaded.kind === 'missing' && spa) {
      const fallbackPath = store.resolvePath(indexFile)

      loaded = fallbackPath ? await store.load(fallbackPath) : { kind: 'forbidden' }
    }

    if (loaded.kind === 'forbidden') {
      ctx.setStatus(403).send('Forbidden')

      return
    }

    if (loaded.kind === 'busy') {
      ctx.setHeader('retry-after', '1').setStatus(503).send('Service Unavailable')

      return
    }

    if (loaded.kind === 'missing') {
      ctx.setStatus(404).send('Not Found')

      return
    }

    if (cacheControl) {
      ctx.setHeader('cache-control', cacheControl)
    }

    // uWS strips the body for HEAD requests at the native level and keeps the
    // correct Content-Length, so GET and HEAD share the same reply path.
    ctx.reply(200, loaded.entry.headers, loaded.entry.buf)
  }
}
