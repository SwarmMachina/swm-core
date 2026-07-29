import type { Readable } from 'node:stream'

/**
 * An HTTP method accepted by a declarative {@link Route}.
 *
 * `del` is an alias for `delete`. `any` registers a catch-all handler for all
 * methods supported by the native transport.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'del' | 'patch' | 'options' | 'head' | 'any'

/**
 * A payload accepted by the HTTP response and streaming APIs.
 *
 * Strings are encoded as UTF-8. Binary views are written using only their
 * visible `byteOffset`/`byteLength` range.
 */
export type HttpBody = string | ArrayBuffer | ArrayBufferView | Buffer

/**
 * A response-header map.
 *
 * Array values emit one header field per item and are intended for repeatable
 * fields such as `Set-Cookie`.
 */
export type HttpHeaders = Record<string, string | string[]>

declare const preparedHeadersBrand: unique symbol

/**
 * An opaque, immutable response-header block created by
 * {@link prepareHeaders}.
 *
 * Prepared headers move validation and normalization out of the response hot
 * path. They cannot be constructed directly.
 */
export interface PreparedHeaders {
  readonly [preparedHeadersBrand]: true
}

/** Header input accepted by response APIs. */
export type ResponseHeaders = HttpHeaders | PreparedHeaders

/**
 * Validates and compiles reusable response headers.
 *
 * @param headers Headers to validate and prepare.
 * @returns An immutable header block that may be reused across requests.
 * @throws {TypeError} If a header name or value is invalid, including values
 * containing CR or LF characters.
 *
 * @example
 * ```ts
 * const headers = prepareHeaders({
 *   'content-type': 'application/json',
 *   'cache-control': 'no-store'
 * })
 *
 * ctx.reply(200, headers, JSON.stringify({ ok: true }))
 * ```
 */
export function prepareHeaders(headers: HttpHeaders): PreparedHeaders

/**
 * An HTTP route or universal request handler.
 *
 * A returned value is sent through {@link HttpContext.send} unless the handler
 * already replied or started a stream. Promise handlers keep the pooled
 * context assigned until the Promise settles.
 */
export type Handler = (ctx: HttpContext) => any | Promise<any>

/** A declarative HTTP route definition. */
export interface Route {
  /** HTTP method matched by the route. */
  method: HttpMethod

  /**
   * Route path.
   *
   * Named parameters use `:name`; a trailing `/*` creates a wildcard route.
   */
  path: string

  /** Handler executed after every `before` hook completes. */
  handler: Handler

  /**
   * A hook or ordered hook chain executed before {@link Route.handler}.
   *
   * Sending a response from a hook short-circuits the remaining hooks and the
   * route handler.
   */
  before?: Handler | Handler[]

  /**
   * Overrides {@link HttpBaseOptions.prefetch} for this route.
   *
   * `true` starts body collection before hooks run. `false` keeps this route
   * lazy even when HTTP-level prefetch is enabled.
   */
  prefetch?: boolean
}

/**
 * Request metadata passed to {@link WSOptions.onUpgrade}.
 *
 * For an asynchronous upgrade, swm-core snapshots URL, query parameters,
 * headers, route parameters, and the remote endpoint before the first `await`.
 */
export interface UpgradeMeta {
  /** Returns the request URL path without the query string. */
  url(): string

  /**
   * Returns the normalized source IP address.
   *
   * @remarks
   * A PROXY Protocol address is network metadata, not authenticated identity.
   * Accept PROXY traffic only from a trusted private ingress.
   */
  ip(): string

  /** Returns a positional route parameter, or `undefined` when absent. */
  getParameter(index: number): string | undefined

  /** Returns the complete query string without a leading `?`. */
  getQuery(): string

  /** Returns the first value for a query key, or `undefined` when absent. */
  getQuery(key: string): string | undefined

  /**
   * Returns a request header value.
   *
   * Header names are case-insensitive. Missing headers produce an empty
   * string, matching the native transport contract.
   */
  getHeader(name: string): string

