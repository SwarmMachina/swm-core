import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import serveStatic from '../../src/static/serve-static.js'

import type { FileHandle } from 'node:fs/promises'

let rootDir = ''

interface CapturedResponse {
  status: number
  headers: Record<string, string>
  responseHeaders: Record<string, string> | null
  body: string | Buffer | undefined
  replied: boolean
}

interface FakeContext {
  captured: CapturedResponse
  getMethod(): string
  getUrl(): string
  setStatus(code: number): this
  setHeader(key: string, value: string): this
  send(body: string | Buffer): void
  reply(status: number, headers: Record<string, string>, body: string | Buffer): void
}

function bodyText(body: string | Buffer | undefined): string {
  if (body === undefined) {
    throw new Error('Expected a response body')
  }

  return body.toString()
}

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'swm-static-'))
  writeFileSync(join(rootDir, 'index.html'), '<h1>home</h1>')
  mkdirSync(join(rootDir, 'assets'))
  writeFileSync(join(rootDir, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(rootDir, 'secret.txt'), 'top secret')
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/**
 * @param {string} url
 * @param {string} [method]
 * @returns {object}
 */
function fakeCtx(url: string, method = 'get'): FakeContext {
  const captured: CapturedResponse = {
    status: 200,
    headers: {},
    responseHeaders: null,
    body: undefined,
    replied: false
  }

  return {
    captured,
    getMethod: () => method,
    getUrl: () => url,
    setStatus(code: number) {
      captured.status = code

      return this
    },
    setHeader(key: string, value: string) {
      captured.headers[key] = value

      return this
    },
    send(body: string | Buffer) {
      captured.body = body
      captured.replied = true
    },
    reply(status: number, headers: Record<string, string>, body: string | Buffer) {
      captured.status = status
      captured.responseHeaders = headers
      Object.assign(captured.headers, headers)
      captured.body = body
      captured.replied = true
    }
  }
}

test('serveStatic: serves an asset with correct mime', async () => {
  const handler = serveStatic(rootDir)
  const ctx = fakeCtx('/assets/app.js')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 200)
  assert.strictEqual(ctx.captured.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.strictEqual(bodyText(ctx.captured.body), 'console.log(1)')
})

test('serveStatic: directory path resolves to index file', async () => {
  const handler = serveStatic(rootDir)
  const ctx = fakeCtx('/')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 200)
  assert.strictEqual(ctx.captured.headers['content-type'], 'text/html; charset=utf-8')
  assert.strictEqual(bodyText(ctx.captured.body), '<h1>home</h1>')
})

test('serveStatic: unknown path returns 404 without spa', async () => {
  const handler = serveStatic(rootDir)
  const ctx = fakeCtx('/missing.js')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 404)
})

test('serveStatic: spa option falls back to index.html', async () => {
  const handler = serveStatic(rootDir, { spa: true })
  const ctx = fakeCtx('/some/client/route')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 200)
  assert.strictEqual(bodyText(ctx.captured.body), '<h1>home</h1>')
})

test('serveStatic: path traversal is rejected with 403', async () => {
  const handler = serveStatic(join(rootDir, 'assets'))
  const ctx = fakeCtx('/%2e%2e/secret.txt')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 403)
  assert.strictEqual(ctx.captured.body, 'Forbidden')
})

