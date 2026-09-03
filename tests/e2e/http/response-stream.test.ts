import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'

import { startHttpServer } from '../../helpers/e2e-server.js'

interface StreamResponse {
  body: Buffer
  complete: boolean
  socket: Socket | null
  status: number
}

function requestStream(agent: http.Agent, port: number, path: string): Promise<StreamResponse> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null

    const request = http.get({ agent, host: '127.0.0.1', path, port }, (response) => {
      const chunks: Buffer[] = []

      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('aborted', () => reject(new Error('response aborted unexpectedly')))
      response.once('error', reject)
      response.once('end', () => {
        resolve({
          body: Buffer.concat(chunks),
          complete: response.complete,
          socket,
          status: response.statusCode ?? 0
        })
      })
    })

    request.once('socket', (value) => {
      socket = value
    })
    request.once('error', reject)
  })
}

function rawRequest(port: number, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []

    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true
      resolve(Buffer.concat(chunks))
    }

    socket.setTimeout(5_000, () => socket.destroy(new Error('raw response timed out')))
    socket.once('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('end', finish)
    socket.once('close', finish)
    socket.once('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

test('streamed download preserves bytes and the keep-alive connection', async () => {
  const payload = Buffer.allocUnsafe(512 * 1024)

  for (let index = 0; index < payload.length; index++) {
    payload[index] = (index * 17) % 251
  }

  const expectedHash = createHash('sha256').update(payload).digest('hex')
  const server = await startHttpServer({
    onRequest: (ctx) => {
      if (ctx.getUrl() === '/stream') {
        return ctx.stream(Readable.from([payload.subarray(0, 131_072), payload.subarray(131_072)]))
      }

      return 'pong'
    }
  })
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  try {
    const streamed = await requestStream(agent, server.port, '/stream')
    const ping = await requestStream(agent, server.port, '/ping')

    assert.equal(streamed.status, 200)
    assert.equal(streamed.complete, true)
    assert.equal(createHash('sha256').update(streamed.body).digest('hex'), expectedHash)
    assert.equal(ping.status, 200)
    assert.equal(ping.body.toString(), 'pong')
    assert.ok(streamed.socket)
    assert.equal(ping.socket, streamed.socket)
  } finally {
    agent.destroy()
    await server.close()
  }
})

test('a source error closes a streamed download without a terminal chunk', async () => {
  const server = await startHttpServer({
    onRequest: (ctx) => {
      const source = new PassThrough()

      source.write('prefix')
      setImmediate(() => source.destroy(new Error('source failed')))

      return ctx.stream(source)
    }
  })

  try {
    const raw = await rawRequest(server.port, '/')
    const text = raw.toString('latin1')

    assert.match(text, /^HTTP\/1\.1 200 /)
    // The force-close may truncate after the payload itself; the important
    // invariant is that no terminal chunk turns this into a success.
    assert.match(text, /\r\n6\r\nprefix/)
    assert.doesNotMatch(text, /\r\n0\r\n\r\n$/)
  } finally {
    await server.close()
  }
})
