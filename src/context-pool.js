export default class ContextPool {
  #inPool = new WeakSet()

  /**
   * @param {(pool: ContextPool) => object} createFn
   * @param {number} maxSize
   */
  constructor(createFn, maxSize = 1000) {
    this.pool = []
    this.maxSize = maxSize
    this.createFn = createFn
  }

  /**
   * @returns {object}
   */
  acquire() {
    const ctx = this.pool.pop()

    if (ctx) {
      this.#inPool.delete(ctx)

      return ctx
    }

    return this.createFn(this)
  }

  /**
   * @param {object} ctx
   */
  release(ctx) {
    if (!ctx || typeof ctx.clear !== 'function') {
      throw new TypeError('ContextPool.release: ctx.clear() is required')
    }

    ctx.clear()

    if (this.maxSize === 0) {
      return
    }

    if (this.pool.length >= this.maxSize) {
      return
    }

    if (this.#inPool.has(ctx)) {
      return
    }

    this.#inPool.add(ctx)
    this.pool.push(ctx)
  }

  clear() {
    this.pool.length = 0
    this.#inPool = new WeakSet()
  }
}
