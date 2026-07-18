import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import { startWsServer } from '../../helpers/e2e-server.js'

const SLOW_CLIENTS = 6
const MESSAGE_SIZE = 256 * 1024
const SENDS_PER_ROUND = 64
const MAX_SEND_ROUNDS = 8

let handle = null
let clients = []

afterEach(async () => {
  for (const client of clients) {
    client.terminate()
  }

  clients = []

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
    const socket = new WebSocket(url, { perMessageDeflate: false })

    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/**
 * Let network reads and server drain events run between publishes.
 * @returns {Promise<void>}
 */
function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

/**
 * @param {Promise<void>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<void>}
 */
function withTimeout(promise, ms, message) {
  let timer

  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test(
  'onDropped: isolates many stalled clients while a reading client keeps receiving',
  { timeout: 15_000 },
  async () => {
    const dropped = []
    const slowIds = new Set(Array.from({ length: SLOW_CLIENTS }, (_, index) => `slow-${index}`))

    handle = await startWsServer({
      ws: {
        onUpgrade: (meta) => ({ isAllowed: true, userData: { id: meta.getQuery('id') } }),
        connectionKey: (ctx) => ctx.data.id,
        onOpen: (ctx) => ctx.subscribe('fanout'),
        onDropped: (ctx, message, isBinary) => {
          dropped.push({ id: ctx.data.id, size: message.byteLength, isBinary })
        }
      }
    })

    for (const id of slowIds) {
      const socket = await connect(`${handle.wsBaseUrl}/?id=${id}`)

      clients.push(socket)
      socket._socket.pause()
    }

    const fast = await connect(`${handle.wsBaseUrl}/?id=fast`)

    clients.push(fast)

    let fastMessages = 0
    let resolveTail

    const tailReceived = new Promise((resolve) => {
      resolveTail = resolve
    })

    fast.on('message', (message) => {
      fastMessages++

      if (message.toString() === 'tail-after-drops') {
        resolveTail()
      }
    })

    assert.strictEqual(handle.server.getSubscribersCount('fanout'), SLOW_CLIENTS + 1)

    const payload = Buffer.alloc(MESSAGE_SIZE, 0x5a)
    const rejectedIds = new Set()
    const rejectedCounts = new Map()

    let sendRounds = 0

    while (sendRounds < MAX_SEND_ROUNDS) {
      for (const id of slowIds) {
        for (let index = 0; index < SENDS_PER_ROUND; index++) {
          if (!handle.server.sendTo(id, payload, true)) {
            rejectedIds.add(id)
            rejectedCounts.set(id, (rejectedCounts.get(id) ?? 0) + 1)
          }
        }
      }

      assert.strictEqual(handle.server.sendTo('fast', `heartbeat-${sendRounds}`, false), true)
      sendRounds++

      const droppedIds = new Set(dropped.map((event) => event.id))

      if ([...slowIds].every((id) => droppedIds.has(id))) {
        break
      }

      await nextTurn()
    }

    const droppedIds = new Set(dropped.map((event) => event.id))
    const droppedCounts = new Map()

    for (const event of dropped) {
      droppedCounts.set(event.id, (droppedCounts.get(event.id) ?? 0) + 1)
    }

    for (const id of slowIds) {
      assert.strictEqual(rejectedIds.has(id), true, `${id} never reported a rejected send`)
      assert.strictEqual(droppedIds.has(id), true, `${id} never reached the backpressure ceiling`)
      assert.strictEqual(
        droppedCounts.get(id),
        rejectedCounts.get(id),
        `${id} must emit one callback per rejected send`
      )
    }

    assert.strictEqual(droppedIds.has('fast'), false, 'the actively reading client must not be dropped')
    assert.strictEqual(
      dropped.every((event) => event.size === MESSAGE_SIZE && event.isBinary),
      true,
      'onDropped must preserve the rejected payload metadata'
    )

    assert.strictEqual(handle.server.publish('fanout', 'tail-after-drops', false), true)
    await withTimeout(tailReceived, 2000, 'healthy client did not receive the tail message')
    await nextTurn()

    const tailDrops = dropped.filter(
      (event) => event.size === Buffer.byteLength('tail-after-drops') && event.isBinary === false
    )
    const tailDropIds = new Set(tailDrops.map((event) => event.id))

    assert.strictEqual(tailDrops.length, SLOW_CLIENTS, 'publish must report one tail drop per stalled subscriber')

    for (const id of slowIds) {
      assert.strictEqual(tailDropIds.has(id), true, `publish did not report the tail drop for ${id}`)
    }

    assert.strictEqual(tailDropIds.has('fast'), false, 'publish must still reach the healthy subscriber')

    assert.strictEqual(
      fastMessages > 1,
      true,
      'the healthy client must receive data before and after slow-client drops'
    )
  }
)
