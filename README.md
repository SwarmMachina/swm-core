# @swarmmachina/swm-core

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js Version](https://img.shields.io/badge/node-22.x%20%7C%2024.x-brightgreen)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-1-brightgreen.svg)](#)
[![stability](https://img.shields.io/badge/stability-experimental-yellow.svg)](#)

A high-performance HTTP/WebSocket server built on the
[`@swarmmachina/swm-uws`](https://www.npmjs.com/package/@swarmmachina/swm-uws)
native binding.

## Features

- **Native uWS transport** - HTTP/WebSocket transport through `swm-uws`
- **HTTP + WebSocket** - Both protocols in a single server instance
- **Context pooling** - Minimizes garbage collection overhead
- **Graceful shutdown** - Cleanly closes active connections
- **Streaming support** - Efficient handling of large payloads
- **Auto Content-Type detection** - Automatically sets headers based on response type
- **Modern ES modules** - Native ESM support (Node.js 22 and 24)

## Installation

```bash
# Install the package and its swm-uws runtime dependency
npm install @swarmmachina/swm-core
```

### Runtime requirements

The server depends on the native `@swarmmachina/swm-uws` addon, which
ships platform-specific prebuilds:

- **Node.js 22 or 24** — other majors are rejected by the package engine constraint.
- **Linux x64 with glibc** — use a `bookworm`/`slim` image rather than Alpine/musl.
- **Windows x64** and **macOS arm64/x64** are supported.
- **Linux ARM64, Windows ARM64 and musl are not supported.**
- **TLS and `permessage-deflate` are disabled** in the native binding; terminate
  TLS before the application.

## Native binding regression gate

The runtime is `@swarmmachina/swm-uws@0.5.0`. The regression gate runs
the same `swm-core` HTTP and WebSocket paths against the dev-only
`uWebSockets.js@20.69.0` reference, changing only the native binding.

```bash
npm run test:e2e:bindings
npm run bench:bindings
npm run bench:bindings:deep
```

`bench:bindings` is the CI gate; `bench:bindings:deep` is the longer diagnostic
run. Both use balanced AB/BA ordering and write JSON under `benchmark/profiles/`.
Parameters can be overridden with `BINDING_BENCH_*` or `DEEP_BINDING_*`.

To advance the runtime binding and its upstream reference together, run:

```bash
npm run deps:update:bindings -- 0.5.0 v20.69.0
npm run test:e2e:bindings
```

The updater changes both pins and the lockfile; do not edit them independently.

`SWM_UWS_NATIVE_FAST_PATHS=0` disables native fast paths. A comma-separated list
selects individual paths; `all` also enables experimental paths.

## Quick Start

### Basic HTTP Server

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: {
    onRequest: (ctx) => {
      return { message: 'Hello World' }
    }
  }
})

await server.listen()
console.log('Server listening on port 3000')
```

Keep a request handler synchronous when it has no real asynchronous work. An
`async` handler always enters the Promise path, which preserves request state
for use after the native callback and adds work even when the returned value is
already available:

```javascript
// Prefer this when the result is available immediately.
onRequest: (ctx) => ({ ok: true })

// Use async only when the handler actually awaits asynchronous work.
onRequest: async (ctx) => ({ user: await loadUser(ctx.param('id')) })
```

### Async Work Before Using the Request Body

With the native uWS transport, start the body reader before the first
asynchronous operation if the handler will need the body later. The body is
collected while the user is checked, but it is not parsed or used until the
check succeeds:

```javascript
http: {
  onRequest: async (ctx) => {
    console.log(`http ${ctx.method()} ${ctx.url()}`)

    if (ctx.method() !== 'post') {
      return null // 204 No Content
    }

    // Register the body reader synchronously, before the first await.
    const dataPromise = ctx.text(1024 * 1024) // 1 MB limit, in bytes

    // The body can fail while the database call is still pending. Attach a
    // rejection handler immediately; awaiting the original promise below still
    // propagates the error when the user is allowed.
    void dataPromise.catch(() => {})

    const token = ctx.header('authorization')
    const isBlocked = await checkUserInDatabase(token)

    if (isBlocked) {
      return null // 204 No Content
    }

    const data = JSON.parse(await dataPromise)
    console.log({ data })

    ctx.status(404)
    return { status: false }
  }
}
```

> **Warning:** awaiting any other asynchronous operation before the first call
> to `ctx.body()`, `ctx.buffer()`, `ctx.text()`, or `ctx.json()` can leave that
> body promise waiting indefinitely on the uWS transport because body events may
> already have arrived. The same rule applies to routes with `before`: if
> the handler will read the body, its reader must be started synchronously
> before an asynchronous `before` hook yields. Calling `ctx.text()` returns a
> Promise`.

### HTTP Server with Routing (Traditional API)

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: {
    onRequest: async (ctx) => {
      // Simple routing
      if (ctx.url() === '/' && ctx.method() === 'get') {
        return { message: 'Welcome to the API' }
      }

      if (ctx.url() === '/users' && ctx.method() === 'get') {
        return { users: await getUsers() }
      }

      if (ctx.url() === '/users' && ctx.method() === 'post') {
        const data = await ctx.json()
        return await createUser(data)
      }

      // 404 Not Found
      ctx.status(404)
      return { error: 'Not found' }
    },
    onError: (ctx, error) => {
      console.error('HTTP Error:', error)
    }
  }
})

