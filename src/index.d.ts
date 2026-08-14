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
  /** Internal nominal marker preventing structural construction by consumers. */
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
 *
 * @param ctx Per-request HTTP context.
 * @returns A response value or a Promise for one.
 */
export type Handler = (ctx: HttpContext) => any | Promise<any>

/** Request-header retention policy used across an asynchronous native callback boundary. */
export type HeaderPrefetch = false | 'all' | readonly string[]

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

  /**
   * Overrides {@link HttpBaseOptions.prefetchHeaders} for this route.
   *
   * A list retains only those lowercase-normalized fields. `false` retains no
   * request headers automatically, while `'all'` retains every field.
   */
  prefetchHeaders?: HeaderPrefetch

  /**
   * Per-route request-body limit in bytes.
   *
   * The value may lower but cannot exceed {@link HttpBaseOptions.maxBodySize},
   * which remains the server-wide safety ceiling.
   */
  maxBodySize?: number
}

/**
 * Request metadata passed to {@link WSOptions.onUpgrade}.
 *
 * For an asynchronous upgrade, swm-core retains URL, query parameters, route
 * parameters, and the remote endpoint before the first `await`. Header
 * retention follows {@link WSOptions.prefetchHeaders}. Without prefetch, only
 * fields read synchronously before the first `await` remain available.
 */
export interface UpgradeMeta {
  /**
   * Lazy stable view of retained or already-read upgrade-request headers.
   *
   * Reading this property does not enumerate the native request. Without
   * header prefetch it starts empty; successful `getHeader()` calls add their
   * values. Prefetched fields are present immediately. Mutations are local to
   * this materialized view and do not change `getHeader()` results.
   */
  readonly headers: Record<string, string>

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
   * @remarks Must be a safe integer from `1` through `67_108_864`.
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
   * @remarks Must be a safe integer from `8` through `960`.
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
   * Retains selected HTTP upgrade headers before {@link WSOptions.onUpgrade}.
   *
   * When configured, an asynchronous upgrade can read only the retained
   * fields after its first `await`. Synchronous reads remain lazy.
   */
  prefetchHeaders?: HeaderPrefetch

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
   * `message` contains an owned copy of the close reason bytes and remains
   * readable across `await`. The underlying socket is no longer writable.
   * Throwing or rejecting still allows lifecycle cleanup.
   */
  onClose?: (ctx: WSContext, code: number, message: ArrayBuffer) => any

  /**
   * Called when outbound backpressure decreases and the socket can make progress.
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
   * object is exposed as {@link WSContext.data}. Async handlers receive owned
   * request metadata and are bounded by {@link WSOptions.upgradeTimeoutMs}.
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

/** Stable, body-free request metadata passed to asynchronous error delivery. */
export interface HttpErrorEvent {
  /** Unix timestamp in milliseconds at which the framework captured the error. */
  readonly timestamp: number

  /** Lowercase HTTP method reported by the transport. */
  readonly method: string

  /** Request path without the query string. */
  readonly url: string

  /** Status selected for the framework-controlled error response. */
  readonly status: number

  /** Configured `errorDelivery.headers` that were present on the request. */
  readonly headers: Readonly<Record<string, string>>

  /** Configured `errorDelivery.query` parameters that were present on the request. */
  readonly query: Readonly<Record<string, string>>

  /** Client address when `errorDelivery.includeIp` is enabled. */
  readonly ip?: string
}

/** Per-attempt controls for asynchronous error delivery. */
export interface HttpErrorDeliveryContext {
  /** Aborted when the delivery timeout or the server shutdown deadline expires. */
  readonly signal: AbortSignal
}

/** Bounded asynchronous error-delivery policy. */
export interface HttpErrorDeliveryOptions {
  /** Maximum simultaneously executing callbacks. @defaultValue `4` */
  concurrency?: number

  /** Maximum callbacks waiting behind active delivery. @defaultValue `256` */
  queueLimit?: number

  /** Deadline for aborting a callback; its slot remains occupied until settlement. @defaultValue `5_000` */
  timeoutMs?: number

  /** Request-header allowlist copied into each error event. @defaultValue `[]` */
  headers?: readonly string[]

  /**
   * Case-sensitive query-parameter allowlist copied into each error event.
   *
   * @defaultValue `[]`
   * @remarks At most 100 unique names; each name must contain 1 through 256 characters.
   */
  query?: readonly string[]

  /** Resolve and copy the client address for error events. @defaultValue `false` */
  includeIp?: boolean
}

/** Point-in-time diagnostics for the server's HTTP error dispatcher. */
export interface HttpErrorDeliveryStats {
  /** Callbacks that have started but have not settled, including timed-out callbacks. */
  readonly inFlight: number

  /** Events waiting for a dispatcher slot. */
  readonly queued: number

