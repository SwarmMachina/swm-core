import HttpContext from '../http-context.js'
import ContextPool from '../context-pool.js'
import { STATUS_TEXT } from '../constants.js'
import { normalizePrefetchHeaders } from './options.js'
import { compileHeaderPrefetchPlan, isPromise } from './utils.js'

import type { HttpRequest, HttpResponse, RequestPrefetchPlan } from '@swarmmachina/swm-uws'
import type { HeaderPrefetch, HttpMethod, NormalizedHttpOptions } from './options.js'

type Handler = (ctx: HttpContext) => unknown | Promise<unknown>
type NativeRouteHandler = (res: HttpResponse, req: HttpRequest) => void
type NativeRouteMethod = (path: string, handler: NativeRouteHandler) => void
type NativeRouteName = Exclude<HttpMethod, 'delete'>

interface HttpApp {
  any: NativeRouteMethod
  del: NativeRouteMethod
  get: NativeRouteMethod
  head: NativeRouteMethod
  options: NativeRouteMethod
  patch: NativeRouteMethod
  post: NativeRouteMethod
  put: NativeRouteMethod
}

interface LifecycleState {
  activeHttp: number
  draining: boolean
}

interface HttpRuntimeServer {
  readonly bindingCapabilities: {
    readonly beginWrite?: boolean
    readonly collectBody?: boolean
    readonly responseBatch?: boolean
  }
  readonly http: NormalizedHttpOptions | null
  readonly httpBodyBudget: {
    tryReserve(bytes: number, owner: object): boolean
    resize(bytes: number, owner: object): boolean
    release(owner: object): void
  } | null
  readonly httpErrorHandler: unknown
  readonly httpMaxBodyBytes: number
  readonly httpRequestTimeoutMs: number
  readonly requestPrefetchPlanClass:
    (new (options: { headers: 'all' | readonly string[] }) => RequestPrefetchPlan) | null
  finalizeHttpContext(context: HttpContext): void
  finishShutdownIfNeed(): void
  safeCall(callback: unknown, ...args: unknown[]): Promise<void>
}

/**
 * @param {import('@swarmmachina/swm-uws').HttpResponse} res
 */
function sendNotFound(res: HttpResponse): void {
  res.cork(() => {
    res.writeStatus(STATUS_TEXT[404]!)
    res.end('Not Found')
  })
}

/**
 * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
 * @param {((ctx: HttpContext) => unknown|Promise<unknown>)|((ctx: HttpContext) => unknown|Promise<unknown>)[]} [before]
 * @returns {(ctx: HttpContext) => unknown|Promise<unknown>}
 */
function composeRouteHandler(handler: Handler, before?: Handler | Handler[]): Handler {
  if (!before) {
    return handler
  }

  const chain = Array.isArray(before) ? before : [before]

  if (chain.length === 0) {
    return handler
  }

  return (ctx: HttpContext) => runBeforeChain(ctx, chain, handler, 0)
}

/**
 * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
 * @returns {(ctx: HttpContext) => unknown|Promise<unknown>}
 */
function withBodyPrefetch(handler: Handler): Handler {
  return (ctx: HttpContext) => {
    const error = ctx.prefetchBody()

    if (error) {
      throw error
    }

    return handler(ctx)
  }
}

/**
 * Stay synchronous until a hook actually returns a Promise/thenable.
 * @param {HttpContext} ctx
 * @param {((ctx: HttpContext) => unknown|Promise<unknown>)[]} chain
 * @param {(ctx: HttpContext) => unknown|Promise<unknown>} handler
 * @param {number} start
 * @returns {unknown|Promise<unknown>}
 */