await server.listen()
```

### HTTP Server with Declarative Routing (`routes` API)

The `routes` API provides method-specific routing, URL parameters and wildcard
matching. Routes are registered directly with uWebSockets.js.

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: {
    routes: [
      {
        method: 'get',
        path: '/',
        handler: () => ({ message: 'Welcome to the API' })
      },
      {
        method: 'get',
        path: '/users',
        handler: async () => ({ users: await getUsers() })
      },
      {
        method: 'get',
        path: '/users/:id',
        handler: (ctx) => {
          const id = ctx.param('id') // or ctx.param(0)
          return getUserById(id)
        }
      },
      {
        method: 'post',
        path: '/users',
        handler: async (ctx) => {
          const data = await ctx.json()
          return await createUser(data)
        }
      },
      {
        method: 'put',
        path: '/users/:id',
        handler: async (ctx) => {
          const id = ctx.param('id')
          const data = await ctx.json()
          return await updateUser(id, data)
        }
      },
      {
        method: 'delete',
        path: '/users/:id',
        handler: (ctx) => {
          const id = ctx.param('id')
          return deleteUser(id)
        }
      }
    ],
    onError: (ctx, error) => {
      console.error('HTTP Error:', error)
    }
  }
})

await server.listen()
```

**Benefits of Declarative Routing:**

- **Direct uWS registration** - Routes are registered with the native engine
- **URL Parameters** - Built-in support for `:param` syntax
- **Cleaner Code** - Declarative route definitions
- **Method-specific** - Automatic HTTP method routing
- **Wildcard catch-all** - A `{ method: 'any', path: '/*' }` route matches anything not matched by a more specific route (useful as a 404 handler or static-file fallback). Specific routes always win over `/*`.

### WebSocket Server

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: {
    onRequest: (ctx) => {
      return { message: 'HTTP endpoint' }
    }
  },
  ws: {
    wsIdleTimeoutSec: 30,
    onUpgrade: (meta) => ({
      isAllowed: true,
      userData: { ip: meta.ip() }
    }),
    onOpen: (ctx) => {
      console.log('Client connected:', ctx.data.ip)
      ctx.send('Welcome!')
    },
    onMessage: (ctx, message, isBinary) => {
      const text = Buffer.from(message).toString()
      console.log('Received:', text)
      ctx.send(`Echo: ${text}`)
    },
    onDropped: (ctx, message, isBinary) => {
      console.warn('Dropped outgoing message for slow client:', message.byteLength, isBinary)
    },
    onClose: (ctx, code, message) => {
      console.log('Client disconnected:', ctx.data.ip)
    },
    onError: (ctx, error) => {
      console.error('WebSocket error:', error)
    }
  }
})