  /** Callbacks that settled successfully before their deadline. */
  readonly completed: number

  /** Callbacks whose deadline elapsed before settlement. */
  readonly timedOut: number

  /** Active callbacks aborted by forced server shutdown before settlement. */
  readonly aborted: number

  /** Callbacks that threw or rejected before their deadline. */
  readonly rejected: number

  /** Events discarded because every active and queued slot was occupied. */
  readonly dropped: number

  /** Age of the oldest unsettled callback, or `null` when none are active. */
  readonly oldestInFlightMs: number | null
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
   * Retains request headers in native-owned storage before handlers run.
   *
   * A list retains only those fields, `false` explicitly disables automatic
   * header retention, and `'all'` retains every field. When omitted, no
   * headers are retained automatically.
   */
  prefetchHeaders?: HeaderPrefetch

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
   * Before a response starts, a timeout returns HTTP 408 and closes the
   * connection. After an early response, it finalizes the request without
   * sending a second response. In both cases it releases body reservations and
   * ignores late Promise results. It does not cancel the application's Promise;
   * use an `AbortController` for cancellable downstream work.
   *
   * @defaultValue `30_000`
   * @remarks Non-zero values must be from `100` through `300_000`.
   */
  requestTimeoutMs?: number

  /**
   * Bounds asynchronous observability work and selects request metadata.
   *
   * Selected headers are retained independently of `prefetchHeaders`, but do
   * not become readable through `HttpContext` unless that policy also selects
   * them. Selected query names are matched case-sensitively. The complete query
   * string and request body are never copied into error events.
   */
  errorDelivery?: HttpErrorDeliveryOptions

  /**
   * Handles request parsing, timeout, and application errors.
   *
   * The framework first copies a compact immutable event, then releases the
   * request context independently of this callback. Delivery is concurrency-
   * and queue-bounded. Rejections, timeouts, and overflow are exposed through
   * {@link Server.httpErrorDeliveryStats}.
   */
  onError?: (event: HttpErrorEvent, err: Error, context: HttpErrorDeliveryContext) => any | Promise<any>
}

/**
 * HTTP application configuration.
 *
 * `onRequest` and `routes` are mutually exclusive. An empty object enables the
 * HTTP layer with a deterministic 404 fallback.
 */
export type HttpOptions = HttpBaseOptions &
  (
    | {
        /** Universal handler invoked for every HTTP request. */
        onRequest: Handler
        /** Declarative routes cannot be combined with `onRequest`. */
        routes?: never
      }
    | {
        /** Declarative route table. */
        routes: Route[]
        /** A universal handler cannot be combined with `routes`. */
        onRequest?: never
      }
    | {
        /** Omit to enable the deterministic HTTP 404 fallback. */
        onRequest?: never
        /** Omit to enable the deterministic HTTP 404 fallback. */
        routes?: never
      }
  )

/** Explicit trust boundary for a listener reached only through known reverse proxies. */
export interface TrustedProxyOptions {
  /** Header written or sanitized by the trusted proxy. */
  header: 'x-forwarded-for' | 'x-real-ip'

  /** Address selected from the right of `X-Forwarded-For`; `1` is the rightmost entry. */
  hops?: number
}

/** Native HTTP parser and connection timeout policy applied by swm-uws. */
export interface HttpTransportOptions {
  /** Request line plus all request header fields, in bytes. */
  maxHeaderSize?: number

  /** Maximum number of request header fields. */
  maxHeaderCount?: number

  /** Deadline for receiving a complete request head. */
  headersTimeoutMs?: number

  /** Idle time while waiting for the next keep-alive request. */
  keepAliveTimeoutMs?: number

  /** Idle timeout while receiving request body bytes. */
  bodyIdleTimeoutMs?: number

  /** Minimum sustained body receive rate, or `null` to disable it. */
  minBodyRateBytesPerSec?: number | null

  /** Timeout for a response blocked by outbound backpressure. */
  responseWriteTimeoutMs?: number

  /**
   * Trusts one forwarded-address header for this listener.
   *
   * Leave unset on public listeners. The nearest proxy must overwrite or
   * sanitize the configured header before forwarding the request.
   */
  trustedProxy?: Readonly<TrustedProxyOptions>
}

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

  /**
   * Optional per-server native HTTP transport policy.
   *
   * Requires a swm-uws binding advertising `httpTransportConfig`.
   */
  transport?: HttpTransportOptions
}

/** Legacy top-level options rejected by the v5 constructor contract. */
type RemovedServerOptions = {
  /** @deprecated The backend is fixed to swm-uws and cannot be configured. */
  backend?: never

  /** @deprecated Use `http.maxBodySize` or `ws.maxPayloadLength`. */
  maxBodySize?: never

  /** @deprecated Use `http.onError`. */
  onHttpError?: never

  /** @deprecated Use `http.prefetch`. */
  prefetch?: never

  /** @deprecated Use `http.routes`. */
  router?: never

  /** @deprecated Use `http.routes`. */
  routes?: never
}

