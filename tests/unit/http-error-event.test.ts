import { describe, test } from 'node:test'
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { createHttpErrorEvent, normalizeHttpError } from '../../src/http/error-event.js'

describe('HTTP error event', () => {
  test('captures an immutable body-free metadata allowlist', () => {
    const event = createHttpErrorEvent(
      {
        getIP: () => '127.0.0.1',
        getMethod: () => 'post',
        getUrl: () => '/failed',
        readErrorHeader: (name) => (name === 'x-request-id' ? 'request-1' : undefined),
        readErrorQuery: (name) => (name === 'requestId' ? 'operation-1' : undefined),
        resolveErrorStatus: () => 503
      },
      new Error('failed'),
      ['x-request-id', 'traceparent'],
      ['requestId', 'token'],
      true
    )

    strictEqual(Object.isFrozen(event), true)
    strictEqual(Object.isFrozen(event.headers), true)
    strictEqual(Object.isFrozen(event.query), true)
    strictEqual(Object.getPrototypeOf(event.headers), null)
    strictEqual(Object.getPrototypeOf(event.query), null)
    strictEqual(Object.hasOwn(event, 'body'), false)
    deepStrictEqual(
      { ...event },
      {
        timestamp: event.timestamp,
        method: 'post',
        url: '/failed',
        status: 503,
        headers: event.headers,
        query: event.query,
        ip: '127.0.0.1'
      }
    )
    deepStrictEqual({ ...event.headers }, { 'x-request-id': 'request-1' })
    deepStrictEqual({ ...event.query }, { requestId: 'operation-1' })
  })

  test('uses safe fallbacks when best-effort metadata readers fail', () => {
    const fail = (): never => {
      throw new Error('metadata unavailable')
    }
    const event = createHttpErrorEvent(
      {
        getIP: fail,
        getMethod: fail,
        getUrl: fail,
        readErrorHeader: fail,
        readErrorQuery: fail,
        resolveErrorStatus: fail
      },
      new Error('failed'),
      ['x-request-id'],
      ['requestId'],
      true
    )

    deepStrictEqual(
      { ...event },
      {
        timestamp: event.timestamp,
        method: '',
        url: '',
        status: 500,
        headers: event.headers,
        query: event.query
      }
    )
    deepStrictEqual({ ...event.headers }, {})
    deepStrictEqual({ ...event.query }, {})
  })

  test('normalizes hostile non-Error values without rethrowing', () => {
    const error = normalizeHttpError({
      [Symbol.toPrimitive]() {
        throw new Error('cannot stringify')
      }
    }) as Error & { code?: string }

    strictEqual(error.message, 'Non-Error value thrown')
    strictEqual(error.code, 'ERR_NON_ERROR_THROWN')
  })
})
