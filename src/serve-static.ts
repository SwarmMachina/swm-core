import { readFile, stat } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'

interface ServeStaticOptions {
  cache?: boolean
  cacheLimit?: number
  index?: string
  maxAge?: number
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

interface StaticEntry {
  readonly buf: Buffer
  readonly headers: Record<string, string>
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}
const OCTET_STREAM = 'application/octet-stream'

/**
 */
function mimeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] || OCTET_STREAM
}

export default function serveStatic(
  root: string,
  options: ServeStaticOptions = {}
): (ctx: StaticContext) => Promise<void> {
  const rootDir = resolve(root)
  const indexFile = options.index ?? 'index.html'
  const spa = options.spa === true
  const useCache = options.cache !== false
  const cacheLimit = options.cacheLimit ?? 128
  const maxAge = options.maxAge
  const cacheControl = maxAge != null ? `public, max-age=${maxAge}` : null

  if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0) {
    throw new TypeError('serveStatic: cacheLimit must be a non-negative safe integer')
  }

  const cache = useCache && cacheLimit > 0 ? new Map<string, StaticEntry>() : null

  /**
   */
  async function load(absPath: string): Promise<StaticEntry | null> {
    const cached = cache?.get(absPath)

    if (cached) {
      return cached
    }

    let buf

    try {
      const info = await stat(absPath)

      if (!info.isFile()) {
        return null
      }

      buf = await readFile(absPath)
    } catch {
      return null
    }

    const entry = { buf, headers: Object.freeze({ 'content-type': mimeFor(absPath) }) }

    if (cache) {
      if (cache.size >= cacheLimit) {
        const oldest = cache.keys().next().value

        if (oldest !== undefined) {
          cache.delete(oldest)
        }
      }

      cache.set(absPath, entry)
    }

    return entry
  }

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
    const absPath = resolve(rootDir, rel)

    if (absPath !== rootDir && !absPath.startsWith(rootDir + sep)) {
      ctx.setStatus(403).send('Forbidden')

      return
    }

    let entry = await load(absPath)

    if (!entry && spa) {
      entry = await load(join(rootDir, indexFile))
    }

    if (!entry) {
      ctx.setStatus(404).send('Not Found')

      return
    }

    if (cacheControl) {
      ctx.setHeader('cache-control', cacheControl)
    }

    // uWS strips the body for HEAD requests at the native level and keeps the
    // correct Content-Length, so GET and HEAD share the same reply path.
    ctx.reply(200, entry.headers, entry.buf)
  }
}
