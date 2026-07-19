import crypto from 'node:crypto'

/**
 * @typedef {object} TestDefinition
 * @property {string} name - Test name (unique identifier)
 * @property {string} method - HTTP method (GET, POST, etc.)
 * @property {string} path - URL path
 * @property {number} duration - Test duration in seconds
 * @property {number} connections - Number of concurrent connections
 * @property {number} [pipelining] - HTTP pipelining (default: 1)
 * @property {object} [headers] - Custom headers
 * @property {string|Buffer|null} [body] - Request body (null for GET)
 * @property {string} [description] - Human-readable description
 * @property {unknown} [payload] - Payload from server
 */

/**
 * @type {Map<string, TestDefinition>}
 */
const TESTS = new Map([
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
export function getTest(name) {
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

/**
 * @returns {Array<{name: string, description?: string}>}
 */
export function listTests() {
  return Array.from(TESTS.values()).map((test) => ({
    name: test.name,
    description: test.description
  }))
}

/**
 * @param {string} name - Test name
 * @returns {boolean}
 */
export function hasTest(name) {
  return TESTS.has(name)
}

export { TESTS }
