import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { startHttpServer } from '../../helpers/e2e-server.js'

let server = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

/**
 * @param {http.Agent} agent
 * @param {{method: string, port: number, path: string, body?: string}} opt
 * @returns {Promise<{status: number, text: string, socket: import('node:net').Socket}>}
 */
function request(agent, { method, port, path, body }) {
  return new Promise((resolve, reject) => {
    let socket = null

    const req = http.request({ host: '127.0.0.1', port, path, method, agent }, (res) => {
      let text = ''

      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, text, socket }))
    })

    req.on('socket', (s) => {
      socket = s
    })
    req.on('error', reject)

    if (body != null) {
      req.write(body)
    }

    req.end()
  })
}

test('reuses a keep-alive connection after a request whose body is never read', async () => {
  server = await startHttpServer({
    routes: [
      { method: 'post', path: '/noread', handler: (ctx) => ctx.sendText('ok') },
      { method: 'get', path: '/next', handler: (ctx) => ctx.sendText('next') }
    ]
  })

  const port = server.port
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  try {
    // Handler ignores the body; the backend must drain it so the socket stays usable.
    const first = await request(agent, { method: 'POST', port, path: '/noread', body: 'x'.repeat(4096) })
    const second = await request(agent, { method: 'GET', port, path: '/next' })

    assert.strictEqual(first.status, 200)
    assert.strictEqual(first.text, 'ok')
    assert.strictEqual(second.status, 200)
    assert.strictEqual(second.text, 'next')
    assert.strictEqual(first.socket, second.socket, 'the keep-alive socket should be reused')
  } finally {
    agent.destroy()
  }
})
