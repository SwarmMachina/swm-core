export default class BodyBudget {
  #limitBytes
  #usedBytes = 0

  constructor(limitBytes) {
    this.#limitBytes = limitBytes
  }

  get limitBytes() {
    return this.#limitBytes
  }

  get usedBytes() {
    return this.#usedBytes
  }

  reserve(bytes) {
    if (bytes <= 0) {
      return true
    }

    if (this.#usedBytes + bytes > this.#limitBytes) {
      return false
    }

    this.#usedBytes += bytes

    return true
  }

  release(bytes) {
    if (bytes <= 0) {
      return
    }

    this.#usedBytes -= bytes

    if (this.#usedBytes < 0) {
      this.#usedBytes = 0
    }
  }
}
