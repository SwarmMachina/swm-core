import crypto from 'node:crypto'

export interface TestDefinition {
  name: string
  method: string
  path: string
  duration: number
  connections: number
  pipelining?: number
  headers?: Record<string, string>
  body?: string | Buffer | null
  description?: string
  payload?: unknown
  responseText?: string
  responseHeaders?: Record<string, string | string[]>
  requiresBackpressure?: boolean
  requiresQueueBound?: boolean
}

const UPLOAD_STREAM_BODY = Buffer.alloc(128 * 1024, 'u')
const UPLOAD_STREAM_BACKPRESSURE_BODY = Buffer.alloc(1024 * 1024, 'u')

export interface HeadersTestDefinition extends TestDefinition {
  responseText: string
  responseHeaders: {
    'content-type': string
    'cache-control': string
    'x-trace-id': string
    'x-response-id': string
    'set-cookie': [string, string]
  }
}

const TESTS: Map<string, TestDefinition> = new Map([
  [
    'base-sync',
    {
      name: 'base-sync',
      method: 'GET',
      path: '/base-sync',
      duration: 10,
      connections: 100,
      pipelining: 10,
      description: 'Synchronous JSON response test',
      payload: { ok: true }
    }
  ],
  [
    'base-async',
    {
      name: 'base-async',
      method: 'GET',
      path: '/base-async',
      duration: 10,
      connections: 100,
      pipelining: 10,
      description: 'Asynchronous JSON response test',
      payload: { ok: true }
    }
  ],
  [
    'headers',
    {
      name: 'headers',
      method: 'GET',
      path: '/headers',
      duration: 10,
      connections: 100,
      pipelining: 10,
      description: 'Response headers benchmark with scalar and multi-value Set-Cookie headers',
      responseText: 'ok',
      responseHeaders: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-trace-id': 'bench-trace-id',
        'x-response-id': 'bench-response-id',
        'set-cookie': [
          'bench.access=1; Path=/; HttpOnly; SameSite=Lax',
          'bench.refresh=2; Path=/refresh; HttpOnly; SameSite=Lax'
        ]
      }
    }
  ],
  [
    'headers-prepared',
    {
      name: 'headers-prepared',
      method: 'GET',
      path: '/headers-prepared',
      duration: 10,
      connections: 100,
      pipelining: 10,
      description: 'Prevalidated reusable response headers benchmark',
      responseText: 'ok'
    }
  ],
  [
    'static-cache-hit',
    {
      name: 'static-cache-hit',
      method: 'GET',
      path: '/static-cache-hit/payload.txt',
      duration: 6,
      connections: 100,
      pipelining: 10,
      description: 'serveStatic cached-file lookup and reusable response metadata'
    }
  ],
  [
    'static-cache-miss',
    {
      name: 'static-cache-miss',
      method: 'GET',
      path: '/static-cache-miss/payload.txt',
      duration: 6,
      connections: 25,
      pipelining: 1,
      description: 'serveStatic uncached filesystem read path (cacheLimit: 0)'
    }
  ],
  [
    'stream',
    {
      name: 'stream',
      method: 'GET',
      path: '/stream',
      duration: 6,
      connections: 100,
      pipelining: 1,
      description: 'Readable streaming response lifecycle'
    }
  ],
  [
    'stream-backpressure',
    {
      name: 'stream-backpressure',
      method: 'GET',
      path: '/stream-backpressure',
      duration: 6,
      connections: 10,
      pipelining: 1,
      description: '1 MiB Readable stream that must observe native write backpressure and resume',
      requiresBackpressure: true
    }
  ],
  [
    'upload-stream',
    {
      name: 'upload-stream',
      method: 'POST',
      path: '/upload-stream',
      duration: 6,
      connections: 100,
      pipelining: 1,
      description: '128 KiB request body consumed through RequestBodyStream',
      body: UPLOAD_STREAM_BODY,
      headers: { 'Content-Type': 'application/octet-stream' }
    }
  ],
  [
    'upload-stream-backpressure',
    {
      name: 'upload-stream-backpressure',
      method: 'POST',
      path: '/upload-stream-backpressure',
      duration: 6,
      connections: 10,
      pipelining: 1,
      description: '1 MiB request body through a deliberately slow sink with observed input backpressure',
      body: UPLOAD_STREAM_BACKPRESSURE_BODY,
      headers: { 'Content-Type': 'application/octet-stream' },
      requiresBackpressure: true,
      requiresQueueBound: true
    }
  ],
  [
    'post-base',
    {
      name: 'post-base',
      method: 'POST',
      path: '/base',
      duration: 30,
      connections: 1000,
      pipelining: 1,
      description: 'Basic JSON request test',
      body: JSON.stringify({ id: crypto.randomUUID() }),
      headers: {
        'Content-Type': 'application/json'
      }
    }
  ],
  [
    'prefetch-get',
    {
      name: 'prefetch-get',
      method: 'GET',
      path: '/prefetch-get',
      duration: 6,
      connections: 100,
      pipelining: 10,
      description: 'Lazy versus prefetch overhead on a request without a body'
    }
  ],
  [
    'prefetch-body-used',
    {
      name: 'prefetch-body-used',
      method: 'POST',
      path: '/prefetch-body-used',
      duration: 6,
      connections: 100,
      pipelining: 1,
      description: 'Manual lazy reader versus transparent prefetch after an async boundary',
      body: JSON.stringify({ data: 'x'.repeat(16 * 1024) }),
      headers: { 'Content-Type': 'application/json' }
    }
  ],
  [
    'prefetch-body-unused',
    {
      name: 'prefetch-body-unused',
      method: 'POST',
      path: '/prefetch-body-unused',
      duration: 6,
      connections: 100,
      pipelining: 1,
      description: 'Cost of collecting a 16 KiB body that application code does not use',
      body: 'x'.repeat(16 * 1024),
      headers: { 'Content-Type': 'text/plain' }
    }
  ],
  [
    'prefetch-body-large',
    {
      name: 'prefetch-body-large',
      method: 'POST',
      path: '/prefetch-body-used',
      duration: 6,
      connections: 25,
      pipelining: 1,
      description: 'Throughput and memory while collecting a 1 MiB request body',
      body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }),
      headers: { 'Content-Type': 'application/json' }
    }
  ]
])

/**
 * @param {string} name
 * @returns {TestDefinition}
 * @throws {Error}
 */
export function getTest(name: string): TestDefinition {
  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid test name: ${name}`)
  }

  const test = TESTS.get(name)

  if (!test) {
    const available = Array.from(TESTS.keys()).join(', ')

    throw new Error(`Test '${name}' not found. Available tests: ${available}`)
  }

  return { ...test }
}
