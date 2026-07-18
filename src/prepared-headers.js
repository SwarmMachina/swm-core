const INVALID_HEADER_VALUE = /[\r\n]/
const PREPARED_HEADERS = new WeakMap()

/**
 * @param {string} value
 */
export function assertHeaderValue(value) {
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new TypeError('Header value must not contain CR or LF')
  }
}

/**
 * Validate and compile a reusable response-header block.
 * @param {Record<string, string|string[]|null|undefined>} headers
 * @returns {object}
 */
export function prepareHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('Headers must be an object')
  }

  const byName = new Map()

  for (const name in headers) {
    const raw = headers[name]

    if (raw === undefined || raw === null) {
      continue
    }

    const values = []
    const source = Array.isArray(raw) ? raw : [raw]

    for (let i = 0; i < source.length; i++) {
      const entry = source[i]

      if (entry === undefined || entry === null) {
        continue
      }

      const value = `${entry}`

      assertHeaderValue(value)
      values.push(value)
    }

    if (values.length) {
      byName.set(name.toLowerCase(), Object.freeze({ name, values: Object.freeze(values) }))
    }
  }

  const groups = Object.freeze(Array.from(byName, ([key, group]) => Object.freeze({ key, ...group })))
  const lines = []

  for (let i = 0; i < groups.length; i++) {
    const { name, values } = groups[i]

    for (let j = 0; j < values.length; j++) {
      lines.push(name, values[j])
    }
  }

  const prepared = Object.freeze(Object.create(null))

  PREPARED_HEADERS.set(prepared, Object.freeze({ groups, lines: Object.freeze(lines) }))

  return prepared
}

/**
 * Internal authenticity check and compiled representation lookup.
 * @param {unknown} value
 * @returns {{groups: ReadonlyArray<object>, lines: ReadonlyArray<string>}|undefined}
 */
export function getPreparedHeaders(value) {
  return value && typeof value === 'object' ? PREPARED_HEADERS.get(value) : undefined
}
