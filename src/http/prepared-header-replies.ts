import type { PreparedHeaderData } from './headers.js'
import type { HttpResponse, NativeData } from '@swarmmachina/swm-uws'

export type PreparedHeaderBlockConstructor = new (headerLines: readonly string[]) => object

type PreparedResponse = HttpResponse & {
  endPrepared?: (status: string, headers: object, body?: NativeData) => HttpResponse
}

/** Owns lazily compiled native blocks for core prepared-header records. */
export default class PreparedHeaderReplies {
  readonly #Block: PreparedHeaderBlockConstructor
  readonly #blocks = new WeakMap<PreparedHeaderData, object>()

  constructor(Block: PreparedHeaderBlockConstructor) {
    this.#Block = Block
  }

  send(response: HttpResponse, status: string, prepared: PreparedHeaderData, body?: NativeData): boolean {
    const nativeResponse = response as PreparedResponse

    if (!prepared.nativeEligible || typeof nativeResponse.endPrepared !== 'function') {
      return false
    }

    let block = this.#blocks.get(prepared)

    if (!block) {
      block = new this.#Block(prepared.lines)
      this.#blocks.set(prepared, block)
    }

    nativeResponse.endPrepared(status, block, body)

    return true
  }
}
