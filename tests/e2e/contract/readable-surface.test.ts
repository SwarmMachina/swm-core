/* eslint-disable jsdoc/reject-any-type */

import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'
import { getFreePort } from '@swarmmachina/benchkit'

import Server from '../../../src/index.js'
import type HttpContext from '../../../src/http-context.js'
import type { RawWebSocket } from '../../../src/ws-context.js'
import type WSContext from '../../../src/ws-context.js'

interface WsObservations {
  open?: true
  closeKey?: string | number | null
  closeContext?: WSContext
  close?: { code: number; reason: string }
  error?: Error
}

interface HttpObservation {
  ip: string
  proxiedPort: number
  peerPort: number
  method: string
  url: string
  fullQuery: string
  one: string | undefined
  empty: string | undefined
  missing: string | undefined
  paramIndex: string | undefined
  paramName: string | undefined
  header: string
  headerFromSnapshot: string | undefined
  missingHeader: string
  contentLength: number
  writeOffset: number
  replied: boolean
  aborted: boolean
}

interface UpgradeObservation {
  url: string
  ip: string
  parameter: string | undefined
  query: string | undefined
  one: string | undefined
  missing: string | undefined
  header: string
  headers: Readonly<Record<string, string>>
  aborted: boolean
}

const READABLE_SURFACE = {
  HttpContext: [
    'aborted',
    'body',
    'buffer',
    'getContentLength',
    'getReqHeader',
    'getHeaders',
    'getIP',
    'getMethod',
    'getParameter',
    'getQuery',
    'getUrl',
    'getWriteOffset',
    'headers',
    'json',
    'replied',
    'text'
  ],
  UpgradeMeta: ['aborted', 'getHeader', 'getParameter', 'getQuery', 'headers', 'ip', 'url'],
  WSContext: ['data', 'decode', 'key', 'ws'],
  RawWebSocket: [
    'getBufferedAmount',
    'getRemoteAddress',
    'getRemoteAddressAsText',
    'getRemotePort',
    'getTopics',
    'getUserData',
    'isSubscribed'
  ],
  Server: [
    'activeHttp',
    'activeWs',
    'connectionCount',
    'getConnection',
    'getSubscribersCount',
    'hasConnection',
    'host',
    'port'
  ]
}
const CORE_READ_METHODS = {
  HttpContext: [
    'getContentLength',
    'getReqHeader',
    'getHeaders',
    'getIP',
    'getMethod',
    'getParameter',
    'getQuery',
    'getUrl',
    'getWriteOffset',
    'headers'
  ],
  WSContext: ['decode'],
  Server: ['activeHttp', 'activeWs', 'connectionCount', 'getConnection', 'getSubscribersCount', 'hasConnection']
}
// Pinned uwebsockets.js v20.69.0 exposes these getters but returns the
// absence values after a custom upgrade. swm-uws preserves the peer address.
const WS_REMOTE_CONTRACT = {
  'swm-uws': { addressLengths: [4, 16], textPresent: true, portPresent: true },
  'uwebsockets-reference': { addressLengths: [0], textPresent: false, portPresent: true }
}

/**
 *
 * @param value
 * @param scope
 */
function corePrototypeReaders(value: object, scope: keyof typeof CORE_READ_METHODS): string[] {
  const explicit = new Set(CORE_READ_METHODS[scope])
  const names = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(value)))
  const record = value as Record<string, unknown>

  for (const name of Object.keys(value)) {
    if (explicit.has(name) && typeof record[name] === 'function') {
      names.add(name)
    }
  }

  return [...names]
    .filter(
      (name) =>
        explicit.has(name) ||
        ((name.startsWith('get') || name.startsWith('has') || name.startsWith('is')) && name !== 'getStatus')
    )
    .sort()
}

/**
 *
 * @param value
 */
function rawPrototypeReaders(value: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value))
    .filter((name) => name.startsWith('get') || name.startsWith('is'))
    .sort()
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index]

  if (item === undefined) {
    throw new RangeError(`Expected item at index ${index}`)
  }

  return item
}

/**
 *
 * @param port
 */
function proxyV2Header(port: number): Buffer {
  const header = Buffer.alloc(28)

  Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'binary').copy(header)
  header[12] = 0x21
  header[13] = 0x11
  header.writeUInt16BE(12, 14)
  Buffer.from([203, 0, 113, 10, 127, 0, 0, 1]).copy(header, 16)
  header.writeUInt16BE(41_234, 24)
  header.writeUInt16BE(port, 26)

  return header
}

/**
 *
 * @param port
 * @param request
 * @param prefix
 * @param resolveOnData
 */
