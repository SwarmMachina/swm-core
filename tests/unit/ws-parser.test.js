import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import FrameParser from '../../src/backends/node-http/ws/parser.js'

const DEFAULT_MASK = [0x12, 0x34, 0x56, 0x78]

/**
 * @param {Buffer} payload
 * @param {number[]} mask
 * @returns {Buffer}
 */
function applyMask(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length)

  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ mask[i & 3]
  }

  return out
}

/**
 * @param {object} opt
 * @param {boolean} [opt.fin]
 * @param {number} opt.opcode
 * @param {Buffer|string} [opt.payload]
 * @param {number[]} [opt.mask]
 * @param {boolean} [opt.masked]
 * @param {number} [opt.rsv]
 * @returns {Buffer}
 */
function frame({ fin = true, opcode, payload = Buffer.alloc(0), mask = DEFAULT_MASK, masked = true, rsv = 0 }) {
  const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = pl.length

  let lenBytes

  if (len < 126) {
    lenBytes = Buffer.from([len])
  } else if (len < 65536) {
    lenBytes = Buffer.alloc(3)
    lenBytes[0] = 126
    lenBytes.writeUInt16BE(len, 1)
  } else {
    lenBytes = Buffer.alloc(9)
    lenBytes[0] = 127
    lenBytes.writeUInt32BE(0, 1)
    lenBytes.writeUInt32BE(len, 5)
  }

  const b0 = (fin ? 0x80 : 0) | (rsv << 4) | opcode

  if (masked) {
    lenBytes[0] |= 0x80
  }

  const maskBytes = masked ? Buffer.from(mask) : Buffer.alloc(0)
  const body = masked ? applyMask(pl, mask) : pl

  return Buffer.concat([Buffer.from([b0]), lenBytes, maskBytes, body])
}

/**
 * @param {object} [opt]
 * @param {number} [opt.maxPayload]
 * @returns {{parser: FrameParser, events: object[]}}
 */
function makeParser({ maxPayload = 1 << 20 } = {}) {
  const events = []
  const parser = new FrameParser({
    maxPayload,
    onMessage: (payload, isBinary) => events.push({ type: 'message', payload, isBinary }),
    onPing: (payload) => events.push({ type: 'ping', payload }),
    onPong: (payload) => events.push({ type: 'pong', payload }),
    onClose: (code, reason) => events.push({ type: 'close', code, reason }),
    onError: (code, message) => events.push({ type: 'error', code, message })
  })

  return { parser, events }
}

