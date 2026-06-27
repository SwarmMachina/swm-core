import type { Readable } from 'node:stream'

export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'del' | 'patch' | 'options' | 'head' | 'any'

/** Body payload accepted by response/streaming writers. */
export type HttpBody = string | ArrayBuffer | ArrayBufferView | Buffer

/** Response headers map; values may be a single string or repeated as an array. */
export type HttpHeaders = Record<string, string | string[]>

/** HTTP route handler. Its return value is sent via `ctx.send()` unless the response was already written. */
export type Handler = (ctx: HttpContext) => any | Promise<any>

export interface Route {
  method: HttpMethod
  path: string
  handler: Handler
}

/** Metadata passed to `ws.onUpgrade`. */
export interface UpgradeMeta {
  url(): string
  ip(): string
  getParameter(index: number): string
  getQuery(key?: string): string
  getHeader(name: string): string
  aborted: boolean
}

export interface UpgradeResult {
  isAllowed: boolean
  userData?: object
}

export interface WSOptions {
  enabled?: boolean
  wsIdleTimeoutSec?: number
  onOpen?: (ctx: WSContext) => any
  onMessage?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => any
  onClose?: (ctx: WSContext, code: number, message: ArrayBuffer) => any
  onDrain?: (ctx: WSContext) => any
  onError?: (ctx: WSContext | null, err: Error) => any
  onUpgrade?: (meta: UpgradeMeta) => UpgradeResult | Promise<UpgradeResult>
  onSubscription?: (ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number) => any
}

export interface ServerOptions {
  /** Universal router function (micro-like API). Provide either `router` or `routes`, not both. */
  router?: Handler
  /** Native routing API: an array of route definitions. Provide either `router` or `routes`, not both. */
  routes?: Route[]
  onHttpError?: (ctx: HttpContext, err: Error) => any | Promise<any>
  /** @default 6000 */
  port?: number
  /** Max request body size in MB (1-64). @default 1 */
  maxBodySize?: number
  ws?: WSOptions
}

/** Per-request context passed to HTTP handlers. Instances are pooled and reused. */
export class HttpContext {
  /** Whether a response has already been sent. */
  replied: boolean
  /** Whether the underlying request was aborted by the client. */
  aborted: boolean

  body(maxSize?: number): Promise<Buffer>
  buffer(maxSize?: number): Promise<Buffer>
  text(maxSize?: number): Promise<string>
  json<T = any>(maxSize?: number): Promise<T>

  ip(): string
  method(): string
  url(): string
  fullQuery(): string
  query(name: string): string | undefined
  param(indexOrName: number | string): string | undefined
  header(name: string): string
  contentLength(): number | null

  status(code: number): this
  setHeader(key: string, value: string | number): this
  appendHeader(key: string, value: string | number): this
  setHeaders(headers: HttpHeaders | null | undefined): void
  flushHeaders(headers?: HttpHeaders | null): void

  send(data: any): void
  sendJson(data: any, status?: number): void
  sendText(text: string, status?: number): void
  sendBuffer(buffer: Buffer | Uint8Array | ArrayBuffer, status?: number): void
  sendError(error: { status?: number; message?: string } | Error): void
  reply(status?: number, headers?: HttpHeaders | null, body?: HttpBody | null): void

  stream(readable: Readable, status?: number, headers?: HttpHeaders | null): Promise<void>
  startStreaming(status?: number, headers?: HttpHeaders | null): this
  write(chunk: HttpBody): boolean
  end(chunk?: HttpBody): void
  onWritable(callback: (offset: number) => void): void
  tryEnd(chunk: HttpBody, totalSize?: number): [boolean, boolean]
  getWriteOffset(): number
}

/** Per-connection context passed to WebSocket handlers. Instances are pooled and reused. */
export class WSContext {
  /** User data returned from `ws.onUpgrade` (`userData` field). */
  data: any
  /** Raw uWebSockets.js WebSocket object. */
  ws: any

  send(data: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): number
  end(code?: number, reason?: string): void
  subscribe(topic: string): boolean
  unsubscribe(topic: string): boolean
  publish(topic: string, message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): boolean
}

export default class Server {
  constructor(options: ServerOptions)

  readonly port: number

  /** Start the server and begin accepting connections. */
  listen(): Promise<this>
  /** Gracefully shut down, waiting up to `timeout` ms for active connections to finish. @default 10000 */
  shutdown(timeout?: number): Promise<void>
  /** Forcefully close the server immediately. */
  close(): void
  /** Publish a message to all clients subscribed to `topic`. */
  publish(topic: string, message: string | ArrayBuffer | Uint8Array | Buffer, isBinary?: boolean): boolean
  /** Number of subscribers for a topic. */
  getSubscribersCount(topic: string): number
}
