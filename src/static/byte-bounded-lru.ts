interface Node<K, V> {
  readonly key: K
  readonly value: V
  older: Node<K, V> | null
  newer: Node<K, V> | null
}

export default class ByteBoundedLru<K, V extends { readonly byteLength: number }> {
  readonly #entries = new Map<K, Node<K, V>>()
  readonly #limit: number
  readonly #byteLimit: number

  #bytes = 0
  #oldest: Node<K, V> | null = null
  #newest: Node<K, V> | null = null

  constructor(limit: number, byteLimit: number) {
    this.#limit = limit
    this.#byteLimit = byteLimit
  }

  get(key: K): V | undefined {
    const node = this.#entries.get(key)

    if (!node) {
      return undefined
    }

    this.#touch(node)

    return node.value
  }

  set(key: K, value: V): void {
    if (value.byteLength > this.#byteLimit || this.#limit === 0) {
      return
    }

    const existing = this.#entries.get(key)

    if (existing) {
      this.#entries.delete(key)
      this.#unlink(existing)
      this.#bytes -= existing.value.byteLength
    }

    while (this.#entries.size >= this.#limit || this.#bytes > this.#byteLimit - value.byteLength) {
      const oldest = this.#oldest

      if (!oldest) {
        break
      }

      this.#entries.delete(oldest.key)
      this.#unlink(oldest)
      this.#bytes -= oldest.value.byteLength
    }

    const node: Node<K, V> = {
      key,
      value,
      older: this.#newest,
      newer: null
    }

    if (this.#newest) {
      this.#newest.newer = node
    } else {
      this.#oldest = node
    }

    this.#newest = node
    this.#entries.set(key, node)
    this.#bytes += value.byteLength
  }

  #touch(node: Node<K, V>): void {
    if (node === this.#newest) {
      return
    }

    this.#unlink(node)
    node.older = this.#newest
    node.newer = null

    if (this.#newest) {
      this.#newest.newer = node
    } else {
      this.#oldest = node
    }

    this.#newest = node
  }

  #unlink(node: Node<K, V>): void {
    if (node.older) {
      node.older.newer = node.newer
    } else {
      this.#oldest = node.newer
    }

    if (node.newer) {
      node.newer.older = node.older
    } else {
      this.#newest = node.older
    }

    node.older = null
    node.newer = null
  }
}