await server.listen()
```

## API Documentation

### Server Constructor

```javascript
new Server(options)
```

**Options:**

| Option          | Type            | Default       | Description                                         |
| --------------- | --------------- | ------------- | --------------------------------------------------- |
| `http`          | `Object`/`null` | `null`        | HTTP application configuration (see below)          |
| `ws`            | `Object`/`null` | `null`        | WebSocket application configuration (see below)     |
| `onServerError` | `Function`      | `() => {}`    | Post-listen transport error handler                 |
| `host`          | `String`        | `'127.0.0.1'` | Address or hostname to bind                         |
| `port`          | `Number`        | `6000`        | Server port (1-65535)                               |
| `maxBodySize`   | `Number`        | `1`           | Max HTTP body / WebSocket payload size in MB (1-64) |

At least one of `http` or `ws` must be an object. A nullish value disables that
application layer. `http: null` with a configured `ws` still creates the minimal
HTTP transport required for WebSocket upgrades; ordinary HTTP requests receive
a fixed `404` without allocating an `HttpContext`.

| `http` | `ws`   | Result                                        |
| ------ | ------ | --------------------------------------------- |
| object | object | HTTP + WebSocket                              |
| object | `null` | HTTP only                                     |
| `null` | object | WebSocket with minimal HTTP upgrade transport |
| `null` | `null` | Configuration error                           |

**HTTP Options (`http` object):**

| Option      | Type       | Default     | Description                                  |
| ----------- | ---------- | ----------- | -------------------------------------------- |
| `onRequest` | `Function` | default 404 | Universal request handler `(ctx) => any`     |
| `routes`    | `Array`    | default 404 | Declarative route definitions                |
| `onError`   | `Function` | `() => {}`  | Request error handler `(ctx, error) => void` |

`http.onRequest` and `http.routes` are mutually exclusive. `http: {}` enables
HTTP with a deterministic default `404` response.

**Route Definition (for `routes` array):**

| Property  | Type               | Description                                                                                              |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `method`  | `String`           | HTTP method: `'get'`, `'post'`, `'put'`, `'delete'`/`'del'`, `'patch'`, `'options'`, `'head'`, `'any'`   |
| `path`    | `String`           | URL path pattern. Supports `:param` segments and a `/*` wildcard catch-all                               |
| `handler` | `Function`         | Handler function `(ctx) => any \| Promise<any>`                                                          |
| `before`  | `Function`/`Array` | Optional. One function or an array, run before `handler` (see [Route before hooks](#route-before-hooks)) |

**WebSocket Options (`ws` object):**

| Option               | Type       | Default                                               | Description                                                                                                                                                                                                                                                              |
| -------------------- | ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wsIdleTimeoutSec`   | `Number`   | `15`                                                  | Idle timeout in seconds (min: 5).                                                                                                                                                                                                                                        |
| `wsUpgradeTimeoutMs` | `Number`   | `10000`                                               | Deadline for an asynchronous `onUpgrade` decision (100-300000 ms).                                                                                                                                                                                                       |
| `onOpen`             | `Function` | `(ctx) => {}`                                         | Called when client connects.                                                                                                                                                                                                                                             |
| `onMessage`          | `Function` | `(ctx, message, isBinary) => {}`                      | Called when message received.                                                                                                                                                                                                                                            |
| `onDropped`          | `Function` | `(ctx, message, isBinary) => {}`                      | Called when an outgoing message is dropped because the connection exceeded its backpressure limit. Copy `message` synchronously if it is needed after the callback returns or across an `await`.                                                                         |
| `onClose`            | `Function` | `(ctx, code, message) => {}`                          | Called when client disconnects.                                                                                                                                                                                                                                          |
| `onDrain`            | `Function` | `(ctx) => {}`                                         | Called when socket is writable again.                                                                                                                                                                                                                                    |
| `onError`            | `Function` | `(ctx, error) => {}`                                  | Called on WebSocket error.                                                                                                                                                                                                                                               |
| `onUpgrade`          | `Function` | `(meta) => ({isAllowed: true, userData?, protocol?})` | Validate WebSocket upgrade. `protocol`, when returned, must exactly match one token from `meta.getHeader('sec-websocket-protocol')`. Call metadata getters synchronously before any `await`; the underlying uWS request is only valid for the synchronous callback.      |
| `onSubscription`     | `Function` | `(ctx, topic, newCount, oldCount) => {}`              | Called on topic subscription change.                                                                                                                                                                                                                                     |
| `connectionKey`      | `Function` | `undefined`                                           | Opt-in. `(ctx) => string \| number \| null`. Derive a stable key (e.g. a user id) so the connection can be addressed via [`server.sendTo()`](#serversendtokey-message-isbinary). Computed once in `onOpen`; return nullish to skip. Unset = no registry (zero overhead). |

`ws: {}` enables WebSocket with permissive upgrades and no-op lifecycle
callbacks. Use `ws: null` (or omit `ws` when `http` is configured) to disable it.

When a client requests WebSocket subprotocols, `onUpgrade` must explicitly
return the selected token as `protocol`. The value must be one of the requested
tokens; raw client input is never reflected automatically.

### Server Methods

#### `server.listen()`

Start the server and begin accepting connections.

```javascript
await server.listen()
```

#### `server.shutdown([timeout])`

Gracefully shutdown the server. Waits for active connections to finish.

```javascript
server.shutdown(10000) // 10 second timeout
```

#### `server.close()`

Forcefully close the server immediately.

```javascript
server.close()
```

#### `server.publish(topic, message, [isBinary])`

Publish message to all WebSocket clients subscribed to a topic.

```javascript
server.publish('news', 'Breaking news!', false)
```

**Returns:** `boolean` - Success status

#### `server.getSubscribersCount(topic)`

Get number of subscribers for a topic.

```javascript
const count = server.getSubscribersCount('news')
```

**Returns:** `number` - Subscriber count

#### `server.sendTo(key, message, [isBinary])`

Send a message directly to the single connection registered under `key` (the
value returned from `ws.connectionKey`). For 1:1 messaging where topic pub/sub
would be overkill. Requires `ws.connectionKey` to be configured.

```javascript
server.sendTo('user-42', 'private message')
```

**Returns:** `boolean` - `true` if a live connection was found and the transport
did not report the message as dropped; `false` when the key is unknown or the
backpressure limit was exceeded.

Keys are matched with strict `Map` identity: `42` and `'42'` are different keys.
Pick one type for `connectionKey` return values and `sendTo()` arguments.

#### `server.hasConnection(key)` / `server.getConnection(key)` / `server.connectionCount`

Inspect the connection registry. `hasConnection` returns a `boolean`;
`getConnection` returns the raw WebSocket handle (or `undefined`);
`connectionCount` is the number of registered connections. The package types
only guarantee the methods declared by `RawWebSocket`; the native handle may
provide additional uWS methods.

```javascript
if (server.hasConnection('user-42')) {
  /* ... */
}
const raw = server.getConnection('user-42') // raw uWS handle or undefined
console.log(server.connectionCount)
```

### HttpContext API

The `ctx` object passed to `http.onRequest` and route handlers:

#### Properties

| Property      | Type      | Description                    |
| ------------- | --------- | ------------------------------ |
| `ctx.replied` | `Boolean` | Whether response has been sent |
| `ctx.aborted` | `Boolean` | Whether request was aborted    |

#### Methods

##### `ctx.method()`

Get request lowercased method.

```javascript
const method = ctx.method()
```

**Returns:** `string`

##### `ctx.url()`

Get request url.

```javascript
const url = ctx.url()
```

**Returns:** `string`

##### `ctx.ip()`

Get client IP address.

```javascript
const ip = ctx.ip()
```

**Returns:** `string`

##### `ctx.query(name)`

Get query parameter value.

```javascript
const page = ctx.query('page') // ?page=1
```

**Returns:** `string | undefined` - `undefined` when the parameter is absent

##### `ctx.fullQuery()`

Get full raw query string.

```javascript
const q = ctx.fullQuery() // page=1&limit=20
```

**Returns:** `string`

##### `ctx.param(indexOrName)`

Get URL parameter by index or name (for pattern matching in the `routes` API).

```javascript
// By index
const id = ctx.param(0) // First parameter

