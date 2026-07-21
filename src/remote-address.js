/**
 * @param {unknown} value
 * @returns {Uint8Array|null}
 */
function byteView(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }

  return null
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isIpv4Mapped(bytes) {
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
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 * @returns {string}
 */
function ipv4(bytes, offset = 0) {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTextAddress(value) {
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
 * @param {object|null|undefined} res
 * @param {string} prefix
 * @returns {string}
 */
function readAddress(res, prefix) {
  const binaryGetter = res?.[`get${prefix}RemoteAddress`]
  const textGetter = res?.[`get${prefix}RemoteAddressAsText`]

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
 * @param {object|null|undefined} res
 * @returns {string}
 */
export function getRemoteAddress(res) {
  return readAddress(res, 'Proxied') || readAddress(res, '')
}
