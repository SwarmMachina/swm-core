import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import NodeHttpResponse from '../../src/backends/node-http/response.js'

class FakeRes extends EventEmitter {
  constructor() {
    super()
    this.head = null
    this.writes = []
    this.ended = false
    this.corks = 0
    this.writableFinished = false
    this.writeReturn = true
    this.socket = { remoteAddress: '1.2.3.4' }
  }

  cork() {
    this.corks++
  }

  uncork() {
    this.corks--
  }

  writeHead(code, message, headers) {
    this.head = { code, message, headers }
    return this
  }

  write(chunk) {
    this.writes.push(chunk)
    return this.writeReturn
  }

  end(chunk) {
    if (chunk !== undefined) {
      this.writes.push(chunk)
    }

    this.ended = true
    this.writableFinished = true
    return this
  }
}

class FakeReq extends EventEmitter {
  constructor() {
    super()
    this.resumed = false
    this.socket = { remoteAddress: '1.2.3.4' }
  }

  resume() {
    this.resumed = true
  }
}

/**
 * @returns {{res: NodeHttpResponse, raw: FakeRes, req: FakeReq}}
 */
function make() {
  const raw = new FakeRes()
  const req = new FakeReq()

  return { res: new NodeHttpResponse(req, raw), raw, req }
}

describe('node-http NodeHttpResponse', () => {
  test('reply path: stages status + headers, flushes once, ends with body and content-length', () => {
    const { res, raw } = make()

    res.cork(() => {
      res.writeStatus('200 OK')
      res.writeHeader('content-type', 'text/plain')
      res.end('hello')
    })

    strictEqual(raw.head.code, 200)
    strictEqual(raw.head.message, 'OK')
    // flat [k, v, ...] with an explicit content-length appended
    deepStrictEqual(raw.head.headers, ['content-type', 'text/plain', 'content-length', '5'])
    strictEqual(raw.ended, true)
    strictEqual(raw.writes.length, 1)
    strictEqual(raw.writes[0].toString(), 'hello')
  })

  test('cork runs its callback synchronously and balances cork/uncork', () => {
    const { res, raw } = make()
    let ran = false

    res.cork(() => {
      ran = true
      strictEqual(raw.corks, 1)
    })

    strictEqual(ran, true)
    strictEqual(raw.corks, 0)
  })

  test('header order does not matter and duplicate header names are preserved', () => {
    const { res, raw } = make()

    res.writeHeader('set-cookie', 'a=1')
    res.writeHeader('set-cookie', 'b=2')
    res.writeStatus('201 Created')
    res.end()

    strictEqual(raw.head.code, 201)
    deepStrictEqual(raw.head.headers, ['set-cookie', 'a=1', 'set-cookie', 'b=2', 'content-length', '0'])
  })

  test('unknown status text is parsed to its numeric code', () => {
    const { res, raw } = make()

    res.writeStatus('499 Unknown')
    res.end()

    strictEqual(raw.head.code, 499)
    strictEqual(raw.head.message, 'Unknown')
  })

  test('tryEnd streams chunks, tracks the write offset and finishes at total', () => {
    const { res, raw } = make()

    res.writeStatus('200 OK')

    const first = res.tryEnd('abc', 6)

    deepStrictEqual(first, [true, false])
    strictEqual(res.getWriteOffset(), 3)
    // content-length is the total, staged on the first tryEnd
    deepStrictEqual(raw.head.headers, ['content-length', '6'])
    strictEqual(raw.ended, false)

    const second = res.tryEnd('def', 6)

    deepStrictEqual(second, [true, true])
    strictEqual(res.getWriteOffset(), 6)
    strictEqual(raw.ended, true)
    strictEqual(raw.writes.map((c) => c.toString()).join(''), 'abcdef')
  })

  test('tryEnd reports backpressure via the ok flag', () => {
    const { res, raw } = make()

    raw.writeReturn = false
    res.writeStatus('200 OK')

    const [ok, done] = res.tryEnd('abc', 6)

    strictEqual(ok, false)
    strictEqual(done, false)
  })

  test('onWritable handler fires on drain with the current offset', () => {
    const { res, raw } = make()
    let got = -1

    res.writeStatus('200 OK')
    res.tryEnd('abc', 6)
    res.onWritable((offset) => {
      got = offset
    })

    raw.emit('drain')

    strictEqual(got, 3)
  })

  test('onData delivers request chunks then a final empty chunk on end', () => {
    const { res, req } = make()
    const chunks = []
    let lastFlag = null

    res.onData((chunk, isLast) => {
      chunks.push(Buffer.from(chunk).toString())
      lastFlag = isLast
    })

    req.emit('data', Buffer.from('foo'))
    req.emit('data', Buffer.from('bar'))
    req.emit('end')

    deepStrictEqual(chunks, ['foo', 'bar', ''])
    strictEqual(lastFlag, true)
  })

  test('onAborted fires once for an aborted response, never after normal completion', () => {
    const aborted = make()
    let abortCount = 0

    aborted.res.onAborted(() => {
      abortCount++
    })
    // connection closed before the response finished
    aborted.raw.emit('close')
    aborted.raw.emit('close')
    strictEqual(abortCount, 1)

    const normal = make()
    let normalAbort = 0

    normal.res.onAborted(() => {
      normalAbort++
    })
    normal.res.writeStatus('200 OK')
    normal.res.end('done')
    normal.raw.emit('close')
    strictEqual(normalAbort, 0)
  })

  test('drains an unread request body on end so keep-alive sockets stay reusable', () => {
    const { res, req } = make()

    res.writeStatus('200 OK')
    res.end('ok')

    strictEqual(req.resumed, true)
  })

  test('does not resume the request when the body was consumed via onData', () => {
    const { res, req } = make()

    res.onData(() => {})
    res.writeStatus('200 OK')
    res.end('ok')

    strictEqual(req.resumed, false)
  })

  test('exposes the remote address as text and omits the proxied variant', () => {
    const { res } = make()

    strictEqual(typeof res.getProxiedRemoteAddressAsText, 'undefined')
    strictEqual(Buffer.from(res.getRemoteAddressAsText()).toString('utf8'), '1.2.3.4')
  })

  test('end is idempotent and ignores writes after finishing', () => {
    const { res, raw } = make()

    res.writeStatus('200 OK')
    res.end('first')
    res.end('second')

    strictEqual(raw.writes.length, 1)
    strictEqual(raw.writes[0].toString(), 'first')
  })
})