// By name (routes API only)
const id = ctx.param('id') // /users/:id

// Multiple parameters
const userId = ctx.param('userId') // /users/:userId/posts/:postId
const postId = ctx.param('postId')
```

**Returns:** `string | undefined` - `undefined` when the parameter is absent

##### `ctx.header(name)`

Get request header value.

```javascript
const auth = ctx.header('authorization')
```

**Returns:** `string`

##### `ctx.contentLength()`

Get a valid non-negative `Content-Length` value. Returns `null` when the header
is absent or invalid.

```javascript
const length = ctx.contentLength()
```

**Returns:** `number | null`

##### `ctx.body([maxSize])`

Read request body as Buffer.

```javascript
const buffer = await ctx.body()
const buffer = await ctx.body(5 * 1024 * 1024) // 5MB limit
```

**Returns:** `Promise<Buffer>`

##### `ctx.buffer([maxSize])`

Alias for `ctx.body([maxSize])`.

```javascript
const buffer = await ctx.buffer()
```

**Returns:** `Promise<Buffer>`

##### `ctx.json([maxSize])`

Parse request body as JSON.

```javascript
const data = await ctx.json()
```

**Returns:** `Promise<any>`

##### `ctx.text([maxSize])`

Read request body as text.

```javascript
const text = await ctx.text()
```

**Returns:** `Promise<string>`

##### `ctx.status(code)`

Set response status code. Returns context for chaining.

```javascript
ctx.status(201).send({ created: true })
```

**Returns:** `HttpContext`

##### `ctx.setHeader(key, value)`

Set or replace a staged response header. Header names are case-insensitive. Repeated `setHeader()` calls replace previously staged values for the same header. Null or undefined values are silently ignored.

```javascript
ctx.setHeader('x-header-any', 'string-value').status(201).send({ created: true })
```

**Returns:** `HttpContext`

##### `ctx.appendHeader(key, value)`

Append another staged response header line without replacing existing values. Useful for repeated headers such as `Set-Cookie`. Null or undefined values are silently ignored.

```javascript
ctx.appendHeader('set-cookie', 'access=...; Path=/; HttpOnly')
ctx.appendHeader('set-cookie', 'refresh=...; Path=/refresh; HttpOnly')
```

**Returns:** `HttpContext`

##### `ctx.setHeaders(headers)`

Set multiple response headers at once. Equivalent to calling `setHeader()` for each key. Header values may be strings or arrays of strings. A block returned by `prepareHeaders()` is also accepted.

```javascript
ctx.setHeaders({
  'x-request-id': '123',
  'cache-control': 'no-cache',
  'set-cookie': ['a=1; Path=/', 'b=2; Path=/refresh']
})
```

##### `ctx.flushHeaders([headers])`

Flush all staged headers (and optionally stage additional ones) to the underlying response. Called automatically by `reply()` and `startStreaming()` — only needed for advanced use cases.

```javascript
ctx.flushHeaders({ 'x-extra': 'value' })
```

##### `ctx.send(data)`

Send response with automatic content-type detection.

```javascript
ctx.send({ message: 'OK' }) // application/json
ctx.send('Hello') // text/plain
ctx.send(Buffer.from('data')) // application/octet-stream
ctx.send(null) // 204 No Content
```

**Supported types:** Objects and arrays (JSON), strings and other primitive
values (text), `Buffer`/`ArrayBuffer`/typed-array views (binary), and nullish
values (`204 No Content`).

##### `ctx.sendJson(data, [status])`

Send a JSON response with explicit status code. Defaults to `200`.

```javascript
ctx.sendJson({ users: [] })
ctx.sendJson({ error: 'Not found' }, 404)
```

##### `ctx.sendText(text, [status])`

Send a plain text response with explicit status code. Defaults to `200`.

```javascript
ctx.sendText('OK')
ctx.sendText('Created', 201)
```

##### `ctx.sendBuffer(buffer, [status])`

Send a binary response with explicit status code. Defaults to `200`.

```javascript
ctx.sendBuffer(Buffer.from('data'))
ctx.sendBuffer(imageBuffer, 201)
```

##### `ctx.sendError(error)`

Send an error response. If `error.status` is a finite number, uses that as the HTTP status with `error.message` as the body. Otherwise responds with `500 Internal Server Error`.

```javascript
ctx.sendError(new Error('Something broke'))

