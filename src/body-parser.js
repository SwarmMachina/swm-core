const CACHED_ERRORS = Object.freeze({
  bodyTooLarge: Object.assign(new Error('Request body too large'), { status: 413 }),
  aborted: Object.assign(new Error('Request aborted'), { status: 418 }),
  sizeMismatch: Object.assign(new Error('Request body size mismatch'), { status: 400 }),
  invalidJSON: Object.assign(new Error('Invalid JSON'), { status: 400 }),
  serverError: Object.assign(new Error('Internal Server Error'), { status: 500 })
})

const NOOP = () => {}

export default class BodyParser {
  /** @type {Buffer} */
  #body = null
  /** @type {Error} */
  #bodyError = null
  /** @type {Promise} */
  #bodyPromise = null
  /** @type {Function} */
  #bodyResolve = null
  /** @type {Function} */
  #bodyReject = null
  /** @type {boolean} */
  #done = false

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

  #onDataKnown = (ab, isLast) => {
    if (this.#done) {
      return
    }

    if (this.#ctx.aborted) {
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

  #onDataUnknown = (ab, isLast) => {
    if (this.#done) {
      return
    }
    if (this.#ctx.aborted) {
      return this.#reject(CACHED_ERRORS.aborted)
    }

    const u8 = new Uint8Array(ab)
    const chunkLen = u8.byteLength
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

    if (this.#bodyPromise) {
      const reject = this.#bodyReject

      this.#bodyPromise = null
      this.#bodyReject = null
      this.#bodyResolve = null

      reject(error)
    }
  }

  /**
   * @param {HttpContext} ctx
   * @param {number} [maxSize]
   */
  reset(ctx, maxSize) {
    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#bodyResolve = null
    this.#bodyReject = null
    this.#done = false

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
    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#bodyResolve = null
    this.#bodyReject = null
    this.#done = false

    this.#dst = null
    this.#offset = 0
    this.#expected = 0

    this.#grow = null
    this.#len = 0
    this.#cap = 0
    this.#limit = 0

    this.#ctx = null
  }

  /**
   * @param {number} [maxSize]
   * @returns {Promise<Buffer>}
   */
  body(maxSize) {
    if (this.#body !== null) {
      return Promise.resolve(this.#body)
    }

    if (this.#bodyError !== null) {
      return Promise.reject(this.#bodyError)
    }

    if (this.#bodyPromise !== null) {
      return this.#bodyPromise
    }

    if (!this.#ctx) {
      this.#bodyError = CACHED_ERRORS.serverError
      return Promise.reject(this.#bodyError)
    }

    const limit = maxSize ?? this.#maxSize
    const contentLength = this.#ctx.contentLength()

    if (this.#ctx.aborted) {
      this.#bodyError = CACHED_ERRORS.aborted
      return Promise.reject(this.#bodyError)
    }

    if (contentLength !== null && contentLength > limit) {
      this.#bodyError = CACHED_ERRORS.bodyTooLarge
      return Promise.reject(this.#bodyError)
    }

    if (contentLength === 0) {
      const buf = Buffer.alloc(0)

      this.#body = buf
      this.#ctx.res.onData(NOOP)
      return Promise.resolve(buf)
    }

    const { promise, resolve, reject } = Promise.withResolvers()

    this.#bodyPromise = promise
    this.#bodyResolve = resolve
    this.#bodyReject = reject
    this.#done = false

    if (contentLength !== null) {
      this.#expected = contentLength
      this.#offset = 0
      this.#dst = Buffer.allocUnsafe(contentLength)

      this.#ctx.res.onData(this.#onDataKnown)
    } else {
      this.#limit = limit
      this.#len = 0
      this.#cap = 0
      this.#grow = null

      this.#ctx.res.onData(this.#onDataUnknown)
    }

    return this.#bodyPromise
  }

  abort() {
    if (this.#done) {
      return
    }

    this.#reject(CACHED_ERRORS.aborted)
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
   * @returns {Promise<any>}
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
