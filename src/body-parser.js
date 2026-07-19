import { CACHED_ERRORS } from './constants.js'

const NOOP = () => {}

export default class BodyParser {
  /** @type {Buffer} */
  #body = null
  /** @type {Error} */
  #bodyError = null
  /** @type {Promise} */
  #bodyPromise = null
  /** @type {(value: Buffer) => void} */
  #bodyResolve = null
  /** @type {(reason: Error) => void} */
  #bodyReject = null
  /** @type {boolean} */
  #done = false
  /** @type {boolean} */
  #started = false
  /** @type {number} */
  #collectionLimit = 0
  /** @type {number} */
  #generation = 0
  /** @type {number} */
  #reservedBytes = 0
  /** @type {import('./body-budget.js').default|null} */
  #budget = null

  /** @type {HttpContext} */
  #ctx = null

  /** @type {number} */
  #maxSize = 1024 * 1024 * 16

  // --- state for known-length mode ---
  /** @type {Buffer|null} */
  #dst = null
  #offset = 0
  #expected = 0

  // --- state for unknown-length (grow buffer) ---
  /** @type {Buffer|null} */
  #grow = null
  #len = 0
  #cap = 0
  #limit = 0

  #onDataKnown(ab, isLast) {
    if (this.#done) {
      return
    }

    if (!this.#ctx || this.#ctx.aborted) {
      return this.#reject(CACHED_ERRORS.aborted)
    }

    const u8 = new Uint8Array(ab)
    const next = this.#offset + u8.byteLength

    if (next > this.#expected) {
      return this.#reject(CACHED_ERRORS.sizeMismatch)
    }

    this.#dst.set(u8, this.#offset)
    this.#offset = next

    if (isLast && this.#offset !== this.#expected) {
      return this.#reject(CACHED_ERRORS.sizeMismatch)
    }