  /** Becomes `true` when the underlying upgrade request is aborted. */
  aborted: boolean
}

/**
 * The result of a WebSocket upgrade decision.
 *
 * `null` denies the upgrade with HTTP 403. An object accepts the upgrade and
 * is exposed by identity as {@link WSContext.data} for that connection.
 */
export type UpgradeResult = object | null

/** Configuration for the WebSocket protocol layer. */
export interface WSOptions {
  /**
   * Maximum size of one reconstructed incoming WebSocket message, in bytes.
   *
   * The limit applies after fragmented frames are reassembled. Oversized text
   * and binary messages close the connection before `onMessage` runs.
   *
   * @defaultValue `1_048_576` (1 MiB)
   * @remarks Must be a safe integer from `0` through `67_108_864`.
   */
  maxPayloadLength?: number

  /**
   * Maximum queued outbound backpressure for each WebSocket, in bytes.
   *
   * This is a per-socket limit, not a process-wide budget. Process memory may
   * therefore grow approximately with
   * `concurrentSlowSockets * maxBackpressure`, plus transport overhead.
   *
   * @defaultValue `65_536` (64 KiB)
   * @remarks Must be a safe integer from `0` through `4_294_967_295`.
   */
  maxBackpressure?: number

  /**
   * Whether to close a WebSocket after an outbound message exceeds
   * {@link WSOptions.maxBackpressure}.
   *
   * When `false`, the message is dropped and the connection stays open. When
   * `true`, the slow connection is closed after the drop.
   *
   * @defaultValue `true`
   */
  closeOnBackpressureLimit?: boolean

  /**
   * Idle timeout in seconds.
   *
   * @defaultValue `15`
   * @remarks The native transport requires a value of at least `5`.
   */
  idleTimeoutSec?: number

  /**
   * Deadline for an asynchronous upgrade decision, in milliseconds.
   *
   * `0` schedules a zero-delay timeout after the synchronous portion of
   * `onUpgrade`; it does not disable the deadline. An immediately resolved
   * Promise can settle before that timer, while an unresolved Promise is
   * rejected on the next timer turn.
   *
   * @defaultValue `10_000`
   * @remarks Must be a safe integer from `0` through `300_000`.
   */
  upgradeTimeoutMs?: number

  /**
   * Called after a WebSocket connection opens.
   *
   * Throwing or rejecting routes the error to {@link WSOptions.onError}.
   */
  onOpen?: (ctx: WSContext) => any

  /**
   * Called for each complete incoming text or binary message.
   *
   * @remarks
   * `message` is backed by transport-owned storage. Copy it synchronously
   * before retaining it or reading it after an `await`.
   */
  onMessage?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => any

  /**
   * Called when an outgoing message is dropped at the backpressure ceiling.
   *
   * @remarks
   * Copy `message` synchronously if it is needed after this callback returns
   * or across an `await`.
   */
  onDropped?: (ctx: WSContext, message: ArrayBuffer, isBinary: boolean) => any

  /**
   * Called when the peer closes or the transport terminates the connection.
   *
   * `message` contains the close reason bytes. The underlying socket is no
   * longer writable. Throwing or rejecting still allows lifecycle cleanup.
   */
  onClose?: (ctx: WSContext, code: number, message: ArrayBuffer) => any

  /**
   * Called after queued outbound data drains and the socket becomes writable.
   *
   * Inspect `ctx.ws.getBufferedAmount()` before resuming application sends.
   */
  onDrain?: (ctx: WSContext) => any

  /**
   * Receives errors thrown or rejected by WebSocket callbacks.
   *
   * `ctx` is `null` when the error occurs before a connection context exists,
   * for example during upgrade authorization.
   */
  onError?: (ctx: WSContext | null, err: Error) => any

