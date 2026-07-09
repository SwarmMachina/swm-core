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

/**
 * @param {string} url
 * @returns {Promise<WebSocket>}
 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { perMessageDeflate: false })

    sock.on('open', () => resolve(sock))
    sock.on('error', reject)
  })
}

test('connection registry: sendTo() delivers a message to the connection registered under a key', async () => {
  handle = await startWsServer({
    ws: {
      enabled: true,
      onUpgrade: (meta) => ({ isAllowed: true, userData: { userId: meta.getQuery('userId') } }),
      connectionKey: (ctx) => ctx.data.userId,
      onMessage: (ctx, message) => {
        const { to, text } = JSON.parse(ctx.decode(message))

        handle.server.sendTo(to, text)
      }
    }
  })

  const alice = await connect(`${handle.wsBaseUrl}/?userId=alice`)
  const bob = await connect(`${handle.wsBaseUrl}/?userId=bob`)

  assert.strictEqual(handle.server.connectionCount, 2)
  assert.strictEqual(handle.server.hasConnection('alice'), true)
  assert.strictEqual(handle.server.hasConnection('bob'), true)

  const bobReceived = new Promise((resolve) => bob.once('message', (data) => resolve(data.toString())))

  alice.send(JSON.stringify({ to: 'bob', text: 'hi bob' }))

  assert.strictEqual(await bobReceived, 'hi bob')

  alice.close()
  bob.close()
})

test('connection registry: closing a connection removes it from the registry', async () => {
  handle = await startWsServer({
    ws: {
      enabled: true,
      onUpgrade: (meta) => ({ isAllowed: true, userData: { userId: meta.getQuery('userId') } }),
      connectionKey: (ctx) => ctx.data.userId
    }
  })

  const alice = await connect(`${handle.wsBaseUrl}/?userId=alice`)

  assert.strictEqual(handle.server.hasConnection('alice'), true)

  alice.close()

  await new Promise((resolve) => alice.on('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.strictEqual(handle.server.hasConnection('alice'), false)
  assert.strictEqual(handle.server.connectionCount, 0)
})
