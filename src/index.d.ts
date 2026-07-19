import type { Readable } from 'node:stream'

export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'del' | 'patch' | 'options' | 'head' | 'any'

/** Body payload accepted by response/streaming writers. */
export type HttpBody = string | ArrayBuffer | ArrayBufferView | Buffer

/** Response headers map; values may be a single string or repeated as an array. */
export type HttpHeaders = Record<string, string | string[]>

declare const preparedHeadersBrand: unique symbol

/** Opaque, immutable response-header block validated once by {@link prepareHeaders}. */
export interface PreparedHeaders {
  readonly [preparedHeadersBrand]: true
}

export type ResponseHeaders = HttpHeaders | PreparedHeaders

/** Validate and compile reusable response headers for allocation-free writes on the response hot path. */
export function prepareHeaders(headers: HttpHeaders): PreparedHeaders

/** HTTP route handler. Its return value is sent via `ctx.send()` unless the response was already written. */
export type Handler = (ctx: HttpContext) => any | Promise<any>

export interface Route {
  method: HttpMethod
  path: string
  handler: Handler
  /** One handler or a chain, run before `handler`. Replying short-circuits the chain. Declarative `routes` only. */
  before?: Handler | Handler[]
}

/**
 * Metadata passed to `ws.onUpgrade`. Call these getters synchronously, before
 * any `await` — the underlying request is only valid for the duration of the
 * synchronous callback.
 */
export interface UpgradeMeta {
  url(): string
  ip(): string
  getParameter(index: number): string | undefined
  getQuery(): string
  getQuery(key: string): string | undefined
  getHeader(name: string): string
  aborted: boolean
}

export interface UpgradeResult {
  isAllowed: boolean
  userData?: object
  /** Selected subprotocol. Must be one of the tokens requested by the client. */
  protocol?: string
}

export interface WSOptions {
  wsIdleTimeoutSec?: number
  /** Maximum time allowed for an asynchronous upgrade decision. @default 10000 */
  wsUpgradeTimeoutMs?: number
  onOpen?: (ctx: WSContext) => any
  onMessage?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => any
  /**
   * Called when an outgoing message is dropped because the connection exceeded its backpressure limit.
   * Copy `message` synchronously if it is needed after the callback returns or across an `await`.
   */
  onDropped?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => any
  onClose?: (ctx: WSContext, code: number, message: ArrayBuffer) => any
  onDrain?: (ctx: WSContext) => any
  onError?: (ctx: WSContext | null, err: Error) => any
  onUpgrade?: (meta: UpgradeMeta) => UpgradeResult | Promise<UpgradeResult>
  onSubscription?: (ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number) => any
  /**
   * Optional connection key for `Server.sendTo`.
   *
   * Called once on open. Return `null`/`undefined` to skip registration.
   * Duplicate keys are replaced by the newest live connection; the displaced
   * connection's `ctx.key` resets to `null`.
   */
  connectionKey?: (ctx: WSContext) => string | number | null | undefined
}

export interface HttpBaseOptions {
  onError?: (ctx: HttpContext, err: Error) => any | Promise<any>
}

/** HTTP application layer. `onRequest` and `routes` are mutually exclusive. An empty object enables default 404 responses. */
export type HttpOptions = HttpBaseOptions &
  (
    | { onRequest: Handler; routes?: never }
    | { routes: Route[]; onRequest?: never }
    | { onRequest?: never; routes?: never }
  )

export interface CommonServerOptions {
  /** Transport errors emitted after the server has started listening. */
  onServerError?: (err: Error) => any | Promise<any>
  /** Address or hostname to bind. @default '127.0.0.1' */
  host?: string
  /** @default 6000 */
  port?: number
  /** Max request body size in MB (1-64). @default 1 */
  maxBodySize?: number
}

/** At least one application protocol must be configured. Nullish `http`/`ws` disables that layer. */
export type ServerOptions = CommonServerOptions &
  ({ http: HttpOptions; ws?: WSOptions | null } | { http?: HttpOptions | null; ws: WSOptions })

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
  setHeaders(headers: ResponseHeaders | null | undefined): void
  flushHeaders(headers?: ResponseHeaders | null): void

  send(data: any): void
  sendJson(data: any, status?: number): void
  sendText(text: string, status?: number): void
  sendBuffer(buffer: Buffer | Uint8Array | ArrayBuffer, status?: number): void
  sendError(error: { status?: number; message?: string } | Error): void
  reply(status?: number, headers?: ResponseHeaders | null, body?: HttpBody | null): void

  stream(readable: Readable, status?: number, headers?: ResponseHeaders | null): Promise<void>
  startStreaming(status?: number, headers?: ResponseHeaders | null): this
  write(chunk: HttpBody): boolean
  end(chunk?: HttpBody): void
  onWritable(callback: (offset: number) => void): void
  /** Finish a streaming response with a known total byte size. `totalSize` is required. */
  tryEnd(chunk: HttpBody, totalSize: number): [boolean, boolean]
  getWriteOffset(): number
}