  /**
   * Authorizes an HTTP-to-WebSocket upgrade.
   *
   * Return `null` to deny with 403, or return an object to accept. The exact
   * object is exposed as {@link WSContext.data}. Async handlers receive an owned
   * metadata snapshot and are bounded by {@link WSOptions.upgradeTimeoutMs}.
   *
   * This callback is required so enabling WebSocket can never implicitly allow
   * unauthenticated upgrades. Return an empty object only when anonymous
   * access is an intentional application policy.
   */
  onUpgrade: (meta: UpgradeMeta) => UpgradeResult | Promise<UpgradeResult>

  /**
   * Selects one subprotocol offered by the client.
   *
   * The callback runs synchronously after upgrade authorization. Returning an
   * unrequested token rejects the upgrade; returning `undefined` selects no
   * subprotocol.
   */
  selectProtocol?: (requested: readonly string[], userData: object) => string | undefined

  /**
   * Called when this socket's subscription count for a topic changes.
   *
   * Topic bytes are transport-owned and should be copied before retention.
   */
  onSubscription?: (ctx: WSContext, topic: ArrayBuffer, newCount: number, oldCount: number) => any

  /**
   * Derives an optional stable key used by {@link Server.sendTo}.
   *
   * Called once during open. Return `null` or `undefined` to skip
   * registration. When two live sockets return the same key, the newest socket
   * replaces the older registry entry; it does not close the older socket.
   */
  connectionKey?: (ctx: WSContext) => string | number | null | undefined
}

/** Shared options for either HTTP routing mode. */
export interface HttpBaseOptions {
  /**
   * Starts collecting request bodies before user hooks and handlers run.
   *
   * Prefetch permits code to perform asynchronous authorization before calling
   * `ctx.body()`/`ctx.json()`. It can also collect bodies that application code
   * never consumes, so it remains subject to
   * {@link HttpBaseOptions.maxBodyBudget}.
   *
   * @defaultValue `false`
   */
  prefetch?: boolean

  /**
   * Maximum body size for one HTTP request, in bytes.
   *
   * A valid larger `Content-Length` is rejected before body allocation.
   * Unknown-length bodies are rejected as soon as streaming input exceeds this
   * value. A body accessor may request a smaller limit, but cannot raise this
   * server-level ceiling.
   *
   * @defaultValue `1_048_576` (1 MiB)
   * @remarks Must be a safe integer from `0` through `67_108_864` (64 MiB).
   */
  maxBodySize?: number

  /**
   * Aggregate retained and in-flight HTTP body budget, in bytes.
   *
   * The default applies to both lazy readers and prefetched bodies. Known
   * lengths reserve their declared size; unknown lengths reserve their
   * collection limit. Successful bodies remain charged until request cleanup.
   * Exhaustion rejects the request with HTTP 503.
   *
   * `0` is a real zero-capacity budget. `null` explicitly disables aggregate
   * accounting and should only be used when another layer bounds concurrency
   * and memory.
   *
   * @defaultValue `268_435_456` (256 MiB)
   */
  maxBodyBudget?: number | null

  /**
   * Timeout for asynchronous HTTP hook/handler chains, in milliseconds.
   *
   * A timeout returns HTTP 408, closes the connection, releases body
   * reservations, and ignores late Promise results. It does not cancel the
   * application's Promise; use an `AbortController` for cancellable downstream
   * work.
   *
   * @defaultValue `30_000`
   * @remarks Non-zero values must be from `100` through `300_000`.
   */
  requestTimeoutMs?: number

  /**
   * Handles request parsing, timeout, and application errors.
   *
   * The framework still performs its controlled response and lifecycle
   * cleanup. Errors thrown or rejected by this hook are contained so they
   * cannot escape into native transport callbacks.
   */
  onError?: (ctx: HttpContext, err: Error) => any | Promise<any>
}

/**
 * HTTP application configuration.
 *
 * `onRequest` and `routes` are mutually exclusive. An empty object enables the
 * HTTP layer with a deterministic 404 fallback.
 */
