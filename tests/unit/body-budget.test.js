import { describe, test } from 'node:test'
import { strictEqual } from 'node:assert/strict'
import BodyBudget from '../../src/body-budget.js'

describe('BodyBudget', () => {
  test('reserves and releases aggregate capacity', () => {
    const budget = new BodyBudget(10)

    strictEqual(budget.reserve(6), true)
    strictEqual(budget.usedBytes, 6)
    strictEqual(budget.reserve(5), false)
    strictEqual(budget.usedBytes, 6)

    budget.release(4)

    strictEqual(budget.usedBytes, 2)
    strictEqual(budget.reserve(5), true)
    strictEqual(budget.usedBytes, 7)
    strictEqual(budget.limitBytes, 10)
  })

  test('does not underflow on defensive duplicate release', () => {
    const budget = new BodyBudget(10)

    budget.reserve(3)
    budget.release(8)

    strictEqual(budget.usedBytes, 0)
  })

  test('treats zero-byte operations as no-ops', () => {
    const budget = new BodyBudget(10)

    strictEqual(budget.reserve(0), true)
    budget.release(0)

    strictEqual(budget.usedBytes, 0)
  })
})