/**
 * Server construction options.
 *
 * At least one protocol layer must be configured. `null` explicitly disables
 * a layer; an empty object enables that layer with default behavior.
 */
export type ServerOptions = CommonServerOptions &
  RemovedServerOptions &
  (
    | {
        /** HTTP protocol configuration. */
        http: HttpOptions
        /** Optional WebSocket protocol configuration; `null` disables it. */
        ws?: WSOptions | null
      }
    | {
        /** Optional HTTP protocol configuration; `null` disables it. */
        http?: HttpOptions | null
        /** WebSocket protocol configuration. */
        ws: WSOptions
      }
  )

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
 * @param options Configuration object to type without cloning it.
 * @returns The same configuration object.
 *
 * @example
 * ```js
 * import Server, { defineConfig } from '@swarmmachina/swm-core'
 *
 * const options = defineConfig({
 *   http: {
 *     maxBodyBudget: 256 * 1024 * 1024,
 *     onRequest: (ctx) => ({ ip: ctx.getIP() })
 *   }
 * })
 *
 * const server = new Server(options)
 * ```
 */
export function defineConfig<const Options extends ServerOptions>(options: Options): Options

/** Normalized HTTP resource settings exposed by {@link Server.effectiveConfig}. */
export interface EffectiveHttpConfig {
  /** Whether body collection starts before the HTTP handler runs. */
  readonly prefetch: boolean

  /** Effective request-header retention policy. */
  readonly prefetchHeaders: HeaderPrefetch

  /** Effective per-request body limit in bytes. */
  readonly maxBodySize: number

  /** Effective aggregate body budget in bytes, or `null` when disabled. */
  readonly maxBodyBudget: number | null

  /** Effective asynchronous request deadline in milliseconds. */
  readonly requestTimeoutMs: number

  /** Effective bounded error-delivery policy, or `null` when `onError` is absent. */
  readonly errorDelivery: Readonly<Required<HttpErrorDeliveryOptions>> | null
}

/** Normalized WebSocket resource settings exposed by {@link Server.effectiveConfig}. */
export interface EffectiveWSConfig {
  /** Effective maximum reconstructed incoming message size in bytes. */
  readonly maxPayloadLength: number

  /** Effective per-socket outbound backpressure limit in bytes. */
  readonly maxBackpressure: number

  /** Whether exceeding the backpressure limit closes the socket. */
  readonly closeOnBackpressureLimit: boolean

  /** Effective idle timeout in seconds. */
  readonly idleTimeoutSec: number

  /** Effective asynchronous upgrade deadline in milliseconds. */
  readonly upgradeTimeoutMs: number

  /** Effective WebSocket upgrade-header retention policy. */
  readonly prefetchHeaders: HeaderPrefetch
}

/** Immutable snapshot of the server's effective protocol configuration. */
export interface EffectiveServerConfig {
  /** Effective HTTP configuration, or `null` when HTTP is disabled. */
  readonly http: Readonly<EffectiveHttpConfig> | null

  /** Effective native transport overrides, or `null` when defaults are used. */
  readonly transport: Readonly<HttpTransportOptions> | null

  /** Effective WebSocket configuration, or `null` when WebSocket is disabled. */
  readonly ws: Readonly<EffectiveWSConfig> | null
}

/** Native binding extensions selected for this process. */
export interface NativeCapabilities {
  /** Supports batched native response-header writes. */
  readonly beginWrite: boolean

  /** Supports native bounded request-body collection. */
  readonly collectBody: boolean

  /** Supports collection with a transport-validated body length. */
  readonly collectBodyLength?: boolean

  /** Supports per-server native HTTP parser and timeout configuration. */
  readonly httpTransportConfig: boolean

  /** Supports pausing and resuming native request-body reads. */
  readonly requestPause: boolean

  /** Supports selective native request-metadata retention. */
  readonly requestPrefetch: boolean

  /** Supports native response batching. */
  readonly responseBatch: boolean
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
  /**
   * Lazy stable view of retained or already-read request headers.
   *
   * Reading this property does not enumerate the native request. Without
   * header prefetch it starts empty; successful {@link HttpContext.getReqHeader}
   * calls add their values. Prefetched fields are present immediately, and
   * {@link HttpContext.getHeaders} fills the view with the complete set.
   * Mutations are local to the view and do not change `getReqHeader()` results.
   */
  readonly headers: Record<string, string>

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
  getIP(): string

  /** Returns the lowercase HTTP request method. */
  getMethod(): string

  /** Returns the URL path without the query string. */
  getUrl(): string

