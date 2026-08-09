/**
 */
function byteView(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }

  return null
}

/**
 */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 16 || bytes[10] !== 0xff || bytes[11] !== 0xff) {
    return false
  }

  for (let index = 0; index < 10; index++) {
    if (bytes[index] !== 0) {
      return false
    }
  }

  return true
}

/**
 */
function ipv4(bytes: Uint8Array, offset = 0): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`
}

/**
 */
function normalizeTextAddress(value: unknown): string {
  const bytes = byteView(value)

  if (!bytes || bytes.byteLength === 0) {
    return ''
  }

  const address = Buffer.from(bytes).toString('utf8')
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address)

  if (!mapped) {
    return address
  }

  const octets = mapped.slice(1).map(Number)

  return octets.every((octet) => octet <= 255) ? octets.join('.') : address
}

/**
 */
function readAddress(res: object | null | undefined, prefix: string): string {
  const response = res as Record<string, unknown> | null | undefined
  const binaryGetter = response?.[`get${prefix}RemoteAddress`]
  const textGetter = response?.[`get${prefix}RemoteAddressAsText`]

  if (typeof binaryGetter === 'function') {
    const bytes = byteView(binaryGetter.call(res))

    if (!bytes || bytes.byteLength === 0) {
      return ''
    }

    if (bytes.byteLength === 4) {
      return ipv4(bytes)
    }

    if (isIpv4Mapped(bytes)) {
      return ipv4(bytes, 12)
    }

    if (typeof textGetter === 'function') {
      return normalizeTextAddress(textGetter.call(res))
    }

    return ''
  }

  return typeof textGetter === 'function' ? normalizeTextAddress(textGetter.call(res)) : ''
}

/**
 * Read the PROXY Protocol v2 source address when present, otherwise the TCP
 * peer address. Native empty ArrayBuffers are absence, not usable addresses.
 */
export function getRemoteAddress(res: object | null | undefined): string {
  return readAddress(res, 'Proxied') || readAddress(res, '')
}
