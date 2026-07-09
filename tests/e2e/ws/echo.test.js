import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import { startWsServer } from '../../helpers/e2e-server.js'

let handle = null

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
})

test('ws echo: onMessage echoes text back to the sender', async () => {
  handle = await startWsServer({
    ws: {
      enabled: true,
      onMessage: (ctx, message, isBinary) => ctx.send(message, isBinary)
    }
  })

  const sock = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  const received = await new Promise((resolve, reject) => {
    sock.on('open', () => sock.send('hello'))
    sock.on('message', (data) => resolve(data.toString()))
    sock.on('error', reject)
  })

  assert.strictEqual(received, 'hello')

  sock.close()
})

test('ws echo: onOpen and onClose fire once per connection', async () => {
  let opens = 0
  let closes = 0

  handle = await startWsServer({
    ws: {
      enabled: true,
      onOpen: () => {
        opens++
      },
      onClose: () => {
        closes++
      }
    }
  })

  const sock = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    sock.on('open', resolve)
    sock.on('error', reject)
  })

  sock.close()

  await new Promise((resolve) => sock.on('close', resolve))
  // give the server's close handler a tick to run
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.strictEqual(opens, 1)
  assert.strictEqual(closes, 1)
})