// With custom status
const err = new Error('Not found')
err.status = 404
ctx.sendError(err)
```

##### `ctx.reply(status, headers, body)`

Send response with full control over status, headers, and body. Header values may be strings or arrays of strings. Array values are written as separate header lines.

```javascript
ctx.reply(
  200,
  {
    'content-type': 'application/json',
    'set-cookie': ['a=1; Path=/', 'b=2; Path=/refresh']
  },
  '{"ok":true}'
)
```

##### `ctx.stream(readable, [status], [headers])`

Stream a readable stream to the response.

```javascript
import fs from 'fs'

const stream = fs.createReadStream('./large-file.mp4')
await ctx.stream(stream, 200, { 'content-type': 'video/mp4' })
```

**Returns:** `Promise<void>`

##### `ctx.startStreaming([status], [headers])`

Start streaming response manually (for advanced use cases). Header values may be strings or arrays of strings.

```javascript
ctx.startStreaming(200, {
  'content-type': 'text/plain',
  'set-cookie': ['a=1; Path=/', 'b=2; Path=/refresh']
})
```

##### `ctx.write(chunk)`

Write chunk to streaming response.

```javascript
const ok = ctx.write('chunk of data')
if (!ok) {
  // backpressure, pause writing
}
```

**Returns:** `boolean` - `false` if backpressure detected

##### `ctx.end([chunk])`

End streaming response.

```javascript
ctx.end('final chunk')
```

##### `ctx.onWritable(callback)`

Register callback to be called when the response stream becomes writable again (for backpressure handling). The callback
receives the current write offset.

```javascript
ctx.onWritable((offset) => {
  // Socket is writable again, can resume writing
  // offset is the current write offset
})
```

**Returns:** `void`

##### `ctx.tryEnd(chunk, totalSize)`

Try to finish a streaming response whose total byte size is known. `totalSize`
is required and is passed to the transport's `tryEnd` implementation.

```javascript
const finalChunk = Buffer.from('final chunk')
const totalSize = ctx.getWriteOffset() + finalChunk.byteLength
const [ok, done] = ctx.tryEnd(finalChunk, totalSize)
if (done) {
  // Response is complete
}
```

**Returns:** `[boolean, boolean]` - `[ok, done]` where `ok` indicates success and `done` indicates completion

##### `ctx.getWriteOffset()`

Get the current write offset (useful for `tryEnd` and backpressure handling).

```javascript
const offset = ctx.getWriteOffset()
```

**Returns:** `number` - Current write offset

### WSContext API

The `ctx` object passed to WebSocket handlers:

#### Properties

| Property   | Type              | Description                                                                                                                                                                                     |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.data` | `Object`          | User data from `onUpgrade` return value (`userData` field)                                                                                                                                      |
| `ctx.ws`   | `RawWebSocket`    | Raw uWS WebSocket handle. Identity-stable for the connection; the exported `RawWebSocket` type documents the supported surface (see [Context lifetime & pooling](#wscontext-lifetime--pooling)) |
| `ctx.key`  | `string`/`number` | Key this connection is registered under (from `connectionKey`), or `null`. Read-only.                                                                                                           |

#### Methods

##### `ctx.send(data, [isBinary])`

Send message to this client.

```javascript
ctx.send('Hello client!')
ctx.send(Buffer.from([1, 2, 3]), true) // binary
```

**Returns:** `number` — send status mirroring uWS: `1` success,
`0` backpressure (queued behind backpressure), `2` dropped (not sent —
backpressure limit exceeded). Check it to react to backpressure.

##### `ctx.end([code], [reason])`

Close this WebSocket connection.

```javascript
ctx.end(1000, 'Goodbye')
```

##### `ctx.subscribe(topic)`

Subscribe this client to a topic.

```javascript
ctx.subscribe('news')
```

**Returns:** `boolean` - Success status

##### `ctx.unsubscribe(topic)`

Unsubscribe this client from a topic.

```javascript
ctx.unsubscribe('news')
```

**Returns:** `boolean` - Success status

##### `ctx.publish(topic, message, [isBinary])`

Publish message to all subscribers of a topic.

```javascript
ctx.publish('news', 'Breaking news!')
```

**Returns:** `boolean` - Success status

##### `ctx.decode(message)`

Decode a received binary message to a UTF-8 string — an opt-in convenience for
the common `Buffer.from(message).toString()`. Not called automatically, so
handlers that work with raw bytes pay nothing.

```javascript
onMessage: (ctx, message) => {
  const text = ctx.decode(message)
}
```

**Returns:** `string`

Call it synchronously inside the handler: uWS neuters the `message`
`ArrayBuffer` at the first `await`/return, so decoding it later throws. Unlike
`ctx`, the `message` argument does **not** survive `await` — decode first, then
await.

#### WSContext lifetime & pooling

`HttpContext` is pooled and reused across requests to minimize GC overhead;
`WSContext` is allocated fresh per connection and **never reused** — that is
what guarantees the fail-loud behavior below. Do not reason about `WSContext`
by analogy to `HttpContext`.

| Context       | Allocated per…            | Valid for…                    | Safe to retain?                              |
| ------------- | ------------------------- | ----------------------------- | -------------------------------------------- |
| `HttpContext` | request (pooled, reused)  | a single request/response     | No — released when the response is finalized |
| `WSContext`   | connection (never reused) | the whole connection lifetime | Yes, for the connection; not past `onClose`  |

- **One instance per connection.** The _same_ `WSContext` is passed to every
  callback of a given connection (`onOpen`, `onMessage`, `onClose`, `onDrain`,
  `onSubscription`). Instances are **not** shared between connections, so `ctx`
  never silently switches sockets — you can hold it across an `await` and use it
  as a stable per-connection identity.
- **Don't use it past `onClose`.** After close the instance is cleared, so a
  retained reference fails loudly (`ws is null`) instead of acting on a stale
  socket. Don't stash `ctx` in a structure that outlives the connection.
- **Address other connections by key, not by `ctx`.** To reach a _different_
  connection (from another handler, a timer, an HTTP route), set `connectionKey`
  and use [`server.sendTo()`](#serversendtokey-message-isbinary), or keep the raw
  `ctx.ws` handle yourself. See
  [Direct messaging between connections](#direct-messaging-between-connections).

## Examples

### REST API with Error Handling

```javascript
import Server from '@swarmmachina/swm-core'

const users = new Map()

const server = new Server({
  port: 3000,
  http: {
    onRequest: async (ctx) => {
      try {
        // GET /users
        if (ctx.url() === '/users' && ctx.method() === 'get') {
          return Array.from(users.values())
        }

        // GET /users/:id
        if (ctx.url().startsWith('/users/') && ctx.method() === 'get') {
          const id = ctx.url().split('/')[2]
          const user = users.get(id)

          if (!user) {
            return ctx.status(404).send({ error: 'User not found' })
          }

          return user
        }

        // POST /users
        if (ctx.url() === '/users' && ctx.method() === 'post') {
          const data = await ctx.json()

          if (!data.name || !data.email) {
            return ctx.status(400).send({ error: 'Missing required fields' })
          }

          const user = { id: Date.now().toString(), ...data }
          users.set(user.id, user)

          return ctx.status(201).send(user)
        }

        // 404
        return ctx.status(404).send({ error: 'Not found' })
      } catch (error) {
        console.error('Route error:', error)
        return ctx.status(500).send({ error: 'Internal server error' })
      }
    },
    onError: (ctx, error) => {
      console.error(`HTTP Error [${ctx.method()} ${ctx.url()}]:`, error)
    }
  }
})

await server.listen()
console.log('REST API running on http://localhost:3000')
```

### File Upload

```javascript
import Server from '@swarmmachina/swm-core'
import fs from 'fs/promises'

const server = new Server({
  port: 3000,
  maxBodySize: 10, // 10 MB
  http: {
    onRequest: async (ctx) => {
      if (ctx.url() === '/upload' && ctx.method() === 'post') {
        const filename = ctx.query('filename') || 'upload.bin'
        const body = await ctx.body()

        await fs.writeFile(`./uploads/${filename}`, body)

        return ctx.status(201).send({
          success: true,
          filename,
          size: body.length
        })
      }

      return ctx.status(404).send({ error: 'Not found' })
    }
  }
})

await server.listen()
```

### File Streaming

```javascript
import Server from '@swarmmachina/swm-core'
import fs from 'fs'

const server = new Server({
  port: 3000,
  http: {
    onRequest: async (ctx) => {
      if (ctx.url() === '/download' && ctx.method() === 'get') {
        const filename = ctx.query('file')

        if (!filename) {
          return ctx.status(400).send({ error: 'Missing file parameter' })
        }

        const stream = fs.createReadStream(`./files/${filename}`)

        await ctx.stream(stream, 200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${filename}"`
        })

        return
      }

      return ctx.status(404).send({ error: 'Not found' })
    }
  }
})

