import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import NodeHttpRequest from '../../src/backends/node-http/request.js'

/**
 * @param {object} [opt]
 * @param {string} [opt.method]
 * @param {string} [opt.url]
 * @param {object} [opt.headers]
 * @param {string[]} [opt.params]
 * @returns {NodeHttpRequest}
 */
function make({ method = 'GET', url = '/', headers = {}, params = [] } = {}) {
  return new NodeHttpRequest({ method, url, headers }, params)
}

describe('node-http NodeHttpRequest', () => {
  test('getMethod returns a lowercase verb', () => {
    strictEqual(make({ method: 'GET' }).getMethod(), 'get')
    strictEqual(make({ method: 'DELETE' }).getMethod(), 'delete')
    strictEqual(make({ method: 'PATCH' }).getMethod(), 'patch')
  })

  test('getMethod falls back to lowercasing unknown verbs', () => {
    strictEqual(make({ method: 'PURGE' }).getMethod(), 'purge')
  })

  test('getUrl strips the query string', () => {
    strictEqual(make({ url: '/a/b?x=1&y=2' }).getUrl(), '/a/b')
    strictEqual(make({ url: '/a/b' }).getUrl(), '/a/b')
    strictEqual(make({ url: '/' }).getUrl(), '/')
  })

  test('getQuery() returns the raw query string without the leading ?', () => {
    strictEqual(make({ url: '/a?x=1&y=2' }).getQuery(), 'x=1&y=2')
    strictEqual(make({ url: '/a' }).getQuery(), '')
  })

  test('getQuery(key) returns the value or undefined', () => {
    const req = make({ url: '/a?x=1&flag&y=hello' })

    strictEqual(req.getQuery('x'), '1')
    strictEqual(req.getQuery('y'), 'hello')
    strictEqual(req.getQuery('flag'), '')
    strictEqual(req.getQuery('missing'), undefined)
  })

  test('getHeader returns the value, empty string for missing, joins arrays', () => {
    const req = make({ headers: { host: 'example.com', 'x-multi': ['a', 'b'] } })

    strictEqual(req.getHeader('host'), 'example.com')
    strictEqual(req.getHeader('missing'), '')
    strictEqual(req.getHeader('x-multi'), 'a, b')
  })

  test('forEach iterates headers with lowercase keys', () => {
    const req = make({ headers: { host: 'h', 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] } })
    const seen = {}

    req.forEach((k, v) => {
      seen[k] = v
    })

    deepStrictEqual(seen, { host: 'h', 'content-type': 'text/plain', 'set-cookie': 'a=1, b=2' })
  })

  test('getParameter returns positional params from the router match', () => {
    const req = make({ params: ['42', 'dune'] })

    strictEqual(req.getParameter(0), '42')
    strictEqual(req.getParameter(1), 'dune')
    strictEqual(req.getParameter(2), undefined)
  })
})
