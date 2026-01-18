import { CACHED_ERRORS } from './constants.js'

export default class ResStreamer {
  /** @type {HttpContext} */
  #ctx = null

  /** @type {import('uwebsockets.js').HttpResponse} */
  #res = null

  /** @type {import('node:stream').Readable} */
  #readable = null

  /** @type {Promise<void>} */
  #streamPromise = null
  /** @type {Function} */
  #streamResolve = null
  /** @type {Function} */
  #streamReject = null

  /** @type {boolean} */
  #paused = false
  /** @type {boolean} */
  #done = false
  /** @type {boolean} */
  #started = false

  /** @type {Function} */
  #onWritableCallback = null
  /** @type {boolean} */
  #uwsWritableInstalled = false

  abort() {
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
   * @param {import('uwebsockets.js').HttpResponse} res
   * @returns {ResStreamer}
   */
  reset(ctx, res = ctx?.res) {
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

  clear() {
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
   * @param {Record<string,string>|null} headers
   * @returns {ResStreamer}
   */
  begin(status = 200, headers = null) {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (this.#started) {
      throw new Error('Response streaming already started')
    }

    if (this.#ctx.aborted) {
      throw CACHED_ERRORS.aborted
    }

    const res = this.#res

    if (!this.#uwsWritableInstalled) {
      this.#uwsWritableInstalled = true
      res.onWritable(this.#onUwsWritable)
    }

    res.cork(() => {
      res.writeStatus(typeof status === 'string' ? status : this.#ctx.getStatus(status))
      this.#ctx.setHeaders(headers)
    })

    this.#started = true
    return this
  }

  /**
   * @param {string|Buffer|ArrayBuffer|Uint8Array} chunk
   * @returns {boolean}
   */
  write(chunk) {
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
  tryEnd(chunk, totalSize) {
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

    let result = [false, false]

    this.#res.cork(() => {
      const [ok, done] = this.#res.tryEnd(chunk, totalSize)

      result = [ok, done]

      if (done) {
        this.#started = false
        this.#ctx.streaming = false
        this.#ctx?.finalize?.()
      }
    })

    return result
  }

  /**
   * @param {string|Buffer|ArrayBuffer|Uint8Array|null} chunk
   */
  end(chunk = null) {
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

    this.#res.cork(() => {
      if (chunk !== null && chunk !== undefined) {
        this.#res.end(chunk)
      } else {
        this.#res.end()
      }
    })

    this.#started = false
    this.#ctx.streaming = false
    this.#ctx?.finalize?.()
  }

  /**
   * @param {(offset:number)=>void} cb
   */
  onWritable(cb) {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    if (!this.#started) {
      throw new Error('Must call begin() before onWritable()')
    }

    this.#onWritableCallback = cb
  }

  getWriteOffset() {
    if (!this.#ctx || !this.#res) {
      throw new Error('ResStreamer is not initialized')
    }

    return this.#res.getWriteOffset()
  }

  /**
   * @param {import('node:stream').Readable} readable
   * @param {number|string} status
   * @param {Record<string,string>|null} headers
   * @returns {Promise<void>}
   */
  stream(readable, status = 200, headers = null) {
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

    const { promise, resolve, reject } = Promise.withResolvers()

    this.#streamPromise = promise
    this.#streamResolve = resolve
    this.#streamReject = reject

    readable.on('data', this.#onData)
    readable.on('end', this.#onEnd)
    readable.on('error', this.#onError)
    readable.on('close', this.#onClose)

    return this.#streamPromise
  }

  #resumeWritable = () => {
    this.#paused = false
    this.#readable?.resume()
  }

  #onData = (chunk) => {
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
      this.onWritable(this.#onWritableResume)
    }
  }

  #onWritableResume = () => {
    this.#resumeWritable()
  }

  #onEnd = () => {
    const ctx = this.#ctx

    if (ctx && !ctx.aborted) {
      this.end()
    } else if (ctx) {
      ctx.streaming = false
    }

    this.#settleOk()
  }

  #onError = (err) => {
    const ctx = this.#ctx

    if (ctx) {
      ctx.streaming = false
    }

    if (ctx && !ctx.aborted) {
      try {
        this.end()
      } catch {
        //
      }
    }

    this.#settleErr(err)
  }

  #onClose = () => {
    const ctx = this.#ctx

    if (ctx) {
      ctx.streaming = false
    }

    this.#settleOk()
  }

  #onUwsWritable = (offset) => {
    const cb = this.#onWritableCallback

    if (!cb) {
      return false
    }

    this.#onWritableCallback = null
    cb(offset)
    return false
  }

  #settleOk() {
    if (this.#done) {
      return
    }
    this.#done = true

    this.#streamResolve?.()
    this.#cleanupStream()
  }

  #settleErr(err) {
    if (this.#done) {
      return
    }
    this.#done = true

    this.#streamReject?.(err)
    this.#cleanupStream()
  }

  #cleanupStream() {
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
