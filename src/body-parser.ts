import { CACHED_ERRORS } from './constants.js'
import type { HttpBodyBudget, HttpBodyContext } from './http-internal.js'
import { DEFAULT_HTTP_MAX_BODY_SIZE_BYTES, validateBodyByteLimit } from './server/options.js'

const NOOP = () => {}
const INITIAL_BODY_CAPACITY = 4096

type BodyParserState = 'cleared' | 'idle' | 'collecting' | 'materialized' | 'failed' | 'aborted'
type BodyInput = ArrayBuffer | ArrayBufferView

/**
 * @param {unknown} value
 * @param {string} name
 */
function assertCapacityValue(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

/**
 * Calculate a bounded grow-buffer capacity without signed 32-bit coercion.
 * @param {number} current
 * @param {number} required
 * @param {number} limit
 * @param {number} [initial]
 * @returns {number}
 */
export function nextBodyCapacity(
  current: number,
  required: number,
  limit: number,
  initial = INITIAL_BODY_CAPACITY
): number {
  assertCapacityValue(current, 'current capacity')
  assertCapacityValue(required, 'required capacity')
  assertCapacityValue(limit, 'capacity limit')
  assertCapacityValue(initial, 'initial capacity')

  if (current > limit) {
    throw new RangeError('current capacity exceeds the capacity limit')
  }

  if (required > limit) {
    throw new RangeError('required capacity exceeds the capacity limit')
  }

  if (required <= current) {
    return current
  }

  const base = current === 0 ? Math.min(initial, limit) : current
  const doubled = base > Math.floor(limit / 2) ? limit : base * 2
  const next = Math.min(limit, Math.max(required, base, doubled))

  if (next < required || next <= current) {
    throw new RangeError('body capacity cannot make safe progress')
  }

  return next
}

/**
 * @param {unknown} value
 * @returns {Uint8Array}
 */
function byteView(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }

  throw new TypeError('Body collector returned a non-buffer value')
}

/**
 * @param {ArrayBuffer|ArrayBufferView} value
 * @returns {Buffer}
 */
function exactBuffer(value: BodyInput): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }

  const view = byteView(value)
  const buffer = Buffer.allocUnsafeSlow(view.byteLength)

  buffer.set(view)

  return buffer
}

export default class BodyParser {
  #state: BodyParserState = 'cleared'
  #body: Buffer | null = null
  #bodyError: Error | null = null
  #bodyPromise: Promise<Buffer> | null = null
  #bodyResolve: ((value: Buffer) => void) | null = null
  #bodyReject: ((reason: Error) => void) | null = null
  #collectionLimit = 0
  #generation = 0
  #budget: HttpBodyBudget | null = null
  #reservedBytes = 0
  #ctx: HttpBodyContext | null = null
  #maxSize = DEFAULT_HTTP_MAX_BODY_SIZE_BYTES

  // Known-length state.
  #dst: Buffer | null = null
  #offset = 0
  #expected = 0

  // Unknown-length state.
  #grow: Buffer | null = null
  #len = 0
  #cap = 0
  #limit = 0

  get diagnostics() {
    return Object.freeze({
      state: this.#state,
      generation: this.#generation,
      collectionLimit: this.#collectionLimit,
      reservedBytes: this.#reservedBytes
    })
  }

  #onDataKnown(value: BodyInput, isLast: boolean): void {
    if (this.#state !== 'collecting') {
      return
    }

    if (!this.#ctx || this.#ctx.aborted) {
      this.#reject(CACHED_ERRORS.aborted, 'aborted')

      return
    }

