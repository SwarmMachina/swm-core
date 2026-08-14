import type { HttpErrorEvent } from '../server/options.js'

interface HttpErrorEventSource {
  getIP(): string
  getMethod(): string
  getUrl(): string
  readErrorHeader(name: string): string | undefined
  readErrorQuery(name: string): string | undefined
  resolveErrorStatus(error: Error): number
}

function readOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function createHttpErrorEvent(
  source: HttpErrorEventSource,
  error: Error,
  headers: readonly string[],
  query: readonly string[],
  includeIp: boolean
): HttpErrorEvent {
  const retainedHeaders: Record<string, string> = Object.create(null)
  const retainedQuery: Record<string, string> = Object.create(null)

  for (let i = 0; i < headers.length; i++) {
    const name = headers[i]!
    const value = readOr(() => source.readErrorHeader(name), undefined)

    if (value !== undefined) {
      retainedHeaders[name] = value
    }
  }

  for (let i = 0; i < query.length; i++) {
    const name = query[i]!
    const value = readOr(() => source.readErrorQuery(name), undefined)

    if (value !== undefined) {
      retainedQuery[name] = value
    }
  }

  const ip = includeIp ? readOr(() => source.getIP(), undefined) : undefined
  const event = {
    timestamp: Date.now(),
    method: readOr(() => source.getMethod(), ''),
    url: readOr(() => source.getUrl(), ''),
    status: readOr(() => source.resolveErrorStatus(error), 500),
    headers: Object.freeze(retainedHeaders),
    query: Object.freeze(retainedQuery),
    ...(ip !== undefined ? { ip } : {})
  }

  return Object.freeze(event)
}

export function normalizeHttpError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }

  let message = 'Unknown HTTP error'

  if (value !== undefined) {
    try {
      message = String(value)
    } catch {
      message = 'Non-Error value thrown'
    }
  }

  const error = new Error(message)

  ;(error as Error & { code: string }).code = 'ERR_NON_ERROR_THROWN'

  return error
}
