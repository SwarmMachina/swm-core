import { isPromise } from '../internal/promise.js'

import type {
  HttpErrorDeliveryContext,
  HttpErrorDeliveryStats,
  HttpErrorEvent,
  HttpErrorHandler,
  NormalizedHttpErrorDeliveryOptions
} from '../server/options.js'

interface DeliveryJob {
  readonly error: Error
  readonly event: HttpErrorEvent
}

interface ActiveDelivery {
  done: boolean
  shutdownAborted: boolean
  timedOut: boolean
  readonly controller: AbortController
  readonly startedAt: number
  readonly timer: ReturnType<typeof setTimeout>
}

const DELIVERY_TIMEOUT_ERROR = Object.assign(new Error('HTTP error delivery timed out'), {
  code: 'ERR_HTTP_ERROR_DELIVERY_TIMEOUT'
})
const DELIVERY_SHUTDOWN_ERROR = Object.assign(new Error('HTTP error delivery stopped during server shutdown'), {
  code: 'ERR_HTTP_ERROR_DELIVERY_SHUTDOWN'
})

export const EMPTY_HTTP_ERROR_DELIVERY_STATS: Readonly<HttpErrorDeliveryStats> = Object.freeze({
  inFlight: 0,
  queued: 0,
  completed: 0,
  timedOut: 0,
  aborted: 0,
  rejected: 0,
  dropped: 0,
  oldestInFlightMs: null
})

export default class HttpErrorDispatcher {
  readonly #active = new Set<ActiveDelivery>()
  readonly #concurrency: number
  readonly #handler: HttpErrorHandler
  readonly #queueLimit: number
  readonly #timeoutMs: number

  #completed = 0
  #accepting = true
  #abortCalled = false
  #aborted = 0
  #draining = false
  #drainScheduled = false
  #dropped = 0
  #inFlight = 0
  #queue: Array<DeliveryJob | undefined> = []
  #queueHead = 0
  #rejected = 0
  #shutdownPromise: Promise<void> | null = null
  #shutdownResolver: (() => void) | null = null
  #timedOut = 0

  constructor(handler: HttpErrorHandler, options: NormalizedHttpErrorDeliveryOptions) {
    this.#handler = handler
    this.#concurrency = options.concurrency
    this.#queueLimit = options.queueLimit
    this.#timeoutMs = options.timeoutMs
  }

  dispatch(event: HttpErrorEvent, error: Error): void {
    if (!this.#accepting) {
      this.#dropped++

      return
    }

    const job = { event, error }
    const capacity = this.#concurrency + this.#queueLimit

    if (this.#inFlight + this.#queued >= capacity) {
      this.#dropped++

      return
    }

    this.#queue.push(job)
    this.#scheduleDrain()
  }

  get closed(): boolean {
    return !this.#accepting
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise
    }

    this.#accepting = false

    const { promise, resolve } = Promise.withResolvers<void>()

    this.#shutdownPromise = promise
    this.#shutdownResolver = resolve
    this.#resolveShutdownIfReady()

    return promise
  }

  abort(): void {
    if (this.#abortCalled) {
      return
    }

    this.#accepting = false
    this.#abortCalled = true
    this.#dropped += this.#queued
    this.#queue = []
    this.#queueHead = 0

    for (const delivery of this.#active) {
      if (!delivery.timedOut) {
        delivery.shutdownAborted = true
        this.#aborted++
      }

      clearTimeout(delivery.timer)

      try {
        delivery.controller.abort(DELIVERY_SHUTDOWN_ERROR)
      } catch {
        // A user signal listener must not prevent forced shutdown.
      }
    }

    this.#resolveShutdownIfReady()
  }

  get stats(): Readonly<HttpErrorDeliveryStats> {
    const now = Date.now()

    let oldestInFlightMs: number | null = null

    for (const delivery of this.#active) {
      const age = Math.max(0, now - delivery.startedAt)

      if (oldestInFlightMs === null || age > oldestInFlightMs) {
        oldestInFlightMs = age
      }
    }

    return Object.freeze({
      inFlight: this.#inFlight,
      queued: this.#queued,
      completed: this.#completed,
      timedOut: this.#timedOut,
      aborted: this.#aborted,
      rejected: this.#rejected,
      dropped: this.#dropped,
      oldestInFlightMs
    })
  }

  get #queued(): number {
    return this.#queue.length - this.#queueHead
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) {
      return
    }

    this.#drainScheduled = true
    queueMicrotask(() => {
      this.#drainScheduled = false
      this.#drain()
    })
  }

  #start(job: DeliveryJob): void {
    this.#inFlight++

    const controller = new AbortController()
    const delivery = {
      done: false,
      shutdownAborted: false,
      timedOut: false,
      controller,
      startedAt: Date.now(),
      timer: setTimeout(() => {
        if (delivery.done || delivery.timedOut) {
          return
        }

        delivery.timedOut = true
        this.#timedOut++

        try {
          controller.abort(DELIVERY_TIMEOUT_ERROR)
        } catch {
          // A user signal listener must not change dispatcher accounting.
        }
      }, this.#timeoutMs)
    }

    delivery.timer.unref?.()
    this.#active.add(delivery)

    const context: HttpErrorDeliveryContext = Object.freeze({ signal: controller.signal })

    let result: unknown

    try {
      result = this.#handler(job.event, job.error, context)

      if (!isPromise(result)) {
        this.#settle(delivery, 'completed')

        return
      }
    } catch {
      this.#settle(delivery, 'rejected')

      return
    }

    try {
      void Promise.resolve(result).then(
        () => this.#settle(delivery, 'completed'),
        () => this.#settle(delivery, 'rejected')
      )
    } catch {
      this.#settle(delivery, 'rejected')
    }
  }

  #settle(delivery: ActiveDelivery, outcome: 'completed' | 'rejected'): void {
    if (delivery.done) {
      return
    }

    delivery.done = true
    clearTimeout(delivery.timer)
    this.#active.delete(delivery)
    this.#inFlight--

    if (!delivery.timedOut && !delivery.shutdownAborted) {
      if (outcome === 'completed') {
        this.#completed++
      } else {
        this.#rejected++
      }
    }

    this.#drain()
  }

  #resolveShutdownIfReady(): void {
    if (!this.#shutdownResolver || (!this.#abortCalled && (this.#inFlight !== 0 || this.#queued !== 0))) {
      return
    }

    const resolve = this.#shutdownResolver

    this.#shutdownResolver = null
    resolve()
  }

  #drain(): void {
    if (this.#draining) {
      return
    }

    this.#draining = true

    try {
      const available = this.#concurrency - this.#inFlight

      let started = 0

      while (started < available && this.#queued > 0) {
        const job = this.#queue[this.#queueHead]

        this.#queue[this.#queueHead] = undefined
        this.#queueHead++

        if (job) {
          started++
          this.#start(job)
        }
      }

      if (this.#queueHead === this.#queue.length) {
        this.#queue = []
        this.#queueHead = 0
      } else if (this.#queueHead >= 1024 && this.#queueHead * 2 >= this.#queue.length) {
        this.#queue = this.#queue.slice(this.#queueHead)
        this.#queueHead = 0
      }

      if (this.#queued > 0 && this.#inFlight < this.#concurrency) {
        this.#scheduleDrain()
      }

      this.#resolveShutdownIfReady()
    } finally {
      this.#draining = false
    }
  }
}
