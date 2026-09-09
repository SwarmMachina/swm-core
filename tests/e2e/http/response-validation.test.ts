import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { prepareHeaders } from '../../../src/http/headers.js'
import type HttpContext from '../../../src/http/public-context.js'
import { startHttpServer } from '../../helpers/e2e-server.js'

for (const asynchronous of [false, true]) {
  test(`response headers fail before native writes ${asynchronous ? 'after await' : 'synchronously'} and preserve keep-alive`, async (t) => {
    const reply = (ctx: HttpContext) => {
      switch (ctx.getUrl()) {
        case '/prepared':
          return ctx.reply(200, prepareHeaders({ 'Content-Length': '2' }), 'ok')
        case '/plain':
          return ctx.reply(200, { 'Transfer-Encoding': 'chunked' }, 'ok')
        case '/control':
          return ctx.reply(200, { 'x-value': 'bad\x01value' }, 'ok')
        case '/manual':
          return ctx.startStreaming(200, { 'content-length': '2' })
        case '/stream':
          return ctx.stream(Readable.from(['ok']), 200, { 'transfer-encoding': 'chunked' })
        default:
          return ctx.setStatus(200).setHeader('Set-Cookie', ['a=1', 'b=2']).sendText('ok')
      }
    }
    const handle = await startHttpServer({
      onRequest: asynchronous
        ? async (ctx) => {
            await nextTurn()

            return reply(ctx)
          }
        : reply
    })

    t.after(handle.close)
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

    t.after(() => agent.destroy())
    const sockets = new Set<object>()
    const paths = ['/prepared', '/plain', '/control', '/manual', '/stream']

    for (const invalidPath of paths) {
      for (const path of [invalidPath, '/ok']) {
        await new Promise<void>((resolve, reject) => {
          const request = http.get(handle.baseUrl + path, { agent }, (response) => {
            sockets.add(response.socket)
            let body = ''

            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              body += chunk
            })
            response.on('error', reject)
            response.on('end', () => {
              try {
                assert.equal(response.statusCode, path === '/ok' ? 200 : 500)
                assert.equal(body, path === '/ok' ? 'ok' : 'Internal Server Error')

                if (path === '/ok') {
                  assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2'])
                }

                resolve()
              } catch (error) {
                reject(error)
              }
            })
          })

          request.on('error', reject)
        })
      }
    }

    assert.equal(sockets.size, 1)
    assert.equal(handle.server.activeHttp, 0)
  })

  test(
    `a native cork exception preserves its cause and releases the request ${asynchronous ? 'after await' : 'synchronously'}`,
    {
      // The reference binding accepts this malformed status instead of throwing
      // inside cork. This regression exercises swm-uws callback-failure cleanup.
      skip: process.execArgv.includes('--conditions=uwebsockets-reference')
    },
    async (t) => {
      const errors: Error[] = []
      const reply = (ctx: HttpContext) => {
        // Force native writeStatus to fail inside cork, after core validation.
        ctx.setStatus(99).reply(200, { 'x-valid': 'value' }, 'bad')
      }
      const handle = await startHttpServer({
        onError: (_event, error) => {
          errors.push(error)
        },
        onRequest: asynchronous
          ? async (ctx) => {
              await nextTurn()
              reply(ctx)
            }
          : reply
      })

      t.after(handle.close)
      await assert.rejects(fetch(handle.baseUrl))
      await nextTurn()
      await nextTurn()
      assert.equal(errors.length, 1)
      assert.match(errors[0]!.message, /status|three-digit/)
      assert.doesNotMatch(errors[0]!.message, /no longer valid/)
      assert.equal(handle.server.activeHttp, 0)
      await handle.close()
    }
  )
}
