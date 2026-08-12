import Server from '../../src/index.js'
import { getFreePort } from '@swarmmachina/benchkit'

import type HttpContext from '../../src/http/context.js'
import type { HeaderPrefetch, Handler, HttpOptions, Route, WSOptions } from '../../src/server/options.js'

export interface HttpServerOptions {
  onRequest?: Handler
  routes?: Route[]
  maxBodySize?: number
  maxBodyBudget?: number | null
  requestTimeoutMs?: number
  prefetch?: boolean
  prefetchHeaders?: HeaderPrefetch
  onError?: (context: HttpContext, error: Error) => unknown | Promise<unknown>
}

export interface HttpServerHandle {
  server: Server
  port: number
  baseUrl: string
  close: () => Promise<void>
}

export async function startHttpServer({
  onRequest,
  routes,
  maxBodySize,
  maxBodyBudget,
  requestTimeoutMs,
  prefetch,
  prefetchHeaders,
  onError
}: HttpServerOptions): Promise<HttpServerHandle> {
  const port = await getFreePort()
  const common = {
    ...(maxBodySize !== undefined ? { maxBodySize } : {}),
    ...(maxBodyBudget !== undefined ? { maxBodyBudget } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(prefetch !== undefined ? { prefetch } : {}),
    ...(prefetchHeaders !== undefined ? { prefetchHeaders } : {}),
    ...(onError !== undefined ? { onError } : {})
  }
  const http: HttpOptions =
    onRequest !== undefined ? { ...common, onRequest } : routes !== undefined ? { ...common, routes } : common
  const server = new Server({
    http,
    port
  })

  await server.listen()

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => server.shutdown(1000)
  }
}

type WsServerConfig = Omit<WSOptions, 'onUpgrade'> & { onUpgrade?: WSOptions['onUpgrade'] }

export interface WsServerOptions {
  ws?: WsServerConfig
  onRequest?: Handler
  routes?: Route[]
  maxPayloadLength?: number
}

export interface WsServerHandle {
  server: Server
  port: number
  httpBaseUrl: string
  wsBaseUrl: string
  close: () => Promise<void>
}

export async function startWsServer({
  ws,
  onRequest,
  routes,
  maxPayloadLength
}: WsServerOptions = {}): Promise<WsServerHandle> {
  const port = await getFreePort()
  const http = onRequest !== undefined ? { onRequest } : routes !== undefined ? { routes } : null
  const wsOptions: WSOptions = {
    ...(ws ?? {}),
    ...(maxPayloadLength !== undefined && ws?.maxPayloadLength === undefined ? { maxPayloadLength } : {}),
    onUpgrade: ws?.onUpgrade ?? (() => ({}))
  }
  const server = new Server({
    port,
    http,
    ws: wsOptions
  })

  await server.listen()

  return {
    server,
    port,
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    close: () => server.shutdown(1000)
  }
}
