import { describe, test } from 'node:test'
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import HttpContext from '../../src/http/context.js'
import { prepareHeaders } from '../../src/http/headers.js'
import { createMockReq, createMockRes, isWriteHeaderCall } from '../helpers/mock-http.js'

/**
 * @param {ReturnType<typeof createMockRes>} res
 * @returns {Array<[string, string]>}
 */
function writtenHeaders(res: ReturnType<typeof createMockRes>): Array<[string, string]> {
  return res.calls.filter(isWriteHeaderCall).map(([, name, value]) => [name, value])
}

describe('prepareHeaders()', () => {
  test('rejects invalid header names before they cross into the native binding', () => {
    throws(() => prepareHeaders({ 'x-safe\r\nset-cookie': 'value' }), {
      name: 'TypeError',
      message: 'Header name must be a valid HTTP token'
    })
  })

  test('validates values when the reusable block is created', () => {
    throws(() => prepareHeaders({ 'x-name': 'ok\r\nset-cookie: evil=1' }), {
      name: 'TypeError',
      message: 'Header value must not contain CR or LF'
    })
  })

  test('rejects non-object inputs', () => {
    for (const value of [null, undefined, 'x', []]) {
      throws(() => prepareHeaders(value), {
        name: 'TypeError',
        message: 'Headers must be an object'
      })
    }
  })

  test('copies values so later source mutations cannot change the trusted block', () => {
    const cookies = ['a=1; Path=/', 'b=2; Path=/refresh']
    const source = { 'x-name': 'first', 'set-cookie': cookies }
    const prepared = prepareHeaders(source)

    source['x-name'] = 'changed'
    cookies[0] = 'evil=1'
    cookies.push('extra=1')

    const ctx = new HttpContext(null)
    const res = createMockRes()

    ctx.reset(res, createMockReq())
    ctx.reply(200, prepared, 'ok')

    deepStrictEqual(writtenHeaders(res), [
      ['x-name', 'first'],
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/refresh']
    ])
  })

  test('preserves case-insensitive overwrite and repeated-header semantics', () => {
    const prepared = prepareHeaders({
      'X-Trace-Id': 'old',
      'x-trace-id': 'new',
      'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/refresh']
    })
    const ctx = new HttpContext(null)
    const res = createMockRes()

    ctx.reset(res, createMockReq())
    ctx.reply(200, prepared, 'ok')

    deepStrictEqual(writtenHeaders(res), [
      ['x-trace-id', 'new'],
      ['Set-Cookie', 'a=1; Path=/'],
      ['Set-Cookie', 'b=2; Path=/refresh']
    ])
  })

  test('cannot be forged by freezing a lookalike plain object', () => {
    const forged = Object.freeze({ 'x-name': 'ok\r\nset-cookie: evil=1' })
    const ctx = new HttpContext(null)

    ctx.reset(createMockRes(), createMockReq())

    throws(() => ctx.reply(200, forged, 'ok'), {
      name: 'TypeError',
      message: 'Header value must not contain CR or LF'
    })
  })

  test('prepared reply headers overwrite staged values like plain reply headers', () => {
    const prepared = prepareHeaders({ 'content-type': 'application/json', 'x-prepared': 'yes' })
    const ctx = new HttpContext(null)
    const res = createMockRes()

    ctx.reset(res, createMockReq())
    ctx.setHeader('content-type', 'text/plain')
    ctx.setHeader('x-dynamic', 'yes')
    ctx.reply(200, prepared, '{}')

    deepStrictEqual(writtenHeaders(res), [
      ['content-type', 'application/json'],
      ['x-dynamic', 'yes'],
      ['x-prepared', 'yes']
    ])
  })

  test('setHeaders accepts a prepared block and dynamic append remains isolated', () => {
    const prepared = prepareHeaders({ 'set-cookie': ['a=1', 'b=2'] })
    const ctx = new HttpContext(null)
    const res = createMockRes()

    ctx.reset(res, createMockReq())
    ctx.setHeaders(prepared)
    ctx.appendHeader('set-cookie', 'c=3')
    ctx.reply(200, null, 'ok')

    deepStrictEqual(writtenHeaders(res), [
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['set-cookie', 'c=3']
    ])
    strictEqual(Object.isFrozen(prepared), true)
  })
})
