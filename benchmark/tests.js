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
 * @property {any} [payload] - Payload from server
 */

/**
 * @type {Map<string, TestDefinition>}
 */
const TESTS = new Map([
  [
    'base',
    {
      name: 'base',
      method: 'GET',
      path: '/base',
      duration: 10,
      connections: 100,
      pipelining: 10,
      description: 'Basic JSON response test',
      payload: { ok: true }
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
