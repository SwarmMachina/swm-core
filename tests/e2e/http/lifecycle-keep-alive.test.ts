import assert from 'node:assert/strict'
import { Agent, get } from 'node:http'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import { startHttpServer } from '../../helpers/e2e-server.js'

function readResponse(
  port: number,
  path: string,
  agent: Agent
): Promise<{ status: number; body: string; socket: Socket | null }> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path, agent }, (response) => {
      const socket = response.socket

      let body = ''

      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body, socket }))
    })

    request.setTimeout(2_000, () => request.destroy(new Error('response timed out')))
    request.once('error', reject)
  })
}

test(
  'one keep-alive socket remains isolated across repeated invalid replies and pooled contexts',
  { timeout: 5_000 },
  async (t) => {
    const handle = await startHttpServer({
      onRequest: (ctx) => {
        if (ctx.getUrl() === '/invalid') {
          Object.assign(ctx, { user: { id: 'admin', payload: Buffer.alloc(64 * 1024) } })
          ctx.reply(200, { 'x-invalid': 'value\r\ninjected' }, 'must not be written')

          return
        }

        return Object.hasOwn(ctx, 'user') ? 'LEAKED' : 'anonymous'
      }
    })
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })

    let socket: Socket | null = null

    t.after(async () => {
      agent.destroy()
      await handle.close()
    })

    for (let index = 0; index < 20; index++) {
      const invalid = await readResponse(handle.port, '/invalid', agent)
      const anonymous = await readResponse(handle.port, '/anonymous', agent)

      socket ??= invalid.socket
      assert.ok(socket)
      assert.equal(invalid.socket, socket)
      assert.equal(anonymous.socket, socket)
      assert.equal(invalid.status, 500)
      assert.equal(invalid.body, 'Internal Server Error')
      assert.equal(anonymous.status, 200)
      assert.equal(anonymous.body, 'anonymous')
      assert.equal(handle.server.activeHttp, 0)
      assert.equal(handle.server.httpBodyBudget!.usedBytes, 0)
    }
  }
)
