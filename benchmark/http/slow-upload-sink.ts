import { Writable } from 'node:stream'

/** Delays writes so the benchmark exercises RequestBodyStream backpressure. */
export default class SlowUploadSink extends Writable {
  #bytes = 0

  constructor() {
    super({ highWaterMark: 64 * 1024 })
  }

  get bytes(): number {
    return this.#bytes
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#bytes += chunk.length
    setTimeout(callback, 2)
  }
}