    try {
      const chunk = byteView(value)
      const remaining = this.#expected - this.#offset

      if (chunk.byteLength > remaining) {
        this.#reject(CACHED_ERRORS.sizeMismatch)

        return
      }

      this.#dst!.set(chunk, this.#offset)
      this.#offset += chunk.byteLength

      if (!isLast) {
        return
      }

      if (this.#offset !== this.#expected) {
        this.#reject(CACHED_ERRORS.sizeMismatch)

        return
      }

      this.#resolve(this.#dst!, this.#expected)
    } catch {
      this.#reject(CACHED_ERRORS.serverError)
    }
  }

  #onDataUnknown(value: BodyInput, isLast: boolean): void {
    if (this.#state !== 'collecting') {
      return
    }

    if (!this.#ctx || this.#ctx.aborted) {
      this.#reject(CACHED_ERRORS.aborted, 'aborted')

      return
    }

    try {
      const chunk = byteView(value)
      const chunkLength = chunk.byteLength

      if (chunkLength > this.#limit - this.#len) {
        this.#reject(CACHED_ERRORS.bodyTooLarge)

        return
      }

      const nextLength = this.#len + chunkLength

      if (nextLength === 0) {
        if (isLast) {
          this.#resolve(Buffer.alloc(0), 0)
        }

        return
      }

      if (nextLength > this.#cap) {
        const capacity = nextBodyCapacity(this.#cap, nextLength, this.#limit)
        // Security invariant: only [0, nextLength) is initialized below and
        // only [0, len) may later become observable. The unwritten capacity
        // tail is retained internally and discarded or kept outside the view.
        const buffer = Buffer.allocUnsafeSlow(capacity)

        if (this.#len > 0) {
          this.#grow!.copy(buffer, 0, 0, this.#len)
        }

        buffer.set(chunk, this.#len)
        this.#grow = buffer
        this.#cap = capacity
        this.#len = nextLength
      } else {
        this.#grow!.set(chunk, this.#len)
        this.#len = nextLength
      }

      if (!isLast) {
        return
      }

      if (this.#len === 0) {
        this.#resolve(Buffer.alloc(0), 0)

        return
      }

      const view = this.#grow!.subarray(0, this.#len)

      if (this.#cap - this.#len > this.#len) {
        const compact = Buffer.allocUnsafeSlow(this.#len)

        compact.set(view)
        this.#resolve(compact, this.#len)

        return
      }

      // `view` retains the whole grow allocation, so retained accounting must
      // keep `cap`, not merely the logical body length.
      this.#resolve(view, this.#cap)
    } catch {
      this.#reject(CACHED_ERRORS.serverError)
    }
  }

  #resolve(body: Buffer, retainedBytes: number): void {
    if (this.#state !== 'collecting') {
      return
    }

    if (!this.#reconcileReservation(retainedBytes)) {
      this.#reject(CACHED_ERRORS.serverError)

      return
    }

    this.#state = 'materialized'
    this.#body = body
    this.#dst = null
    this.#grow = null

    if (this.#bodyPromise) {
      const resolve = this.#bodyResolve

      this.#bodyPromise = null
      this.#bodyReject = null
      this.#bodyResolve = null
      resolve?.(body)
    }
  }

  #reject(error: Error, state: BodyParserState = 'failed'): void {
    if (this.#state !== 'idle' && this.#state !== 'collecting') {
      return
    }

    this.#state = state
    this.#bodyError = error
    this.#discardStorage()
    this.#releaseReservation()

    if (this.#bodyPromise) {
      const reject = this.#bodyReject

      this.#bodyPromise = null
      this.#bodyReject = null
      this.#bodyResolve = null
      reject?.(error)
    }
  }

  #discardStorage(): void {
    this.#body = null
    this.#dst = null
    this.#offset = 0
    this.#expected = 0
    this.#grow = null
    this.#len = 0
    this.#cap = 0
    this.#limit = 0
  }

  #reserve(bytes: number): boolean {
    const budget = this.#ctx?.server?.httpBodyBudget

    if (!budget) {
      return true
    }

    if (!budget.tryReserve(bytes, this)) {
      return false
    }

    this.#budget = budget
    this.#reservedBytes = bytes

    return true
  }

  #reconcileReservation(bytes: number): boolean {
    if (!this.#budget) {
      return true
    }

    if (bytes === this.#reservedBytes) {
      return true
    }

    if (!this.#budget.resize(bytes, this)) {
      return false
    }

    this.#reservedBytes = bytes

    return true
  }

  #releaseReservation(): void {
    const budget = this.#budget

    if (!budget) {
      return
    }

    // Null first so cleanup remains idempotent even if a surrounding terminal
    // path is re-entered. BodyBudget itself asserts double release and owners.
    this.#budget = null
    this.#reservedBytes = 0
    budget.release(this)
  }

  #cancel(error: Error, state: BodyParserState): void {
    if (this.#state === 'cleared' || this.#state === 'failed' || this.#state === 'aborted') {
      return
    }

    const reject = this.#bodyPromise ? this.#bodyReject : null

    this.#generation++
    this.#state = state
    this.#bodyError = error
    this.#bodyPromise = null
    this.#bodyReject = null
    this.#bodyResolve = null
    this.#discardStorage()
    this.#releaseReservation()
    reject?.(error)
  }

  #clearRequestState(): void {
    this.#body = null
    this.#bodyError = null
    this.#bodyPromise = null
    this.#bodyResolve = null
    this.#bodyReject = null
    this.#collectionLimit = 0
    this.#budget = null
    this.#reservedBytes = 0
    this.#discardStorage()
  }

  /**
   * @param {HttpContext} ctx
   * @param {number} [maxSize]
   */
  reset(ctx: HttpBodyContext, maxSize: number = this.#maxSize): void {
    if (this.#state !== 'idle' && this.#state !== 'cleared') {
      if (this.#state === 'collecting') {
        this.#cancel(CACHED_ERRORS.aborted, 'aborted')
      }

      this.#releaseReservation()
      this.#generation++
      this.#clearRequestState()
    }

    this.#maxSize = validateBodyByteLimit(maxSize, 'maxSize')
    this.#ctx = ctx
    this.#state = 'idle'
  }

  clear(): void {
    if (this.#state === 'cleared') {
      return
    }

    if (this.#state === 'idle') {
      this.#clearRequestState()
      this.#ctx = null
      this.#state = 'cleared'

      return
    }

    if (this.#state === 'collecting') {
      this.#cancel(CACHED_ERRORS.aborted, 'aborted')
    }

    this.#releaseReservation()
    this.#generation++
    this.#clearRequestState()
    this.#ctx = null
    this.#state = 'cleared'
  }

  prefetch(): Error | null {
    if (this.#state !== 'idle') {
      return this.#bodyError
    }

    if (!this.#ctx) {
      this.#bodyError = CACHED_ERRORS.serverError
      this.#state = 'failed'

      return this.#bodyError
    }

    this.#start(this.#maxSize)

    return this.#bodyError
  }

  #discardIncomingBody(ctx: HttpBodyContext): void {
    try {
      ctx.res?.onData?.(NOOP)
    } catch {
      // The controlled request error remains the primary failure.
    }
  }

  #start(limit: number): void {
    const ctx = this.#ctx

    if (!ctx) {
      this.#reject(CACHED_ERRORS.serverError)

      return
    }

    this.#state = 'collecting'
    this.#collectionLimit = limit

    const contentLength = ctx.getContentLength()

    if (ctx.aborted) {
      this.#reject(CACHED_ERRORS.aborted, 'aborted')

      return
    }

    if (contentLength !== null && contentLength > limit) {
      this.#discardIncomingBody(ctx)
      this.#reject(CACHED_ERRORS.bodyTooLarge)

      return
    }

    if (contentLength === 0) {
      this.#discardIncomingBody(ctx)
      this.#resolve(Buffer.alloc(0), 0)

      return
    }

    const reservationBytes = contentLength ?? limit

    if (!this.#reserve(reservationBytes)) {
      this.#discardIncomingBody(ctx)
      this.#reject(CACHED_ERRORS.bodyBudgetExceeded)

      return
    }

    const generation = this.#generation

    if (ctx.server?.bindingCapabilities?.collectBody === true && typeof ctx.res?.collectBody === 'function') {
      try {
        ctx.res.collectBody(limit, (body) => {
          if (this.#generation !== generation || this.#ctx !== ctx || this.#state !== 'collecting') {
            return
          }

          try {
            if (body === null) {
              this.#reject(CACHED_ERRORS.bodyTooLarge)

              return
            }

            const buffer = exactBuffer(body)

            if (buffer.length > limit) {
              this.#reject(CACHED_ERRORS.bodyTooLarge)

              return
            }

            if (contentLength !== null && buffer.length !== contentLength) {
              this.#reject(CACHED_ERRORS.sizeMismatch)

              return
            }

            this.#resolve(buffer, buffer.byteLength)
          } catch {
            this.#reject(CACHED_ERRORS.serverError)
          }
        })
      } catch {
        this.#reject(CACHED_ERRORS.serverError)
      }

      return
    }

    if (contentLength !== null) {
      try {
        this.#expected = contentLength
        this.#offset = 0
        // Security invariant: this uninitialized buffer becomes observable only
        // after isLast and after every byte in [0, expected) was written by this
        // request. Error and abort paths discard it.
        this.#dst = Buffer.allocUnsafeSlow(contentLength)

        ctx.res!.onData((value, isLast) => {
          if (this.#generation === generation && this.#ctx === ctx) {
            this.#onDataKnown(value, isLast)
          }
        })
      } catch {
        this.#reject(CACHED_ERRORS.serverError)
      }

      return
    }

    this.#limit = limit
    this.#len = 0
    this.#cap = 0
    this.#grow = null

    try {
      ctx.res!.onData((value, isLast) => {
        if (this.#generation === generation && this.#ctx === ctx) {
          this.#onDataUnknown(value, isLast)
        }
      })
    } catch {
      this.#reject(CACHED_ERRORS.serverError)
    }
  }

  #checkLimit(body: Buffer, limit: number): Buffer {
    if (body.length > limit) {
      throw CACHED_ERRORS.bodyTooLarge
    }

    return body
  }

  /**
   * The first body call (or prefetch) fixes the collector limit. Later smaller
   * limits are checked against the materialized body; larger limits do not
   * restart or expand a failed/in-flight collector.
   * @param {number} [maxSize]
   * @returns {Promise<Buffer>}
   */
  body(maxSize?: number): Promise<Buffer> {
    let limit

    try {
      const requestedLimit = maxSize === undefined ? this.#maxSize : validateBodyByteLimit(maxSize, 'maxSize')

      // Accessors may narrow the server policy for a specific parse, but can
      // never widen the configured per-request ceiling.
      limit = Math.min(requestedLimit, this.#maxSize)
    } catch (error) {
      return Promise.reject(error)
    }

    if (this.#state === 'materialized') {
      try {
        return Promise.resolve(this.#checkLimit(this.#body!, limit))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    if (this.#bodyError !== null) {
      return Promise.reject(this.#bodyError)
    }

    if (!this.#ctx || this.#state === 'cleared') {
      this.#bodyError = CACHED_ERRORS.serverError
      this.#state = 'failed'

      return Promise.reject(this.#bodyError)
    }

    if (this.#state === 'idle') {
      this.#start(limit)

      if ((this.#state as BodyParserState) === 'materialized') {
        return Promise.resolve(this.#body!)
      }

      if (this.#bodyError !== null) {
        return Promise.reject(this.#bodyError)
      }
    }

    if (this.#bodyPromise === null) {
      const { promise, resolve, reject } = Promise.withResolvers<Buffer>()

      this.#bodyPromise = promise
      this.#bodyResolve = resolve
      this.#bodyReject = reject
    }

    if (limit >= this.#collectionLimit) {
      return this.#bodyPromise
    }

    return this.#bodyPromise.then((body) => this.#checkLimit(body, limit))
  }

  buffer(maxSize?: number): Promise<Buffer> {
    return this.body(maxSize)
  }

  abort(): void {
    this.#cancel(CACHED_ERRORS.aborted, 'aborted')
  }

  timeout(): void {
    this.#cancel(CACHED_ERRORS.requestTimeout, 'failed')
  }

  async text(maxSize?: number): Promise<string> {
    const buffer = await this.body(maxSize)

    return buffer.length === 0 ? '' : buffer.toString('utf8')
  }

  async json(maxSize?: number): Promise<unknown> {
    const buffer = await this.body(maxSize)

    if (buffer.length === 0) {
      return null
    }

    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch {
      throw CACHED_ERRORS.invalidJSON
    }
  }
}
