// Explicitly reject HTTP control bytes while allowing horizontal tabs.
// eslint-disable-next-line no-control-regex
const INVALID_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/
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

/** Throws for response-header control characters other than horizontal tabs. */
export function assertHeaderValue(value: string): void {
  if (INVALID_HEADER_VALUE.test(value)) {
    throwInvalidHeaderValue(value)
  }
}

function throwInvalidHeaderValue(value: string): never {
  throw new TypeError(
    value.includes('\r') || value.includes('\n')
      ? 'Header value must not contain CR or LF'
      : 'Header value must not contain control characters'
  )
}

const MANAGED_HEADER_NAMES = new Set(['content-length', 'transfer-encoding'])
const MANAGED_NAME_LENGTHS = new Set(Array.from(MANAGED_HEADER_NAMES, (name) => name.length))

/** Keep framing-name normalization off the common header validation path. */
function assertUnmanagedHeaderName(value: string): void {
  if (MANAGED_HEADER_NAMES.has(value.toLowerCase())) {
    throw new TypeError('Content-Length and Transfer-Encoding are managed by the HTTP transport')
  }
}

function throwInvalidHeaderName(): never {
  throw new TypeError('Header name must be a valid HTTP token')
}

/** Rejects invalid HTTP tokens and transport-managed response framing headers. */
export function assertHeaderName(value: string): void {
  if (!HEADER_NAME.test(value)) {
    throwInvalidHeaderName()
  }

  if (MANAGED_NAME_LENGTHS.has(value.length)) {
    assertUnmanagedHeaderName(value)
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