function rawRequest(port: number, request: string, prefix?: Buffer, resolveOnData = false): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []

    let settled = false

    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')))
    socket.on('connect', () => {
      if (prefix) {
        socket.write(prefix)
      }

      socket.write(request)
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)

      if (resolveOnData && !settled) {
        settled = true
        resolve(Buffer.concat(chunks).toString())
        socket.destroy()
      }
    })
    socket.on('end', () => {
      if (!settled) {
        resolve(Buffer.concat(chunks).toString())
      }
    })
    socket.on('error', reject)
  })
}

/**
 *
 * @param path
 */
function upgradeRequest(path: string): string {
  return [
    `GET ${path} HTTP/1.1`,
    'Host: localhost',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'X-Upgrade-Test: yes',
    '',
    ''
  ].join('\r\n')
}

/**
 *
 * @param target
 * @param name
 */
function nextEvent<T extends Event>(target: EventTarget, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${name} timed out`)), 5_000)

    target.addEventListener(
      name,
      (event) => {
        clearTimeout(timer)
        resolve(event as T)
      },
      { once: true }
    )
    target.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error(`WebSocket ${name} failed`))
      },
      { once: true }
    )
  })
}

test(
  'public readable API works over real HTTP, PROXY v2, upgrade and WebSocket connections',
  { timeout: 15_000 },
  async () => {
    const port = await getFreePort()
    const covered = new Set()
    const httpObservations: Array<{ sync: HttpObservation; repeated: HttpObservation; async: HttpObservation }> = []
    const upgrades: UpgradeObservation[] = []
    const wsObservations: WsObservations = {}

    const wsClosed = Promise.withResolvers<void>()

    /**
     *
     * @param scope
     * @param {...any} names
     */
    function cover(scope: string, ...names: string[]): void {
      for (const name of names) {
        covered.add(`${scope}.${name}`)
      }
    }

    /**
     *
     * @param ctx
     */
    function readHttp(ctx: HttpContext): HttpObservation {
      assert.deepEqual(corePrototypeReaders(ctx, 'HttpContext'), [...CORE_READ_METHODS.HttpContext].sort())

      const readable = ctx as unknown as Record<string, unknown>

      for (const method of ['body', 'buffer', 'text', 'json']) {
        assert.equal(typeof readable[method], 'function')
      }

      cover(
        'HttpContext',
        'aborted',
        'buffer',
        'getContentLength',
        'getReqHeader',
        'getHeaders',
        'getIP',
        'getMethod',
        'getParameter',
        'getQuery',
        'getUrl',
        'getWriteOffset',
        'headers',
        'replied'
      )

      const requestHeader = ctx.getReqHeader('x-contract')

      assert.equal(ctx.headers, ctx.headers)
      assert.equal(ctx.headers['x-contract'], 'Value')

      const headers = ctx.getHeaders()
      const headerFromSnapshot = headers['x-contract']

      assert.equal(Object.getPrototypeOf(headers), null)
      assert.equal(Object.hasOwn(headers, 'x-missing'), false)
      headers['x-contract'] = 'mutated'
      assert.equal(ctx.getReqHeader('x-contract'), 'Value')

      const response = ctx.res

      if (!response) {
        throw new Error('Expected a live HTTP response')
      }

      return {
        ip: ctx.getIP(),
        proxiedPort: response.getProxiedRemotePort() ?? 0,
        peerPort: response.getRemotePort() ?? 0,
        method: ctx.getMethod(),
        url: ctx.getUrl(),
        fullQuery: ctx.getQuery(),
        one: ctx.getQuery('one'),
        empty: ctx.getQuery('empty'),
        missing: ctx.getQuery('missing'),
        paramIndex: ctx.getParameter(0),
        paramName: ctx.getParameter('name'),
        header: requestHeader,
        headerFromSnapshot,
        missingHeader: ctx.getReqHeader('x-missing'),
        contentLength: ctx.getContentLength() ?? 0,
        writeOffset: ctx.getWriteOffset(),
        replied: ctx.replied,
        aborted: ctx.aborted
      }
    }

    const server = new Server({
      host: '127.0.0.1',
      port,
      http: {
        routes: [
          {
            method: 'post',
            path: '/contract/:name',
            prefetch: true,
            async handler(ctx) {
              const sync = readHttp(ctx)
              const repeated = readHttp(ctx)

              await new Promise((resolve) => setImmediate(resolve))
              const async = readHttp(ctx)

              httpObservations.push({ sync, repeated, async })

              cover('HttpContext', 'body', 'buffer', 'text', 'json')
              await ctx.body()

              assert.deepEqual(await ctx.buffer(), Buffer.from('{"ok":true}'))
              assert.equal(await ctx.text(), '{"ok":true}')
              assert.deepEqual(await ctx.json(), { ok: true })

              return { ip: sync.ip }
            }
          }
        ]
      },
      ws: {
        connectionKey(ctx) {
          cover('WSContext', 'key')
          assert.equal(ctx.key, null)

          return 'contract-client'
        },
        onUpgrade(meta) {
          assert.deepEqual(Object.keys(meta).sort(), [...READABLE_SURFACE.UpgradeMeta].sort())
          cover('UpgradeMeta', 'aborted', 'getHeader', 'getParameter', 'getQuery', 'headers', 'ip', 'url')
          const observation = {
            url: meta.url(),
            ip: meta.ip(),
            parameter: meta.getParameter(0),
            query: meta.getQuery(),
            one: meta.getQuery('one'),
            missing: meta.getQuery('missing'),
            header: meta.getHeader('x-upgrade-test'),
            headers: meta.headers,
            aborted: meta.aborted
          }

          upgrades.push(observation)

          return observation.url === '/ws' ? { role: 'reader' } : null
        },
        onOpen(ctx) {
          assert.deepEqual(corePrototypeReaders(ctx, 'WSContext'), CORE_READ_METHODS.WSContext)
          cover('WSContext', 'data', 'key', 'ws')
          cover(
            'RawWebSocket',
            'getBufferedAmount',
            'getRemoteAddress',
            'getRemoteAddressAsText',
            'getRemotePort',
            'getTopics',
            'getUserData',
            'isSubscribed'
          )
          const raw = requireRawWebSocket(ctx)
          const backend = process.execArgv.includes('--conditions=uwebsockets-reference')
            ? 'uwebsockets-reference'
            : 'swm-uws'
          const remoteContract = WS_REMOTE_CONTRACT[backend]

          assert.deepEqual(rawPrototypeReaders(raw), [...READABLE_SURFACE.RawWebSocket].sort())
          assert.equal((ctx.data as { role: string }).role, 'reader')
          assert.equal(ctx.key, 'contract-client')
          assert.equal((raw.getUserData() as { role: string }).role, 'reader')
          assert.equal(raw.getBufferedAmount(), 0)
          const wsRemoteAddress = raw.getRemoteAddress()

          assert.ok(
            remoteContract.addressLengths.includes(wsRemoteAddress.byteLength),
            `${backend} WebSocket remote address length: ${wsRemoteAddress.byteLength}`
          )
          assert.equal(raw.getRemoteAddressAsText().byteLength > 0, remoteContract.textPresent)
          assert.equal(raw.getRemotePort() > 0, remoteContract.portPresent)
          assert.equal(raw.isSubscribed('contract'), false)
          assert.deepEqual(raw.getTopics(), [])
          ctx.subscribe('contract')
          assert.equal(raw.isSubscribed('contract'), true)
          assert.deepEqual([...raw.getTopics()].sort(), ['contract'])
          ctx.unsubscribe('contract')
          assert.equal(raw.isSubscribed('contract'), false)
          assert.deepEqual(raw.getTopics(), [])
          wsObservations.open = true
          ctx.send('ready')
        },
        onMessage(ctx, message, isBinary) {
          cover('WSContext', 'decode')
          assert.equal(ctx.decode(message), 'hello')
          assert.equal(isBinary, false)
          ctx.end(1000, 'done')
        },
        onClose(ctx, code, reason) {
          wsObservations.closeKey = ctx.key
          wsObservations.closeContext = ctx
          wsObservations.close = { code, reason: ctx.decode(reason) }
          wsClosed.resolve()
        },
        onError(_ctx, error) {
          wsObservations.error = error
        }
      }
    })

    cover(
      'Server',
      'activeHttp',
      'activeWs',
      'connectionCount',
      'getConnection',
      'getSubscribersCount',
      'hasConnection',
      'host',
      'port'
    )
    assert.deepEqual(corePrototypeReaders(server, 'Server'), [...CORE_READ_METHODS.Server].sort())
    assert.equal(server.host, '127.0.0.1')
    assert.equal(server.port, port)
    assert.equal(server.activeHttp, 0)
    assert.equal(server.activeWs, 0)
    assert.equal(server.connectionCount, 0)
    assert.equal(server.getSubscribersCount('contract'), 0)
    assert.equal(server.hasConnection('contract-client'), false)
    assert.equal(server.getConnection('contract-client'), undefined)

    await server.listen()

    try {
      const payload = '{"ok":true}'
      const request = [
        'POST /contract/alice?one=1&empty= HTTP/1.1',
        'Host: localhost',
        'X-Contract: Value',
        `Content-Length: ${payload.length}`,
        'Connection: close',
        '',
        payload
      ].join('\r\n')
      const directResponse = await rawRequest(port, request)
      const proxyResponse = await rawRequest(port, request, proxyV2Header(port))

      assert.match(directResponse, /"ip":"127\.0\.0\.1"/)
      assert.match(proxyResponse, /"ip":"203\.0\.113\.10"/)
      assert.equal(httpObservations.length, 2)
      assert.equal(at(httpObservations, 0).sync.proxiedPort, 0)
      assert.equal(at(httpObservations, 0).sync.peerPort > 0, true)
      // The production swm-uws binding returns the network-order PROXY v2
      // source port correctly. Pinned upstream uWebSockets.js v20.69.0 exposes
      // the same two bytes swapped (0x12a1); keep that compatibility anomaly
      // visible rather than hiding it behind a swm-core heuristic.
      const expectedProxiedPort = process.execArgv.includes('--conditions=uwebsockets-reference') ? 0x12a1 : 41_234

      assert.equal(at(httpObservations, 1).sync.proxiedPort, expectedProxiedPort)
      assert.equal(at(httpObservations, 1).sync.peerPort > 0, true)

      for (const { sync, repeated, async } of httpObservations) {
        assert.deepEqual(repeated, sync)
        assert.deepEqual(async, sync)
        assert.equal(sync.method, 'post')
        assert.equal(sync.url, '/contract/alice')
        assert.equal(sync.fullQuery, 'one=1&empty=')
        assert.equal(sync.one, '1')
        assert.equal(sync.empty, '')
        assert.equal(sync.missing, undefined)
        assert.equal(sync.paramIndex, 'alice')
        assert.equal(sync.paramName, 'alice')
        assert.equal(sync.header, 'Value')
        assert.equal(sync.headerFromSnapshot, 'Value')
        assert.equal(sync.missingHeader, '')
        assert.equal(sync.contentLength, payload.length)
        assert.equal(sync.writeOffset, 0)
        assert.equal(sync.replied, false)
        assert.equal(sync.aborted, false)
      }

      const directUpgradeResponse = await rawRequest(port, upgradeRequest('/probe/value?one=1'), undefined, true)
      const proxyUpgradeResponse = await rawRequest(
        port,
        upgradeRequest('/probe/value?one=1'),
        proxyV2Header(port),
        true
      )

      assert.equal(
        upgrades.length,
        2,
        `${directUpgradeResponse}\n--- proxy ---\n${proxyUpgradeResponse}\n${wsObservations.error?.stack || ''}`
      )
      assert.equal(at(upgrades, 0).ip, '127.0.0.1')
      assert.equal(at(upgrades, 1).ip, '203.0.113.10')

      for (const meta of upgrades.slice(0, 2)) {
        assert.equal(meta.url, '/probe/value')
        assert.equal(meta.query, 'one=1')
        assert.equal(meta.one, '1')
        assert.equal(meta.missing, undefined)
        assert.equal(meta.header, 'yes')
        assert.equal(meta.headers['x-upgrade-test'], 'yes')
        assert.equal(meta.aborted, false)
      }

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

      let message: MessageEvent<string>

      try {
        message = await nextEvent<MessageEvent<string>>(ws, 'message')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        throw new Error(`${message}\n${wsObservations.error?.stack || ''}`, { cause: error })
      }

      assert.equal(message.data, 'ready')
      assert.equal(server.activeWs, 1)
      assert.equal(server.connectionCount, 1)
      assert.equal(server.hasConnection('contract-client'), true)
      assert.ok(server.getConnection('contract-client'))
      ws.send('hello')
      await nextEvent<CloseEvent>(ws, 'close')
      await wsClosed.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(wsObservations.open, true)
      assert.deepEqual(wsObservations.close, { code: 1000, reason: 'done' })
      assert.equal(wsObservations.closeKey, 'contract-client')
      assert.ok(wsObservations.closeContext)
      assert.equal(wsObservations.closeContext.key, null)
      assert.equal(server.activeWs, 0)
      assert.equal(server.connectionCount, 0)

      assert.deepEqual(
        [...covered].sort(),
        Object.entries(READABLE_SURFACE)
          .flatMap(([scope, names]) => names.map((name) => `${scope}.${name}`))
          .sort(),
        'every documented readable manifest entry must execute a functional assertion'
      )
    } finally {
      await server.shutdown(1000)
    }
  }
)

function requireRawWebSocket(ctx: WSContext): RawWebSocket {
  if (!ctx.ws) {
    throw new Error('Expected a live WebSocket context')
  }

  return ctx.ws
}
