import { strict as assert } from 'node:assert'
import test from 'node:test'

import { getRemoteAddress } from '../../src/remote-address.js'

/**
 * @param {Iterable<number>} bytes
 * @returns {ArrayBuffer}
 */
function buffer(bytes: Iterable<number>): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

test('falls back from native ArrayBuffer(0) proxied address to the TCP peer', () => {
  const res = {
    getProxiedRemoteAddress: () => new ArrayBuffer(0),
    getRemoteAddress: () => buffer([127, 0, 0, 1])
  }

  assert.equal(getRemoteAddress(res), '127.0.0.1')
})

test('prefers the PROXY Protocol v2 source address', () => {
  const res = {
    getProxiedRemoteAddress: () => buffer([203, 0, 113, 10]),
    getRemoteAddress: () => buffer([127, 0, 0, 1])
  }

  assert.equal(getRemoteAddress(res), '203.0.113.10')
})

test('normalizes a binary IPv4-mapped IPv6 address', () => {
  const res = {
    getProxiedRemoteAddress: () => new ArrayBuffer(0),
    getRemoteAddress: () => buffer([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1])
  }

  assert.equal(getRemoteAddress(res), '127.0.0.1')
})

test('uses the text method for a genuine IPv6 address', () => {
  const res = {
    getProxiedRemoteAddress: () => new ArrayBuffer(0),
    getRemoteAddress: () => buffer([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    getRemoteAddressAsText: () => buffer(Buffer.from('2001:db8::1'))
  }

  assert.equal(getRemoteAddress(res), '2001:db8::1')
})

test('supports text-only backends and treats empty text buffers as absent', () => {
  const res = {
    getProxiedRemoteAddressAsText: () => new ArrayBuffer(0),
    getRemoteAddressAsText: () => buffer(Buffer.from('::ffff:127.0.0.1'))
  }

  assert.equal(getRemoteAddress(res), '127.0.0.1')
  assert.equal(getRemoteAddress(null), '')
})
