import HttpContext from '../http-context.js'
import ContextPool from '../context-pool.js'
import { STATUS_TEXT } from '../constants.js'
import { isPromise } from './utils.js'

/**
 * @param {import('@swarmmachina/swm-uws').HttpResponse} res
 */
function sendNotFound(res) {
  res.cork(() => {
    res.writeStatus(STATUS_TEXT[404])
    res.end('Not Found')
  })
}

/**
 * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
 * @param {((ctx: HttpContext) => unknown|Promise<unknown>)|((ctx: HttpContext) => unknown|Promise<unknown>)[]} [before]
 * @returns {(ctx: HttpContext) => unknown|Promise<unknown>}
 */
function composeRouteHandler(handler, before) {
  if (before == null) {
    return handler
  }

  const chain = Array.isArray(before) ? before : [before]

  for (let i = 0; i < chain.length; i++) {
    if (typeof chain[i] !== 'function') {
      throw new TypeError('Route before must be a function or an array of functions')
    }
  }

  if (chain.length === 0) {
    return handler
  }

  return (ctx) => runBeforeChain(ctx, chain, handler, 0)
}

/**
 * Stay synchronous until a hook actually returns a Promise/thenable.
 * @param {HttpContext} ctx
 * @param {((ctx: HttpContext) => unknown|Promise<unknown>)[]} chain
 * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
 * @param {number} start
 * @returns {unknown|Promise<unknown>}
 */
function runBeforeChain(ctx, chain, handler, start) {
  for (let i = start; i < chain.length; i++) {
    const result = chain[i](ctx)

    if (isPromise(result)) {
      return Promise.resolve(result).then(() => {
        if (shouldStopBefore(ctx)) {
          return
        }

        return runBeforeChain(ctx, chain, handler, i + 1)
      })
    }

    if (shouldStopBefore(ctx)) {
      return
    }
  }

  return handler(ctx)
}

/**
 * @param {HttpContext} ctx
 * @returns {boolean}
 */
function shouldStopBefore(ctx) {
  return ctx.done || ctx.aborted || ctx.terminating || (ctx.replied && !ctx.streaming)
}

export default class HttpRuntime {
  #server
  #lifecycle

  constructor(server, lifecycle) {
    this.#server = server
    this.#lifecycle = lifecycle
    this.contextPool = new ContextPool((pool) => new HttpContext(pool), 1000)

    this.register = this.register.bind(this)
  }

  /**
   * @param {HttpContext} ctx
   */
  finalizeHttpContext = (ctx) => {
    if (ctx.asyncPending) {
      ctx.releasePending = true
    } else {
      ctx.release()
    }

    this.#lifecycle.activeHttp--

    if (this.#lifecycle.draining) {
      this.#server.finishShutdownIfNeed()
    }
  }

  /**
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
   * @param {string[]} [paramNames]
   */
  handleWithContext = (res, req, handler, paramNames) => {
    const server = this.#server

    if (this.#lifecycle.draining) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[503])
        res.writeHeader('Connection', 'close')
        res.end()
      })

      return
    }

    this.#lifecycle.activeHttp++

    const ctx = this.contextPool.acquire().reset(res, req, server, server.httpMaxBodyBytes)

    res.onAborted(ctx.onAbort)
    ctx.handlerPending = true

    let result

    try {
      result = handler(ctx)
    } catch (err) {
      if (!ctx.replied) {
        ctx.sendError(err)
      }

      void server.safeCall(server.httpErrorHandler, ctx, err)
      ctx.handlerPending = false

      if (ctx.abortPending) {
        ctx.abortPending = false
        ctx.finalize()
      }

      if (!ctx.done && !ctx.aborted && !ctx.terminating && !ctx.streaming) {
        ctx.finalize()
      }

      return
    }

    const asyncPending = isPromise(result)

    if (asyncPending && !ctx.aborted) {
      ctx.cacheRequest(paramNames)
    }

    ctx.asyncPending = asyncPending
    ctx.handlerPending = false

    if (ctx.abortPending) {
      ctx.abortPending = false
      ctx.finalize()
    }

    if (asyncPending) {
      // eslint-disable-next-line promise/catch-or-return
      result.then(ctx.onResolve, ctx.onReject)

      return
    }

    if (ctx.done || ctx.aborted || ctx.terminating) {
      return
    }

    if (!ctx.replied) {
      try {
        ctx.send(result)
      } catch (err) {
        if (!ctx.replied) {
          ctx.sendError(err)
        }

        void server.safeCall(server.httpErrorHandler, ctx, err)
      }
    }

    if (!ctx.streaming) {
      ctx.finalize()
    }
  }

  /**
   * @param {object} app
   */
  register(app) {
    const server = this.#server
    const handleWithContext = this.handleWithContext

    if (server.http?.routes) {
      for (const route of server.http.routes) {
        const { method, path, handler, before } = route
        const methodName = method === 'delete' ? 'del' : method
        const routeHandler = composeRouteHandler(handler, before)
        const paramNames = path.match(/:[^/]+/g)?.map((name) => name.slice(1)) ?? []

        app[methodName](path, (res, req) => handleWithContext(res, req, routeHandler, paramNames))
      }

      if (!server.http.routes.some(({ method, path }) => method === 'any' && path === '/*')) {
        app.any('/*', sendNotFound)
      }

      return
    }

    if (server.http?.onRequest) {
      const onRequest = server.http.onRequest

      app.any('/*', (res, req) => handleWithContext(res, req, onRequest))

      return
    }

    app.any('/*', sendNotFound)
  }
}
