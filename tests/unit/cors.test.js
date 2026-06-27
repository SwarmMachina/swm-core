import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import cors from '../../src/cors.js'

test('cors: throws when credentials are combined with wildcard origin', () => {
  assert.throws(() => cors({ credentials: true }), TypeError)
  assert.throws(() => cors({ credentials: true, origin: '*' }), TypeError)
})

test('cors: allows credentials with an explicit origin', () => {
  assert.doesNotThrow(() => cors({ credentials: true, origin: 'https://app.example' }))
})

test('cors: builds without credentials on the default wildcard origin', () => {
  assert.equal(typeof cors(), 'function')
})