export type HttpOptions = HttpBaseOptions &
  (
    | { onRequest: Handler; routes?: never }
    | { routes: Route[]; onRequest?: never }
    | { onRequest?: never; routes?: never }
  )

/** Options shared by HTTP-only, WebSocket-only, and dual-protocol servers. */
export interface CommonServerOptions {
  /**
   * Handles transport/server errors after construction.
   *
   * @defaultValue A no-op function.
   */
  onServerError?: (err: Error) => any | Promise<any>

  /**
   * Address or hostname on which to listen.
   *
   * @defaultValue `'127.0.0.1'`
   */
  host?: string

  /**
   * TCP port on which to listen.
   *
   * @defaultValue `6000`
   */
  port?: number
}

/**
 * Server construction options.
 *
 * At least one protocol layer must be configured. `null` explicitly disables
 * a layer; an empty object enables that layer with default behavior.
 */
export type ServerOptions = CommonServerOptions &
  ({ http: HttpOptions; ws?: WSOptions | null } | { http?: HttpOptions | null; ws: WSOptions })

/**
 * Provides contextual {@link ServerOptions} typing for a separately declared
 * configuration object.
 *
 * The function returns the same object without cloning, validation, or side
 * effects. Runtime validation still occurs when the object is passed to the
 * {@link Server} constructor. The generic return type preserves literal
 * handler, route, and protocol option types.
 *
 * This helper is primarily useful in JavaScript, where a standalone object
 * literal otherwise has no contextual type and therefore no nested IDE
 * completion.
 *
 * @example
 * ```js
 * import Server, { defineConfig } from '@swarmmachina/swm-core'
 *
 * const options = defineConfig({
 *   http: {
 *     maxBodyBudget: 256 * 1024 * 1024,
 *     onRequest: (ctx) => ({ ip: ctx.ip() })
 *   }
 * })
 *
 * const server = new Server(options)
 * ```
 */
export function defineConfig<const Options extends ServerOptions>(options: Options): Options

/** Normalized HTTP resource settings exposed by {@link Server.effectiveConfig}. */
export interface EffectiveHttpConfig {
  readonly prefetch: boolean
  readonly maxBodySize: number
  readonly maxBodyBudget: number | null
  readonly requestTimeoutMs: number
}

/** Normalized WebSocket resource settings exposed by {@link Server.effectiveConfig}. */
export interface EffectiveWSConfig {
  readonly maxPayloadLength: number
  readonly maxBackpressure: number
  readonly closeOnBackpressureLimit: boolean
  readonly idleTimeoutSec: number
  readonly upgradeTimeoutMs: number
}

/** Immutable snapshot of the server's effective protocol configuration. */
export interface EffectiveServerConfig {
  readonly http: Readonly<EffectiveHttpConfig> | null
  readonly ws: Readonly<EffectiveWSConfig> | null
}

/**
 * Per-request context passed to HTTP handlers.
 *
 * @remarks
 * Contexts are pooled. A context remains valid through the Promise returned by
 * its handler, but must not be retained after that Promise settles. Copy any
 * data needed by background work.
 */
export interface HttpContext {
  /** Whether a response or stream has already started. */
  replied: boolean

  /** Whether the client or server terminated the underlying request. */
  aborted: boolean

  /**
   * Materializes the request body as a `Buffer`.
   *
   * The first body accessor or prefetch operation fixes the collection limit.
   * Later calls share the same collection. A smaller later limit validates the
   * same body; a larger value cannot restart collection or exceed
   * `http.maxBodySize`.
   *
   * @param maxSize Optional per-call ceiling in bytes.
   * @returns A Promise for the complete body.
   * @throws An error with status 413 when the body exceeds the effective limit.
   * @throws An error with status 503 when aggregate body budget is exhausted.
   */
  body(maxSize?: number): Promise<Buffer>

  /** Alias of {@link HttpContext.body}. */
  buffer(maxSize?: number): Promise<Buffer>

  /** Materializes the body and decodes it as UTF-8 text. */
  text(maxSize?: number): Promise<string>

