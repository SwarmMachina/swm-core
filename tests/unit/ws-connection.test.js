import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import NodeWebSocket from '../../src/backends/node-http/ws/connection.js'

const MASK = [0x11, 0x22, 0x33, 0x44]

/**
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {boolean} [fin]
 * @returns {Buffer}
 */
function clientFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const masked = Buffer.allocUnsafe(pl.length)

  for (let i = 0; i < pl.length; i++) {
    masked[i] = pl[i] ^ MASK[i & 3]
  }

  const header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | pl.length, ...MASK])

  return Buffer.concat([header, masked])
}

/**
 * Read an unmasked (server) frame's opcode and payload.
 * @param {Buffer} buf
 * @returns {{opcode: number, payload: Buffer}}
 */
function readServerFrame(buf) {
  const opcode = buf[0] & 0x0f
  const len = buf[1] & 0x7f

  return { opcode, payload: buf.subarray(2, 2 + len) }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.written = []
    this.writableLength = 0
    this.destroyed = false
    this.ended = false
    this.corks = 0
    this.writeReturn = true
  }

  cork() {
    this.corks++
  }

  uncork() {
    this.corks--
  }

  write(buf) {
    this.written.push(Buffer.from(buf))

    return this.writeReturn
  }

  end(buf) {
    if (buf) {
      this.written.push(Buffer.from(buf))
    }

    this.ended = true
  }

  destroy() {
    this.destroyed = true
  }

  setNoDelay() {}
}

/**
 * @param {object} [opt]
 * @param {object} [opt.userData]
 * @param {number} [opt.maxBackpressure]
 * @returns {{ws: NodeWebSocket, socket: FakeSocket, events: object[], hub: object}}
 */
function make({ userData = { id: 1 }, maxBackpressure } = {}) {
  const socket = new FakeSocket()
  const events = []
  const hub = {
    subscribe: (conn, topic) => (events.push({ type: 'subscribe', topic }), true),
    unsubscribe: (conn, topic) => (events.push({ type: 'unsubscribe', topic }), true),
    remove: () => events.push({ type: 'remove' })
  }
  const behavior = {
    message: (conn, payload, isBinary) => events.push({ type: 'message', payload: Buffer.from(payload), isBinary }),
    dropped: (conn, payload, isBinary) =>
      events.push({ type: 'dropped', conn, payload: Buffer.from(payload), isBinary }),
    drain: () => events.push({ type: 'drain' }),
    close: (conn, code, reason) => events.push({ type: 'close', code, reason: Buffer.from(reason) })
  }
  const ws = new NodeWebSocket({ socket, behavior, hub, userData, maxPayload: 1 << 20, maxBackpressure })

  return { ws, socket, events, hub }
}

