export default class InflightBudget {
  readonly #maxBytes: number
  readonly #maxFiles: number

  #bytes = 0
  #files = 0

  constructor(maxBytes: number, maxFiles: number) {
    this.#maxBytes = maxBytes
    this.#maxFiles = maxFiles
  }

  tryReserveFile(): boolean {
    if (this.#files >= this.#maxFiles) {
      return false
    }

    this.#files++

    return true
  }

  releaseFile(): void {
    this.#files--
  }

  tryReserveBytes(byteLength: number): boolean {
    if (byteLength > this.#maxBytes - this.#bytes) {
      return false
    }

    this.#bytes += byteLength

    return true
  }

  releaseBytes(byteLength: number): void {
    this.#bytes -= byteLength
  }
}
