import { CACHED_ERRORS } from './status.js'
import type { Readable } from 'node:stream'
import type { HttpStreamingContext, HttpStreamingResponse } from './internal.js'

type ResponseChunk = string | ArrayBuffer | ArrayBufferView | Buffer

const PREMATURE_CLOSE_ERROR = Object.assign(new Error('Response stream closed before its source ended'), {
  code: 'ERR_STREAM_PREMATURE_CLOSE'
})

const IGNORE_LATE_STREAM_ERROR = () => {}

function finishReadableClose(this: Readable): void {
  this.removeListener('error', IGNORE_LATE_STREAM_ERROR)
  this.removeListener('close', finishReadableClose)
}

/**
 * Keep asynchronous destruction errors contained without retaining a request.
 * Only a source this streamer destroys is guarded: one it merely detaches from
 * stays under the application's own error handling.
 */
function destroyReadable(readable: Readable): void {
  if (!readable.closed) {
    readable.on('error', IGNORE_LATE_STREAM_ERROR)
    readable.on('close', finishReadableClose)
  }

  try {
    readable.destroy()
  } catch {
    // A source cleanup failure must not interrupt request finalization.
  }
}

export default class ResStreamer {
  #ctx: HttpStreamingContext | null = null
  #res: HttpStreamingResponse | null = null
  #readable: Readable | null = null
  #streamPromise: Promise<void> | null = null
  #streamResolve: (() => void) | null = null
  #streamReject: ((reason?: unknown) => void) | null = null
  #paused = false
  #done = false
  #started = false
  #onWritableCallback: ((offset: number) => void) | null = null
  #uwsWritableInstalled = false

  abort(): void {
    this.#onWritableCallback = null
    this.#started = false

    this.#settleOk(true)
  }

  /**
   * @param {HttpContext} ctx
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @returns {ResStreamer}
   */
  reset(ctx: HttpStreamingContext, res: HttpStreamingResponse | null = ctx.res): this {
    if (this.#streamPromise && !this.#done) {
      this.#streamReject?.(CACHED_ERRORS.aborted)
    }

    this.#cleanupStream()
    this.#done = false

    this.#ctx = ctx
    this.#res = res

    this.#uwsWritableInstalled = false
    this.#onWritableCallback = null
    this.#started = false

    return this
  }

  clear(): void {
    if (this.#streamPromise && !this.#done) {
      this.#streamReject?.(CACHED_ERRORS.aborted)
    }

    this.#cleanupStream()
    this.#done = true

    this.#ctx = null
    this.#res = null
    this.#uwsWritableInstalled = false
    this.#onWritableCallback = null
    this.#started = false
  }