test('serveStatic: symlink escapes outside the canonical root are rejected', async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), 'swm-static-outside-'))
  const outsideFile = join(outsideDir, 'secret.txt')

  writeFileSync(outsideFile, 'not public')
  symlinkSync(outsideFile, join(rootDir, 'leak.txt'))

  try {
    const handler = serveStatic(rootDir)
    const ctx = fakeCtx('/leak.txt')

    await handler(ctx)

    assert.strictEqual(ctx.captured.status, 403)
    assert.strictEqual(ctx.captured.body, 'Forbidden')
  } finally {
    rmSync(join(rootDir, 'leak.txt'), { force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('serveStatic: symlinks whose real path stays inside the root remain supported', async () => {
  const link = join(rootDir, 'app-link.js')

  symlinkSync(join(rootDir, 'assets', 'app.js'), link)

  try {
    const handler = serveStatic(rootDir)
    const ctx = fakeCtx('/app-link.js')

    await handler(ctx)

    assert.strictEqual(ctx.captured.status, 200)
    assert.strictEqual(bodyText(ctx.captured.body), 'console.log(1)')
  } finally {
    rmSync(link, { force: true })
  }
})

test('serveStatic: non-GET/HEAD method returns 405', async () => {
  const handler = serveStatic(rootDir)
  const ctx = fakeCtx('/index.html', 'post')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 405)
})

test('serveStatic: maxAge sets Cache-Control', async () => {
  const handler = serveStatic(rootDir, { maxAge: 3600 })
  const ctx = fakeCtx('/index.html')

  await handler(ctx)

  assert.strictEqual(ctx.captured.headers['cache-control'], 'public, max-age=3600')
})

test('serveStatic: HEAD is served like GET (uWS strips the body natively)', async () => {
  const handler = serveStatic(rootDir)
  const ctx = fakeCtx('/assets/app.js', 'head')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 200)
  assert.strictEqual(ctx.captured.headers['content-type'], 'text/javascript; charset=utf-8')
})

test('serveStatic: bounded cache evicts oldest and re-reads from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-cache-'))

  writeFileSync(join(dir, 'a.txt'), 'A1')
  writeFileSync(join(dir, 'b.txt'), 'B1')
  const handler = serveStatic(dir, { cacheLimit: 1 })

  let ctx = fakeCtx('/a.txt')

  await handler(ctx)
  assert.strictEqual(bodyText(ctx.captured.body), 'A1')

  ctx = fakeCtx('/b.txt')
  await handler(ctx)

  writeFileSync(join(dir, 'a.txt'), 'A2')
  ctx = fakeCtx('/a.txt')
  await handler(ctx)
  assert.strictEqual(bodyText(ctx.captured.body), 'A2')

  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: byte-bounded cache uses LRU eviction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-byte-cache-'))

  writeFileSync(join(dir, 'a.txt'), 'AA')
  writeFileSync(join(dir, 'b.txt'), 'BB')
  writeFileSync(join(dir, 'c.txt'), 'CC')
  const handler = serveStatic(dir, { cacheLimit: 3, cacheByteLimit: 4 })

  for (const path of ['/a.txt', '/b.txt', '/a.txt', '/c.txt']) {
    await handler(fakeCtx(path))
  }

  writeFileSync(join(dir, 'b.txt'), 'B2')
  const ctx = fakeCtx('/b.txt')

  await handler(ctx)
  assert.strictEqual(bodyText(ctx.captured.body), 'B2')

  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: rejects files above maxFileSize before reading them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-max-file-'))

  writeFileSync(join(dir, 'large.txt'), '12345')
  const handler = serveStatic(dir, { maxFileSize: 4 })
  const ctx = fakeCtx('/large.txt')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 404)
  assert.strictEqual(ctx.captured.body, 'Not Found')
  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: deduplicates simultaneous uncached reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-dedupe-'))

  writeFileSync(join(dir, 'asset.txt'), 'shared')
  const handler = serveStatic(dir, { cache: false, maxInflightFiles: 1 })
  const first = fakeCtx('/asset.txt')
  const second = fakeCtx('/asset.txt')

  await Promise.all([handler(first), handler(second)])

  assert.strictEqual(first.captured.body, second.captured.body)
  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: maxInflightFiles rejects excess distinct filesystem loads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-inflight-files-'))

  writeFileSync(join(dir, 'a.txt'), 'A')
  writeFileSync(join(dir, 'b.txt'), 'B')
  const handler = serveStatic(dir, {
    cache: false,
    maxFileSize: 1,
    maxInflightBytes: 2,
    maxInflightFiles: 1
  })
  const first = fakeCtx('/a.txt')
  const excess = fakeCtx('/b.txt')

  await Promise.all([handler(first), handler(excess)])

  assert.strictEqual(first.captured.status, 200)
  assert.strictEqual(excess.captured.status, 503)
  assert.strictEqual(excess.captured.headers['retry-after'], '1')
  assert.strictEqual(excess.captured.body, 'Service Unavailable')
  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: maxInflightBytes bounds distinct concurrent reads', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-inflight-bytes-'))

  writeFileSync(join(dir, 'a.txt'), 'AA')
  writeFileSync(join(dir, 'b.txt'), 'BB')
  const handler = serveStatic(dir, {
    cache: false,
    maxFileSize: 2,
    maxInflightBytes: 2,
    maxInflightFiles: 2
  })
  const first = fakeCtx('/a.txt')
  const second = fakeCtx('/b.txt')
  const probe = await open(join(dir, 'a.txt'), 'r')
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    read(
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ): Promise<{ bytesRead: number; buffer: Buffer }>
  }
  const originalRead = fileHandlePrototype.read

  await probe.close()

  let markReadStarted!: () => void
  let releaseRead!: () => void

  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve
  })
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })

  let blockFirstRead = true

  t.mock.method(
    fileHandlePrototype,
    'read',
    async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
      if (blockFirstRead) {
        blockFirstRead = false
        markReadStarted()
        await readGate
      }

      return originalRead.call(this, buffer, offset, length, position)
    }
  )

  const firstLoad = handler(first)

  await readStarted
  await handler(second)
  releaseRead()
  await firstLoad

  assert.strictEqual(first.captured.status, 200)
  assert.strictEqual(second.captured.status, 503)
  assert.strictEqual(second.captured.headers['retry-after'], '1')
  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: cache hits reuse the response header block', async () => {
  const handler = serveStatic(rootDir)
  const first = fakeCtx('/assets/app.js')
  const second = fakeCtx('/assets/app.js')

  await handler(first)
  await handler(second)

  assert.strictEqual(first.captured.responseHeaders, second.captured.responseHeaders)
})

test('serveStatic: cacheLimit zero disables caching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swm-static-no-cache-'))

  writeFileSync(join(dir, 'asset.txt'), 'v1')
  const handler = serveStatic(dir, { cacheLimit: 0 })

  let ctx = fakeCtx('/asset.txt')

  await handler(ctx)
  assert.strictEqual(bodyText(ctx.captured.body), 'v1')

  writeFileSync(join(dir, 'asset.txt'), 'v2')
  ctx = fakeCtx('/asset.txt')
  await handler(ctx)
  assert.strictEqual(bodyText(ctx.captured.body), 'v2')

  rmSync(dir, { recursive: true, force: true })
})

test('serveStatic: rejects an invalid cache limit at initialization', () => {
  for (const cacheLimit of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => serveStatic(rootDir, { cacheLimit }), /cacheLimit must be a non-negative safe integer/)
  }
})

test('serveStatic: rejects invalid resource limits at initialization', () => {
  for (const option of ['cacheByteLimit', 'maxFileSize', 'maxInflightBytes', 'maxInflightFiles'] as const) {
    for (const value of [-1, 1.5, NaN, Infinity]) {
      assert.throws(
        () => serveStatic(rootDir, { [option]: value }),
        new RegExp(`${option} must be a non-negative safe integer`)
      )
    }
  }

  assert.throws(
    () => serveStatic(rootDir, { maxFileSize: 2, maxInflightBytes: 1 }),
    /maxInflightBytes must be greater than or equal to maxFileSize/
  )
})
