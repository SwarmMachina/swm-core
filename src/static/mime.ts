import { extname } from 'node:path'

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

const MIME_HEADERS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MIME_TYPES).map(([extension, mime]) => [extension, Object.freeze({ 'content-type': mime })])
  )
)
const OCTET_STREAM_HEADERS = Object.freeze({ 'content-type': 'application/octet-stream' })

export function headersFor(filePath: string): Readonly<Record<string, string>> {
  return MIME_HEADERS[extname(filePath).toLowerCase()] || OCTET_STREAM_HEADERS
}