describe('ws FrameParser', () => {
  test('parses a single masked text frame', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 1, payload: 'hello' }))

    strictEqual(events.length, 1)
    strictEqual(events[0].type, 'message')
    strictEqual(events[0].isBinary, false)
    strictEqual(events[0].payload.toString(), 'hello')
  })

  test('parses a binary frame', () => {
    const { parser, events } = makeParser()
    const data = Buffer.from([1, 2, 3, 4])

    parser.push(frame({ opcode: 2, payload: data }))

    strictEqual(events[0].isBinary, true)
    deepStrictEqual(events[0].payload, data)
  })

  test('reassembles a frame delivered byte by byte', () => {
    const { parser, events } = makeParser()
    const bytes = frame({ opcode: 1, payload: 'chunked' })

    for (const b of bytes) {
      parser.push(Buffer.from([b]))
    }

    strictEqual(events.length, 1)
    strictEqual(events[0].payload.toString(), 'chunked')
  })

  test('tracks partial input and releases it after a complete frame', () => {
    const { parser, events } = makeParser()
    const bytes = frame({ opcode: 1, payload: 'pending' })

    parser.push(bytes.subarray(0, 1))
    strictEqual(parser.pending, true)

    parser.push(bytes.subarray(1))
    strictEqual(parser.pending, false)
    strictEqual(events[0].payload.toString(), 'pending')
  })

  test('stop releases pending input and ignores later frames', () => {
    const { parser, events } = makeParser()

    parser.push(Buffer.from([0x81]))
    strictEqual(parser.pending, true)

    parser.stop()
    parser.push(frame({ opcode: 1, payload: 'late' }))

    strictEqual(parser.pending, false)
    strictEqual(events.length, 0)
  })

  test('handles two frames arriving in a single buffer', () => {
    const { parser, events } = makeParser()

    parser.push(Buffer.concat([frame({ opcode: 1, payload: 'a' }), frame({ opcode: 1, payload: 'b' })]))

    strictEqual(events.length, 2)
    strictEqual(events[0].payload.toString(), 'a')
    strictEqual(events[1].payload.toString(), 'b')
  })

  test('assembles a fragmented message (text + continuation)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ fin: false, opcode: 1, payload: 'Hel' }))
    parser.push(frame({ fin: true, opcode: 0, payload: 'lo!' }))

    strictEqual(events.length, 1)
    strictEqual(events[0].type, 'message')
    strictEqual(events[0].payload.toString(), 'Hello!')
  })

  test('delivers a control frame interleaved between fragments', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ fin: false, opcode: 2, payload: Buffer.from([1, 2]) }))
    parser.push(frame({ fin: true, opcode: 9, payload: Buffer.from('pp') })) // ping mid-fragment
    parser.push(frame({ fin: true, opcode: 0, payload: Buffer.from([3, 4]) }))

    deepStrictEqual(
      events.map((e) => e.type),
      ['ping', 'message']
    )
    deepStrictEqual(events[1].payload, Buffer.from([1, 2, 3, 4]))
  })

  test('emits ping and pong', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 9, payload: 'pi' }))
    parser.push(frame({ opcode: 10, payload: 'po' }))

    deepStrictEqual(
      events.map((e) => e.type),
      ['ping', 'pong']
    )
    strictEqual(events[0].payload.toString(), 'pi')
    strictEqual(events[1].payload.toString(), 'po')
  })

  test('parses a close frame with code and reason', () => {
    const { parser, events } = makeParser()
    const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('bye')]) // 1000 + "bye"

    parser.push(frame({ opcode: 8, payload }))

    strictEqual(events[0].type, 'close')
    strictEqual(events[0].code, 1000)
    strictEqual(events[0].reason.toString(), 'bye')
  })

  test('parses an empty close frame as no-status (1005)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 8 }))

    strictEqual(events[0].type, 'close')
    strictEqual(events[0].code, 1005)
    strictEqual(events[0].reason.length, 0)
  })

  test('parses 16-bit and 64-bit length frames', () => {
    const big16 = Buffer.alloc(200, 0x41)
    const big64 = Buffer.alloc(70000, 0x42)
    const a = makeParser()

    a.parser.push(frame({ opcode: 2, payload: big16 }))
    strictEqual(a.events[0].payload.length, 200)

    const b = makeParser({ maxPayload: 1 << 20 })

    b.parser.push(frame({ opcode: 2, payload: big64 }))
    strictEqual(b.events[0].payload.length, 70000)
  })

  test('rejects non-canonical 16-bit payload lengths (1002)', () => {
    const { parser, events } = makeParser()
    const mask = Buffer.from(DEFAULT_MASK)
    const payload = applyMask(Buffer.from('x'), DEFAULT_MASK)

    parser.push(Buffer.concat([Buffer.from([0x81, 0xfe, 0x00, 0x01]), mask, payload]))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1002)
  })

  test('rejects non-canonical 64-bit payload lengths (1002)', () => {
    const { parser, events } = makeParser()
    const mask = Buffer.from(DEFAULT_MASK)
    const payload = applyMask(Buffer.from('x'), DEFAULT_MASK)
    const length = Buffer.alloc(8)

    length.writeUInt32BE(1, 4)
    parser.push(Buffer.concat([Buffer.from([0x81, 0xff]), length, mask, payload]))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1002)
  })

  test('rejects a 64-bit payload length with the high bit set (1002)', () => {
    const { parser, events } = makeParser()
    const length = Buffer.alloc(8)

    length.writeUInt32BE(0x80000000, 0)
    parser.push(Buffer.concat([Buffer.from([0x82, 0xff]), length]))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1002)
  })

  test('rejects a frame with RSV bits set (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 1, payload: 'x', rsv: 4 }))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1002)
  })

  test('rejects a reserved opcode (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 5, payload: 'x' }))

    strictEqual(events[0].code, 1002)
  })

  test('rejects a fragmented control frame (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ fin: false, opcode: 9, payload: 'x' }))

    strictEqual(events[0].code, 1002)
  })

  test('rejects an oversized control frame (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 9, payload: Buffer.alloc(126, 1) }))

    strictEqual(events[0].code, 1002)
  })

  test('rejects an unmasked client frame (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 1, payload: 'x', masked: false }))

    strictEqual(events[0].code, 1002)
  })

  test('rejects a continuation without a start (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ fin: true, opcode: 0, payload: 'x' }))

    strictEqual(events[0].code, 1002)
  })

  test('rejects a new data frame during fragmentation (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ fin: false, opcode: 1, payload: 'a' }))
    parser.push(frame({ fin: true, opcode: 1, payload: 'b' }))

    strictEqual(events[events.length - 1].type, 'error')
    strictEqual(events[events.length - 1].code, 1002)
  })

  test('rejects a message exceeding maxPayload before allocating (1009)', () => {
    const { parser, events } = makeParser({ maxPayload: 100 })

    parser.push(frame({ opcode: 2, payload: Buffer.alloc(200, 1) }))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1009)
  })

  test('rejects a close frame with a 1-byte payload (1002)', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 8, payload: Buffer.from([0x03]) }))

    strictEqual(events[0].code, 1002)
  })

  test('rejects an invalid close code (1002)', () => {
    const { parser, events } = makeParser()
    // 1005 is not allowed on the wire
    const payload = Buffer.from([0x03, 0xed])

    parser.push(frame({ opcode: 8, payload }))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1002)
  })

  test('accepts valid close codes in the 3000-4999 range', () => {
    const { parser, events } = makeParser()
    const payload = Buffer.from([0x0b, 0xb8]) // 3000

    parser.push(frame({ opcode: 8, payload }))

    strictEqual(events[0].type, 'close')
    strictEqual(events[0].code, 3000)
  })

  test('rejects invalid UTF-8 in a text message (1007)', () => {
    const { parser, events } = makeParser()

    // 0xC0 0x80 is an overlong (invalid) encoding
    parser.push(frame({ opcode: 1, payload: Buffer.from([0xc0, 0x80]) }))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1007)
  })

  test('accepts valid UTF-8 split across a fragment boundary', () => {
    const { parser, events } = makeParser()

    // "é" = 0xC3 0xA9, split across two fragments
    parser.push(frame({ fin: false, opcode: 1, payload: Buffer.from([0xc3]) }))
    parser.push(frame({ fin: true, opcode: 0, payload: Buffer.from([0xa9]) }))

    strictEqual(events[0].type, 'message')
    strictEqual(events[0].payload.toString('utf8'), 'é')
  })

  test('rejects an invalid UTF-8 close reason (1007)', () => {
    const { parser, events } = makeParser()
    const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from([0xc0, 0x80])])

    parser.push(frame({ opcode: 8, payload }))

    strictEqual(events[0].type, 'error')
    strictEqual(events[0].code, 1007)
  })

  test('stops processing frames after a close frame', () => {
    const { parser, events } = makeParser()

    // Close followed by a text frame in the same buffer: the text must be ignored.
    parser.push(
      Buffer.concat([frame({ opcode: 8, payload: Buffer.from([0x03, 0xe8]) }), frame({ opcode: 1, payload: 'after' })])
    )

    strictEqual(events.length, 1)
    strictEqual(events[0].type, 'close')
  })

  test('stops emitting after a protocol error', () => {
    const { parser, events } = makeParser()

    parser.push(frame({ opcode: 5, payload: 'x' })) // reserved -> error
    parser.push(frame({ opcode: 1, payload: 'ok' })) // must be ignored

    strictEqual(events.length, 1)
    strictEqual(events[0].type, 'error')
  })
})