await server.listen()
```

### WebSocket Chat Room

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: null,
  ws: {
    onUpgrade: (meta) => ({
      isAllowed: true,
      userData: { username: meta.getQuery('username') || 'Anonymous' }
    }),
    onOpen: (ctx) => {
      console.log('User joined:', ctx.data.username)
      ctx.subscribe('chat')
      ctx.publish(
        'chat',
        JSON.stringify({
          type: 'join',
          user: ctx.data.username
        })
      )
    },
    onMessage: (ctx, message, isBinary) => {
      const text = Buffer.from(message).toString()

      // Broadcast to all clients in the chat room
      ctx.publish(
        'chat',
        JSON.stringify({
          type: 'message',
          user: ctx.data.username,
          text
        })
      )
    },
    onClose: (ctx, code, message) => {
      console.log('User left:', ctx.data.username)
      ctx.publish(
        'chat',
        JSON.stringify({
          type: 'leave',
          user: ctx.data.username
        })
      )
    }
  }
})

await server.listen()
console.log('Chat server running on ws://localhost:3000')
```

### WebSocket with Authentication

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: null,
  ws: {
    onUpgrade: async (meta) => {
      // Validate token from query or header
      const token = meta.getQuery('token') || meta.getHeader('authorization')

      if (!token) {
        return { isAllowed: false }
      }

      try {
        const user = await validateToken(token)

        return {
          isAllowed: true,
          userData: { userId: user.id, username: user.name }
        }
      } catch (error) {
        return { isAllowed: false }
      }
    },
    onOpen: (ctx) => {
      console.log('Authenticated user:', ctx.data.username)
      ctx.send(`Welcome, ${ctx.data.username}!`)
    },
    onMessage: (ctx, message, isBinary) => {
      const text = Buffer.from(message).toString()
      console.log(`[${ctx.data.username}]:`, text)
    }
  }
})

