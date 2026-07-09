import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import Router from '../../src/backends/node-http/router.js'

/**
 * @param {Router} router
 * @param {string} method
 * @param {string} path
 * @returns {{handler: Function, params: string[]}|null}
 */
function m(router, method, path) {
  return router.match(method, path)
}

describe('node-http Router', () => {
  test('matches a static route', () => {
    const router = new Router()
    const h = () => 'ok'

    router.add('get', '/api/ping', h)

    const r = m(router, 'get', '/api/ping')

    strictEqual(r.handler, h)
    deepStrictEqual(r.params, [])
  })

  test('returns null when nothing matches', () => {
    const router = new Router()

    router.add('get', '/api/ping', () => {})

    strictEqual(m(router, 'get', '/nope'), null)
    strictEqual(m(router, 'get', '/api'), null)
  })

  test('captures a single named param positionally', () => {
    const router = new Router()
    const h = () => {}

    router.add('get', '/users/:id', h)

    const r = m(router, 'get', '/users/42')

    strictEqual(r.handler, h)
    deepStrictEqual(r.params, ['42'])
  })

  test('captures multiple named params in declaration order', () => {
    const router = new Router()

    router.add('get', '/users/:id/books/:bookId', () => {})

    const r = m(router, 'get', '/users/7/books/99')

    deepStrictEqual(r.params, ['7', '99'])
  })

  test('static segment beats a param at the same position', () => {
    const router = new Router()
    const staticH = () => 'static'
    const paramH = () => 'param'

    router.add('get', '/users/:id', paramH)
    router.add('get', '/users/me', staticH)

    strictEqual(m(router, 'get', '/users/me').handler, staticH)
    strictEqual(m(router, 'get', '/users/42').handler, paramH)
    deepStrictEqual(m(router, 'get', '/users/42').params, ['42'])
  })

  test('param beats wildcard at the same position', () => {
    const router = new Router()
    const paramH = () => 'param'
    const wildH = () => 'wild'

    router.add('get', '/files/*', wildH)
    router.add('get', '/files/:name', paramH)

    strictEqual(m(router, 'get', '/files/report').handler, paramH)
  })

  test('wildcard matches deep tails and the empty tail, exposing the rest as a trailing param', () => {
    const router = new Router()
    const h = () => {}

    router.add('any', '/*', h)

    strictEqual(m(router, 'get', '/nope').handler, h)
    deepStrictEqual(m(router, 'get', '/nope').params, ['nope'])
    deepStrictEqual(m(router, 'get', '/a/b/c').params, ['a/b/c'])
    // '/' matches the empty tail of '/*'
    strictEqual(m(router, 'get', '/').handler, h)
    deepStrictEqual(m(router, 'get', '/').params, [''])
  })

  test('specific method wins, any is the fallback', () => {
    const router = new Router()
    const getH = () => 'get'
    const anyH = () => 'any'

    router.add('get', '/thing', getH)
    router.add('any', '/thing', anyH)

    strictEqual(m(router, 'get', '/thing').handler, getH)
    strictEqual(m(router, 'post', '/thing').handler, anyH)
  })

  test('a specific route that lacks the method falls through to a catch-all any route', () => {
    const router = new Router()
    const pingH = () => 'ping'
    const catchAll = () => 'catchall'

    router.add('get', '/api/ping', pingH)
    router.add('any', '/*', catchAll)

    strictEqual(m(router, 'get', '/api/ping').handler, pingH)
    // POST /api/ping: no POST/any at the specific node -> falls to /* any
    strictEqual(m(router, 'post', '/api/ping').handler, catchAll)
    strictEqual(m(router, 'get', '/nope').handler, catchAll)
  })

  test('backtracks past a dead-end static branch to a matching param route', () => {
    const router = new Router()
    const h = () => {}

    router.add('get', '/a/b/c', () => {})
    router.add('get', '/a/:x/d', h)

    const r = m(router, 'get', '/a/b/d')

    strictEqual(r.handler, h)
    deepStrictEqual(r.params, ['b'])
  })

  test('exposes named params before the wildcard tail', () => {
    const router = new Router()

    router.add('get', '/books/:genre/*', () => {})

    const r = m(router, 'get', '/books/sci-fi/dune/2021')

    deepStrictEqual(r.params, ['sci-fi', 'dune/2021'])
  })
})
