import { describe, test } from 'node:test'
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import HttpErrorDispatcher from '../../src/http/error-dispatcher.js'

import type { HttpErrorEvent, NormalizedHttpErrorDeliveryOptions } from '../../src/server/options.js'

const OPTIONS: NormalizedHttpErrorDeliveryOptions = {
  concurrency: 1,
  queueLimit: 1,
  timeoutMs: 1_000,
  headers: [],
  query: [],
  includeIp: false
}

function event(url: string): HttpErrorEvent {
  return Object.freeze({
    timestamp: Date.now(),
    method: 'get',
    url,
    status: 500,
    headers: Object.freeze({}),
    query: Object.freeze({})
  })
}

describe('HttpErrorDispatcher', () => {
  test('bounds concurrency and queue length and counts overflow', async () => {
    const deliveries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const started: string[] = []
    const dispatcher = new HttpErrorDispatcher((item) => {
      started.push(item.url)

      return deliveries[started.length - 1]!.promise
    }, OPTIONS)

    dispatcher.dispatch(event('/one'), new Error('one'))
    dispatcher.dispatch(event('/two'), new Error('two'))
    dispatcher.dispatch(event('/three'), new Error('three'))
    await Promise.resolve()

    strictEqual(dispatcher.stats.inFlight, 1)
    strictEqual(dispatcher.stats.queued, 1)
    strictEqual(dispatcher.stats.dropped, 1)
    deepStrictEqual(started, ['/one'])

    deliveries[0]!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    deepStrictEqual(started, ['/one', '/two'])
    strictEqual(dispatcher.stats.inFlight, 1)
    strictEqual(dispatcher.stats.queued, 0)

    deliveries[1]!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    strictEqual(dispatcher.stats.completed, 2)
    strictEqual(dispatcher.stats.inFlight, 0)
  })

  test('aborts at the deadline but keeps an unresolved delivery inside the concurrency bound', async () => {
    let signal: AbortSignal | null = null

    const dispatcher = new HttpErrorDispatcher(
      (_event, _error, context) => {
        signal = context.signal

        return new Promise(() => {})
      },
      { ...OPTIONS, timeoutMs: 10 }
    )

    dispatcher.dispatch(event('/timeout'), new Error('timeout'))
    await Promise.resolve()

    strictEqual(dispatcher.stats.inFlight, 1)
    strictEqual(typeof dispatcher.stats.oldestInFlightMs, 'number')

    await new Promise((resolve) => setTimeout(resolve, 30))

    strictEqual((signal as AbortSignal | null)?.aborted, true)
    strictEqual(dispatcher.stats.inFlight, 1)
    strictEqual(dispatcher.stats.timedOut, 1)
    strictEqual(typeof dispatcher.stats.oldestInFlightMs, 'number')
  })

  test('releases a timed-out slot only when the callback settles', async () => {
    const delivery = Promise.withResolvers<void>()
    const dispatcher = new HttpErrorDispatcher(() => delivery.promise, { ...OPTIONS, timeoutMs: 10 })

    dispatcher.dispatch(event('/timeout'), new Error('timeout'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    strictEqual(dispatcher.stats.inFlight, 1)
    strictEqual(dispatcher.stats.timedOut, 1)

    delivery.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    strictEqual(dispatcher.stats.inFlight, 0)
    strictEqual(dispatcher.stats.completed, 0)
    strictEqual(dispatcher.stats.rejected, 0)
    strictEqual(dispatcher.stats.oldestInFlightMs, null)
  })

  test('contains synchronous throws and asynchronous rejections', async () => {
    let calls = 0

    const dispatcher = new HttpErrorDispatcher(() => {
      calls++

      if (calls === 1) {
        throw new Error('sync')
      }

      return Promise.reject(new Error('async'))
    }, OPTIONS)

    dispatcher.dispatch(event('/sync'), new Error('sync request'))
    dispatcher.dispatch(event('/async'), new Error('async request'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    strictEqual(dispatcher.stats.rejected, 2)
    strictEqual(dispatcher.stats.inFlight, 0)
    strictEqual(dispatcher.stats.queued, 0)
  })

  test('shutdown drains accepted work, drops later events, and is idempotent', async () => {
    const deliveries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const started: string[] = []
    const dispatcher = new HttpErrorDispatcher((item) => {
      started.push(item.url)

      return deliveries[started.length - 1]!.promise
    }, OPTIONS)

    dispatcher.dispatch(event('/one'), new Error('one'))
    dispatcher.dispatch(event('/two'), new Error('two'))
    await Promise.resolve()

    const shutdown = dispatcher.shutdown()

    strictEqual(dispatcher.shutdown(), shutdown)
    strictEqual(dispatcher.closed, true)
    dispatcher.dispatch(event('/late'), new Error('late'))
    strictEqual(dispatcher.stats.dropped, 1)

    deliveries[0]!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    deepStrictEqual(started, ['/one', '/two'])

    deliveries[1]!.resolve()
    await shutdown

    strictEqual(dispatcher.stats.inFlight, 0)
    strictEqual(dispatcher.stats.queued, 0)
    strictEqual(dispatcher.stats.completed, 2)
  })

  test('abort drops queued work, signals active work, and releases shutdown without waiting for settlement', async () => {
    let signal: AbortSignal | null = null

    const dispatcher = new HttpErrorDispatcher(
      (_event, _error, context) => {
        signal = context.signal

        return new Promise(() => {})
      },
      { ...OPTIONS, timeoutMs: 10 }
    )

    dispatcher.dispatch(event('/active'), new Error('active'))
    dispatcher.dispatch(event('/queued'), new Error('queued'))
    await Promise.resolve()

    const shutdown = dispatcher.shutdown()

    dispatcher.abort()
    await shutdown
    await new Promise((resolve) => setTimeout(resolve, 30))

    strictEqual((signal as AbortSignal | null)?.aborted, true)
    strictEqual((signal as AbortSignal | null)?.reason?.code, 'ERR_HTTP_ERROR_DELIVERY_SHUTDOWN')
    strictEqual(dispatcher.stats.inFlight, 1)
    strictEqual(dispatcher.stats.queued, 0)
    strictEqual(dispatcher.stats.dropped, 1)
    strictEqual(dispatcher.stats.timedOut, 0)
    strictEqual(dispatcher.stats.aborted, 1)
    strictEqual(dispatcher.stats.completed, 0)
    strictEqual(dispatcher.stats.rejected, 0)
  })
})
