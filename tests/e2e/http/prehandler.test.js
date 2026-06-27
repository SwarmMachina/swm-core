import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { getFreePort } from '../../../helpers/ports.js'
import Server from '../../../src/index.js'
import { reqText } from '../../helpers/http-client.js'

let server = null

/**
 * @param {import('../../../src/index.js').Route[]} routes
 * @returns {Promise<string>}
 */
async function start(routes) {
  const port = await getFreePort()
  server = new Server({ port, routes })
  await server.listen()
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server) {
    await server.shutdown(1000)
    server = null
  }
})

test('preHandler runs before the handler and shares the context', async () => {
  const baseUrl = await start([
    {
      method: 'get',
      path: '/*',
      preHandler: (ctx) => {
        ctx.setHeader('x-pre', 'seen')
      },
      handler: () => 'ok'
    }
  ])

  const { status, headers, text } = await reqText(`${baseUrl}/x`)

  assert.strictEqual(status, 200)
  assert.strictEqual(text, 'ok')
  assert.strictEqual(headers.get('x-pre'), 'seen')
})

test('preHandler array runs in order', async () => {
  const order = []
  const baseUrl = await start([
    {
      method: 'get',
      path: '/*',
      preHandler: [
        (ctx) => {
          order.push('a')
        },
        async (ctx) => {
          order.push('b')
        }
      ],
      handler: () => {
        order.push('h')
        return 'done'
      }
    }
  ])

  const { text } = await reqText(`${baseUrl}/x`)

  assert.strictEqual(text, 'done')
  assert.deepStrictEqual(order, ['a', 'b', 'h'])
})

test('preHandler can short-circuit; handler is skipped and context does not leak', async () => {
  let handlerCalled = false
  const baseUrl = await start([
    {
      method: 'get',
      path: '/*',
      preHandler: (ctx) => {
        ctx.status(401).send('unauthorized')
      },
      handler: () => {
        handlerCalled = true
        return 'should not run'
      }
    }
  ])

  const { status, text } = await reqText(`${baseUrl}/x`)

  assert.strictEqual(status, 401)
  assert.strictEqual(text, 'unauthorized')
  assert.strictEqual(handlerCalled, false)

  // A leaked context would keep `activeHttp` > 0 and make shutdown wait for the
  // force-close timeout. A clean finalize lets shutdown resolve immediately.
  const startedAt = performance.now()
  await server.shutdown(3000)
  server = null
  assert.ok(performance.now() - startedAt < 500, 'shutdown should resolve immediately (no context leak)')
})
