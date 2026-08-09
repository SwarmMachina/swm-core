import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import type { Socket } from 'node:net'
import { startWsServer } from '../../helpers/e2e-server.js'
import type { WsServerHandle } from '../../helpers/e2e-server.js'
import type WSContext from '../../../src/ws-context.js'

const SLOW_CLIENTS = 6
const MESSAGE_SIZE = 256 * 1024
const SENDS_PER_ROUND = 64
const MAX_SEND_ROUNDS = 8

let handle: WsServerHandle | null = null
let clients: WebSocket[] = []

function idFrom(data: object | null): string {
  const id = (data as { id?: unknown } | null)?.id

  if (typeof id !== 'string') {
    throw new TypeError('Expected WebSocket user data with a string id')
  }

  return id
}

function rawSocket(ctx: WSContext) {
  if (!ctx.ws) {
    throw new Error('Expected a live WebSocket')
  }

  return ctx.ws
}

function tcpSocket(client: WebSocket): Socket {
  return (client as unknown as { _socket: Socket })._socket
}

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

function connect(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false })

    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/**
 * Let network reads and server drain events run between publishes.
 * @returns {Promise<void>}
 */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 1))
}

/**
 * @param {Promise<void>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<void>}
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test(
  'onDropped: isolates many stalled clients while a reading client keeps receiving',
  { timeout: 15_000 },
  async () => {
    const dropped: Array<{ id: string; size: number; isBinary: boolean; bufferedAmount: number }> = []
    const slowIds = new Set(Array.from({ length: SLOW_CLIENTS }, (_, index) => `slow-${index}`))

    handle = await startWsServer({
      ws: {
        onUpgrade: (meta) => ({ id: meta.getQuery('id') }),
        connectionKey: (ctx) => idFrom(ctx.data),
        maxBackpressure: 1024 * 64,
        closeOnBackpressureLimit: false,
        onOpen: (ctx) => ctx.subscribe('fanout'),
        onDropped: (ctx, message, isBinary) => {
          dropped.push({
            id: idFrom(ctx.data),
            size: message.byteLength,
            isBinary,
            bufferedAmount: rawSocket(ctx).getBufferedAmount()
          })
        }
      }
    })

    for (const id of slowIds) {
      const socket = await connect(`${handle.wsBaseUrl}/?id=${id}`)

      clients.push(socket)
      tcpSocket(socket).pause()
    }

    const fast = await connect(`${handle.wsBaseUrl}/?id=fast`)

    clients.push(fast)

    let fastMessages = 0
    let resolveTail: () => void

    const tailReceived = new Promise<void>((resolve) => {
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
    assert.strictEqual(
      dropped.every((event) => event.bufferedAmount >= 64 * 1024),
      true,
      'dropped callbacks must observe the configured per-socket backpressure ceiling'
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

test('closeOnBackpressureLimit closes only the stalled WebSocket', { timeout: 10_000 }, async () => {
  const closed = Promise.withResolvers<void>()
  const dropped: string[] = []

  handle = await startWsServer({
    ws: {
      maxBackpressure: 1024 * 64,
      closeOnBackpressureLimit: true,
      onUpgrade: (meta) => ({ id: meta.getQuery('id') }),
      connectionKey: (ctx) => idFrom(ctx.data),
      onDropped: (ctx) => dropped.push(idFrom(ctx.data)),
      onClose: (ctx) => {
        if (idFrom(ctx.data) === 'slow') {
          closed.resolve()
        }
      }
    }
  })

  const slow = await connect(`${handle.wsBaseUrl}/?id=slow`)
  const fast = await connect(`${handle.wsBaseUrl}/?id=fast`)

  clients.push(slow, fast)
  tcpSocket(slow).pause()

  const fastReceived = Promise.withResolvers<string>()

  fast.once('message', (message) => fastReceived.resolve(message.toString()))

  const payload = Buffer.alloc(MESSAGE_SIZE, 0x41)

  for (let round = 0; round < MAX_SEND_ROUNDS && dropped.length === 0; round++) {
    for (let index = 0; index < SENDS_PER_ROUND; index++) {
      handle.server.sendTo('slow', payload, true)
    }

    await nextTurn()
  }

  await withTimeout(closed.promise, 2000, 'stalled WebSocket was not closed at the backpressure limit')
  assert.strictEqual(dropped.includes('slow'), true)
  assert.strictEqual(handle.server.hasConnection('slow'), false)
  assert.strictEqual(handle.server.sendTo('fast', 'healthy', false), true)
  assert.strictEqual(await withTimeout(fastReceived.promise, 2000, 'healthy WebSocket stopped receiving'), 'healthy')
  assert.strictEqual(handle.server.hasConnection('fast'), true)
})

test('onDrain reports recovery after a stalled socket resumes reading', { timeout: 10_000 }, async () => {
  const drained = Promise.withResolvers<number>()

  handle = await startWsServer({
    ws: {
      maxBackpressure: 8 * 1024 * 1024,
      closeOnBackpressureLimit: false,
      onUpgrade: () => ({ id: 'slow' }),
      connectionKey: (ctx) => idFrom(ctx.data),
      onDrain: (ctx) => {
        drained.resolve(rawSocket(ctx).getBufferedAmount())
      }
    }
  })

  const slow = await connect(handle.wsBaseUrl)

  clients.push(slow)
  tcpSocket(slow).pause()

  const payload = Buffer.alloc(MESSAGE_SIZE, 0x44)
  const raw = handle.server.getConnection('slow')

  assert.ok(raw)

  for (let index = 0; index < 64 && raw.getBufferedAmount() === 0; index++) {
    assert.strictEqual(handle.server.sendTo('slow', payload, true), true)
  }

  const bufferedBeforeResume = raw.getBufferedAmount()

  assert.ok(bufferedBeforeResume > 0, 'test did not create native WebSocket backpressure')
  tcpSocket(slow).resume()

  const bufferedAfterDrain = await withTimeout(
    drained.promise,
    3000,
    'native WebSocket did not emit drain after reads resumed'
  )

  assert.ok(
    bufferedAfterDrain < bufferedBeforeResume,
    `native WebSocket drain made no progress: before=${bufferedBeforeResume}, after=${bufferedAfterDrain}`
  )
  assert.strictEqual(handle.server.hasConnection('slow'), true)
})