describe('ws NodeWebSocket', () => {
  test('getUserData returns the userData captured at open', () => {
    const { ws } = make({ userData: { id: 42 } })

    deepStrictEqual(ws.getUserData(), { id: 42 })
  })

  test('send writes a text frame and reports SUCCESS (1)', () => {
    const { ws, socket } = make()
    const status = ws.send('hi', false)

    strictEqual(status, 1)
    strictEqual(socket.written.length, 1)

    const f = readServerFrame(socket.written[0])

    strictEqual(f.opcode, 1)
    strictEqual(f.payload.toString(), 'hi')
  })

  test('send reports BACKPRESSURE (0) when the socket buffers', () => {
    const { ws, socket, events } = make()

    socket.writeReturn = false
    strictEqual(ws.send('x', false), 0)

    // drain fires the behavior.drain callback
    socket.emit('drain')
    strictEqual(events.filter((e) => e.type === 'drain').length, 1)
  })

  test('send reports DROPPED (2) and the rejected payload when backpressure exceeds the limit', () => {
    const { ws, socket, events } = make()

    socket.writableLength = 1 << 20 // way above the threshold
    strictEqual(ws.send('x', false), 2)
    strictEqual(socket.written.length, 0)

    const dropped = events.find((event) => event.type === 'dropped')

    strictEqual(dropped.conn, ws)
    strictEqual(dropped.payload.toString(), 'x')
    strictEqual(dropped.isBinary, false)
  })

  test('sendFrame reports the original binary publish payload when dropped', () => {
    const { ws, socket, events } = make({ maxBackpressure: 16 })
    const payload = Buffer.from([1, 2, 3])

    socket.writableLength = 16
    strictEqual(ws.sendFrame(Buffer.from('serialized-frame'), payload, true), 2)
    strictEqual(socket.written.length, 0)

    const dropped = events.find((event) => event.type === 'dropped')

    deepStrictEqual(dropped.payload, payload)
    strictEqual(dropped.isBinary, true)
  })

  test('send after close reports DROPPED (2)', () => {
    const { ws, socket, events } = make()

    socket.emit('close')
    strictEqual(ws.send('x', false), 2)
    strictEqual(
      events.some((event) => event.type === 'dropped'),
      false
    )
  })

  test('delivers an incoming message to behavior.message', () => {
    const { socket, events } = make()

    socket.emit('data', clientFrame(0x1, 'hello'))

    const msg = events.find((e) => e.type === 'message')

    strictEqual(msg.isBinary, false)
    strictEqual(msg.payload.toString(), 'hello')
  })

  test('auto-replies pong to an incoming ping without a message callback', () => {
    const { socket, events } = make()

    socket.emit('data', clientFrame(0x9, 'pp'))

    strictEqual(
      events.some((e) => e.type === 'message'),
      false
    )
    const pong = socket.written.map(readServerFrame).find((f) => f.opcode === 0xa)

    ok(pong)
    strictEqual(pong.payload.toString(), 'pp')
  })

  test('terminates instead of queueing a pong above the backpressure ceiling', () => {
    const { socket, events } = make({ maxBackpressure: 16 })

    socket.writableLength = 16
    socket.emit('data', clientFrame(0x9, 'pp'))

    strictEqual(socket.written.length, 0)
    strictEqual(socket.destroyed, true)
    strictEqual(events.filter((event) => event.type === 'close').length, 1)
    strictEqual(events.find((event) => event.type === 'close').code, 1006)
  })

  test('tracks how long a partial message has been retained', () => {
    const { ws, socket } = make()
    const bytes = clientFrame(0x1, 'slow')

    socket.emit('data', bytes.subarray(0, 1))
    strictEqual(ws.pendingSince > 0, true)

    socket.emit('data', bytes.subarray(1))
    strictEqual(ws.pendingSince, 0)
  })

  test('peer close echoes a close frame and fires behavior.close once', () => {
    const { socket, events } = make()
    const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('bye')]) // 1000 "bye"

    socket.emit('data', clientFrame(0x8, payload))

    const closeFrame = socket.written.map(readServerFrame).find((f) => f.opcode === 8)

    ok(closeFrame, 'a close frame is echoed')

    const closes = events.filter((e) => e.type === 'close')

    strictEqual(closes.length, 1)
    strictEqual(closes[0].code, 1000)
  })

  test('ignores frames after a peer close (no pong, no crash) and closes once', () => {
    const { socket, events } = make()

    // Close then a ping in one chunk: the ping must not be processed.
    socket.emit('data', Buffer.concat([clientFrame(0x8, Buffer.from([0x03, 0xe8])), clientFrame(0x9, 'late')]))

    const pong = socket.written.map(readServerFrame).find((f) => f.opcode === 0xa)

    strictEqual(pong, undefined)
    strictEqual(events.filter((e) => e.type === 'close').length, 1)

    // A post-close socket error must be swallowed, not thrown.
    socket.emit('error', new Error('EPIPE'))
    strictEqual(events.filter((e) => e.type === 'close').length, 1)
  })

  test('server-initiated end waits for the peer echo before firing close', () => {
    const { ws, socket, events } = make()

    ws.end(1000, 'done')

    const closeFrame = socket.written.map(readServerFrame).find((f) => f.opcode === 8)

    ok(closeFrame, 'a close frame is sent')
    strictEqual(
      events.some((e) => e.type === 'close'),
      false
    )

    // peer echoes close -> now behavior.close fires
    socket.emit('data', clientFrame(0x8, Buffer.from([0x03, 0xe8])))
    strictEqual(events.filter((e) => e.type === 'close').length, 1)
  })

  test('a protocol error sends a close frame and fires close', () => {
    const { socket, events } = make()

    // unmasked frame -> 1002
    socket.emit('data', Buffer.from([0x81, 0x01, 0x41]))

    const closeFrame = socket.written.map(readServerFrame).find((f) => f.opcode === 8)

    ok(closeFrame)
    strictEqual(closeFrame.payload.readUInt16BE(0), 1002)
    strictEqual(events.filter((e) => e.type === 'close').length, 1)
    strictEqual(events.find((e) => e.type === 'close').code, 1002)
  })

  test('an abnormal socket close fires behavior.close with 1006 exactly once', () => {
    const { socket, events } = make()

    socket.emit('error', new Error('reset'))
    socket.emit('close')

    const closes = events.filter((e) => e.type === 'close')

    strictEqual(closes.length, 1)
    strictEqual(closes[0].code, 1006)
  })

  test('subscribe and unsubscribe delegate to the hub', () => {
    const { ws, events } = make()

    strictEqual(ws.subscribe('news'), true)
    strictEqual(ws.unsubscribe('news'), true)

    deepStrictEqual(
      events.filter((e) => e.type === 'subscribe' || e.type === 'unsubscribe'),
      [
        { type: 'subscribe', topic: 'news' },
        { type: 'unsubscribe', topic: 'news' }
      ]
    )
  })

  test('processes incoming data while the socket is corked (batched writes)', () => {
    const { socket } = make()

    // Two ping frames in one chunk -> both pongs written under one cork/uncork pair
    socket.emit('data', Buffer.concat([clientFrame(0x9, 'a'), clientFrame(0x9, 'b')]))

    strictEqual(socket.corks, 0) // balanced
    const pongs = socket.written.map(readServerFrame).filter((f) => f.opcode === 0xa)

    strictEqual(pongs.length, 2)
  })
})
