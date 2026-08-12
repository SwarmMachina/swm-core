import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import serveStatic from '../../../src/static/serve-static.js'
import { startHttpServer } from '../../helpers/e2e-server.js'
import type { HttpServerHandle } from '../../helpers/e2e-server.js'
import { reqText } from '../../helpers/http-client.js'

test('serveStatic confines real paths and enforces the file-size limit over HTTP', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'swm-static-e2e-'))
  const publicDir = join(fixtureDir, 'public')

  mkdirSync(publicDir)
  writeFileSync(join(publicDir, 'asset.txt'), 'safe')
  writeFileSync(join(publicDir, 'large.txt'), '12345')
  writeFileSync(join(fixtureDir, 'secret.txt'), 'not public')
  symlinkSync('../secret.txt', join(publicDir, 'leak.txt'))

  let server: HttpServerHandle | null = null

  try {
    server = await startHttpServer({
      onRequest: serveStatic(publicDir, { maxFileSize: 4 })
    })

    const asset = await reqText(`${server.baseUrl}/asset.txt`)
    const leaked = await reqText(`${server.baseUrl}/leak.txt`)
    const oversized = await reqText(`${server.baseUrl}/large.txt`)

    assert.deepEqual([asset.status, asset.text], [200, 'safe'])
    assert.deepEqual([leaked.status, leaked.text], [403, 'Forbidden'])
    assert.deepEqual([oversized.status, oversized.text], [404, 'Not Found'])
  } finally {
    await server?.close()
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})

test('serveStatic exposes filesystem admission pressure as 503 over HTTP', async () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'swm-static-busy-e2e-'))

  writeFileSync(join(publicDir, 'asset.txt'), 'safe')
  let server: HttpServerHandle | null = null

  try {
    server = await startHttpServer({
      onRequest: serveStatic(publicDir, { maxInflightFiles: 0 })
    })

    const response = await reqText(`${server.baseUrl}/asset.txt`)

    assert.deepEqual([response.status, response.text], [503, 'Service Unavailable'])
    assert.strictEqual(response.headers.get('retry-after'), '1')
  } finally {
    await server?.close()
    rmSync(publicDir, { recursive: true, force: true })
  }
})
