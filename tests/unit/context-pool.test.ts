// noinspection JSCheckFunctionSignatures

import { describe, test } from 'node:test'
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import ContextPool from '../../src/http/context-pool.js'

interface PoolEntry {
  clear(): void
}

interface TestContext extends PoolEntry {
  id?: number
  pool?: ContextPool<TestContext>
  cleared?: boolean
}

interface PoolInspection<T extends PoolEntry> {
  createFn: (pool: ContextPool<T>) => T
  maxSize: number
  pool: T[]
}

function inspectPool<T extends PoolEntry>(pool: ContextPool<T>): PoolInspection<T> {
  return pool as unknown as PoolInspection<T>
}

function releaseInvalid(pool: ContextPool<TestContext>, value: unknown): void {
  pool.release(value as TestContext)
}

describe('ContextPool', () => {
  describe('constructor', () => {
    test('should create pool with default maxSize', () => {
      let idCounter = 0

      const createFn = () => ({ id: ++idCounter, clear: () => {} })
      const pool = new ContextPool<TestContext>(createFn)

      strictEqual(inspectPool(pool).maxSize, 1000)
      strictEqual(inspectPool(pool).createFn, createFn)
      deepStrictEqual(inspectPool(pool).pool, [])
    })

    test('should create pool with custom maxSize', () => {
      let idCounter = 0

      const createFn = () => ({ id: ++idCounter, clear: () => {} })
      const pool = new ContextPool<TestContext>(createFn, 500)

      strictEqual(inspectPool(pool).maxSize, 500)
      strictEqual(inspectPool(pool).createFn, createFn)
      deepStrictEqual(inspectPool(pool).pool, [])
    })
  })

  describe('acquire', () => {
    test('should create new context when pool is empty', () => {
      let callCount = 0

      const createFn = (pool: ContextPool<TestContext>) => {
        callCount++

        return { id: callCount, pool, clear: () => {} }
      }
      const pool = new ContextPool<TestContext>(createFn)
      const ctx = pool.acquire()

      strictEqual(callCount, 1)
      strictEqual(ctx.id, 1)
      strictEqual(ctx.pool, pool)
      strictEqual(inspectPool(pool).pool.length, 0)
    })

    test('should return context from pool when available', () => {
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({ id: ++idCounter, pool, clear: () => {} })
      const pool = new ContextPool<TestContext>(createFn)
      const ctx1 = pool.acquire()

      ctx1.id = 999
      pool.release(ctx1)

      const ctx2 = pool.acquire()

      strictEqual(ctx2.id, 999)
      strictEqual(ctx2, ctx1)
      strictEqual(inspectPool(pool).pool.length, 0)
    })

    test('should pass pool instance to createFn', () => {
      let receivedPool = null

      const createFn = (pool: ContextPool<TestContext>) => {
        receivedPool = pool

        return { clear: () => {} }
      }
      const pool = new ContextPool<TestContext>(createFn)

      pool.acquire()

      strictEqual(receivedPool, pool)
    })

    test('should allow re-release after acquire (acquire must reset pool tracking)', () => {
      let idCounter = 0

      const createFn = () => ({ id: ++idCounter, clear: () => {} })
      const pool = new ContextPool<TestContext>(createFn, 10)
      const ctx = pool.acquire()

      pool.release(ctx)
      strictEqual(inspectPool(pool).pool.length, 1)

      const same = pool.acquire()

      strictEqual(same, ctx)
      strictEqual(inspectPool(pool).pool.length, 0)

      pool.release(same)
      strictEqual(inspectPool(pool).pool.length, 1)
      strictEqual(inspectPool(pool).pool[0], ctx)
    })
  })

  describe('release', () => {
    test('should throw TypeError when ctx is null', () => {
      const pool = new ContextPool<TestContext>(() => ({ clear: () => {} }))

      throws(
        () => {
          releaseInvalid(pool, null)
        },
        {
          name: 'TypeError',
          message: 'ContextPool.release: ctx.clear() is required'
        }
      )
    })

    test('should throw TypeError when ctx has no clear method', () => {
      const pool = new ContextPool<TestContext>(() => ({ clear: () => {} }))

      throws(
        () => {
          releaseInvalid(pool, {})
        },
        {
          name: 'TypeError',
          message: 'ContextPool.release: ctx.clear() is required'
        }
      )
    })

    test('should throw TypeError when ctx.clear is not a function', () => {
      const pool = new ContextPool<TestContext>(() => ({ clear: () => {} }))

      throws(
        () => {
          releaseInvalid(pool, { clear: 'not a function' })
        },
        {
          name: 'TypeError',
          message: 'ContextPool.release: ctx.clear() is required'
        }
      )
    })

    test('should add context to pool when pool is not full', () => {
      let clearCallCount = 0
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool<TestContext>(createFn, 10)
      const ctx = pool.acquire()

      pool.release(ctx)

      strictEqual(inspectPool(pool).pool.length, 1)
      strictEqual(inspectPool(pool).pool[0], ctx)
      strictEqual(clearCallCount, 1)
    })

    test('should not add context to pool when pool is full but still call clear', () => {
      let clearCallCount = 0
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool<TestContext>(createFn, 2)
      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()
      const ctx3 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)
      pool.release(ctx3)

      strictEqual(inspectPool(pool).pool.length, 2)
      strictEqual(clearCallCount, 3)
      strictEqual(inspectPool(pool).pool.includes(ctx1), true)
      strictEqual(inspectPool(pool).pool.includes(ctx2), true)
      strictEqual(inspectPool(pool).pool.includes(ctx3), false)
    })

    test('should clear once and make duplicate release a no-op', () => {
      let clearCallCount = 0
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool<TestContext>(createFn)
      const ctx = pool.acquire()

      strictEqual(clearCallCount, 0)

      pool.release(ctx)
      strictEqual(clearCallCount, 1)
      strictEqual(inspectPool(pool).pool.length, 1)

      pool.release(ctx)
      strictEqual(clearCallCount, 1)
      strictEqual(inspectPool(pool).pool.length, 1)
    })

    test('should not duplicate context on double release', () => {
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool<TestContext>(createFn, 5)
      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)
      strictEqual(inspectPool(pool).pool.length, 2)

      pool.release(ctx1)
      pool.release(ctx2)
      strictEqual(inspectPool(pool).pool.length, 2)

      pool.release(ctx1)
      strictEqual(inspectPool(pool).pool.length, 2)
    })

    test('should handle multiple acquire/release cycles', () => {
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool<TestContext>(createFn, 5)
      const contexts = []

      for (let i = 0; i < 5; i++) {
        const ctx = pool.acquire()

        contexts.push(ctx)
      }

      for (const ctx of contexts) {
        pool.release(ctx)
      }

      strictEqual(inspectPool(pool).pool.length, 5)

      const reused = pool.acquire()

      strictEqual(inspectPool(pool).pool.length, 4)
      strictEqual(contexts.includes(reused), true)

      pool.release(reused)
      strictEqual(inspectPool(pool).pool.length, 5)
    })

    test('should follow LIFO order', () => {
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool<TestContext>(createFn)
      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()

      ctx1.id = 1001
      ctx2.id = 1002

      pool.release(ctx1)
      pool.release(ctx2)

      const acquired = pool.acquire()

      strictEqual(acquired.id, 1002)
      strictEqual(acquired, ctx2)
    })
  })

  describe('integration', () => {
    test('should reuse contexts efficiently', () => {
      const createdContexts = []

      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => {
        const ctx = {
          id: ++idCounter,
          pool,
          clear: () => {
            ctx.cleared = true
          },
          cleared: false
        }

        createdContexts.push(ctx)

        return ctx
      }
      const pool = new ContextPool<TestContext>(createFn, 3)
      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()
      const ctx3 = pool.acquire()

      strictEqual(createdContexts.length, 3)

      pool.release(ctx1)
      pool.release(ctx2)
      pool.release(ctx3)

      const reused1 = pool.acquire()
      const reused2 = pool.acquire()
      const reused3 = pool.acquire()

      strictEqual(createdContexts.length, 3)
      strictEqual(reused1.cleared, true)
      strictEqual(reused2.cleared, true)
      strictEqual(reused3.cleared, true)
    })

    test('should handle maxSize of 0 and still call clear', () => {
      let clearCallCount = 0
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool<TestContext>(createFn, 0)
      const ctx = pool.acquire()

      pool.release(ctx)

      strictEqual(inspectPool(pool).pool.length, 0)
      strictEqual(clearCallCount, 1)
    })

    test('should handle maxSize of 1', () => {
      let idCounter = 0

      const createFn = (pool: ContextPool<TestContext>) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool<TestContext>(createFn, 1)
      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)

      strictEqual(inspectPool(pool).pool.length, 1)
      strictEqual(inspectPool(pool).pool[0], ctx1)
    })
  })
})
