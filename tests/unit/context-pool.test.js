// noinspection JSCheckFunctionSignatures

import { describe, test } from 'node:test'
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import ContextPool from '../../src/context-pool.js'

describe('ContextPool', () => {
  describe('constructor', () => {
    test('should create pool with default maxSize', () => {
      let idCounter = 0
      const createFn = () => ({ id: ++idCounter })
      const pool = new ContextPool(createFn)

      strictEqual(pool.maxSize, 1000)
      strictEqual(pool.createFn, createFn)
      deepStrictEqual(pool.pool, [])
    })

    test('should create pool with custom maxSize', () => {
      let idCounter = 0
      const createFn = () => ({ id: ++idCounter })
      const pool = new ContextPool(createFn, 500)

      strictEqual(pool.maxSize, 500)
      strictEqual(pool.createFn, createFn)
      deepStrictEqual(pool.pool, [])
    })
  })

  describe('acquire', () => {
    test('should create new context when pool is empty', () => {
      let callCount = 0
      const createFn = (pool) => {
        callCount++
        return { id: callCount, pool, clear: () => {} }
      }
      const pool = new ContextPool(createFn)

      const ctx = pool.acquire()

      strictEqual(callCount, 1)
      strictEqual(ctx.id, 1)
      strictEqual(ctx.pool, pool)
      strictEqual(pool.pool.length, 0)
    })

    test('should return context from pool when available', () => {
      let idCounter = 0
      const createFn = (pool) => ({ id: ++idCounter, pool, clear: () => {} })
      const pool = new ContextPool(createFn)

      const ctx1 = pool.acquire()

      ctx1.id = 'test-id'
      pool.release(ctx1)

      const ctx2 = pool.acquire()

      strictEqual(ctx2.id, 'test-id')
      strictEqual(ctx2, ctx1)
      strictEqual(pool.pool.length, 0)
    })

    test('should pass pool instance to createFn', () => {
      let receivedPool = null
      const createFn = (pool) => {
        receivedPool = pool
        return { clear: () => {} }
      }
      const pool = new ContextPool(createFn)

      pool.acquire()

      strictEqual(receivedPool, pool)
    })

    test('should allow re-release after acquire (acquire must remove ctx from inPool tracking)', () => {
      let idCounter = 0
      const createFn = () => ({ id: ++idCounter, clear: () => {} })
      const pool = new ContextPool(createFn, 10)

      const ctx = pool.acquire()

      pool.release(ctx)
      strictEqual(pool.pool.length, 1)

      const same = pool.acquire()

      strictEqual(same, ctx)
      strictEqual(pool.pool.length, 0)

      pool.release(same)
      strictEqual(pool.pool.length, 1)
      strictEqual(pool.pool[0], ctx)
    })
  })

  describe('release', () => {
    test('should throw TypeError when ctx is null', () => {
      const pool = new ContextPool(() => ({ clear: () => {} }))

      throws(
        () => {
          pool.release(null)
        },
        {
          name: 'TypeError',
          message: 'ContextPool.release: ctx.clear() is required'
        }
      )
    })

    test('should throw TypeError when ctx has no clear method', () => {
      const pool = new ContextPool(() => ({ clear: () => {} }))

      throws(
        () => {
          pool.release({})
        },
        {
          name: 'TypeError',
          message: 'ContextPool.release: ctx.clear() is required'
        }
      )
    })

    test('should throw TypeError when ctx.clear is not a function', () => {
      const pool = new ContextPool(() => ({ clear: () => {} }))

      throws(
        () => {
          pool.release({ clear: 'not a function' })
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
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool(createFn, 10)

      const ctx = pool.acquire()

      pool.release(ctx)

      strictEqual(pool.pool.length, 1)
      strictEqual(pool.pool[0], ctx)
      strictEqual(clearCallCount, 1)
    })

    test('should not add context to pool when pool is full but still call clear', () => {
      let clearCallCount = 0
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool(createFn, 2)

      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()
      const ctx3 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)
      pool.release(ctx3)

      strictEqual(pool.pool.length, 2)
      strictEqual(clearCallCount, 3)
      strictEqual(pool.pool.includes(ctx1), true)
      strictEqual(pool.pool.includes(ctx2), true)
      strictEqual(pool.pool.includes(ctx3), false)
    })

    test('should call clear on context when releasing and be idempotent for pool', () => {
      let clearCallCount = 0
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool(createFn)

      const ctx = pool.acquire()

      strictEqual(clearCallCount, 0)

      pool.release(ctx)
      strictEqual(clearCallCount, 1)
      strictEqual(pool.pool.length, 1)

      pool.release(ctx)
      strictEqual(clearCallCount, 2)
      strictEqual(pool.pool.length, 1)
    })

    test('should not duplicate context on double release', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn, 5)

      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)
      strictEqual(pool.pool.length, 2)

      pool.release(ctx1)
      pool.release(ctx2)
      strictEqual(pool.pool.length, 2)

      pool.release(ctx1)
      strictEqual(pool.pool.length, 2)
    })

    test('should handle multiple acquire/release cycles', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn, 5)

      const contexts = []

      for (let i = 0; i < 5; i++) {
        const ctx = pool.acquire()

        contexts.push(ctx)
      }

      for (const ctx of contexts) {
        pool.release(ctx)
      }

      strictEqual(pool.pool.length, 5)

      const reused = pool.acquire()

      strictEqual(pool.pool.length, 4)
      strictEqual(contexts.includes(reused), true)

      pool.release(reused)
      strictEqual(pool.pool.length, 5)
    })

    test('should follow LIFO order', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn)

      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()

      ctx1.id = 'ctx1'
      ctx2.id = 'ctx2'

      pool.release(ctx1)
      pool.release(ctx2)

      const acquired = pool.acquire()

      strictEqual(acquired.id, 'ctx2')
      strictEqual(acquired, ctx2)
    })
  })

  describe('clear', () => {
    test('should empty the pool', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn)

      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()
      const ctx3 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)
      pool.release(ctx3)

      strictEqual(pool.pool.length, 3)

      pool.clear()

      strictEqual(pool.pool.length, 0)
    })

    test('should work on empty pool', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn)

      pool.clear()

      strictEqual(pool.pool.length, 0)
    })

    test('should reset tracking after clear', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn, 5)

      const ctx = pool.acquire()

      pool.release(ctx)
      strictEqual(pool.pool.length, 1)

      pool.clear()
      strictEqual(pool.pool.length, 0)

      pool.release(ctx)
      strictEqual(pool.pool.length, 1)
    })
  })

  describe('integration', () => {
    test('should reuse contexts efficiently', () => {
      const createdContexts = []
      let idCounter = 0
      const createFn = (pool) => {
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
      const pool = new ContextPool(createFn, 3)

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
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {
          clearCallCount++
        }
      })
      const pool = new ContextPool(createFn, 0)

      const ctx = pool.acquire()

      pool.release(ctx)

      strictEqual(pool.pool.length, 0)
      strictEqual(clearCallCount, 1)
    })

    test('should handle maxSize of 1', () => {
      let idCounter = 0
      const createFn = (pool) => ({
        id: ++idCounter,
        pool,
        clear: () => {}
      })
      const pool = new ContextPool(createFn, 1)

      const ctx1 = pool.acquire()
      const ctx2 = pool.acquire()

      pool.release(ctx1)
      pool.release(ctx2)

      strictEqual(pool.pool.length, 1)
      strictEqual(pool.pool[0], ctx1)
    })
  })
})
