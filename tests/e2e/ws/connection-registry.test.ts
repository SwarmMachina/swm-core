import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import { startWsServer } from '../../helpers/e2e-server.js'
import type { WsServerHandle } from '../../helpers/e2e-server.js'

let handle: WsServerHandle | null = null

function userId(data: object | null): string {
  const value = (data as { userId?: unknown } | null)?.userId

  if (typeof value !== 'string') {
    throw new TypeError('Expected a string user id')
  }

  return value
}

function requireHandle(): WsServerHandle {
  if (handle === null) {
    throw new Error('Expected WebSocket server handle')
  }

  return handle
}

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
})

function connect(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(url, { perMessageDeflate: false })

    sock.on('open', () => resolve(sock))
    sock.on('error', reject)
  })
}

test('connection registry: sendTo() delivers a message to the connection registered under a key', async () => {
  handle = await startWsServer({
    ws: {
      onUpgrade: (meta) => ({ userId: meta.getQuery('userId') }),
      connectionKey: (ctx) => userId(ctx.data),
      onMessage: (ctx, message) => {
        const { to, text } = JSON.parse(ctx.decode(message))

        requireHandle().server.sendTo(to, text)
      }
    }
  })

  const alice = await connect(`${handle.wsBaseUrl}/?userId=alice`)
  const bob = await connect(`${handle.wsBaseUrl}/?userId=bob`)

  assert.strictEqual(handle.server.connectionCount, 2)
  assert.strictEqual(handle.server.hasConnection('alice'), true)
  assert.strictEqual(handle.server.hasConnection('bob'), true)

  const bobReceived = new Promise<string>((resolve) => bob.once('message', (data) => resolve(data.toString())))

  alice.send(JSON.stringify({ to: 'bob', text: 'hi bob' }))

  assert.strictEqual(await bobReceived, 'hi bob')

  alice.close()
  bob.close()
})

test('connection registry: closing a connection removes it from the registry', async () => {
  handle = await startWsServer({
    ws: {
      onUpgrade: (meta) => ({ userId: meta.getQuery('userId') }),
      connectionKey: (ctx) => userId(ctx.data)
    }
  })

  const alice = await connect(`${handle.wsBaseUrl}/?userId=alice`)

  assert.strictEqual(handle.server.hasConnection('alice'), true)

  alice.close()

  await new Promise<void>((resolve) => alice.on('close', () => resolve()))
  await new Promise<void>((resolve) => setTimeout(resolve, 20))

  assert.strictEqual(handle.server.hasConnection('alice'), false)
  assert.strictEqual(handle.server.connectionCount, 0)
})

test('connection registry: closeConnection gracefully closes a connection by key', async () => {
  handle = await startWsServer({
    ws: {
      onUpgrade: (meta) => ({ userId: meta.getQuery('userId') }),
      connectionKey: (ctx) => userId(ctx.data)
    }
  })

  const alice = await connect(`${handle.wsBaseUrl}/?userId=alice`)
  const closed = new Promise<{ code: number; reason: Buffer }>((resolve) =>
    alice.once('close', (code, reason) => resolve({ code, reason }))
  )

  assert.strictEqual(handle.server.closeConnection('alice', 1008, 'policy violation'), true)
  assert.strictEqual(handle.server.hasConnection('alice'), false)

  const result = await closed

  assert.strictEqual(result.code, 1008)
  assert.strictEqual(result.reason.toString(), 'policy violation')
  assert.strictEqual(handle.server.closeConnection('alice'), false)
})

test('connection registry: terminateConnection force-closes a connection by key', async () => {
  handle = await startWsServer({
    ws: {
      onUpgrade: (meta) => ({ userId: meta.getQuery('userId') }),
      connectionKey: (ctx) => userId(ctx.data)
    }
  })

  const alice = await connect(`${handle.wsBaseUrl}/?userId=alice`)
  const closed = new Promise<{ code: number; reason: Buffer }>((resolve) =>
    alice.once('close', (code, reason) => resolve({ code, reason }))
  )

  assert.strictEqual(handle.server.terminateConnection('alice'), true)
  assert.strictEqual(handle.server.hasConnection('alice'), false)

  const result = await closed

  assert.strictEqual(result.code, 1006)
  assert.strictEqual(result.reason.length, 0)
  assert.strictEqual(handle.server.terminateConnection('alice'), false)
})
