import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import { startWsServer } from '../../helpers/e2e-server.js'
import type { WsServerHandle } from '../../helpers/e2e-server.js'

let handle: WsServerHandle | null = null

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

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

test('pub/sub: publish reaches every subscriber of a topic', async () => {
  handle = await startWsServer({
    ws: {
      onOpen: (ctx) => ctx.subscribe('room')
    }
  })

  const a = await connect(handle.wsBaseUrl)
  const b = await connect(handle.wsBaseUrl)

  await wait(30)
  assert.strictEqual(handle.server.getSubscribersCount('room'), 2)

  const aGot = new Promise<string>((resolve) => a.once('message', (data) => resolve(data.toString())))
  const bGot = new Promise<string>((resolve) => b.once('message', (data) => resolve(data.toString())))

  assert.strictEqual(handle.server.publish('room', 'hello-all'), true)

  assert.strictEqual(await aGot, 'hello-all')
  assert.strictEqual(await bGot, 'hello-all')

  a.close()
  b.close()
})

test('pub/sub: closing a subscriber decrements the topic count', async () => {
  handle = await startWsServer({
    ws: {
      onOpen: (ctx) => ctx.subscribe('room')
    }
  })

  const a = await connect(handle.wsBaseUrl)
  const b = await connect(handle.wsBaseUrl)

  await wait(30)
  assert.strictEqual(handle.server.getSubscribersCount('room'), 2)

  a.close()
  await wait(30)

  assert.strictEqual(handle.server.getSubscribersCount('room'), 1)

  b.close()
})

test('pub/sub: publish to an empty topic returns false', async () => {
  handle = await startWsServer({
    ws: { onOpen: () => {} }
  })

  await connect(handle.wsBaseUrl)

  assert.strictEqual(handle.server.publish('nobody', 'x'), false)
})