/**
 * Backend-neutral WebSocket send result, mirroring uWebSockets.js `SendStatus`:
 * `0` BACKPRESSURE (queued behind backpressure), `1` SUCCESS, `2` DROPPED
 * (not sent — backpressure limit exceeded). Check it to react to backpressure.
 */
export type WSSendStatus = 0 | 1 | 2

/**
 * Raw per-connection WebSocket handle exposed as {@link WSContext.ws}. Its
 * identity is stable for the connection's lifetime and invalid after close.
 * Typed as an opaque interface so the package does not expose binding-specific
 * uWebSockets.js types in the public API.
 */
export interface RawWebSocket {
  getUserData(): any
  send(data: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): WSSendStatus
  end(code?: number, reason?: string): void
  subscribe(topic: string): boolean
  unsubscribe(topic: string): boolean
}

/** @deprecated Use {@link RawWebSocket}. */
export type UWebSocket = RawWebSocket

/**
 * Per-connection WebSocket context.
 *
 * `WSContext` is reused for all callbacks of one connection and remains valid
 * until `onClose`. It is safe across `await`, but must not be used after close.
 *
 * For cross-connection sends, use `connectionKey` + `Server.sendTo`, or store
 * the raw `ws` handle and remove it on close.
 */
export class WSContext {
  /** User data returned from `ws.onUpgrade`. */
  data: any

  /**
   * Raw per-connection WebSocket handle.
   * Stable for the connection lifetime; invalid after close.
   */
  ws: RawWebSocket

  /** Registered connection key, or `null` when unset. */
  readonly key: string | number | null

  send(data: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): WSSendStatus
  end(code?: number, reason?: string): void
  subscribe(topic: string): boolean
  unsubscribe(topic: string): boolean
  publish(topic: string, message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): boolean
  decode(message: ArrayBuffer | ArrayBufferView): string
}

export default class Server {
  constructor(options: ServerOptions)

  readonly host: string
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
  /**
   * Send a message directly to the single connection registered under `key`
   * (from `ws.connectionKey`). For 1:1 messaging where topic pub/sub is overkill.
   * @returns `true` if a live connection was found and the message was not
   * dropped; `false` when the key is unknown or the transport reported
   * DROPPED (backpressure limit exceeded).
   */
  sendTo(key: string | number, message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): boolean
  /** Whether a live connection is registered under `key`. */
  hasConnection(key: string | number): boolean
  /** Raw uWS socket, or `undefined`. `RawWebSocket` documents the supported surface. */
  getConnection(key: string | number): RawWebSocket | undefined
  /** Number of registered addressable connections. */
  readonly connectionCount: number
}

export interface CorsOptions {
  /** @default '*' */
  origin?: string
  methods?: string
  allowedHeaders?: string
  /** @default false */
  credentials?: boolean
  /** Preflight cache lifetime in seconds. */
  maxAge?: number
}

/**
 * Build a CORS applier. Call it at the top of a handler; it returns `true` when it
 * already replied to a preflight (`OPTIONS`) request. Throws if `credentials` is set
 * together with the wildcard `origin` `'*'`.
 */
export function cors(options?: CorsOptions): (ctx: HttpContext) => boolean

export interface ServeStaticOptions {
  /** Fall back to the index file for unmatched paths. @default false */
  spa?: boolean
  /** @default 'index.html' */
  index?: string
  /** In-memory content cache. @default true */
  cache?: boolean
  /** Max number of cached files (FIFO eviction). @default 128 */
  cacheLimit?: number
  /** `Cache-Control: public, max-age=<seconds>`. */
  maxAge?: number
}

/** Build a handler that serves files from `root`, intended for a wildcard `/*` route. */
export function serveStatic(root: string, options?: ServeStaticOptions): (ctx: HttpContext) => Promise<void>
