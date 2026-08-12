const INVALID_HEADER_VALUE = /[\r\n]/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

interface PreparedHeaderGroup {
  readonly key: string
  readonly name: string
  readonly values: readonly string[]
}

interface PreparedHeaderData {
  readonly groups: readonly PreparedHeaderGroup[]
  readonly lines: readonly string[]
}

const PREPARED_HEADERS = new WeakMap<object, PreparedHeaderData>()

export function assertHeaderValue(value: string): void {
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new TypeError('Header value must not contain CR or LF')
  }
}

export function assertHeaderName(value: string): void {
  if (!HEADER_NAME.test(value)) {
    throw new TypeError('Header name must be a valid HTTP token')
  }
}

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

  const prepared = Object.freeze(Object.create(null))

  PREPARED_HEADERS.set(prepared, Object.freeze({ groups, lines: Object.freeze(lines) }))

  return prepared
}

export function getPreparedHeaders(value: unknown): PreparedHeaderData | undefined {
  return value && typeof value === 'object' ? PREPARED_HEADERS.get(value) : undefined
}
