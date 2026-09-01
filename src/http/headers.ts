const INVALID_HEADER_VALUE = /[\r\n]/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

interface PreparedHeaderGroup {
  readonly key: string
  readonly name: string
  readonly values: readonly string[]
}

export interface PreparedHeaderData {
  readonly groups: readonly PreparedHeaderGroup[]
  readonly lines: readonly string[]
  readonly nativeEligible: boolean
}

const PREPARED_HEADERS = new WeakMap<object, PreparedHeaderData>()

/** Throws when a response-header value contains a line break. */
export function assertHeaderValue(value: string): void {
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new TypeError('Header value must not contain CR or LF')
  }
}

/** Throws when a response-header name is not a valid HTTP token. */
export function assertHeaderName(value: string): void {
  if (!HEADER_NAME.test(value)) {
    throw new TypeError('Header name must be a valid HTTP token')
  }
}

/**
 * Validates and compiles an immutable response-header block for reuse.
 * @param headers Response headers to validate and normalize.
 * @returns An opaque prepared-header block.
 * @throws {TypeError} If a header name or value is invalid.
 */
export function prepareHeaders(headers: unknown): object {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('Headers must be an object')
  }

  const byName = new Map<string, Omit<PreparedHeaderGroup, 'key'>>()
  const sourceHeaders = headers as Record<string, unknown>

  for (const name in sourceHeaders) {
    const raw = sourceHeaders[name]

    if (raw === undefined || raw === null) {
      continue
    }

    assertHeaderName(name)

    const values: string[] = []
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
  const lines: string[] = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    if (!group) {
      continue
    }

    const { name, values } = group

    for (let j = 0; j < values.length; j++) {
      const value = values[j]

      if (value !== undefined) {
        lines.push(name, value)
      }
    }
  }

  let nativeEligible = lines.length / 2 <= 64
  let nativeBytes = 0

  for (let index = 0; nativeEligible && index < lines.length; index += 2) {
    const name = lines[index]!
    const value = lines[index + 1]!
    const lowercaseName = name.toLowerCase()

    if (lowercaseName === 'content-length' || lowercaseName === 'transfer-encoding') {
      nativeEligible = false
      break
    }

    nativeBytes += name.length + Buffer.byteLength(value)
    nativeEligible = nativeBytes <= 64 * 1024
  }

  const prepared = Object.freeze(Object.create(null))

  PREPARED_HEADERS.set(prepared, Object.freeze({ groups, lines: Object.freeze(lines), nativeEligible }))

  return prepared
}

/** Returns compiled header data for a value created by {@link prepareHeaders}. */
export function getPreparedHeaders(value: unknown): PreparedHeaderData | undefined {
  return value && typeof value === 'object' ? PREPARED_HEADERS.get(value) : undefined
}