  /**
   * Materializes and parses the body as JSON.
   *
   * Empty input resolves to `null`. Invalid JSON rejects with an HTTP 400
   * application error.
   */
  json<T = any>(maxSize?: number): Promise<T>

  /**
   * Returns the normalized network source IP.
   *
   * @remarks Network metadata is not authenticated identity. PROXY-derived
   * values are safe only behind a trusted ingress.
   */
  ip(): string

  /** Returns the lowercase HTTP request method. */
  method(): string

  /** Returns the URL path without the query string. */
  url(): string

  /** Returns the complete query string without a leading `?`. */
  fullQuery(): string

  /** Returns the first value for a query key, or `undefined`. */
  query(name: string): string | undefined

  /** Returns a positional or named route parameter, or `undefined`. */
  param(indexOrName: number | string): string | undefined

  /**
   * Returns a request header value.
   *
   * Header names are case-insensitive. Missing fields return an empty string.
   */
  header(name: string): string

  /**
   * Returns a strictly parsed non-negative `Content-Length`.
   *
   * Invalid, absent, signed, fractional, or unsafe-integer values return
   * `null` and are handled as unknown-length input by body readers.
   */
  contentLength(): number | null

  /** Sets the status code used by the next response helper. */
  status(code: number): this

  /**
   * Stages a response header, replacing earlier values for the same name.
   *
   * @throws {TypeError} For invalid names or CR/LF-containing values.
   */
  setHeader(key: string, value: string | number): this

  /**
   * Appends another value for a repeatable response header.
   *
   * @throws {TypeError} For invalid names or CR/LF-containing values.
   */
  appendHeader(key: string, value: string | number): this

  /** Stages a header map or prepared header block. */
  setHeaders(headers: ResponseHeaders | null | undefined): void

  /** Writes staged and optional supplied headers to the native response. */
  flushHeaders(headers?: ResponseHeaders | null): void

  /**
   * Sends a value using the default representation.
   *
   * `null`/`undefined` sends 204, strings and numbers send text, binary values
   * send octet-stream, and other values are JSON-serialized.
   */
  send(data: any): void

  /** JSON-serializes and sends a response. */
  sendJson(data: any, status?: number): void

  /** Sends UTF-8 text. */
  sendText(text: string, status?: number): void

  /** Sends binary data as `application/octet-stream`. */
  sendBuffer(buffer: Buffer | Uint8Array | ArrayBuffer, status?: number): void

  /** Sends the framework error representation using `error.status` when set. */
  sendError(error: { status?: number; message?: string } | Error): void

  /** Sends an explicit status, headers, and optional body. */
  reply(status?: number, headers?: ResponseHeaders | null, body?: HttpBody | null): void

  /** Sends a response and closes the HTTP connection after flushing it. */
  replyAndClose(status?: number, headers?: ResponseHeaders | null, body?: HttpBody | null): void

  /** Force-closes the HTTP connection without guaranteeing a response. */
  terminate(): void

  /**
   * Pipes a Node.js readable stream with native response backpressure.
   *
   * @returns A Promise that resolves when streaming completes.
   */
  stream(readable: Readable, status?: number, headers?: ResponseHeaders | null): Promise<void>

  /** Starts a manually managed streaming response. */
  startStreaming(status?: number, headers?: ResponseHeaders | null): this

  /**
   * Writes a streaming chunk.
   *
   * @returns `false` when the caller must wait for {@link onWritable}.
   */
  write(chunk: HttpBody): boolean

  /** Ends a manually managed streaming response. */
  end(chunk?: HttpBody): void

  /** Registers a one-shot callback for native response writability. */
  onWritable(callback: (offset: number) => void): void

  /**
   * Writes a chunk when the final response byte length is known.
   *
   * @returns `[writeSucceeded, responseCompleted]`.
   */
  tryEnd(chunk: HttpBody, totalSize: number): [boolean, boolean]

