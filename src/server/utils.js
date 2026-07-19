const WS_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export const isPromise = (value) =>
  value != null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'

/**
 * Select and validate the application-requested WebSocket subprotocol.
 * @param {string} requestedHeader
 * @param {unknown} selected
 * @returns {string}
 */
export function selectWsProtocol(requestedHeader, selected) {
  if (selected == null || selected === '') {
    return ''
  }

  if (typeof selected !== 'string' || !WS_PROTOCOL_TOKEN.test(selected)) {
    throw new TypeError('WebSocket upgrade protocol must be a valid protocol token')
  }

  const requested = requestedHeader
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)

  if (!requested.includes(selected)) {
    throw new TypeError(`WebSocket upgrade protocol was not requested by the client: ${selected}`)
  }

  return selected
}
