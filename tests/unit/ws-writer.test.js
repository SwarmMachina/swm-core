import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import {
  encode,
  encodeText,
  encodeBinary,
  encodePing,
  encodePong,
  encodeClose
} from '../../src/backends/node-http/ws/writer.js'

/**
 * Decode an unmasked (server) frame for round-trip checks.
 * @param {Buffer} buf
 * @returns {{fin: boolean, opcode: number, masked: boolean, payload: Buffer}}
 */
function decodeServerFrame(buf) {
  const fin = (buf[0] & 0x80) === 0x80
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) === 0x80

  let len = buf[1] & 0x7f
  let offset = 2

  if (len === 126) {
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    strictEqual(buf.readUInt32BE(2), 0)
    len = buf.readUInt32BE(6)
    offset = 10
  }

  return { fin, opcode, masked, payload: buf.subarray(offset, offset + len) }
}

describe('ws writer', () => {
  test('encodes a small text frame without a mask', () => {
    const buf = encodeText(Buffer.from('hi'))

    strictEqual(buf[0], 0x81) // FIN + text
    strictEqual(buf[1], 0x02) // len 2, mask bit clear
    strictEqual(buf.subarray(2).toString(), 'hi')
  })

  test('encodes a binary frame', () => {
    const buf = encodeBinary(Buffer.from([9, 8, 7]))
    const f = decodeServerFrame(buf)

    strictEqual(f.opcode, 2)
    strictEqual(f.masked, false)
    deepStrictEqual(f.payload, Buffer.from([9, 8, 7]))
  })

  test('uses a 16-bit length for payloads 126..65535', () => {
    const payload = Buffer.alloc(200, 0x41)
    const buf = encodeBinary(payload)

    strictEqual(buf[1] & 0x7f, 126)
    strictEqual(buf.readUInt16BE(2), 200)

    const f = decodeServerFrame(buf)

    strictEqual(f.payload.length, 200)
  })

  test('uses a 64-bit length for payloads >= 65536', () => {
    const payload = Buffer.alloc(70000, 0x42)
    const buf = encodeBinary(payload)

    strictEqual(buf[1] & 0x7f, 127)
    strictEqual(buf.readUInt32BE(2), 0)
    strictEqual(buf.readUInt32BE(6), 70000)

    const f = decodeServerFrame(buf)

    strictEqual(f.payload.length, 70000)
  })

  test('round-trips payloads across all length classes', () => {
    for (const size of [0, 1, 125, 126, 200, 65535, 65536, 70000]) {
      const payload = Buffer.alloc(size, 0x5a)
      const f = decodeServerFrame(encodeBinary(payload))

      strictEqual(f.opcode, 2)
      strictEqual(f.fin, true)
      strictEqual(f.payload.length, size)
    }
  })

  test('encodes ping and pong', () => {
    strictEqual(encodePing(Buffer.from('p'))[0], 0x89)
    strictEqual(encodePong(Buffer.from('p'))[0], 0x8a)
  })

  test('supports non-final frames for fragmentation', () => {
    const buf = encode(0x1, Buffer.from('part'), false)

    strictEqual(buf[0], 0x01) // no FIN, text opcode
  })

  test('encodes a close frame with code and reason', () => {
    const buf = encodeClose(1000, 'bye')
    const f = decodeServerFrame(buf)

    strictEqual(f.opcode, 8)
    strictEqual(f.payload.readUInt16BE(0), 1000)
    strictEqual(f.payload.subarray(2).toString(), 'bye')
  })

  test('encodes an empty close for no-status (1005) and undefined code', () => {
    strictEqual(decodeServerFrame(encodeClose(1005)).payload.length, 0)
    strictEqual(decodeServerFrame(encodeClose()).payload.length, 0)
  })

  test('encodes a close frame with a code and no reason', () => {
    const f = decodeServerFrame(encodeClose(1001))

    strictEqual(f.payload.length, 2)
    strictEqual(f.payload.readUInt16BE(0), 1001)
  })
})
