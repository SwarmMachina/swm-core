import { throws } from 'node:assert/strict'
import test from 'node:test'
import {
  assertNonEmpty,
  assertNonNegativeFinite,
  assertPositiveFinite,
  assertPositiveSafeInteger
} from '../../benchmark/harness/args.js'

test('benchmark argument guards accept valid values', () => {
  assertNonEmpty(['core'], '--fw')
  assertNonNegativeFinite(0, '--warmup')
  assertPositiveFinite(0.5, '--duration')
  assertPositiveSafeInteger(1, '--runs')
})

test('benchmark argument guards reject empty and non-measurable values', () => {
  throws(() => assertNonEmpty([], '--fw'), { message: '--fw must not be empty' })
  throws(() => assertNonNegativeFinite(-1, '--warmup'), { message: '--warmup must be a non-negative finite number' })
  throws(() => assertPositiveFinite(0, '--duration'), { message: '--duration must be a positive finite number' })
  throws(() => assertPositiveSafeInteger(0, '--runs'), { message: '--runs must be a positive safe integer' })
})
