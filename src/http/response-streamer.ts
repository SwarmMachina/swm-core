import { CACHED_ERRORS } from './status.js'
import type { Readable } from 'node:stream'
import type { HttpStreamingContext, HttpStreamingResponse } from './internal.js'

type ResponseChunk = string | ArrayBuffer | ArrayBufferView | Buffer

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
    if (this.#readable) {
      try {
        this.#readable.destroy()
      } catch {
        //
      }
    }

    this.#onWritableCallback = null
    this.#started = false

    this.#settleOk()
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

    if (!this.#uwsWritableInstalled) {
      this.#uwsWritableInstalled = true
      res.onWritable(this.#onUwsWritable)
    }

    res.cork(() => {
      res.writeStatus(typeof status === 'string' ? status : ctx.getStatus(status))
      ctx.flushHeaders(headers)

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

    this.begin(status, headers)

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

    const ok = this.write(chunk)

    if (!ok && !this.#paused) {
      this.#paused = true
      this.#readable?.pause()
      this.onWritable(this.#resumeReadable)
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
      this.#settleOk()
    }
  }

  #onError = (err: unknown): void => {
    const ctx = this.#ctx

    if (ctx && !ctx.aborted) {
      this.#finishEnd(null, err)

      return
    }

    this.#settleErr(err)
  }

  #onClose = () => {
    const ctx = this.#ctx

    if (ctx && !ctx.aborted && this.#started) {
      this.#finishEnd(null)

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
      return false
    }

    this.#onWritableCallback = null
    cb(offset)

    return false
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

    this.#started = false
    ctx.streaming = false

    if (streamError) {
      this.#settleErr(streamError)
    } else if (responseError) {
      this.#settleErr(responseError)
    } else {
      this.#settleOk()
    }

    ctx.finalize()

    if (responseError && !streamError) {
      throw responseError
    }
  }

  #settleOk(): void {
    if (this.#done) {
      return
    }

    this.#done = true

    this.#streamResolve?.()
    this.#cleanupStream()
  }

  #settleErr(err: unknown): void {
    if (this.#done) {
      return
    }

    this.#done = true

    this.#streamReject?.(err)
    this.#cleanupStream()
  }

  #cleanupStream(): void {
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
    this.#done = false
  }
}
