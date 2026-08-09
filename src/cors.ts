const DEFAULT_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE'
const DEFAULT_HEADERS = 'Content-Type, Authorization'

interface CorsOptions {
  allowedHeaders?: string
  credentials?: boolean
  maxAge?: number
  methods?: string
  origin?: string
}

interface CorsContext {
  appendHeader(name: string, value: string): CorsContext
  method(): string
  reply(status: number, headers: null, body: null): unknown
  setHeader(name: string, value: string): CorsContext
}

export default function cors(options: CorsOptions = {}): (ctx: CorsContext) => boolean {
  const origin = options.origin ?? '*'
  const methods = options.methods ?? DEFAULT_METHODS
  const allowedHeaders = options.allowedHeaders ?? DEFAULT_HEADERS
  const credentials = options.credentials === true
  const maxAge = options.maxAge

  if (credentials && origin === '*') {
    throw new TypeError("cors: 'credentials' requires an explicit 'origin' (wildcard '*' is rejected by browsers)")
  }

  return function applyCors(ctx: CorsContext): boolean {
    ctx.setHeader('access-control-allow-origin', origin)

    if (origin !== '*') {
      ctx.appendHeader('vary', 'Origin')
    }

    if (credentials) {
      ctx.setHeader('access-control-allow-credentials', 'true')
    }

    if (ctx.method() !== 'options') {
      return false
    }

    ctx.setHeader('access-control-allow-methods', methods)
    ctx.setHeader('access-control-allow-headers', allowedHeaders)

    if (maxAge != null) {
      ctx.setHeader('access-control-max-age', `${maxAge}`)
    }

    ctx.reply(204, null, null)

    return true
  }
}
