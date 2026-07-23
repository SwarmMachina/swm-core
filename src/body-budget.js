/**
 * @param {unknown} bytes
 * @param {string} name
 */
function assertBytes(bytes, name) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer byte count`)
  }
}

export default class BodyBudget {
  #limitBytes
  #usedBytes = 0
  #reservations = new Set()

  constructor(limitBytes) {
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
   * Reserve retained/in-flight body storage for one request-generation owner.
   * @param {number} bytes
   * @param {object} owner
   * @returns {{bytes: number, owner: object, active: boolean}|null}
   */
  tryReserve(bytes, owner) {
    assertBytes(bytes, 'BodyBudget reservation')

    if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) {
      throw new TypeError('BodyBudget owner must be an object')
    }

    if (bytes > this.#limitBytes - this.#usedBytes) {
      return null
    }

    const reservation = { bytes, owner, active: true }

    this.#reservations.add(reservation)
    this.#usedBytes += bytes
    this.#assertInvariant()

    return reservation
  }

  /**
   * Atomically resize a live reservation. Failure leaves it unchanged.
   * @param {{bytes: number, owner: object, active: boolean}} reservation
   * @param {number} newBytes
   * @param {object} owner
   * @returns {boolean}
   */
  resize(reservation, newBytes, owner) {
    this.#assertOwned(reservation, owner)
    assertBytes(newBytes, 'BodyBudget reservation')

    const delta = newBytes - reservation.bytes

    if (delta > this.#limitBytes - this.#usedBytes) {
      return false
    }

    reservation.bytes = newBytes
    this.#usedBytes += delta
    this.#assertInvariant()

    return true
  }

  /**
   * @param {{bytes: number, owner: object, active: boolean}} reservation
   * @param {object} owner
   */
  release(reservation, owner) {
    this.#assertOwned(reservation, owner)

    this.#reservations.delete(reservation)
    reservation.active = false
    this.#usedBytes -= reservation.bytes
    this.#assertInvariant()
  }

  #assertOwned(reservation, owner) {
    if (!reservation || reservation.active !== true || !this.#reservations.has(reservation)) {
      throw new Error('BodyBudget reservation is not active')
    }

    if (reservation.owner !== owner) {
      throw new Error('BodyBudget reservation owner mismatch')
    }
  }

  #assertInvariant() {
    if (!Number.isSafeInteger(this.#usedBytes) || this.#usedBytes < 0 || this.#usedBytes > this.#limitBytes) {
      throw new Error('BodyBudget accounting invariant violated')
    }
  }
}
