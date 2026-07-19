const POOLED_BY = Symbol('ContextPool.pooledBy')

export default class ContextPool {
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
      ctx[POOLED_BY] = null

      return ctx
    }

    const created = this.createFn(this)

    created[POOLED_BY] = null

    return created
  }

  /**
   * @param {object} ctx
   */
  release(ctx) {
    if (!ctx || typeof ctx.clear !== 'function') {
      throw new TypeError('ContextPool.release: ctx.clear() is required')
    }

    if (ctx[POOLED_BY] === this) {
      return
    }

    ctx.clear()

    if (this.maxSize === 0) {
      return
    }

    if (this.pool.length >= this.maxSize) {
      return
    }

    ctx[POOLED_BY] = this
    this.pool.push(ctx)
  }

  clear() {
    for (let i = 0; i < this.pool.length; i++) {
      const ctx = this.pool[i]

      if (ctx[POOLED_BY] === this) {
        ctx[POOLED_BY] = null
      }
    }

    this.pool.length = 0
  }
}
