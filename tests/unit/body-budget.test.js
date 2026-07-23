import { describe, test } from 'node:test'
import { strictEqual, throws } from 'node:assert/strict'
import BodyBudget from '../../src/body-budget.js'

describe('BodyBudget', () => {
  test('reserves, resizes, and releases aggregate retained capacity', () => {
    const budget = new BodyBudget(10)
    const ownerA = {}
    const ownerB = {}
    const a = budget.tryReserve(6, ownerA)

    strictEqual(a.bytes, 6)
    strictEqual(budget.usedBytes, 6)
    strictEqual(budget.activeReservations, 1)
    strictEqual(budget.tryReserve(5, ownerB), null)
    strictEqual(budget.resize(a, 4, ownerA), true)
    strictEqual(budget.usedBytes, 4)

    const b = budget.tryReserve(5, ownerB)

    strictEqual(b.bytes, 5)
    strictEqual(budget.usedBytes, 9)
    strictEqual(budget.resize(a, 6, ownerA), false)
    strictEqual(a.bytes, 4)
    strictEqual(budget.usedBytes, 9)

    budget.release(a, ownerA)
    budget.release(b, ownerB)

    strictEqual(budget.usedBytes, 0)
    strictEqual(budget.activeReservations, 0)
    strictEqual(budget.limitBytes, 10)
  })

  test('asserts duplicate release and wrong-generation ownership', () => {
    const budget = new BodyBudget(10)
    const owner = {}
    const reservation = budget.tryReserve(3, owner)

    throws(() => budget.resize(reservation, 2, {}), /owner mismatch/)
    throws(() => budget.release(reservation, {}), /owner mismatch/)

    budget.release(reservation, owner)

    throws(() => budget.release(reservation, owner), /not active/)
    strictEqual(budget.usedBytes, 0)
  })

  test('tracks zero-byte reservations without treating zero as unlimited', () => {
    const budget = new BodyBudget(0)
    const owner = {}
    const reservation = budget.tryReserve(0, owner)

    strictEqual(reservation.bytes, 0)
    strictEqual(budget.tryReserve(1, {}), null)
    strictEqual(budget.usedBytes, 0)
    strictEqual(budget.activeReservations, 1)

    budget.release(reservation, owner)
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
