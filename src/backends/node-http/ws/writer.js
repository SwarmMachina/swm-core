const EMPTY = Buffer.alloc(0)

/**
 * @param {number} opcode
 * @param {Buffer|Uint8Array} payload
 * @param {boolean} [fin]
 * @returns {Buffer}
 */
export function encode(opcode, payload, fin = true) {
  const len = payload.length

  let headerLen

  if (len < 126) {
    headerLen = 2
  } else if (len < 65536) {
    headerLen = 4
  } else {
    headerLen = 10
  }

  const frame = Buffer.allocUnsafe(headerLen + len)

  frame[0] = (fin ? 0x80 : 0) | opcode

  if (len < 126) {
    frame[1] = len
  } else if (len < 65536) {
    frame[1] = 126
    frame.writeUInt16BE(len, 2)
  } else {
    frame[1] = 127
    // We never exceed 2^32 bytes, so the high word is always zero.
    frame.writeUInt32BE(0, 2)
    frame.writeUInt32BE(len, 6)
  }

  if (len > 0) {
    frame.set(payload, headerLen)
  }

  return frame
}

/**
 * @param {Buffer|Uint8Array} payload
 * @returns {Buffer}
 */
export function encodeText(payload) {
  return encode(0x1, payload)
}

/**
 * @param {Buffer|Uint8Array} payload
 * @returns {Buffer}
 */
export function encodeBinary(payload) {
  return encode(0x2, payload)
}

/**
 * @param {Buffer|Uint8Array} payload
 * @returns {Buffer}
 */
export function encodePing(payload = EMPTY) {
  return encode(0x9, payload)
}

/**
 * @param {Buffer|Uint8Array} payload
 * @returns {Buffer}
 */
export function encodePong(payload = EMPTY) {
  return encode(0xa, payload)
}

/**
 * @param {number} [code]
 * @param {string|Buffer} [reason]
 * @returns {Buffer}
 */
export function encodeClose(code, reason) {
  // 1005 (no status received) is not sent on the wire: emit a bodyless close.
  if (code === undefined || code === null || code === 1005) {
    return encode(0x8, EMPTY)
  }

  const reasonBuf = reason ? (Buffer.isBuffer(reason) ? reason : Buffer.from(String(reason))) : EMPTY
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length)

  payload.writeUInt16BE(code, 0)

  if (reasonBuf.length > 0) {
    reasonBuf.copy(payload, 2)
  }

  return encode(0x8, payload)
}
