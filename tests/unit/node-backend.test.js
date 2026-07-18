import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { strictEqual } from 'node:assert/strict'
import { App } from '../../src/backends/node-http/index.js'

class FakeServer extends EventEmitter {
  listen(port, host, cb) {
    this.port = port
    this.host = host
    this.listenCallback = cb
  }

  close() {}

  closeAllConnections() {}
}

describe('node-http backend lifecycle', () => {
  test('routes post-listen server errors to the registered handler', () => {
    const raw = new FakeServer()
    const app = App(() => raw)
    const error = new Error('transport failed')

    let received = null
    let listenToken = null

    app.onError((err) => {
      received = err
    })
    app.listen('localhost', 7000, (token) => {
      listenToken = token
    })
    raw.listenCallback()
    raw.emit('error', error)

    strictEqual(typeof listenToken.stopAccepting, 'function')
    strictEqual(raw.host, 'localhost')
    strictEqual(raw.port, 7000)
    strictEqual(received, error)
  })

  test('does not let a throwing transport error handler escape EventEmitter', () => {
    const raw = new FakeServer()
    const app = App(() => raw)

    app.onError(() => {
      throw new Error('handler failed')
    })
    app.listen('localhost', 7000, () => {})
    raw.listenCallback()

    raw.emit('error', new Error('transport failed'))
  })

  test('reports a pre-listen bind error through the listen callback', () => {
    const raw = new FakeServer()
    const app = App(() => raw)

    let result = 'unset'

    app.listen('localhost', 7000, (token) => {
      result = token
    })
    raw.emit('error', new Error('EADDRINUSE'))

    strictEqual(result, null)
  })
})
