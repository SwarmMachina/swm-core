import { describe, test } from 'node:test'
import { strictEqual, throws } from 'node:assert/strict'
import BodyBudget from '../../src/body-budget.js'

describe('BodyBudget', () => {
  test('reserves, resizes, and releases aggregate retained capacity', () => {
    const budget = new BodyBudget(10)
    const ownerA = {}
    const ownerB = {}

    strictEqual(budget.tryReserve(6, ownerA), true)

    strictEqual(budget.usedBytes, 6)
    strictEqual(budget.activeReservations, 1)
    strictEqual(budget.tryReserve(5, ownerB), false)
    strictEqual(budget.resize(4, ownerA), true)
    strictEqual(budget.usedBytes, 4)

    strictEqual(budget.tryReserve(5, ownerB), true)

    strictEqual(budget.usedBytes, 9)
    strictEqual(budget.resize(6, ownerA), false)
    strictEqual(budget.usedBytes, 9)

    budget.release(ownerA)
    budget.release(ownerB)

    strictEqual(budget.usedBytes, 0)
    strictEqual(budget.activeReservations, 0)
    strictEqual(budget.limitBytes, 10)
  })

  test('asserts duplicate reservation and release', () => {
    const budget = new BodyBudget(10)
    const owner = {}

    strictEqual(budget.tryReserve(3, owner), true)
    throws(() => budget.tryReserve(2, owner), /already has an active reservation/)
    throws(() => budget.resize(2, {}), /not active/)
    throws(() => budget.release({}), /not active/)

    budget.release(owner)

    throws(() => budget.release(owner), /not active/)
    strictEqual(budget.usedBytes, 0)
  })

  test('tracks zero-byte reservations without treating zero as unlimited', () => {
    const budget = new BodyBudget(0)
    const owner = {}

    strictEqual(budget.tryReserve(0, owner), true)

    strictEqual(budget.tryReserve(1, {}), false)
    strictEqual(budget.usedBytes, 0)
    strictEqual(budget.activeReservations, 1)

    budget.release(owner)
    strictEqual(budget.activeReservations, 0)
  })

  test('rejects invalid limits and reservation sizes without coercion', () => {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}, new Number(1)]) {
      throws(() => new BodyBudget(value), TypeError)
    }

    const budget = new BodyBudget(10)

    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}]) {
      throws(() => budget.tryReserve(value, {}), TypeError)
    }
  })
})
