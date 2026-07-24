import assert from 'node:assert/strict'
import test from 'node:test'
import { getFreePort } from '@swarmmachina/benchkit'

import Server from '../../../src/index.js'
import { createMockRes } from '../../helpers/mock-http.js'

test('HTTP remote-address mocks match the native base contract', async () => {
  const port = await getFreePort()
  const server = new Server({
    port,
    http: {
      onRequest(ctx) {
        const native = ctx.res
        const mock = createMockRes()
        const remote = native.getRemoteAddress()
        const remoteText = native.getRemoteAddressAsText()

        mock.setRemoteAddress(new Uint8Array(remote), Buffer.from(remoteText).toString())

        for (const method of [
          'getProxiedRemoteAddress',
          'getProxiedRemoteAddressAsText',
          'getRemoteAddress',
          'getRemoteAddressAsText'
        ]) {
          const actual = native[method]()
          const emulated = mock[method]()

          assert.ok(actual instanceof ArrayBuffer, `native ${method}`)
          assert.ok(emulated instanceof ArrayBuffer, `mock ${method}`)
          assert.equal(emulated.byteLength, actual.byteLength, method)
        }

        return 'ok'
      }
    }
  })

  await server.listen()
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5_000) })

    assert.equal(await response.text(), 'ok')
  } finally {
    await server.shutdown(1000)
  }
})