  /** Returns the complete query string without a leading `?`. */
  getQuery(): string

  /** Returns the first value for a query key, or `undefined`. */
  getQuery(name: string): string | undefined

  /** Returns a positional or named route parameter, or `undefined`. */
  getParameter(indexOrName: number | string): string | undefined

  /**
   * Returns a request header value.
   *
   * Header names are case-insensitive. Missing fields return an empty string.
   */
  getReqHeader(name: string): string

  /**
   * Returns a shallow copy of all request headers.
   *
   * Header names are lowercase and the returned object has a `null`
   * prototype. This operation is independent of selective header prefetch.
   * It also fills the stable {@link HttpContext.headers} view with the complete
   * set while returning a separate shallow copy.
   * After an async boundary, it requires an earlier synchronous call or
   * `prefetchHeaders: 'all'`; otherwise it throws an error with code
   * `REQUEST_HEADERS_NOT_RETAINED` instead of returning a partial set.
   */
  getHeaders(): Record<string, string>

  /**
   * Returns a strictly parsed non-negative `Content-Length`.
   *
   * Invalid, absent, signed, fractional, or unsafe-integer values return
   * `null` and are handled as unknown-length input by body readers.
   */
  getContentLength(): number | null

  /** Sets the status code used by the next response helper. */
  setStatus(code: number): this

  /**
   * Stages a response header, replacing earlier values for the same name.
   *
   * Array values emit one header field per item, preserving order. `Cookie`
   * values follow node:http and are joined with `; `.
   *
   * @throws {TypeError} For invalid names or CR/LF-containing values.
   */
  setHeader(key: string, value: string | number | readonly string[]): this

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

  /** Frozen point-in-time diagnostics for bounded HTTP error delivery. */
  readonly httpErrorDeliveryStats: Readonly<HttpErrorDeliveryStats>

  /**
   * Frozen snapshot of normalized resource and timeout configuration.
   *
   * Use this for startup diagnostics instead of reproducing defaulting logic.
   */
  readonly effectiveConfig: Readonly<EffectiveServerConfig>

  /**
   * Advertised native extensions after `SWM_UWS_NATIVE_FAST_PATHS` selection.
   * Populated when {@link listen} loads the binding.
   */
  readonly bindingCapabilities: Readonly<NativeCapabilities>

  /**
   * Starts listening.
   *
   * @returns This server after the native listener is ready.
   * @throws If the address cannot be bound.
   */
  listen(): Promise<this>

  /**
   * Stops accepting new work and waits for active requests, WebSockets, and
   * accepted HTTP error-delivery jobs.
   *
   * When the timeout expires, remaining connections are force-closed, queued
   * error events are dropped, and active error-delivery signals are aborted.
   *
   * @param timeout Maximum graceful wait in milliseconds.
   * @defaultValue `10_000`
   */
  shutdown(timeout?: number): Promise<void>

  /** Immediately closes native connections and aborts bounded HTTP error delivery. */
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
 * @param options CORS response policy.
 * @returns A request-level CORS applier.
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
   * Maximum number of cached files before LRU eviction.
   *
   * @defaultValue `128`
   */
  cacheLimit?: number

  /**
   * Maximum total bytes retained by the in-memory LRU.
   *
   * @defaultValue `67108864` (64 MiB)
   */
  cacheByteLimit?: number

  /**
   * Maximum size of one file loaded into memory. Larger files are treated as
   * misses; stream them explicitly with {@link HttpContext.stream} instead.
   *
   * @defaultValue `16777216` (16 MiB)
   */
  maxFileSize?: number

  /**
   * Maximum bytes read concurrently across distinct cache misses. Identical
   * simultaneous misses share one read. Must be at least `maxFileSize` when
   * both values are set.
   *
   * @defaultValue The larger of `67108864` (64 MiB) and `maxFileSize`.
   */
  maxInflightBytes?: number

  /**
   * Maximum number of distinct filesystem loads in progress. Identical
   * simultaneous misses share one slot. `0` rejects every uncached load with
   * `503 Service Unavailable`.
   *
   * @defaultValue `32`
   */
  maxInflightFiles?: number

  /** `Cache-Control: public, max-age=<seconds>` lifetime. */
  maxAge?: number
}

/**
 * Creates a handler that serves files below `root`.
 *
 * Mount the returned handler on a wildcard `/*` route. Resolved paths remain
 * confined to the canonical `root`; file reads and cache storage are bounded
 * by byte limits as well as {@link ServeStaticOptions.cacheLimit}.
 *
 * @param root Static root directory.
 * @param options Static-file cache and admission policy.
 * @returns An asynchronous HTTP handler.
 */
export function serveStatic(root: string, options?: ServeStaticOptions): (ctx: HttpContext) => Promise<void>
