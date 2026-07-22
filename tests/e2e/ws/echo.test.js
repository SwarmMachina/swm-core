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

test('ws-only server returns the minimal 404 for ordinary HTTP requests', async () => {
  handle = await startWsServer({ ws: {} })

  const response = await fetch(handle.httpBaseUrl)

  assert.strictEqual(response.status, 404)
  assert.strictEqual(await response.text(), 'Not Found')
})

test('ws echo: onOpen and onClose fire once per connection', async () => {
  let opens = 0
  let closes = 0

  handle = await startWsServer({
    ws: {
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

test('ws upgrade selects only the subprotocol returned by selectProtocol', async () => {
  handle = await startWsServer({
    ws: {
      onUpgrade: () => ({}),
      selectProtocol: () => 'chat'
    }
  })

  const sock = new WebSocket(handle.wsBaseUrl, ['chat', 'events'], { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    sock.on('open', resolve)
    sock.on('error', reject)
  })

  assert.strictEqual(sock.protocol, 'chat')
  sock.close()
})

test('async ws upgrade reads owned metadata after await', async () => {
  let openedData

  handle = await startWsServer({
    ws: {
      onUpgrade: async (meta) => {
        await new Promise((resolve) => setImmediate(resolve))

        return {
          url: meta.url(),
          query: meta.getQuery('token'),
          header: meta.getHeader('x-auth')
        }
      },
      onOpen: (ctx) => {
        openedData = ctx.data
      }
    }
  })

  const sock = new WebSocket(`${handle.wsBaseUrl}/async?token=query-token`, {
    headers: { 'x-auth': 'header-token' },
    perMessageDeflate: false
  })

  await new Promise((resolve, reject) => {
    sock.on('open', resolve)
    sock.on('error', reject)
  })

  assert.strictEqual(openedData.url, '/async')
  assert.strictEqual(openedData.query, 'query-token')
  assert.strictEqual(openedData.header, 'header-token')
  sock.close()
})

test('transport aborts an asynchronous upgrade after ws.upgradeTimeoutMs', async () => {
  handle = await startWsServer({
    ws: {
      upgradeTimeoutMs: 100,
      onUpgrade: () => new Promise(() => {})
    }
  })

  const sock = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('upgrade socket was not closed')), 1000)
    const done = () => {
      clearTimeout(timeout)
      resolve()
    }

    sock.once('error', done)
    sock.once('close', done)
  })
})