  /** Returns the number of response bytes accepted by the native transport. */
  getWriteOffset(): number
}

/**
 * Backend-neutral WebSocket send status.
 *
 * - `0`: BACKPRESSURE — accepted but queued behind buffered output.
 * - `1`: SUCCESS — sent without backpressure.
 * - `2`: DROPPED — rejected at the configured backpressure ceiling.
 */
export type WSSendStatus = 0 | 1 | 2

/**
 * Raw WebSocket handle exposed through {@link WSContext.ws}.
 *
 * The interface intentionally avoids exporting binding-specific native types.
 * Its identity is stable for one connection and becomes invalid after close.
 */
export interface RawWebSocket {
  /** Returns the binding-native view of upgrade data. */
  getUserData(): any

  /** Returns currently buffered outbound bytes. */
  getBufferedAmount(): number

  /** Returns the binary remote address. */
  getRemoteAddress(): ArrayBuffer

  /** Returns the textual remote address encoded as bytes. */
  getRemoteAddressAsText(): ArrayBuffer

  /** Returns the remote TCP port. */
  getRemotePort(): number

  /** Tests whether this connection subscribes to a topic. */
  isSubscribed(topic: string): boolean

  /** Returns current topic subscriptions. */
  getTopics(): string[]

  /** Sends a message and reports native backpressure status. */
  send(data: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): WSSendStatus

  /** Sends a WebSocket close frame. */
  end(code?: number, reason?: string): void

  /** Force-closes the connection without a close frame. */
  close(): void

  /** Subscribes the connection to a topic. */
  subscribe(topic: string): boolean

  /** Removes a topic subscription. */
  unsubscribe(topic: string): boolean
}

/** @deprecated Use {@link RawWebSocket}. */
export type UWebSocket = RawWebSocket

/**
 * Per-connection context supplied to WebSocket callbacks.
 *
 * A context is stable across callbacks and `await` boundaries for one
 * connection. It becomes invalid after `onClose` settles.
 */
export interface WSContext {
  /** Exact object returned by {@link WSOptions.onUpgrade}. */
  data: any

  /** Raw handle valid for this connection's lifetime. */
  ws: RawWebSocket

  /** Registry key derived by `connectionKey`, or `null` when unregistered. */
  readonly key: string | number | null

  /** Sends a message and returns native backpressure status. */
  send(data: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): WSSendStatus

  /**
   * Gracefully closes the connection.
   *
   * Close reasons must fit in 123 UTF-8 bytes and the code must be valid for a
   * wire close frame.
   */
  end(code?: number, reason?: string): void

  /** Force-closes the connection without sending a close frame. */
  terminate(): void

  /** Subscribes this connection to a pub/sub topic. */
  subscribe(topic: string): boolean

  /** Unsubscribes this connection from a pub/sub topic. */
  unsubscribe(topic: string): boolean

  /** Publishes a message to every subscriber of a topic. */
  publish(topic: string, message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): boolean

  /** Decodes binary message bytes as UTF-8 without requiring a live socket. */
  decode(message: ArrayBuffer | ArrayBufferView): string
}

/**
 * High-performance HTTP and WebSocket server backed by swm-uws.
 *
 * Construction validates and normalizes all configuration synchronously.
 * Call {@link Server.listen} once to begin accepting connections and
 * {@link Server.shutdown} for graceful termination.
 */
declare class Server {
  /**
   * Creates a server.
   *
   * @throws {TypeError} If no protocol is enabled or an option is invalid.
   */
  constructor(options: ServerOptions)

  /** Effective bind host. */
  readonly host: string

  /** Effective bind port. */
  readonly port: number

  /** Number of HTTP requests whose lifecycle has not completed. */
  readonly activeHttp: number

  /** Number of open WebSocket connections. */
  readonly activeWs: number

  /**
   * Frozen snapshot of normalized resource and timeout configuration.
   *
   * Use this for startup diagnostics instead of reproducing defaulting logic.
   */
  readonly effectiveConfig: Readonly<EffectiveServerConfig>

