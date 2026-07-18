import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { strictEqual } from 'node:assert/strict'
import WsLayer, { UpgradeResponse } from '../../src/backends/node-http/ws/ws-layer.js'

const VALID_KEY = Buffer.alloc(16, 7).toString('base64')

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.written = []
    this.destroyed = false
    this.ended = false
    this.noDelay = false
    this.remoteAddress = '127.0.0.1'
    this.writableLength = 0
  }

  write(data) {
    this.written.push(Buffer.from(data))

    return true
  }

  end() {
    this.ended = true
  }

  destroy() {
    this.destroyed = true
  }

  setNoDelay(value) {
    this.noDelay = value
  }

  cork() {}

  uncork() {}
}

/**
 * @param {object} [headers]
 * @param {string} [method]
 * @returns {object}
 */
function request(headers = {}, method = 'GET') {
  return {
    method,
    url: '/',
    headers: {
      upgrade: 'websocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-key': VALID_KEY,
      'sec-websocket-version': '13',
      ...headers
    }
  }
}

/**
 * @param {(res: UpgradeResponse) => void} upgrade
 * @param {number} [upgradeTimeout]
 * @returns {WsLayer}
 */
function layer(upgrade, upgradeTimeout = 1000) {
  return new WsLayer({
    maxPayloadLength: 1024,
    idleTimeout: 5,
    upgradeTimeout,
    sendPingsAutomatically: false,
    upgrade,
    open() {},
    message() {},
    close() {},
    drain() {},
    subscription() {}
  })
}

describe('ws WsLayer upgrade', () => {
  test('accepts only a strict RFC 6455 handshake', () => {
    const cases = [
      request({}, 'POST'),
      request({ connection: 'keep-alive' }),
      request({ upgrade: 'h2c' }),
      request({ 'sec-websocket-key': 'not-a-valid-key' }),
      request({ 'sec-websocket-version': '12' }),
      request({ 'sec-websocket-protocol': 'chat, bad protocol' }),
      request({ 'sec-websocket-protocol': '' })
    ]

    for (const req of cases) {
      let called = false

      const wsLayer = layer(() => {
        called = true
      })
      const socket = new FakeSocket()

      wsLayer.handleUpgrade(req, socket, Buffer.alloc(0))

      strictEqual(called, false)
      strictEqual(socket.destroyed, true)
      strictEqual(Buffer.concat(socket.written).toString().startsWith('HTTP/1.1 400 Bad Request'), true)
      wsLayer.close()
    }
  })

  test('passes a valid handshake to the upgrade behavior', () => {
    let called = false

    const wsLayer = layer((res) => {
      called = true
      res.writeStatus('403 Forbidden')
      res.end()
    })
    const socket = new FakeSocket()

    wsLayer.handleUpgrade(request(), socket, Buffer.alloc(0))

    strictEqual(called, true)
    strictEqual(socket.noDelay, true)
    strictEqual(socket.ended, true)
    strictEqual(Buffer.concat(socket.written).toString().startsWith('HTTP/1.1 403 Forbidden'), true)
    wsLayer.close()
  })

  test('destroys an upgrade whose async decision exceeds the deadline', async () => {
    let aborted = 0

    const wsLayer = layer((res) => {
      res.onAborted(() => {
        aborted++
      })
    }, 10)
    const socket = new FakeSocket()

    wsLayer.handleUpgrade(request(), socket, Buffer.alloc(0))
    await new Promise((resolve) => setTimeout(resolve, 30))

    strictEqual(socket.destroyed, true)
    strictEqual(aborted, 1)
    wsLayer.close()
  })

  test('rejects an invalid response subprotocol before writing headers', () => {
    const socket = new FakeSocket()
    const response = new UpgradeResponse(socket, Buffer.alloc(0), { open() {} }, 1000)

    response.upgrade({}, VALID_KEY, 'chat, admin')

    strictEqual(socket.destroyed, true)
    strictEqual(socket.written.length, 0)
  })

  test('terminates a partial message that exceeds the assembly deadline', () => {
    let connection = null

    const wsLayer = new WsLayer({
      maxPayloadLength: 1024,
      idleTimeout: 0.1,
      upgradeTimeout: 1000,
      sendPingsAutomatically: false,
      upgrade() {},
      open(conn) {
        connection = conn
      },
      message() {},
      close() {},
      drain() {},
      subscription() {}
    })
    const socket = new FakeSocket()

    wsLayer.open(socket, Buffer.alloc(0), {})
    socket.emit('data', Buffer.from([0x81]))

    strictEqual(connection.pendingSince > 0, true)
    wsLayer.runMaintenance(connection.pendingSince + 101)

    strictEqual(socket.destroyed, true)
    wsLayer.close()
  })
})