    if (this.#offset === this.#expected) {
      return this.#resolve(this.#dst)
    }
  }

  #onDataUnknown(ab, isLast) {
    if (this.#done) {
      return
    }

    if (!this.#ctx || this.#ctx.aborted) {
      return this.#reject(CACHED_ERRORS.aborted)
    }

    const u8 = new Uint8Array(ab)
    const chunkLen = u8.byteLength

    if (chunkLen === 0 && isLast && this.#len === 0) {
      return this.#resolve(Buffer.alloc(0))
    }

    const nextLen = this.#len + chunkLen

    if (nextLen > this.#limit) {
      return this.#reject(CACHED_ERRORS.bodyTooLarge)
    }

    if (nextLen > this.#cap) {
      let cap = this.#cap || 4096

      while (cap < nextLen) {
        cap <<= 1
      }

      if (cap > this.#limit) {
        cap = this.#limit
      }

      const b = Buffer.allocUnsafe(cap)

      if (this.#len > 0) {
        this.#grow.copy(b, 0, 0, this.#len)
      }

      this.#grow = b
      this.#cap = cap
    }

    this.#grow.set(u8, this.#len)
    this.#len = nextLen

    if (!isLast) {
      return
    }

    const view = this.#grow.subarray(0, this.#len)
    const out = this.#cap > this.#len << 1 ? Buffer.from(view) : view

    return this.#resolve(out)
  }

  /**
   * @param {Buffer} dst
   */
  #resolve(dst) {
    if (this.#done) {
      return
    }

    this.#done = true
    this.#body = dst

    if (this.#bodyPromise) {
      const resolve = this.#bodyResolve

      this.#bodyPromise = null
      this.#bodyReject = null
      this.#bodyResolve = null

      resolve(dst)
    }
  }

  /**
   * @param {Error} error
   */
  #reject(error) {
    if (this.#done) {
      return
    }

    this.#done = true
    this.#bodyError = error
    this.#discardStorage()
    this.#releaseReservation()

    if (this.#bodyPromise) {
      const reject = this.#bodyReject

      this.#bodyPromise = null
      this.#bodyReject = null
      this.#bodyResolve = null

      reject(error)
    }
  }

  #discardStorage() {
    this.#body = null
    this.#dst = null
    this.#offset = 0
    this.#expected = 0
    this.#grow = null
    this.#len = 0
    this.#cap = 0
    this.#limit = 0
  }

  #reserve(bytes) {
    const budget = this.#ctx?.server?.httpBodyBudget

    if (!budget || bytes <= 0) {
      return true
    }

    if (!budget.reserve(bytes)) {
      return false
    }

    this.#budget = budget
    this.#reservedBytes = bytes

    return true
  }

  #releaseReservation() {
    if (this.#reservedBytes === 0) {
      return
    }

    this.#budget?.release(this.#reservedBytes)
    this.#budget = null
    this.#reservedBytes = 0
  }

  #cancel(error) {
    if (this.#bodyError === error && this.#done) {
      return
    }

    const reject = this.#bodyPromise && !this.#done ? this.#bodyReject : null

    this.#generation++
    this.#done = true
    this.#started = true
    this.#bodyError = error
    this.#bodyPromise = null
    this.#bodyReject = null
    this.#bodyResolve = null
    this.#discardStorage()
    this.#releaseReservation()

    reject?.(error)
  }

  /**
   * @param {HttpContext} ctx
   * @param {number} [maxSize]
   */
  reset(ctx, maxSize) {
    this.#releaseReservation()
    this.#generation++
    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#bodyResolve = null
    this.#bodyReject = null
    this.#done = false
    this.#started = false
    this.#collectionLimit = 0
    this.#reservedBytes = 0
    this.#budget = null

    this.#maxSize = maxSize || this.#maxSize

    this.#dst = null
    this.#offset = 0
    this.#expected = 0

    this.#grow = null
    this.#len = 0
    this.#cap = 0
    this.#limit = 0

    this.#ctx = ctx
  }

  clear() {
    if (this.#bodyPromise !== null && !this.#done) {
      this.#reject(CACHED_ERRORS.aborted)
    }

    this.#generation++
    this.#releaseReservation()
    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#bodyResolve = null
    this.#bodyReject = null
    this.#done = false
    this.#started = false
    this.#collectionLimit = 0
    this.#reservedBytes = 0
    this.#budget = null

    this.#dst = null
    this.#offset = 0
    this.#expected = 0

    this.#grow = null
    this.#len = 0
    this.#cap = 0
    this.#limit = 0

    this.#ctx = null
  }

  prefetch() {
    if (this.#started || this.#done || this.#body !== null || this.#bodyError !== null) {
      return this.#bodyError
    }

    if (!this.#ctx) {
      this.#bodyError = CACHED_ERRORS.serverError

      return this.#bodyError
    }

    this.#start(this.#maxSize)

    return this.#bodyError
  }

  /**
   * @param {number} limit
   */
  #start(limit) {
    const ctx = this.#ctx

    this.#started = true
    this.#collectionLimit = limit

    const contentLength = ctx.contentLength()

    if (ctx.aborted) {
      this.#reject(CACHED_ERRORS.aborted)

      return
    }

    if (contentLength !== null && contentLength > limit) {
      this.#reject(CACHED_ERRORS.bodyTooLarge)

      return
    }

    if (contentLength === 0) {
      ctx.res.onData(NOOP)
      this.#resolve(Buffer.alloc(0))

      return
    }

    const reservation = contentLength ?? limit

    if (!this.#reserve(reservation)) {
      this.#reject(CACHED_ERRORS.bodyBudgetExceeded)

      return
    }

    const generation = this.#generation

    if (ctx.server?.bindingCapabilities?.collectBody === true && typeof ctx.res?.collectBody === 'function') {
      ctx.res.collectBody(limit, (body) => {
        if (this.#generation !== generation || this.#ctx !== ctx) {
          return
        }

        if (body === null) {
          this.#reject(CACHED_ERRORS.bodyTooLarge)

          return
        }

        const buffer = Buffer.from(body)

        if (contentLength !== null && buffer.length !== contentLength) {
          this.#reject(CACHED_ERRORS.sizeMismatch)

          return
        }

        this.#resolve(buffer)
      })

      return
    }

    if (contentLength !== null) {
      this.#expected = contentLength
      this.#offset = 0
      this.#dst = Buffer.allocUnsafe(contentLength)

      ctx.res.onData((ab, isLast) => {
        if (this.#generation === generation && this.#ctx === ctx) {
          this.#onDataKnown(ab, isLast)
        }
      })
    } else {
      this.#limit = limit
      this.#len = 0
      this.#cap = 0
      this.#grow = null

      ctx.res.onData((ab, isLast) => {
        if (this.#generation === generation && this.#ctx === ctx) {
          this.#onDataUnknown(ab, isLast)
        }
      })
    }
  }

  /**
   * @param {Buffer} body
   * @param {number} limit
   * @returns {Buffer}
   */
  #checkLimit(body, limit) {
    if (body.length > limit) {
      throw CACHED_ERRORS.bodyTooLarge
    }

    return body
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<Buffer>}
   */
  body(maxSize) {
    const limit = maxSize ?? this.#maxSize

    if (this.#body !== null) {
      try {
        return Promise.resolve(this.#checkLimit(this.#body, limit))
      } catch (err) {
        return Promise.reject(err)
      }
    }

    if (this.#bodyError !== null) {
      return Promise.reject(this.#bodyError)
    }

    if (!this.#ctx) {
      this.#bodyError = CACHED_ERRORS.serverError

      return Promise.reject(this.#bodyError)
    }

    if (!this.#started) {
      this.#start(limit)

      if (this.#body !== null) {
        try {
          return Promise.resolve(this.#checkLimit(this.#body, limit))
        } catch (err) {
          return Promise.reject(err)
        }
      }

      if (this.#bodyError !== null) {
        return Promise.reject(this.#bodyError)
      }
    }

    if (this.#bodyPromise === null) {
      const { promise, resolve, reject } = Promise.withResolvers()

      this.#bodyPromise = promise
      this.#bodyResolve = resolve
      this.#bodyReject = reject
      this.#done = false
    }

    if (limit >= this.#collectionLimit) {
      return this.#bodyPromise
    }

    return this.#bodyPromise.then((body) => this.#checkLimit(body, limit))
  }

  abort() {
    if (this.#done) {
      return
    }

    this.#cancel(CACHED_ERRORS.aborted)
  }

  timeout() {
    this.#cancel(CACHED_ERRORS.requestTimeout)
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<Buffer>}
   */
  buffer(maxSize) {
    return this.body(maxSize)
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<string>}
   */
  async text(maxSize) {
    const buf = await this.body(maxSize)

    if (buf.length === 0) {
      return ''
    }

    return buf.toString('utf8')
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<unknown>}
   */
  async json(maxSize) {
    const buf = await this.body(maxSize)

    if (buf.length === 0) {
      return null
    }

    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      throw CACHED_ERRORS.invalidJSON
    }
  }
}
