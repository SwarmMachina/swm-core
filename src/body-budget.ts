/**
 * @param {unknown} bytes
 * @param {string} name
 */
function assertBytes(bytes: unknown, name: string): asserts bytes is number {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer byte count`)
  }
}

type BudgetOwner = object | ((...args: never[]) => unknown)

export default class BodyBudget {
  #limitBytes: number
  #usedBytes = 0
  #reservations = new Map<BudgetOwner, number>()

  constructor(limitBytes: number) {
    assertBytes(limitBytes, 'BodyBudget limit')
    this.#limitBytes = limitBytes
  }

  get limitBytes() {
    return this.#limitBytes
  }

  get usedBytes() {
    return this.#usedBytes
  }

  get activeReservations() {
    return this.#reservations.size
  }

  /**
   * Reserve retained/in-flight body storage for one request collector.
   * @param {number} bytes
   * @param {object} owner
   * @returns {boolean}
   */
  tryReserve(bytes: number, owner: BudgetOwner): boolean {
    assertBytes(bytes, 'BodyBudget reservation')
    this.#assertOwner(owner)

    if (this.#reservations.has(owner)) {
      throw new Error('BodyBudget owner already has an active reservation')
    }

    if (bytes > this.#limitBytes - this.#usedBytes) {
      return false
    }

    this.#reservations.set(owner, bytes)
    this.#usedBytes += bytes
    this.#assertInvariant()

    return true
  }

  /**
   * Atomically resize a live reservation. Failure leaves it unchanged.
   * @param {number} newBytes
   * @param {object} owner
   * @returns {boolean}
   */
  resize(newBytes: number, owner: BudgetOwner): boolean {
    assertBytes(newBytes, 'BodyBudget reservation')
    const currentBytes = this.#getReservation(owner)
    const delta = newBytes - currentBytes

    if (delta > this.#limitBytes - this.#usedBytes) {
      return false
    }

    this.#reservations.set(owner, newBytes)
    this.#usedBytes += delta
    this.#assertInvariant()

    return true
  }

  /**
   * @param {object} owner
   */
  release(owner: BudgetOwner): void {
    const bytes = this.#getReservation(owner)

    this.#reservations.delete(owner)
    this.#usedBytes -= bytes
    this.#assertInvariant()
  }

  #assertOwner(owner: unknown): asserts owner is BudgetOwner {
    if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) {
      throw new TypeError('BodyBudget owner must be an object')
    }
  }

  #getReservation(owner: BudgetOwner): number {
    this.#assertOwner(owner)

    const bytes = this.#reservations.get(owner)

    if (bytes === undefined) {
      throw new Error('BodyBudget reservation is not active')
    }

    return bytes
  }

  #assertInvariant(): void {
    if (!Number.isSafeInteger(this.#usedBytes) || this.#usedBytes < 0 || this.#usedBytes > this.#limitBytes) {
      throw new Error('BodyBudget accounting invariant violated')
    }
  }
}
