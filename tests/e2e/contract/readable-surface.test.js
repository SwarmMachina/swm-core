/* eslint-disable jsdoc/require-param-type, jsdoc/require-returns, jsdoc/reject-any-type */

import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'

import Server from '../../../src/index.js'
import { getFreePort } from '../../../helpers/ports.js'

const READABLE_SURFACE = {
  HttpContext: [
    'aborted',
    'body',
    'buffer',
    'contentLength',
    'fullQuery',
    'getWriteOffset',
    'header',
    'ip',
    'json',
    'method',
    'param',
    'query',
    'replied',
    'text',
    'url'
  ],
  UpgradeMeta: ['aborted', 'getHeader', 'getParameter', 'getQuery', 'ip', 'url'],
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
  HttpContext: ['contentLength', 'fullQuery', 'getWriteOffset', 'header', 'ip', 'method', 'param', 'query', 'url'],
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
function corePrototypeReaders(value, scope) {
  const explicit = new Set(CORE_READ_METHODS[scope])
  const names = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(value)))

  for (const name of Object.keys(value)) {
    if (explicit.has(name) && typeof value[name] === 'function') {
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
function rawPrototypeReaders(value) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value))
    .filter((name) => name.startsWith('get') || name.startsWith('is'))
    .sort()
}

/**
 *
 * @param port
 */
function proxyV2Header(port) {
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
function rawRequest(port, request, prefix, resolveOnData = false) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks = []

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
function upgradeRequest(path) {
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
function nextEvent(target, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${name} timed out`)), 5_000)

    target.addEventListener(
      name,
      (event) => {
        clearTimeout(timer)
        resolve(event)
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
    const httpObservations = []
    const upgrades = []
    const wsObservations = {}

    let resolveWsClose

    const wsClosed = new Promise((resolve) => {
      resolveWsClose = resolve
    })

    /**
     *
     * @param scope
     * @param {...any} names
     */
    function cover(scope, ...names) {
      for (const name of names) {
        covered.add(`${scope}.${name}`)
      }
    }

    /**
     *
     * @param ctx
     */
    function readHttp(ctx) {
      assert.deepEqual(corePrototypeReaders(ctx, 'HttpContext'), [...CORE_READ_METHODS.HttpContext].sort())

      for (const method of ['body', 'buffer', 'text', 'json']) {
        assert.equal(typeof ctx[method], 'function')
      }

      cover(
        'HttpContext',
        'aborted',
        'contentLength',
        'fullQuery',
        'getWriteOffset',
        'header',
        'ip',
        'method',
        'param',
        'query',
        'replied',
        'url'
      )

      return {
        ip: ctx.ip(),
        proxiedPort: ctx.res.getProxiedRemotePort(),
        peerPort: ctx.res.getRemotePort(),
        method: ctx.method(),
        url: ctx.url(),
        fullQuery: ctx.fullQuery(),
        one: ctx.query('one'),
        empty: ctx.query('empty'),
        missing: ctx.query('missing'),
        paramIndex: ctx.param(0),
        paramName: ctx.param('name'),
        header: ctx.header('x-contract'),
        missingHeader: ctx.header('x-missing'),
        contentLength: ctx.contentLength(),
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
              const body = await ctx.body()

              assert.equal(await ctx.buffer(), body)
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
          cover('UpgradeMeta', 'aborted', 'getHeader', 'getParameter', 'getQuery', 'ip', 'url')
          const observation = {
            url: meta.url(),
            ip: meta.ip(),
            parameter: meta.getParameter(0),
            query: meta.getQuery(),
            one: meta.getQuery('one'),
            missing: meta.getQuery('missing'),
            header: meta.getHeader('x-upgrade-test'),
            aborted: meta.aborted
          }

          upgrades.push(observation)

          return observation.url === '/ws' ? { role: 'reader' } : false
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
          const raw = ctx.ws
          const backend = process.execArgv.includes('--conditions=uwebsockets-reference')
            ? 'uwebsockets-reference'
            : 'swm-uws'
          const remoteContract = WS_REMOTE_CONTRACT[backend]

          assert.deepEqual(rawPrototypeReaders(raw), [...READABLE_SURFACE.RawWebSocket].sort())
          assert.equal(ctx.data.role, 'reader')
          assert.equal(ctx.key, 'contract-client')
          assert.equal(raw.getUserData().role, 'reader')
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
          resolveWsClose()
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
      assert.equal(httpObservations[0].sync.proxiedPort, 0)
      assert.equal(httpObservations[0].sync.peerPort > 0, true)
      // The production swm-uws binding returns the network-order PROXY v2
      // source port correctly. Pinned upstream uWebSockets.js v20.69.0 exposes
      // the same two bytes swapped (0x12a1); keep that compatibility anomaly
      // visible rather than hiding it behind a swm-core heuristic.
      const expectedProxiedPort = process.execArgv.includes('--conditions=uwebsockets-reference') ? 0x12a1 : 41_234

      assert.equal(httpObservations[1].sync.proxiedPort, expectedProxiedPort)
      assert.equal(httpObservations[1].sync.peerPort > 0, true)

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
      assert.equal(upgrades[0].ip, '127.0.0.1')
      assert.equal(upgrades[1].ip, '203.0.113.10')

      for (const meta of upgrades.slice(0, 2)) {
        assert.equal(meta.url, '/probe/value')
        assert.equal(meta.query, 'one=1')
        assert.equal(meta.one, '1')
        assert.equal(meta.missing, undefined)
        assert.equal(meta.header, 'yes')
        assert.equal(meta.aborted, false)
      }

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

      let message

      try {
        message = await nextEvent(ws, 'message')
      } catch (error) {
        throw new Error(`${error.message}\n${wsObservations.error?.stack || ''}`, { cause: error })
      }

      assert.equal(message.data, 'ready')
      assert.equal(server.activeWs, 1)
      assert.equal(server.connectionCount, 1)
      assert.equal(server.hasConnection('contract-client'), true)
      assert.ok(server.getConnection('contract-client'))
      ws.send('hello')
      await nextEvent(ws, 'close')
      await wsClosed
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(wsObservations.open, true)
      assert.deepEqual(wsObservations.close, { code: 1000, reason: 'done' })
      assert.equal(wsObservations.closeKey, 'contract-client')
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
