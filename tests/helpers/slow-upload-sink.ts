import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'

/** Delays completion so a real upload must apply transport backpressure. */
export default class SlowUploadSink extends Writable {
  readonly #hash = createHash('sha256')
  #bytes = 0

  constructor() {
    super({ highWaterMark: 64 * 1024 })
  }

  get bytes(): number {
    return this.#bytes
  }

  digest(): string {
    return this.#hash.digest('hex')
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#bytes += chunk.length
    this.#hash.update(chunk)
    setTimeout(callback, 2)
  }
}