await server.listen()
```

### Direct messaging between connections

To send a message to a **specific** other connection (1:1), topic pub/sub is
overkill. Set `connectionKey` to give each connection a stable address, then use
`server.sendTo(key, …)`. The registry is maintained automatically (populated in
`onOpen`, cleaned in `onClose`) and only exists when `connectionKey` is set —
nothing happens on the message hot path.

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: null,
  ws: {
    onUpgrade: (meta) => ({
      isAllowed: true,
      userData: { userId: meta.getQuery('userId') }
    }),
    // Address each connection by its user id.
    connectionKey: (ctx) => ctx.data.userId,
    onMessage: (ctx, message) => {
      const { to, text } = JSON.parse(ctx.decode(message))

      // Direct 1:1 message to another connection.
      server.sendTo(to, JSON.stringify({ from: ctx.key, text }))
    }
  }
})

await server.listen()
```

Notes:

- **The key must come from verified identity** (a session, a signed token
  checked in `onUpgrade`) — never from an attacker-controlled value like a raw
  query parameter. With last-write-wins semantics, anyone who can claim an
  arbitrary key can silently take over that address and receive its 1:1
  messages. The example above trusts `userId` only for brevity.
- If two live connections yield the same key, the newer one wins; the older
  socket closing will not evict the newer entry, and the displaced connection's
  `ctx.key` is reset to `null`.
- Keys are compared with strict `Map` identity — `42` and `'42'` are different
  addresses; stick to one type.
- Need low-level control? Use `server.getConnection(key)` and narrow the handle
  to the native uWS socket type. Methods beyond `RawWebSocket` (such as
  `getBufferedAmount()`) are binding-specific.
- Prefer managing your own `Map` instead? Store `ctx.ws` (identity-stable for the
  connection) rather than `ctx`, and delete it in `onClose`.

For 1-to-many fan-out (rooms, channels, broadcasts) prefer topic pub/sub
(`ctx.subscribe` / `ctx.publish` / `server.publish`) instead of addressing
connections individually.

## Advanced Usage

### Graceful Shutdown

```javascript
const server = new Server({
  /* ... */
})
await server.listen()

// Handle shutdown signals
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...')
  server.shutdown(10000) // 10 second timeout
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...')
  server.shutdown(10000)
})
```

### Route before hooks

A route may declare `before` — one function or an array — run before its
`handler` (auth, logging, validation).

```javascript
const requireAuth = (ctx) => {
  if (ctx.header('authorization') !== 'Bearer secret') {
    ctx.status(401).send('Unauthorized') // replying short-circuits the chain
  }
}

const server = new Server({
  http: {
    routes: [
      {
        method: 'get',
        path: '/admin',
        before: requireAuth,
        handler: () => ({ ok: true })
      }
    ]
  }
})
```

- Run in order and stay synchronous until a hook actually returns a Promise;
  replying (`ctx.replied`) stops the chain.
- Composed once at registration — zero per-request cost for routes without one.
- Declarative `http.routes` API only (not `http.onRequest`).

### Custom Response Headers

```javascript
const server = new Server({
  http: {
    onRequest: (ctx) => {
      // Set custom headers
      ctx.setHeader('custom-header', 'value')
      return ctx.reply(
        200,
        {
          'content-type': 'application/json',
          'x-custom-header': 'value',
          'cache-control': 'no-cache'
        },
        JSON.stringify({ ok: true })
      )
    }
  }
})
```

