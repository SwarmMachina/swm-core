import { Readable } from 'node:stream'

import type { HttpResponse } from '@swarmmachina/swm-uws'

import { CACHED_ERRORS } from './status.js'

const NOOP = () => {}

function copyChunk(value: ArrayBuffer): Buffer {
  const source = new Uint8Array(value)
  const chunk = Buffer.allocUnsafeSlow(source.byteLength)

  chunk.set(source)

  return chunk
}

/** Drain an unread body so the connection remains eligible for keep-alive. */
function discardBody(response: HttpResponse, paused: boolean): void {
  const discard = (response as { discardBody?: () => void }).discardBody

  if (typeof discard === 'function') {
    try {
      discard.call(response)
    } catch {
      // The original callback ignores data after stream destruction.
    }
  }

  if (paused) {
    try {
      response.resume()
    } catch {
      // The response may already be invalid after a transport abort.
    }
  }
}

/** A bounded Node.js readable request body. */
export default class RequestBodyStream extends Readable {
  readonly contentLength: number | null

  readonly #maxSize: number
  #response: HttpResponse | null = null
  #receivedSize = 0
  #paused = false
  #sourceEnded = false
  #started = false

  constructor(contentLength: number | null, maxSize: number) {
    super()

    this.contentLength = contentLength
    this.#maxSize = maxSize

    // Delivery can fail before application code starts consuming the stream.
    // Preserve the error for later consumers without an unhandled emission.
    this.once('error', NOOP)
  }

  start(response: HttpResponse): void {
    if (this.#started || this.destroyed) {
      throw new Error('Request body stream already started')
    }

    this.#started = true
    this.#response = response

    if (this.contentLength === 0) {
      response.onData(NOOP)
      this.#end()

      return
    }

    response.onData(this.#onData)
  }

  override _read(): void {
    if (!this.#paused || this.#sourceEnded || this.destroyed) {
      return
    }

    const response = this.#response

    if (!response) {
      return
    }

    this.#paused = false

    try {
      response.resume()
    } catch {
      if (!this.#sourceEnded && !this.destroyed && this.#response === response) {
        this.#paused = true
      }

      this.destroy(CACHED_ERRORS.serverError)
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const response = this.#response

    this.#response = null

    if (!this.#sourceEnded && response) {
      discardBody(response, this.#paused)
    }

    this.#paused = false
    callback(error)
  }

  #onData = (value: ArrayBuffer, isLast: boolean): void => {
    if (this.#sourceEnded || this.destroyed) {
      return
    }

    const chunkLength = value.byteLength

    if (this.contentLength !== null && chunkLength > this.contentLength - this.#receivedSize) {
      this.destroy(CACHED_ERRORS.sizeMismatch)

      return
    }

    if (chunkLength > this.#maxSize - this.#receivedSize) {
      this.destroy(CACHED_ERRORS.bodyTooLarge)

      return
    }

    try {
      const chunk = copyChunk(value)

      this.#receivedSize += chunkLength

      const accepted = chunkLength === 0 || this.push(chunk)

      if (this.destroyed) {
        return
      }

      if (isLast) {
        if (this.contentLength !== null && this.#receivedSize !== this.contentLength) {
          this.destroy(CACHED_ERRORS.sizeMismatch)

          return
        }

        this.#end()

        return
      }

      if (!accepted && !this.#paused) {
        this.#paused = true
        this.#response?.pause()
      }
    } catch {
      this.destroy(CACHED_ERRORS.serverError)
    }
  }

  #end(): void {
    const response = this.#response
    const paused = this.#paused

    this.#sourceEnded = true
    this.#response = null
    this.#paused = false

    if (paused && response) {
      try {
        response.resume()
      } catch {
        this.destroy(CACHED_ERRORS.serverError)

        return
      }
    }

    if (!this.destroyed) {
      this.push(null)
    }
  }
}