  /**
   * @param {number|string} status
   * @param {object|null} headers
   * @returns {ResStreamer}
   */
  begin(status: number | string = 200, headers: object | null = null): this {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (this.#started) {
      throw new Error('Response streaming already started')
    }

    if (this.#ctx.aborted) {
      throw CACHED_ERRORS.aborted
    }

    const ctx = this.#ctx!
    const res = this.#res!
    const preparedHeaders = ctx.beginStreaming(headers)

    if (!this.#uwsWritableInstalled) {
      this.#uwsWritableInstalled = true
      res.onWritable(this.#onUwsWritable)
    }

    res.cork(() => {
      res.writeStatus(typeof status === 'string' ? status : ctx.getStatus(status))
      ctx.flushHeaders(preparedHeaders)

      if (ctx.server?.bindingCapabilities?.beginWrite === true && typeof res.beginWrite === 'function') {
        res.beginWrite()
      }
    })

    this.#started = true

    return this
  }

  /**
   * @param {string|Buffer|ArrayBuffer|Uint8Array} chunk
   * @returns {boolean}
   */
  write(chunk: ResponseChunk): boolean {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (!this.#started) {
      throw new Error('Must call begin() before write()')
    }

    if (this.#ctx.aborted) {
      return false
    }

    return this.#res.write(chunk)
  }

  /**
   * @param {string|Buffer|ArrayBuffer|Uint8Array} chunk
   * @param {number} totalSize
   * @returns {[boolean, boolean]} [ok, done]
   */
  tryEnd(chunk: ResponseChunk, totalSize: number): [boolean, boolean] {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (!this.#started) {
      throw new Error('Must call begin() before tryEnd()')
    }

    if (this.#ctx.aborted) {
      return [false, false]
    }

    if (!Number.isFinite(totalSize) || totalSize < 0) {
      throw new Error('tryEnd(chunk, totalSize): totalSize is required')
    }

    const ctx = this.#ctx!
    const res = this.#res!

    let result: [boolean, boolean] = [false, false]

    res.cork(() => {
      result = res.tryEnd(chunk, totalSize)

      if (result[1]) {
        this.#started = false
        ctx.streaming = false
        this.#settleOk()
        ctx.finalize()
      }
    })

    return result
  }

  /**
   * @param {string|Buffer|ArrayBuffer|Uint8Array|null} chunk
   */
  end(chunk: ResponseChunk | null = null): void {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (!this.#started) {
      return
    }

    if (this.#ctx.aborted) {
      this.#started = false
      this.#ctx.streaming = false

      return
    }

    this.#finishEnd(chunk)
  }

  /**
   * @param {(offset:number)=>void} cb
   */
  onWritable(cb: (offset: number) => void): void {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (!this.#started) {
      throw new Error('Must call begin() before onWritable()')
    }

    this.#onWritableCallback = cb
  }

  getWriteOffset(): number {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    return this.#res.getWriteOffset()
  }

  /**
   * @param {import('node:stream').Readable} readable
   * @param {number|string} status
   * @param {object|null} headers
   * @returns {Promise<void>}
   */
  stream(readable: Readable, status: number | string = 200, headers: object | null = null): Promise<void> {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (this.#streamPromise && !this.#done) {
      throw new Error('Streaming already in progress')
    }

    this.#readable = readable
    this.#paused = false
    this.#done = false

    try {
      this.begin(status, headers)
    } catch (error) {
      this.#cleanupStream(true)
      throw error
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>()

    this.#streamPromise = promise
    this.#streamResolve = resolve
    this.#streamReject = reject

    readable.on('data', this.#onData)
    readable.on('end', this.#onEnd)
    readable.on('error', this.#onError)
    readable.on('close', this.#onClose)

    return this.#streamPromise
  }

  #resumeReadable = () => {
    this.#paused = false
    this.#readable?.resume()
  }

  #onData = (chunk: string | Buffer | ArrayBuffer | Uint8Array): void => {
    const ctx = this.#ctx

    if (!ctx) {
      return this.#settleOk()
    }

    if (ctx.aborted) {
      return this.abort()
    }

    try {
      const ok = this.write(chunk)

      if (!ok && !this.#paused) {
        this.#paused = true
        this.#readable?.pause()
        this.onWritable(this.#resumeReadable)
      }
    } catch (error) {
      this.#failIncompleteStream(error)
    }
  }

  #onEnd = () => {
    const ctx = this.#ctx

    if (ctx && !ctx.aborted) {
      this.end()
    } else if (ctx) {
      ctx.streaming = false
    }

    if (ctx?.aborted) {
      this.#settleOk(true)
    }
  }

  #onError = (err: unknown): void => {
    const ctx = this.#ctx

    if (ctx && !ctx.aborted) {
      this.#failIncompleteStream(err)

      return
    }

    if (ctx) {
      ctx.streaming = false
    }

    this.#settleErr(err)
  }

  #onClose = () => {
    const ctx = this.#ctx

    if (ctx && !ctx.aborted && this.#started) {
      this.#failIncompleteStream(PREMATURE_CLOSE_ERROR)

      return
    }

    if (ctx) {
      ctx.streaming = false
    }

    this.#settleOk()
  }

  #onUwsWritable = (offset: number): boolean => {
    const cb = this.#onWritableCallback

    if (!cb) {
      return true
    }

    this.#onWritableCallback = null

    try {
      cb(offset)
    } catch (error) {
      this.#failIncompleteStream(error)

      return true
    }

    // uWS requires true after a successful callback, including a spurious
    // writable event that did not write data. A resumed source that blocks
    // again registers a new callback and must return false instead.
    return this.#onWritableCallback === null
  }

  #failIncompleteStream(reason: unknown): void {
    const ctx = this.#ctx

    if (!ctx || !this.#res) {
      this.#settleErr(reason)

      return
    }

    this.#started = false
    ctx.streaming = false
    ctx.reportError(reason)
    this.#settleErr(reason)

    // A source failure after headers must not look like a normally finished
    // chunked download. terminate() closes without writing the terminal chunk.
    // Wait for onAborted, or discard the owner when the transport is already invalid.
    ctx.terminateAfterError()
  }

  #finishEnd(chunk: ResponseChunk | null, streamError: unknown = null): void {
    const ctx = this.#ctx
    const res = this.#res

    if (!ctx || !res) {
      return
    }

    let responseError: unknown = null

    try {
      res.cork(() => {
        if (chunk !== null && chunk !== undefined) {
          res.end(chunk)
        } else {
          res.end()
        }
      })
    } catch (error) {
      responseError = error
    }

    if (responseError) {
      const hasStreamPromise = this.#streamPromise !== null

      this.#failIncompleteStream(responseError)

      // Manual callers receive the write error; a piped source delivers it
      // through stream() instead of throwing out of its native end event.
      if (!hasStreamPromise) {
        throw responseError
      }

      return
    }

    this.#started = false
    ctx.streaming = false

    if (streamError) {
      this.#settleErr(streamError)
    } else {
      this.#settleOk()
    }

    ctx.finalize()
  }

  #settleOk(destroySource = false): void {
    if (this.#done) {
      return
    }

    this.#done = true

    this.#streamResolve?.()
    this.#cleanupStream(destroySource)
  }

  #settleErr(err: unknown): void {
    if (this.#done) {
      return
    }

    this.#done = true

    this.#streamReject?.(err)
    this.#cleanupStream(true)
  }

  #cleanupStream(destroySource = false): void {
    const readable = this.#readable

    if (this.#readable) {
      if (typeof this.#readable.off === 'function') {
        this.#readable.off('data', this.#onData)
        this.#readable.off('end', this.#onEnd)
        this.#readable.off('error', this.#onError)
        this.#readable.off('close', this.#onClose)
      } else {
        this.#readable.removeListener('data', this.#onData)
        this.#readable.removeListener('end', this.#onEnd)
        this.#readable.removeListener('error', this.#onError)
        this.#readable.removeListener('close', this.#onClose)
      }
    }

    this.#readable = null
    this.#streamPromise = null
    this.#streamResolve = null
    this.#streamReject = null
    this.#paused = false

    if (destroySource && readable && !readable.destroyed) {
      destroyReadable(readable)
    }
  }
}