For headers reused across requests, validate and compile them once with
`prepareHeaders()`. The returned opaque block is immutable and can be passed to
`reply()`, `setHeaders()`, streaming methods, or `flushHeaders()`. Dynamic plain
objects and individual header setters continue to validate every value.

```javascript
import Server, { prepareHeaders } from '@swarmmachina/swm-core'

const responseHeaders = prepareHeaders({
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'set-cookie': ['access=...; Path=/; HttpOnly', 'refresh=...; Path=/refresh; HttpOnly']
})

const server = new Server({
  http: {
    onRequest: (ctx) => ctx.reply(200, responseHeaders, JSON.stringify({ ok: true }))
  }
})
```

`prepareHeaders()` copies all values and rejects CR or LF before creating the
trusted block, so later mutation of the source object cannot change responses.

### CORS

`cors(options)` stages CORS headers and replies to preflight (`OPTIONS`) requests.
Call it at the top of a handler; it returns `true` when it handled the preflight.

```javascript
import Server, { cors } from '@swarmmachina/swm-core'

const applyCors = cors({
  origin: 'https://app.example', // default '*'
  credentials: true, // default false
  maxAge: 600 // optional, preflight cache seconds
})

const server = new Server({
  http: {
    routes: [
      {
        method: 'any',
        path: '/*',
        handler: (ctx) => {
          if (applyCors(ctx)) {
            return // preflight handled (204)
          }

          return { ok: true }
        }
      }
    ]
  }
})
```

Options: `origin` (default `'*'`), `methods`, `allowedHeaders`, `credentials`,
`maxAge`. A non-`'*'` `origin` appends `Vary: Origin`; `credentials` requires an
explicit `origin`.

### Serving Static Files

`serveStatic(root, options)` returns a handler for a wildcard `/*` route (specific
routes still take precedence). It guards against path traversal, sets Content-Type
by extension, and caches file contents in memory.

```javascript
import Server, { serveStatic } from '@swarmmachina/swm-core'

const server = new Server({
  http: {
    routes: [
      { method: 'get', path: '/api/health', handler: () => ({ ok: true }) },
      {
        method: 'get',
        path: '/*',
        handler: serveStatic('./public', {
          spa: true, // fall back to index.html for unmatched paths (default false)
          maxAge: 3600 // optional Cache-Control: public, max-age=<seconds>
        })
      }
    ]
  }
})
```

Options: `spa` (fall back to `index`), `index` (default `'index.html'`), `cache`
(default `true`; set `false` in dev to pick up edits), `cacheLimit` (max cached
files, default `128`), `maxAge` (`Cache-Control` seconds). Misses return `404`,
traversal `403`, non-`GET`/`HEAD` `405`.

### Backpressure Handling

```javascript
const server = new Server({
  http: {
    onRequest: async (ctx) => {
      if (ctx.url() === '/stream') {
        ctx.startStreaming(200, { 'content-type': 'text/plain' })

        for (let i = 0; i < 1000; i++) {
          const ok = ctx.write(`Chunk ${i}\n`)

          if (!ok) {
            // Handle backpressure
            await new Promise((resolve) => {
              ctx.onWritable((offset) => {
                resolve(offset)
              })
            })
          }
        }

        ctx.end()
      }
    }
  }
})
```

## Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Regression profiling (CI)

`npm run profile:ci` checks HTTP, body-parser and WebSocket performance against
`benchmark/baselines/*.json`. CI runs it on release tags and manual dispatches.

The self-hosted `regression-gate` runs, in order:

1. regression profile;
2. native-binding comparison;
3. framework comparison (report only);
4. Autobahn conformance.

Reports are uploaded as CI artifacts.

## Release

CI publishes only tags matching the package version (`vX.Y.Z`). The tagged commit
must belong to `master`, and `package.json` and `package-lock.json` must agree.

CI packs once, verifies the tarball and checksum, then publishes that exact
artifact. A retry succeeds only when the existing npm package has the same
integrity. Manual dispatch runs all gates without publishing.

Local release: `npm run release`.

Rollback by moving `latest` to a known-good version and deprecating the bad one.
Never reuse a published version or release tag.

### Self-hosted runner

Use an ephemeral runner in the `swm-ci` group with the `bench` label. Run it as an
unprivileged user, allow only outbound HTTPS, and do not expose production
secrets. Fork pull requests do not use this runner.

Register it from repository Settings → Actions → Runners:

```bash
./config.sh --url https://github.com/<owner>/<repo> --token <RUNNER_TOKEN> --labels bench --ephemeral
sudo ./svc.sh install <user>
sudo ./svc.sh start
```

Use the performance governor and keep the host idle during benchmarks:

```bash
sudo cpupower frequency-set -g performance
```

After changing hardware, recalibrate `benchmark/baselines/*.json` from several
green runs (`min` ≈ low × 0.9; `max` ≈ high × 1.15).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Licensed under the MPL-2.0 License.

Copyright © 2025 SwarmMachina Team

See [LICENSE](LICENSE) file for details.
