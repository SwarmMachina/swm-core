import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import serveStatic from '../../src/serve-static.js'

let rootDir = ''

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
function fakeCtx(url, method = 'get') {
  const captured = { status: 200, headers: {}, body: undefined, replied: false }

  return {
    captured,
    method: () => method,
    url: () => url,
    status(code) {
      captured.status = code
      return this
    },
    setHeader(key, value) {
      captured.headers[key] = value
      return this
    },
    send(body) {
      captured.body = body
      captured.replied = true
    },
    reply(status, headers, body) {
      captured.status = status
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
  assert.strictEqual(ctx.captured.body.toString(), 'console.log(1)')
})

test('serveStatic: directory path resolves to index file', async () => {
  const handler = serveStatic(rootDir)
  const ctx = fakeCtx('/')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 200)
  assert.strictEqual(ctx.captured.headers['content-type'], 'text/html; charset=utf-8')
  assert.strictEqual(ctx.captured.body.toString(), '<h1>home</h1>')
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
  assert.strictEqual(ctx.captured.body.toString(), '<h1>home</h1>')
})

test('serveStatic: path traversal is rejected with 403', async () => {
  const handler = serveStatic(join(rootDir, 'assets'))
  const ctx = fakeCtx('/%2e%2e/secret.txt')

  await handler(ctx)

  assert.strictEqual(ctx.captured.status, 403)
  assert.strictEqual(ctx.captured.body, 'Forbidden')
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
  assert.strictEqual(ctx.captured.body.toString(), 'A1')

  ctx = fakeCtx('/b.txt')
  await handler(ctx)

  writeFileSync(join(dir, 'a.txt'), 'A2')
  ctx = fakeCtx('/a.txt')
  await handler(ctx)
  assert.strictEqual(ctx.captured.body.toString(), 'A2')

  rmSync(dir, { recursive: true, force: true })
})
