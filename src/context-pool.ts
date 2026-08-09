const POOLED_BY = Symbol('ContextPool.pooledBy')

interface Poolable {
  [POOLED_BY]?: ContextPool<Poolable> | null
  clear(): void
}

export default class ContextPool<T extends Poolable> {
  private readonly createFn: (pool: ContextPool<T>) => T
  private readonly maxSize: number
  private readonly pool: T[]

  constructor(createFn: (pool: ContextPool<T>) => T, maxSize = 1000) {
    this.createFn = createFn
    this.maxSize = maxSize
    this.pool = []
  }

  acquire(): T {
    const ctx = this.pool.pop()

    if (ctx) {
      ctx[POOLED_BY] = null

      return ctx
    }

    const created = this.createFn(this)

    created[POOLED_BY] = null

    return created
  }

  release(ctx: T): void {
    if (!ctx || typeof ctx.clear !== 'function') {
      throw new TypeError('ContextPool.release: ctx.clear() is required')
    }

    if (ctx[POOLED_BY] === (this as unknown as ContextPool<Poolable>)) {
      return
    }

    ctx.clear()

    if (this.maxSize === 0) {
      return
    }

    if (this.pool.length >= this.maxSize) {
      return
    }

    ctx[POOLED_BY] = this as unknown as ContextPool<Poolable>
    this.pool.push(ctx)
  }

  clear(): void {
    for (let i = 0; i < this.pool.length; i++) {
      const ctx = this.pool[i]

      if (!ctx) {
        continue
      }

      if (ctx[POOLED_BY] === (this as unknown as ContextPool<Poolable>)) {
        ctx[POOLED_BY] = null
      }
    }

    this.pool.length = 0
  }
}
