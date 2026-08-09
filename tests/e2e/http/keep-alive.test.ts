import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import http from 'node:http'
import type { Socket } from 'node:net'
import { startHttpServer } from '../../helpers/e2e-server.js'
import type { HttpServerHandle } from '../../helpers/e2e-server.js'

let server: HttpServerHandle | null = null

interface RequestOptions {
  method: string
  port: number
  path: string
  body?: string
}

interface RequestResult {
  status: number
  text: string
  socket: Socket
}

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

function request(agent: http.Agent, { method, port, path, body }: RequestOptions): Promise<RequestResult> {
  return new Promise<RequestResult>((resolve, reject) => {
    let socket: Socket | null = null

    const req = http.request({ host: '127.0.0.1', port, path, method, agent }, (res) => {
      let text = ''

      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => {
        if (socket === null) {
          reject(new Error('HTTP response was received without a socket'))

          return
        }

        resolve({ status: res.statusCode ?? 0, text, socket })
      })
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
    // Handler ignores the body; the transport must drain it so the socket stays usable.
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

test('replyAndClose sends the response and prevents keep-alive reuse', async () => {
  server = await startHttpServer({
    routes: [
      { method: 'get', path: '/reject', handler: (ctx) => ctx.replyAndClose(403, null, 'Forbidden') },
      { method: 'get', path: '/next', handler: (ctx) => ctx.sendText('next') }
    ]
  })

  const port = server.port
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  try {
    const first = await request(agent, { method: 'GET', port, path: '/reject' })
    const second = await request(agent, { method: 'GET', port, path: '/next' })

    assert.strictEqual(first.status, 403)
    assert.strictEqual(first.text, 'Forbidden')
    assert.strictEqual(second.status, 200)
    assert.strictEqual(second.text, 'next')
    assert.notStrictEqual(first.socket, second.socket, 'the closed connection must not be reused')
  } finally {
    agent.destroy()
  }
})

test('drains an early declared body-limit rejection before keep-alive reuse', async () => {
  server = await startHttpServer({
    maxBodySize: 4,
    routes: [
      {
        method: 'post',
        path: '/limited',
        handler: async (ctx) => {
          await ctx.body()

          return 'unreachable'
        }
      },
      { method: 'get', path: '/next', handler: () => 'next' }
    ]
  })

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  try {
    const rejected = await request(agent, {
      method: 'POST',
      port: server.port,
      path: '/limited',
      body: '12345'
    })
    const next = await request(agent, { method: 'GET', port: server.port, path: '/next' })

    assert.strictEqual(rejected.status, 413)
    assert.strictEqual(rejected.text, 'Request body too large')
    assert.strictEqual(next.status, 200)
    assert.strictEqual(next.text, 'next')
    assert.strictEqual(rejected.socket, next.socket)
  } finally {
    agent.destroy()
  }
})

test('terminate aborts the HTTP connection without sending a response', async () => {
  server = await startHttpServer({
    routes: [{ method: 'get', path: '/terminate', handler: (ctx) => ctx.terminate() }]
  })

  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server!.port, path: '/terminate', method: 'GET' }, () =>
        resolve()
      )

      req.on('error', reject)
      req.end()
    })
  )
})
