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

test('ws context keeps the exact object returned by onUpgrade', async () => {
  const dataFromOnUpgrade = Object.freeze({ userId: 123 })

  let openedData

  handle = await startWsServer({
    ws: {
      onUpgrade: () => dataFromOnUpgrade,
      onOpen: (ctx) => {
        openedData = ctx.data
      }
    }
  })

  const sock = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    sock.on('open', resolve)
    sock.on('error', reject)
  })

  assert.strictEqual(openedData, dataFromOnUpgrade)
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

test('maxPayloadLength accepts exact text/binary messages and rejects one byte over', { timeout: 5000 }, async () => {
  const received = []

  handle = await startWsServer({
    ws: {
      maxPayloadLength: 1024 * 32,
      onMessage: (ctx, message, isBinary) => {
        received.push({ length: message.byteLength, isBinary })
        ctx.send(String(message.byteLength))
      }
    }
  })

  const exact = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    exact.once('open', resolve)
    exact.once('error', reject)
  })

  const responses = []

  exact.on('message', (message) => responses.push(message.toString()))
  exact.send('x'.repeat(32_768))
  exact.send(Buffer.alloc(32_768))

  while (responses.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.deepStrictEqual(received, [
    { length: 32_768, isBinary: false },
    { length: 32_768, isBinary: true }
  ])
  assert.deepStrictEqual(responses, ['32768', '32768'])
  exact.close()

  const oversized = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    oversized.once('open', resolve)
    oversized.once('error', reject)
  })

  oversized.send(Buffer.alloc(32_769))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oversized WebSocket was not closed')), 2000)

    oversized.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    oversized.once('error', () => {})
  })

  assert.deepStrictEqual(received, [
    { length: 32_768, isBinary: false },
    { length: 32_768, isBinary: true }
  ])
})

test('maxPayloadLength applies to the reconstructed fragmented message', { timeout: 5000 }, async () => {
  let callbacks = 0

  handle = await startWsServer({
    ws: {
      maxPayloadLength: 1024 * 32,
      onMessage: (ctx, message) => {
        callbacks++
        ctx.send(String(message.byteLength))
      }
    }
  })

  const exact = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    exact.once('open', resolve)
    exact.once('error', reject)
  })

  const exactReply = new Promise((resolve) => exact.once('message', (message) => resolve(message.toString())))

  exact.send(Buffer.alloc(16_384), { binary: true, fin: false })
  exact.send(Buffer.alloc(16_384), { binary: true, fin: true })
  assert.strictEqual(await exactReply, '32768')
  assert.strictEqual(callbacks, 1)
  exact.close()

  const oversized = new WebSocket(handle.wsBaseUrl, { perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    oversized.once('open', resolve)
    oversized.once('error', reject)
  })

  oversized.send(Buffer.alloc(16_384), { binary: true, fin: false })
  oversized.send(Buffer.alloc(16_385), { binary: true, fin: true })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oversized fragmented WebSocket was not closed')), 2000)

    oversized.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    oversized.once('error', () => {})
  })

  assert.strictEqual(callbacks, 1)
})

test('supported bindings do not negotiate permessage-deflate', { timeout: 5000 }, async () => {
  const received = Promise.withResolvers()

  handle = await startWsServer({
    ws: {
      maxPayloadLength: 1024 * 32,
      onMessage: (_ctx, message) => received.resolve(message.byteLength)
    }
  })

  const socket = new WebSocket(handle.wsBaseUrl, {
    perMessageDeflate: { threshold: 0 }
  })

  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  assert.strictEqual(socket.extensions, '')
  socket.send(Buffer.alloc(32_768))
  assert.strictEqual(await received.promise, 32_768)
  socket.close()
})
