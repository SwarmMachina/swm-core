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
  method(): string
  reply(status: number, headers: Record<string, string>, body: Buffer): unknown
  send(body: string): unknown
  setHeader(name: string, value: string): StaticContext
  status(code: number): StaticContext
  url(): string
}

interface StaticEntry {
  readonly buf: Buffer
  readonly type: string
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
  const cache = useCache ? new Map<string, StaticEntry>() : null

  /**
   */
  async function load(absPath: string): Promise<StaticEntry | null> {
    if (cache && cache.has(absPath)) {
      return cache.get(absPath) ?? null
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

    const entry = { buf, type: mimeFor(absPath) }

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
    const method = ctx.method()

    if (method !== 'get' && method !== 'head') {
      ctx.status(405).send('Method Not Allowed')

      return
    }

    let pathname

    try {
      pathname = decodeURIComponent(ctx.url())
    } catch {
      ctx.status(400).send('Bad Request')

      return
    }

    if (pathname.endsWith('/')) {
      pathname += indexFile
    }

    const rel = pathname.replace(/^\/+/, '')
    const absPath = resolve(rootDir, rel)

    if (absPath !== rootDir && !absPath.startsWith(rootDir + sep)) {
      ctx.status(403).send('Forbidden')

      return
    }

    let entry = await load(absPath)

    if (!entry && spa) {
      entry = await load(join(rootDir, indexFile))
    }

    if (!entry) {
      ctx.status(404).send('Not Found')

      return
    }

    if (cacheControl) {
      ctx.setHeader('cache-control', cacheControl)
    }

    // uWS strips the body for HEAD requests at the native level and keeps the
    // correct Content-Length, so GET and HEAD share the same reply path.
    ctx.reply(200, { 'content-type': entry.type }, entry.buf)
  }
}
