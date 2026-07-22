const WS_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export const isPromise = (value) =>
  value != null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'

/**
 * Validate a WebSocket close frame payload before crossing into the native
 * binding. RFC-defined codes and application/private codes are accepted;
 * reserved wire codes are rejected.
 * @param {number} code
 * @param {string} reason
 */
export function validateWsClose(code, reason) {
  const standardCode = code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006
  const applicationCode = code >= 3000 && code <= 4999

  if (!Number.isInteger(code) || (!standardCode && !applicationCode)) {
    throw new RangeError('WebSocket close code must be a valid wire code')
  }

  if (typeof reason !== 'string') {
    throw new TypeError('WebSocket close reason must be a string')
  }

  if (Buffer.byteLength(reason) > 123) {
    throw new RangeError('WebSocket close reason must not exceed 123 UTF-8 bytes')
  }
}

/**
 * @param {string} requestedHeader
 * @returns {readonly string[]}
 */
export function parseWsProtocols(requestedHeader) {
  return Object.freeze(
    requestedHeader
      .split(',')
      .map((protocol) => protocol.trim())
      .filter(Boolean)
  )
}

/**
 * @param {readonly string[]} requested
 * @param {unknown} selected
 * @returns {string}
 */
export function validateWsProtocolSelection(requested, selected) {
  if (selected == null || selected === '') {
    return ''
  }

  if (typeof selected !== 'string' || !WS_PROTOCOL_TOKEN.test(selected)) {
    throw new TypeError('WebSocket upgrade protocol must be a valid protocol token')
  }

  if (!requested.includes(selected)) {
    throw new TypeError(`WebSocket upgrade protocol was not requested by the client: ${selected}`)
  }

  return selected
}