function runBeforeChain(
  ctx: HttpContext,
  chain: Handler[],
  handler: Handler,
  start: number
): unknown | Promise<unknown> {
  for (let i = start; i < chain.length; i++) {
    const result = chain[i]!(ctx)

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
function shouldStopBefore(ctx: HttpContext): boolean {
  return ctx.done || ctx.aborted || ctx.terminating || (ctx.replied && !ctx.streaming)
}

export default class HttpRuntime {
  #server: HttpRuntimeServer
  #lifecycle: LifecycleState
  readonly contextPool: ContextPool<HttpContext>

  constructor(server: HttpRuntimeServer, lifecycle: LifecycleState) {
    this.#server = server
    this.#lifecycle = lifecycle
    this.contextPool = new ContextPool((pool) => new HttpContext(pool), 1000)

    this.register = this.register.bind(this)
  }

  /**
   * @param {HttpContext} ctx
   */
  finalizeHttpContext = (ctx: HttpContext): void => {
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
   * @param {false|'all'|readonly string[]} [headerSelection]
   * @param {object|null} [headerPlan]
   * @param {number} [maxBodySize]
   */
  handleWithContext = (
    res: HttpResponse,
    req: HttpRequest,
    handler: Handler,
    paramNames?: string[],
    headerSelection: HeaderPrefetch = false,
    headerPlan: RequestPrefetchPlan | null = null,
    maxBodySize?: number
  ): void => {
    const server = this.#server

    if (this.#lifecycle.draining) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[503]!)
        res.writeHeader('Connection', 'close')
        res.end()
      })

      return
    }

    this.#lifecycle.activeHttp++

    const ctx = this.contextPool.acquire().reset(res, req, server, maxBodySize ?? server.httpMaxBodyBytes)

    res.onAborted(ctx.onAbort)
    ctx.handlerPending = true

    let result: unknown

    try {
      if (headerSelection !== false) {
        ctx.attachPrefetchedHeaders(headerSelection, headerPlan)
      }

      result = handler(ctx)
    } catch (err) {
      if (!ctx.replied) {
        ctx.sendError(err as Error)
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
      ctx.startRequestTimeout(server.httpRequestTimeoutMs)

      // eslint-disable-next-line promise/catch-or-return
      Promise.resolve(result).then(ctx.onResolve, ctx.onReject)

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
          ctx.sendError(err as Error)
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
  register(app: HttpApp): void {
    const server = this.#server
    const handleWithContext = this.handleWithContext

    if (server.http?.routes) {
      for (const route of server.http.routes) {
        const { method, path, handler, before, prefetch } = route
        const methodName: NativeRouteName = method === 'delete' ? 'del' : method
        const composedHandler = composeRouteHandler(handler, before)
        const shouldPrefetch = prefetch ?? server.http.prefetch
        const routeHandler = shouldPrefetch ? withBodyPrefetch(composedHandler) : composedHandler
        const paramNames = path.match(/:[^/]+/g)?.map((name) => name.slice(1)) ?? []
        const headerSelection = Object.hasOwn(route, 'prefetchHeaders')
          ? normalizePrefetchHeaders(route.prefetchHeaders, `route ${method.toUpperCase()} ${path} prefetchHeaders`)
          : server.http.prefetchHeaders
        const headerPlan = compileHeaderPrefetchPlan(
          headerSelection,
          server.requestPrefetchPlanClass
        ) as RequestPrefetchPlan | null
        const maxBodySize = route.maxBodySize ?? server.httpMaxBodyBytes

        app[methodName](path, (res, req) =>
          handleWithContext(res, req, routeHandler, paramNames, headerSelection, headerPlan, maxBodySize)
        )
      }

      if (!server.http.routes.some(({ method, path }) => method === 'any' && path === '/*')) {
        app.any('/*', sendNotFound)
      }

      return
    }

    if (server.http?.onRequest) {
      const onRequest = server.http.prefetch ? withBodyPrefetch(server.http.onRequest) : server.http.onRequest
      const headerSelection = server.http.prefetchHeaders
      const headerPlan = compileHeaderPrefetchPlan(
        headerSelection,
        server.requestPrefetchPlanClass
      ) as RequestPrefetchPlan | null

      app.any('/*', (res, req) => handleWithContext(res, req, onRequest, undefined, headerSelection, headerPlan))

      return
    }

    app.any('/*', sendNotFound)
  }
}