  /**
   * Starts listening.
   *
   * @returns This server after the native listener is ready.
   * @throws If the address cannot be bound.
   */
  listen(): Promise<this>

  /**
   * Stops accepting new work and waits for active requests and WebSockets.
   *
   * Remaining connections are force-closed when the timeout expires.
   *
   * @param timeout Maximum graceful wait in milliseconds.
   * @defaultValue `10_000`
   */
  shutdown(timeout?: number): Promise<void>

  /** Immediately closes the listener and active native connections. */
  close(): void

  /**
   * Publishes to every WebSocket subscribed to a topic.
   *
   * @returns `true` when the native transport accepted publication.
   */
  publish(topic: string, message: string | ArrayBuffer | Uint8Array | Buffer, isBinary?: boolean): boolean

  /** Returns the number of current subscribers for a topic. */
  getSubscribersCount(topic: string): number

  /**
   * Sends directly to the connection registered under `key`.
   *
   * @returns `true` when a live connection exists and the message was not
   * dropped; otherwise `false`.
   */
  sendTo(key: string | number, message: string | ArrayBuffer | ArrayBufferView, isBinary?: boolean): boolean

  /**
   * Gracefully closes an addressable connection.
   *
   * @returns `false` when no live connection is registered under `key`.
   */
  closeConnection(key: string | number, code?: number, reason?: string): boolean

  /**
   * Force-closes an addressable connection without a close frame.
   *
   * @returns `false` when no live connection is registered under `key`.
   */
  terminateConnection(key: string | number): boolean

  /** Tests whether a live connection is registered under `key`. */
  hasConnection(key: string | number): boolean

  /** Returns the raw registered socket, or `undefined` when absent. */
  getConnection(key: string | number): RawWebSocket | undefined

  /** Number of live entries in the addressable connection registry. */
  readonly connectionCount: number
}

export default Server
export type { Server }

/** CORS middleware options. */
export interface CorsOptions {
  /**
   * Value emitted as `Access-Control-Allow-Origin`.
   *
   * @defaultValue `'*'`
   */
  origin?: string

  /** Value emitted as `Access-Control-Allow-Methods`. */
  methods?: string

  /** Value emitted as `Access-Control-Allow-Headers`. */
  allowedHeaders?: string

  /**
   * Emits `Access-Control-Allow-Credentials: true`.
   *
   * @defaultValue `false`
   */
  credentials?: boolean

  /** Preflight cache lifetime in seconds. */
  maxAge?: number
}

/**
 * Creates a CORS applier.
 *
 * Call the returned function at the beginning of a handler. It returns `true`
 * after replying to an `OPTIONS` preflight request.
 *
 * @throws {TypeError} If credentials are combined with wildcard origin `'*'`.
 */
export function cors(options?: CorsOptions): (ctx: HttpContext) => boolean

/** Static-file handler options. */
export interface ServeStaticOptions {
  /**
   * Falls back to the index file for unmatched paths.
   *
   * @defaultValue `false`
   */
  spa?: boolean

  /**
   * Index filename used for directory and SPA fallbacks.
   *
   * @defaultValue `'index.html'`
   */
  index?: string

  /**
   * Enables the in-memory content cache.
   *
   * @defaultValue `true`
   */
  cache?: boolean

  /**
   * Maximum number of cached files before FIFO eviction.
   *
   * @defaultValue `128`
   */
  cacheLimit?: number

  /** `Cache-Control: public, max-age=<seconds>` lifetime. */
  maxAge?: number
}

/**
 * Creates a handler that serves files below `root`.
 *
 * Mount the returned handler on a wildcard `/*` route. Resolved paths remain
 * confined to `root`; cache storage is bounded by
 * {@link ServeStaticOptions.cacheLimit}.
 */
export function serveStatic(root: string, options?: ServeStaticOptions): (ctx: HttpContext) => Promise<void>
