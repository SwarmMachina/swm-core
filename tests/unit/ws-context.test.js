// noinspection JSCheckFunctionSignatures

import { describe, test } from 'node:test'
import { strictEqual, deepStrictEqual, throws } from 'node:assert/strict'
import WSContext from '../../src/ws-context.js'

describe('WSContext', () => {
  describe('constructor', () => {
    test('should save pool and initialize server/ws/data to null', () => {
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      strictEqual(ctx.pool, pool)
      strictEqual(ctx.server, null)
      strictEqual(ctx.ws, null)
      strictEqual(ctx.data, null)
    })

    test('should handle null pool', () => {
      const ctx = new WSContext(null)

      strictEqual(ctx.pool, null)
      strictEqual(ctx.server, null)
      strictEqual(ctx.ws, null)
      strictEqual(ctx.data, null)
    })
  })

  describe('reset', () => {
    test('should set server, ws, and data', () => {
      const pool = { release: () => {} }
      const server = { publish: () => {} }
      const ws = { send: () => {}, end: () => {}, subscribe: () => {}, unsubscribe: () => {} }
      const userData = { userId: 123 }

      const ctx = new WSContext(pool)
      const result = ctx.reset(server, ws, userData)

      strictEqual(ctx.server, server)
      strictEqual(ctx.ws, ws)
      strictEqual(ctx.data, userData)
      strictEqual(result, ctx)
    })

    test('should return this for chaining', () => {
      const pool = { release: () => {} }
      const server = { publish: () => {} }
      const ws = { send: () => {}, end: () => {}, subscribe: () => {}, unsubscribe: () => {} }
      const userData = { userId: 456 }

      const ctx = new WSContext(pool)
      const result = ctx.reset(server, ws, userData)

      strictEqual(result, ctx)
    })

    test('should overwrite existing values', () => {
      const pool = { release: () => {} }
      const server1 = { publish: () => {} }
      const server2 = { publish: () => {} }
      const ws1 = { send: () => {}, end: () => {}, subscribe: () => {}, unsubscribe: () => {} }
      const ws2 = { send: () => {}, end: () => {}, subscribe: () => {}, unsubscribe: () => {} }
      const userData1 = { userId: 1 }
      const userData2 = { userId: 2 }

      const ctx = new WSContext(pool)

      ctx.reset(server1, ws1, userData1)

      strictEqual(ctx.server, server1)
      strictEqual(ctx.ws, ws1)
      strictEqual(ctx.data, userData1)

      ctx.reset(server2, ws2, userData2)

      strictEqual(ctx.server, server2)
      strictEqual(ctx.ws, ws2)
      strictEqual(ctx.data, userData2)
    })
  })

  describe('clear', () => {
    test('should reset server/ws/data to null but keep pool', () => {
      const pool = { release: () => {} }
      const server = { publish: () => {} }
      const ws = { send: () => {}, end: () => {}, subscribe: () => {}, unsubscribe: () => {} }
      const userData = { userId: 789 }

      const ctx = new WSContext(pool)

      ctx.reset(server, ws, userData)

      ctx.clear()

      strictEqual(ctx.pool, pool)
      strictEqual(ctx.server, null)
      strictEqual(ctx.ws, null)
      strictEqual(ctx.data, null)
    })

    test('should work on already cleared context', () => {
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.clear()

      strictEqual(ctx.pool, pool)
      strictEqual(ctx.server, null)
      strictEqual(ctx.ws, null)
      strictEqual(ctx.data, null)
    })

    test('after clear, methods should throw again due to null ws/server', () => {
      const pool = { release: () => {} }
      const server = { publish: () => {} }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)
      ctx.clear()

      throws(
        () => {
          ctx.send('x')
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )

      throws(
        () => {
          ctx.end()
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )

      throws(
        () => {
          ctx.subscribe('t')
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )

      throws(
        () => {
          ctx.unsubscribe('t')
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )

      throws(
        () => {
          ctx.publish('t', 'm')
        },
        {
          name: 'Error',
          message: 'WSContext: server is null (did you forget reset?)'
        }
      )
    })
  })

  describe('release', () => {
    test('should call pool.release with context when pool is set', () => {
      const releaseCalls = []
      const pool = {
        release: (ctx) => {
          releaseCalls.push(ctx)
        }
      }
      const ctx = new WSContext(pool)

      ctx.release()

      strictEqual(releaseCalls.length, 1)
      strictEqual(releaseCalls[0], ctx)
    })

    test('should not call anything when pool is null', () => {
      const ctx = new WSContext(null)

      ctx.release()
    })

    test('should call pool.release exactly once per call', () => {
      const releaseCalls = []
      const pool = {
        release: (ctx) => {
          releaseCalls.push(ctx)
        }
      }
      const ctx = new WSContext(pool)

      ctx.release()
      ctx.release()
      ctx.release()

      strictEqual(releaseCalls.length, 3)
      strictEqual(releaseCalls[0], ctx)
      strictEqual(releaseCalls[1], ctx)
      strictEqual(releaseCalls[2], ctx)
    })
  })

  describe('send', () => {
    test('should throw Error when ws is null (no reset)', () => {
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      throws(
        () => {
          ctx.send('test')
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )
    })

    test('should delegate to ws.send with explicit isBinary=true', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 42
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.send('test', true)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, 'test')
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result, 42)
    })

    test('should delegate to ws.send with explicit isBinary=false', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 43
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.send('test', false)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, 'test')
      strictEqual(sendCalls[0].isBinary, false)
      strictEqual(result, 43)
    })

    test('should use isBinary=false for string when not provided', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 44
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.send('hello world')

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, 'hello world')
      strictEqual(sendCalls[0].isBinary, false)
      strictEqual(result, 44)
    })

    test('should use isBinary=true for Buffer when not provided', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 45
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const buffer = Buffer.from('test')
      const result = ctx.send(buffer)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, buffer)
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result, 45)
    })

    test('should use isBinary=true for Uint8Array when not provided', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 46
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const uint8Array = new Uint8Array([1, 2, 3])
      const result = ctx.send(uint8Array)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, uint8Array)
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result, 46)
    })

    test('should use isBinary=true for ArrayBuffer when not provided', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 47
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const arrayBuffer = new Uint8Array([1, 2, 3]).buffer
      const result = ctx.send(arrayBuffer)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, arrayBuffer)
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result, 47)
    })

    test('should throw TypeError for unsupported data type (object)', () => {
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const obj = { key: 'value' }

      throws(
        () => {
          ctx.send(obj)
        },
        {
          name: 'TypeError',
          message: 'WSContext.send: unsupported data type'
        }
      )
    })

    test('should throw TypeError for unsupported data type (number)', () => {
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      throws(
        () => {
          ctx.send(123)
        },
        {
          name: 'TypeError',
          message: 'WSContext.send: unsupported data type'
        }
      )
    })

    test('should return value from ws.send', () => {
      const ws = {
        send: () => 999,
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.send('test')

      strictEqual(result, 999)
    })

    test('should treat DataView as binary and default isBinary=true', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 48
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const view = new DataView(new Uint8Array([1, 2, 3]).buffer)
      const result = ctx.send(view)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, view)
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result, 48)
    })

    test('should pass ArrayBufferView with offset (Uint8Array.subarray) as is, and default isBinary=true', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 49
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const u8 = new Uint8Array([9, 8, 7, 6])
      const sub = u8.subarray(1, 3) // [8,7], byteOffset != 0
      const result = ctx.send(sub)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, sub)
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result, 49)
    })

    test('should not override explicit isBinary argument (even if mismatched with data type)', () => {
      const sendCalls = []
      const ws = {
        send: (data, isBinary) => {
          sendCalls.push({ data, isBinary })
          return 50
        },
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result1 = ctx.send('text', true)

      strictEqual(sendCalls.length, 1)
      strictEqual(sendCalls[0].data, 'text')
      strictEqual(sendCalls[0].isBinary, true)
      strictEqual(result1, 50)

      const buffer = Buffer.from('x')
      const result2 = ctx.send(buffer, false)

      strictEqual(sendCalls.length, 2)
      strictEqual(sendCalls[1].data, buffer)
      strictEqual(sendCalls[1].isBinary, false)
      strictEqual(result2, 50)
    })
  })

  describe('end', () => {
    test('should throw Error when ws is null (no reset)', () => {
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      throws(
        () => {
          ctx.end()
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )
    })

    test('should call ws.end with default code=1000 and reason="" when no args', () => {
      const endCalls = []
      const ws = {
        send: () => {},
        end: (code, reason) => {
          endCalls.push({ code, reason })
        },
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      ctx.end()

      strictEqual(endCalls.length, 1)
      strictEqual(endCalls[0].code, 1000)
      strictEqual(endCalls[0].reason, '')
    })

    test('should call ws.end with provided code and default reason=""', () => {
      const endCalls = []
      const ws = {
        send: () => {},
        end: (code, reason) => {
          endCalls.push({ code, reason })
        },
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      ctx.end(1001)

      strictEqual(endCalls.length, 1)
      strictEqual(endCalls[0].code, 1001)
      strictEqual(endCalls[0].reason, '')
    })

    test('should call ws.end with provided code and reason', () => {
      const endCalls = []
      const ws = {
        send: () => {},
        end: (code, reason) => {
          endCalls.push({ code, reason })
        },
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      ctx.end(1002, 'custom reason')

      strictEqual(endCalls.length, 1)
      strictEqual(endCalls[0].code, 1002)
      strictEqual(endCalls[0].reason, 'custom reason')
    })

    test('should call ws.end multiple times', () => {
      const endCalls = []
      const ws = {
        send: () => {},
        end: (code, reason) => {
          endCalls.push({ code, reason })
        },
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      ctx.end(1000, 'first')
      ctx.end(1001, 'second')

      strictEqual(endCalls.length, 2)
      strictEqual(endCalls[0].code, 1000)
      strictEqual(endCalls[0].reason, 'first')
      strictEqual(endCalls[1].code, 1001)
      strictEqual(endCalls[1].reason, 'second')
    })
  })

  describe('subscribe', () => {
    test('should throw Error when ws is null (no reset)', () => {
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      throws(
        () => {
          ctx.subscribe('topic')
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )
    })

    test('should delegate to ws.subscribe and return result', () => {
      const subscribeCalls = []
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: (topic) => {
          subscribeCalls.push(topic)
          return true
        },
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.subscribe('test-topic')

      strictEqual(subscribeCalls.length, 1)
      strictEqual(subscribeCalls[0], 'test-topic')
      strictEqual(result, true)
    })

    test('should return false when ws.subscribe returns false', () => {
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => false,
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.subscribe('another-topic')

      strictEqual(result, false)
    })

    test('should handle multiple subscribe calls', () => {
      const subscribeCalls = []
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: (topic) => {
          subscribeCalls.push(topic)
          return true
        },
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      ctx.subscribe('topic1')
      ctx.subscribe('topic2')
      ctx.subscribe('topic3')

      strictEqual(subscribeCalls.length, 3)
      deepStrictEqual(subscribeCalls, ['topic1', 'topic2', 'topic3'])
    })
  })

  describe('unsubscribe', () => {
    test('should throw Error when ws is null (no reset)', () => {
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      throws(
        () => {
          ctx.unsubscribe('topic')
        },
        {
          name: 'Error',
          message: 'WSContext: ws is null (did you forget reset?)'
        }
      )
    })

    test('should delegate to ws.unsubscribe and return result', () => {
      const unsubscribeCalls = []
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: (topic) => {
          unsubscribeCalls.push(topic)
          return true
        }
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.unsubscribe('test-topic')

      strictEqual(unsubscribeCalls.length, 1)
      strictEqual(unsubscribeCalls[0], 'test-topic')
      strictEqual(result, true)
    })

    test('should return false when ws.unsubscribe returns false', () => {
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => false
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      const result = ctx.unsubscribe('another-topic')

      strictEqual(result, false)
    })

    test('should handle multiple unsubscribe calls', () => {
      const unsubscribeCalls = []
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: (topic) => {
          unsubscribeCalls.push(topic)
          return true
        }
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset({ publish: () => {} }, ws, null)

      ctx.unsubscribe('topic1')
      ctx.unsubscribe('topic2')
      ctx.unsubscribe('topic3')

      strictEqual(unsubscribeCalls.length, 3)
      deepStrictEqual(unsubscribeCalls, ['topic1', 'topic2', 'topic3'])
    })
  })

  describe('publish', () => {
    test('should throw Error when server is null (no reset)', () => {
      const pool = { release: () => {} }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const ctx = new WSContext(pool)

      ctx.reset(null, ws, null)

      throws(
        () => {
          ctx.publish('topic', 'message')
        },
        {
          name: 'Error',
          message: 'WSContext: server is null (did you forget reset?)'
        }
      )
    })

    test('should delegate to server.publish and return result', () => {
      const publishCalls = []
      const server = {
        publish: (topic, msg, isBinary) => {
          publishCalls.push({ topic, msg, isBinary })
          return true
        }
      }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)

      const result = ctx.publish('test-topic', 'message', false)

      strictEqual(publishCalls.length, 1)
      strictEqual(publishCalls[0].topic, 'test-topic')
      strictEqual(publishCalls[0].msg, 'message')
      strictEqual(publishCalls[0].isBinary, false)
      strictEqual(result, true)
    })

    test('should pass isBinary=true to server.publish', () => {
      const publishCalls = []
      const server = {
        publish: (topic, msg, isBinary) => {
          publishCalls.push({ topic, msg, isBinary })
          return true
        }
      }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)

      const buffer = Buffer.from('binary data')
      const result = ctx.publish('topic', buffer, true)

      strictEqual(publishCalls.length, 1)
      strictEqual(publishCalls[0].topic, 'topic')
      strictEqual(publishCalls[0].msg, buffer)
      strictEqual(publishCalls[0].isBinary, true)
      strictEqual(result, true)
    })

    test('should return false when server.publish returns false', () => {
      const server = {
        publish: () => false
      }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)

      const result = ctx.publish('topic', 'msg', false)

      strictEqual(result, false)
    })

    test('should handle multiple publish calls', () => {
      const publishCalls = []
      const server = {
        publish: (topic, msg, isBinary) => {
          publishCalls.push({ topic, msg, isBinary })
          return true
        }
      }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)

      ctx.publish('topic1', 'msg1', false)
      ctx.publish('topic2', 'msg2', true)
      ctx.publish('topic3', 'msg3', false)

      strictEqual(publishCalls.length, 3)
      strictEqual(publishCalls[0].topic, 'topic1')
      strictEqual(publishCalls[0].msg, 'msg1')
      strictEqual(publishCalls[0].isBinary, false)
      strictEqual(publishCalls[1].topic, 'topic2')
      strictEqual(publishCalls[1].msg, 'msg2')
      strictEqual(publishCalls[1].isBinary, true)
      strictEqual(publishCalls[2].topic, 'topic3')
      strictEqual(publishCalls[2].msg, 'msg3')
      strictEqual(publishCalls[2].isBinary, false)
    })

    test('should pass undefined isBinary when not provided', () => {
      const publishCalls = []
      const server = {
        publish: (topic, msg, isBinary) => {
          publishCalls.push({ topic, msg, isBinary })
          return true
        }
      }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)

      ctx.publish('topic', 'message')

      strictEqual(publishCalls.length, 1)
      strictEqual(publishCalls[0].topic, 'topic')
      strictEqual(publishCalls[0].msg, 'message')
      strictEqual(publishCalls[0].isBinary, undefined)
    })

    test('should allow publishing Buffer and Uint8Array and pass them through unchanged', () => {
      const publishCalls = []
      const server = {
        publish: (topic, msg, isBinary) => {
          publishCalls.push({ topic, msg, isBinary })
          return true
        }
      }
      const ws = {
        send: () => {},
        end: () => {},
        subscribe: () => {},
        unsubscribe: () => {}
      }
      const pool = { release: () => {} }
      const ctx = new WSContext(pool)

      ctx.reset(server, ws, null)

      const buffer = Buffer.from('a')

      ctx.publish('t', buffer)

      strictEqual(publishCalls.length, 1)
      strictEqual(publishCalls[0].topic, 't')
      strictEqual(publishCalls[0].msg, buffer)
      strictEqual(publishCalls[0].isBinary, undefined)

      const uint8Array = new Uint8Array([1, 2])

      ctx.publish('t', uint8Array)

      strictEqual(publishCalls.length, 2)
      strictEqual(publishCalls[1].topic, 't')
      strictEqual(publishCalls[1].msg, uint8Array)
      strictEqual(publishCalls[1].isBinary, undefined)
    })
  })
})
