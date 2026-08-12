# @swarmmachina/swm-core

[![CI](https://github.com/SwarmMachina/swm-core/actions/workflows/ci.yml/badge.svg)](https://github.com/SwarmMachina/swm-core/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-1-brightgreen.svg)](#runtime-requirements)
[![stability](https://img.shields.io/badge/stability-experimental-orange.svg)](#stability)

A high-performance HTTP/WebSocket server built on the
[`@swarmmachina/swm-uws`](https://www.npmjs.com/package/@swarmmachina/swm-uws)
native binding.

## Features

- **Native uWS transport** - HTTP/WebSocket transport through `swm-uws`.
- **HTTP + WebSocket** - Both protocols in a single server instance.
- **Context pooling** - Minimizes garbage collection overhead.
- **Graceful shutdown** - Cleanly closes active connections.
- **Streaming support** - Efficient handling of large payloads.
- **Auto Content-Type detection** - Automatically sets headers based on response type.
- **Modern ES modules** - Native ESM support for Node.js 22 and 24.

## Installation

```bash
# Install the package and its swm-uws runtime dependency
pnpm add @swarmmachina/swm-core
```

### Migrating from 4.x

Version 5 removes the short request aliases that duplicated the explicit
`HttpContext` API. Update calls as follows:

| 4.x alias                          | 5.x method               |
| ---------------------------------- | ------------------------ |
| `ctx.getHeader(name)` / `header()` | `ctx.getReqHeader(name)` |
| `ctx.ip()`                         | `ctx.getIP()`            |
| `ctx.method()`                     | `ctx.getMethod()`        |
| `ctx.url()`                        | `ctx.getUrl()`           |
| `ctx.fullQuery()`                  | `ctx.getQuery()`         |
| `ctx.query(name)`                  | `ctx.getQuery(name)`     |
| `ctx.param(name)`                  | `ctx.getParameter(name)` |
| `ctx.contentLength()`              | `ctx.getContentLength()` |
| `ctx.status(code)`                 | `ctx.setStatus(code)`    |

The package now publishes compiled files from `dist/`. Root imports remain
unchanged; unsupported deep imports from `@swarmmachina/swm-core/src/*` must be
replaced with exports from the package root.

### Runtime requirements

The server depends on the native `@swarmmachina/swm-uws` addon, which
ships platform-specific prebuilds:

- **Node.js 22 or 24** — other majors are rejected by the package engine constraint.
- **Linux x64 with glibc** — use a `bookworm`/`slim` image rather than Alpine/musl.
- **Windows x64** and **macOS arm64/x64** are supported.
- **Linux ARM64, Windows ARM64 and musl are not supported.**
- **TLS and `permessage-deflate` are disabled** in the native binding; terminate
  TLS before the application.

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
onRequest: async (ctx) => ({ user: await loadUser(ctx.getParameter('id')) })
```

### Async Work Before Using the Request Body

The default request body mode is `lazy`. With the native uWS transport, a lazy
body reader must be started before the first asynchronous operation. Enable the
opt-in `prefetch` mode when a handler should be able to authenticate a user in a
database before it asks for the body:

```javascript
const server = new Server({
  http: {
    prefetch: true,

    // Body-size values are expressed in bytes. The omitted maxBodyBudget uses
    // the finite 256 MiB process-wide default in both lazy and prefetch modes.
    maxBodySize: 16 * 1024 * 1024, // 16 MiB per request

    onRequest: async (ctx) => {
      if (ctx.getMethod() !== 'post') {
        return null
      }

      const token = ctx.getReqHeader('authorization')
      const user = await findUserByToken(token)

      if (!user) {
        ctx.setStatus(401)
        return { error: 'Unauthorized' }
      }

      // Safe after await: raw bytes have been collected by the framework.
      // JSON parsing itself remains lazy and happens here.
      const data = await ctx.json()

      return { userId: user.id, data }
    }
  }
})
```

Declarative routes can enable or disable prefetch individually. An omitted
route `prefetch` inherits `http.prefetch`:

```javascript
const server = new Server({
  http: {
    routes: [
      {
        method: 'post',
        path: '/users',
        prefetch: true,
        before: async (ctx) => {
          const user = await findUserByToken(ctx.getReqHeader('authorization'))

          if (!user) {
            ctx.setStatus(401).send({ error: 'Unauthorized' })
            return
          }

          ctx.user = user
        },
        handler: async (ctx) => ({ user: ctx.user, data: await ctx.json() })
      }
    ]
  }
})
```

Prefetch starts collecting raw bytes before `before` and `handler` run. It does
not eagerly decode text or parse JSON. The trade-off is additional work for
requests that never use their body and memory proportional to concurrent
request bodies. `http.maxBodySize` bounds one request; `http.maxBodyBudget`
bounds aggregate retained and in-flight body storage. When the budget is
omitted, `swm-core` applies the same finite 256 MiB safety-net in both lazy and
prefetch modes. Use `null` only as an intentional opt-out.

When keeping the default lazy mode, start the reader manually before the first
`await`. The body is then collected while the user is checked, but it is not
parsed or used until the check succeeds:

```javascript
http: {
  onRequest: async (ctx) => {
    console.log(`http ${ctx.getMethod()} ${ctx.getUrl()}`)

    if (ctx.getMethod() !== 'post') {
      return null // 204 No Content
    }

    // Register the body reader synchronously, before the first await.
    const dataPromise = ctx.text(1024 * 1024) // 1 MiB limit, expressed in bytes

    // The body can fail while the database call is still pending. Attach a
    // rejection handler immediately; awaiting the original promise below still
    // propagates the error when the user is allowed.
    void dataPromise.catch(() => {})

    const token = ctx.getReqHeader('authorization')
    const isBlocked = await checkUserInDatabase(token)

    if (isBlocked) {
      return null // 204 No Content
    }

    const data = JSON.parse(await dataPromise)
    console.log({ data })

    ctx.setStatus(404)
    return { status: false }
  }
}
```

> **Warning (lazy mode):** call `ctx.body()`, `ctx.buffer()`, `ctx.text()`, or
> `ctx.json()` before awaiting any other asynchronous work. Otherwise uWS body
> events may arrive before the reader is registered, leaving its Promise pending.
> A route handler runs too late to guarantee this after an asynchronous `before`.
> Either enable `prefetch`, or start the reader synchronously inside `before`,
> before its first `await`, and retain the returned Promise for the handler.

### HTTP Server with Routing (Traditional API)

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  http: {
    onRequest: async (ctx) => {
      // Simple routing
      if (ctx.getUrl() === '/' && ctx.getMethod() === 'get') {
        return { message: 'Welcome to the API' }
      }

      if (ctx.getUrl() === '/users' && ctx.getMethod() === 'get') {
        return { users: await getUsers() }
      }

      if (ctx.getUrl() === '/users' && ctx.getMethod() === 'post') {
        const data = await ctx.json()
        return await createUser(data)
      }

      // 404 Not Found
      ctx.setStatus(404)
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
          const id = ctx.getParameter('id') // or ctx.getParameter(0)
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
          const id = ctx.getParameter('id')
          const data = await ctx.json()
          return await updateUser(id, data)
        }
      },
      {
        method: 'delete',
        path: '/users/:id',
        handler: (ctx) => {
          const id = ctx.getParameter('id')
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
    maxPayloadLength: 1024 * 32, // 32 KiB per incoming message, in bytes
    maxBackpressure: 1024 * 64, // 64 KiB per slow WebSocket, in bytes
    closeOnBackpressureLimit: true,
    idleTimeoutSec: 30,
    onUpgrade: (meta) => ({ ip: meta.ip() }),
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

| Option          | Type            | Default       | Description                                     |
| --------------- | --------------- | ------------- | ----------------------------------------------- |
| `http`          | `Object`/`null` | `null`        | HTTP application configuration (see below)      |
| `ws`            | `Object`/`null` | `null`        | WebSocket application configuration (see below) |
| `transport`     | `Object`/`null` | `null`        | Explicit native HTTP parser/connection policy   |
| `onServerError` | `Function`      | `() => {}`    | Post-listen transport error handler             |
| `host`          | `String`        | `'127.0.0.1'` | Address or hostname to bind                     |
| `port`          | `Number`        | `6000`        | Server port (1-65535)                           |

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

| Option             | Type                       | Default     | Description                                                          |
| ------------------ | -------------------------- | ----------- | -------------------------------------------------------------------- |
| `maxBodySize`      | `Number`                   | `1048576`   | Maximum HTTP request body size in bytes (1 MiB default, 64 MiB max). |
| `maxBodyBudget`    | `Number`/`null`            | `268435456` | Aggregate retained/in-flight body-memory budget in bytes (256 MiB).  |
| `requestTimeoutMs` | `Number`                   | `30000`     | Async handler timeout in ms (100-300000); explicit `0` disables it.  |
| `prefetch`         | `Boolean`                  | `false`     | Collect request bodies before user handlers run.                     |
| `prefetchHeaders`  | `false`/`'all'`/`String[]` | omitted     | Retain selected request headers before handlers run.                 |
| `onRequest`        | `Function`                 | default 404 | Universal request handler `(ctx) => any`                             |
| `routes`           | `Array`                    | default 404 | Declarative route definitions                                        |
| `onError`          | `Function`                 | `() => {}`  | Request error handler `(ctx, error) => void`                         |

`http.onRequest` and `http.routes` are mutually exclusive. `http: {}` enables
HTTP with a deterministic default `404` response.

`prefetchHeaders` is independent from body `prefetch`. A string list is
normalized once and retains only those fields in native-owned storage. `false`
explicitly retains none and `'all'` retains every field. When the option is
omitted, no headers are retained automatically. Fields remain readable
synchronously and successful reads populate `ctx.headers`, but they are
unavailable after the native callback returns unless read and cached before
detach. Use a selective list for the usual async case and `'all'` only when the
complete set is actually required after an `await`.

`ctx.headers` is a stable view of headers already retained or read. Accessing it
does not enumerate the native request: without header prefetch it starts empty,
and each successful `ctx.getReqHeader(name)` adds that field. `ctx.getHeaders()`
collects the complete set and fills the same view.

```javascript
new Server({
  http: {
    prefetchHeaders: ['authorization', 'traceparent'],
    onRequest: async (ctx) => {
      await authorize(ctx.headers.authorization)
      return { trace: ctx.headers.traceparent }
    }
  }
})
```

The native binding capability is checked during `listen()`. Configuration
fails instead of silently falling back to a full JavaScript header scan.

**Native HTTP transport options (`transport` object):**

| Option                   | Type            | Description                                      |
| ------------------------ | --------------- | ------------------------------------------------ |
| `maxHeaderSize`          | `Number`        | Request line plus all request headers, in bytes. |
| `maxHeaderCount`         | `Number`        | Maximum number of request header fields.         |
| `headersTimeoutMs`       | `Number`        | Deadline for receiving a complete request head.  |
| `keepAliveTimeoutMs`     | `Number`        | Idle wait for the next keep-alive request.       |
| `bodyIdleTimeoutMs`      | `Number`        | Idle timeout while receiving request body bytes. |
| `minBodyRateBytesPerSec` | `Number`/`null` | Minimum body receive rate; `null` disables it.   |
| `responseWriteTimeoutMs` | `Number`        | Timeout for outbound backpressure stalls.        |

Only explicitly configured values are passed to `swm-uws`; binding defaults
remain binding-owned. Transport values are positive safe integers, timeout
values are capped at 300000 ms, and `maxHeaderCount` is capped at the native
capacity of 100.

`http.maxBodySize` and `ws.maxPayloadLength` are independent. Changing one does
not change the limit for the other protocol. `ws.maxPayloadLength` must be at
least one byte.

#### Configuration examples

The following configurations cover every public `Server` option. Choose either
`http.onRequest` or `http.routes`; they cannot be used together.

**HTTP, transport policy, and root options**

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  host: '127.0.0.1',
  port: 3000,
  onServerError: (error) => {
    console.error('Transport error:', error)
  },
  transport: {
    maxHeaderSize: 32 * 1024,
    maxHeaderCount: 64,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 60_000,
    bodyIdleTimeoutMs: 15_000,
    minBodyRateBytesPerSec: 1024,
    responseWriteTimeoutMs: 30_000
  },
  http: {
    prefetch: true,
    prefetchHeaders: ['authorization', 'traceparent'],
    maxBodySize: 2 * 1024 * 1024,
    maxBodyBudget: 64 * 1024 * 1024,
    requestTimeoutMs: 15_000,
    onRequest: async (ctx) => {
      const body = await ctx.json()

      return {
        trace: ctx.headers.traceparent,
        body
      }
    },
    onError: (ctx, error) => {
      console.error(`Request failed: ${ctx.getMethod()} ${ctx.getUrl()}`, error)
    }
  },
  ws: null
})

await server.listen()
```

Set `minBodyRateBytesPerSec: null` when the trusted ingress already enforces a
body receive-rate policy. Omit `transport` to use the binding defaults.

**Declarative routes**

```javascript
import Server from '@swarmmachina/swm-core'

// db is the application's database client.
const routeServer = new Server({
  http: {
    maxBodySize: 2 * 1024 * 1024,
    maxBodyBudget: 32 * 1024 * 1024,
    requestTimeoutMs: 10_000,
    routes: [
      {
        method: 'post',
        path: '/accounts/:accountId',
        prefetch: true,
        prefetchHeaders: ['authorization'],
        maxBodySize: 256 * 1024,
        before: [
          async (ctx) => {
            const token = ctx.headers.authorization

            if (!token) {
              return ctx.setStatus(401).send({ error: 'Unauthorized' })
            }

            const user = await db.users.findByAccessToken(token)
            const accountId = ctx.getParameter('accountId')
            const canWrite = user && (await db.accounts.canWrite(user.id, accountId))

            if (!canWrite) {
              return ctx.setStatus(403).send({ error: 'Forbidden' })
            }
          }
        ],
        handler: async (ctx) => {
          const update = await ctx.json()

          return db.accounts.update(ctx.getParameter('accountId'), update)
        }
      },
      {
        method: 'get',
        path: '/health',
        prefetch: false,
        prefetchHeaders: false,
        maxBodySize: 0,
        handler: () => ({ ok: true })
      }
    ],
    onError: (ctx, error) => {
      console.error(`Route failed: ${ctx.getUrl()}`, error)
    }
  },
  ws: null
})

await routeServer.listen()
```

`before` may be one function or an ordered array. A route limit may lower, but
cannot exceed, `http.maxBodySize`.

**WebSocket options and callbacks**

```javascript
import Server from '@swarmmachina/swm-core'

const wsServer = new Server({
  host: '127.0.0.1',
  port: 3001,
  http: null,
  ws: {
    maxPayloadLength: 64 * 1024,
    maxBackpressure: 128 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeoutSec: 30,
    upgradeTimeoutMs: 5_000,
    prefetchHeaders: ['authorization'],
    onUpgrade: async (meta) => {
      const token = meta.headers.authorization

      if (!token) {
        return null
      }

      const user = await authenticate(token)
      return user ? { userId: user.id } : null
    },
    selectProtocol: (requested) => (requested.includes('chat.v1') ? 'chat.v1' : undefined),
    connectionKey: (ctx) => ctx.data.userId,
    onOpen: (ctx) => {
      ctx.subscribe(`user:${ctx.key}`)
    },
    onMessage: (ctx, message, isBinary) => {
      if (!isBinary) {
        ctx.publish('chat', ctx.decode(message))
      }
    },
    onDropped: (ctx, message, isBinary) => {
      console.warn('Dropped message:', ctx.key, message.byteLength, isBinary)
    },
    onDrain: (ctx) => {
      console.log('Writable again:', ctx.key)
    },
    onSubscription: (ctx, topic, newCount, oldCount) => {
      console.log(ctx.key, ctx.decode(topic), oldCount, '->', newCount)
    },
    onClose: (ctx, code, reason) => {
      console.log('Closed:', ctx.key, code, ctx.decode(reason))
    },
    onError: (ctx, error) => {
      console.error('WebSocket error:', ctx?.key, error)
    }
  }
})

await wsServer.listen()
```

`onUpgrade` is required and must return an object to accept or `null` to reject
the upgrade. `connectionKey` is optional; return `null` or `undefined` when a
connection must not be addressable through `server.sendTo()`.

#### JavaScript configuration typing

IDE types load automatically from the package root import. For a configuration
declared separately, use `defineConfig()` to retain completion without JSDoc:

```javascript
import Server, { defineConfig } from '@swarmmachina/swm-core'

const options = defineConfig({
  http: { maxBodyBudget: 256 * 1024 * 1024 }
})

const server = new Server(options)
```

`defineConfig()` returns the same object; constructor validation is unchanged.
Global declarations and a `compilerOptions.types` entry are not required.
Avoid deep imports from `@swarmmachina/swm-core/src/*`.

For an existing JSDoc codebase that uses `Swm.*`, opt in to the type-only
namespace once per project or entry point:

```javascript
/// <reference types="@swarmmachina/swm-core/global" />

/**
 * @typedef {object} ContextState
 * @property {?Swm.HttpContext} req
 * @property {?Swm.HttpContext} res
 */
```

The namespace contains types only. It does not create or declare a runtime
`globalThis.Swm` value.

### HTTP body memory limits

All values are byte counts. `maxBodySize` defaults to 1 MiB and cannot exceed
64 MiB; it limits one request. `maxBodyBudget` defaults to 256 MiB and limits
the aggregate retained and in-flight body memory across requests.

```javascript
const server = new Server({
  http: {
    maxBodySize: 16 * 1024 * 1024,
    maxBodyBudget: 256 * 1024 * 1024,
    onRequest
  }
})
```

A valid `Content-Length` above `maxBodySize` is rejected before allocation.
Exceeding `maxBodySize` returns `413`; exhausting `maxBodyBudget` returns `503`.
`maxBodyBudget: 0` permits only empty bodies, while `null` disables the
aggregate limit. The budget accounts for bodies only, not total process RSS.

Body accessors materialize a `Buffer`; use a streaming or object-storage upload
flow for larger uploads. `requestTimeoutMs` defaults to 30 seconds. Before a
response starts it releases the body reservation and returns `408`; after an
early response it finalizes the request without a second response. It does not
cancel application work.
The normalized values are available on `server.effectiveConfig.http`.

**Route Definition (for `routes` array):**

| Property          | Type                       | Description                                                                                              |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `method`          | `String`                   | HTTP method: `'get'`, `'post'`, `'put'`, `'delete'`/`'del'`, `'patch'`, `'options'`, `'head'`, `'any'`   |
| `path`            | `String`                   | URL path pattern. Supports `:param` segments and a `/*` wildcard catch-all                               |
| `handler`         | `Function`                 | Handler function `(ctx) => any \| Promise<any>`                                                          |
| `before`          | `Function`/`Array`         | Optional. One function or an array, run before `handler` (see [Route before hooks](#route-before-hooks)) |
| `prefetch`        | `Boolean`                  | Optional route body-prefetch override. Omitted inherits `http.prefetch`.                                 |
| `prefetchHeaders` | `false`/`'all'`/`String[]` | Optional header-retention override. Omitted inherits `http.prefetchHeaders`.                             |
| `maxBodySize`     | `Number`                   | Optional route body limit in bytes; cannot exceed `http.maxBodySize`.                                    |

**WebSocket Options (`ws` object):**

| Option                     | Type                       | Default                                  | Description                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxPayloadLength`         | `Number`                   | `1048576`                                | Maximum bytes in one incoming WebSocket message (1 MiB default, 64 MiB max).                                                                                                                                                                                             |
| `maxBackpressure`          | `Number`                   | `65536`                                  | Maximum permitted outgoing backpressure in bytes per WebSocket.                                                                                                                                                                                                          |
| `closeOnBackpressureLimit` | `Boolean`                  | `true`                                   | Close a slow WebSocket when an outgoing message is dropped at the backpressure limit.                                                                                                                                                                                    |
| `idleTimeoutSec`           | `Number`                   | `15`                                     | Idle timeout in seconds (integer: 8-960).                                                                                                                                                                                                                                |
| `upgradeTimeoutMs`         | `Number`                   | `10000`                                  | Deadline for an asynchronous `onUpgrade` decision in milliseconds (0-300000). `0` schedules a zero-delay timeout; it does not disable the deadline.                                                                                                                      |
| `prefetchHeaders`          | `false`/`'all'`/`String[]` | omitted                                  | Retain selected HTTP upgrade headers for asynchronous `onUpgrade` authorization.                                                                                                                                                                                         |
| `onOpen`                   | `Function`                 | `(ctx) => {}`                            | Called when client connects.                                                                                                                                                                                                                                             |
| `onMessage`                | `Function`                 | `(ctx, message, isBinary) => {}`         | Called when message received.                                                                                                                                                                                                                                            |
| `onDropped`                | `Function`                 | `(ctx, message, isBinary) => {}`         | Called when an outgoing message is dropped because the connection exceeded its backpressure limit. Copy `message` synchronously if it is needed after the callback returns or across an `await`.                                                                         |
| `onClose`                  | `Function`                 | `(ctx, code, message) => {}`             | Called when client disconnects. `message` is copied and remains readable across `await`.                                                                                                                                                                                 |
| `onDrain`                  | `Function`                 | `(ctx) => {}`                            | Called when socket is writable again.                                                                                                                                                                                                                                    |
| `onError`                  | `Function`                 | `(ctx, error) => {}`                     | Called on WebSocket error.                                                                                                                                                                                                                                               |
| `onUpgrade`                | `Function`                 | **required**                             | Authorize the upgrade. Return `null` to reject with `403`, or a flat object to accept; that exact object becomes `ctx.data`. Async handlers can safely use `meta` after an `await`.                                                                                      |
| `selectProtocol`           | `Function`                 | `undefined`                              | Optional synchronous `(requested, userData) => string \| undefined` subprotocol selector. The returned token must be present in the client-requested list.                                                                                                               |
| `onSubscription`           | `Function`                 | `(ctx, topic, newCount, oldCount) => {}` | Called on topic subscription change.                                                                                                                                                                                                                                     |
| `connectionKey`            | `Function`                 | `undefined`                              | Opt-in. `(ctx) => string \| number \| null`. Derive a stable key (e.g. a user id) so the connection can be addressed via [`server.sendTo()`](#serversendtokey-message-isbinary). Computed once in `onOpen`; return nullish to skip. Unset = no registry (zero overhead). |

`ws.onUpgrade` is required. Use `onUpgrade: () => ({})` only for intentionally
anonymous endpoints; use `ws: null` to disable WebSocket.

`ws.prefetchHeaders` runs on the HTTP request before `onUpgrade` is called, so
the selected fields remain available from `meta.headers` and
`meta.getHeader()` after an `await`. Without prefetch, `meta.headers` starts
empty and is populated by successful `meta.getHeader(name)` calls without
enumerating the native request. Those reads must happen synchronously to remain
available after detach. Fields outside a selective list are available only
during the synchronous part of `onUpgrade`. The protocol-required `sec-websocket-key`,
`sec-websocket-protocol`, and `sec-websocket-extensions` fields are captured
directly by swm-core and do not need to be included in the list.

### WebSocket payload and backpressure limits

WebSocket input uses `maxPayloadLength`, not HTTP `maxBodySize`. All limits are
byte counts:

```javascript
const server = new Server({
  http: null,
  ws: {
    maxPayloadLength: 1024 * 32, // 32 KiB per incoming message
    maxBackpressure: 1024 * 64, // 64 KiB per slow connection
    closeOnBackpressureLimit: true,
    onUpgrade: () => ({}) // Explicitly allow anonymous connections.
  }
})
```

`maxPayloadLength` applies to each reconstructed text or binary message;
oversized messages close before `onMessage`. `maxBackpressure` applies per
socket. `send()` and `sendTo()` report backpressure or dropped messages;
`onDropped` observes drops and `onDrain` signals recovery. With the default
`closeOnBackpressureLimit: true`, a dropped message closes the slow socket.
Set it to `false` only when dropping messages is acceptable.

`selectProtocol` runs synchronously after `onUpgrade` accepts. Return one of the
requested tokens; returning `undefined` (or omitting the selector) negotiates no
subprotocol.

```javascript
const server = new Server({
  http: null,
  ws: {
    onUpgrade: async (meta) => {
      const token = meta.getHeader('authorization')
      const user = await authenticate(token)

      return user ? { userId: user.id, role: user.role } : null
    },
    selectProtocol: (requested, userData) => {
      if (userData.role === 'admin' && requested.includes('admin.v1')) {
        return 'admin.v1'
      }

      return requested.includes('chat.v1') ? 'chat.v1' : undefined
    }
  }
})

// Browser/client: offer the protocols the client supports.
const socket = new WebSocket('wss://example.com', ['chat.v1', 'admin.v1'])
```

The negotiated value is available as `socket.protocol`. Async upgrades capture
URL, IP, headers, query, and the `/*` parameter before the native request
expires, so `UpgradeMeta` remains safe after an `await`. This capture is
unrelated to `http.prefetch`.

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

#### `server.closeConnection(key, [code], [reason])`

Gracefully close the WebSocket registered under `key`. A close frame is sent,
so the client receives the status code and reason. The connection is removed
from the addressable registry before its `onClose` callback runs.

```javascript
server.closeConnection('user-42', 1008, 'policy violation')
```

**Returns:** `boolean` - `true` when a live registered connection was found and
closing was initiated; `false` for an unknown key.

The close reason is limited to 123 UTF-8 bytes. Reserved wire codes such as
`1005`, `1006`, and `1015` are rejected. Use `1008` for policy violations,
`1013` for temporary overload, or an application code in the `3000`-`4999`
range.

#### `server.terminateConnection(key)`

Immediately force-close the WebSocket registered under `key` without sending a
close frame. Use this for abusive or unresponsive peers when graceful shutdown
is not appropriate.

```javascript
server.terminateConnection('user-42')
```

**Returns:** `boolean` - `true` when a live registered connection was found and
terminated; `false` for an unknown key. The client observes an abnormal close
(typically code `1006`) and receives no reason.

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

Request metadata uses explicit `get*` readers. `ctx.getReqHeader()` reads an
incoming request header; `ctx.setHeader()` stages
an outgoing response header.

#### Properties

| Property      | Type                     | Description                                                |
| ------------- | ------------------------ | ---------------------------------------------------------- |
| `ctx.headers` | `Record<string, string>` | Stable view of prefetched or already-read request headers. |
| `ctx.replied` | `Boolean`                | Whether response has been sent                             |
| `ctx.aborted` | `Boolean`                | Whether request was aborted                                |

#### Methods

##### `ctx.getMethod()`

Get request lowercased method.

```javascript
const method = ctx.getMethod()
```

**Returns:** `string`

##### `ctx.getUrl()`

Get request url.

```javascript
const url = ctx.getUrl()
```

**Returns:** `string`

##### `ctx.getIP()`

Get network source metadata. A valid PROXY Protocol source address is preferred;
otherwise the TCP peer address is returned. IPv4-mapped IPv6 is normalized and
the value is cached only for the current context generation. `X-Forwarded-For`
is not automatically trusted or parsed.

```javascript
const ip = ctx.getIP()
```

**Returns:** `string`

`ctx.getIP()` is not authenticated identity. Accept PROXY Protocol only on a
listener reachable exclusively through a trusted ingress or load balancer;
otherwise a public client can spoof the source address in its PROXY header.
Authorization, rate limiting, and audit attribution need an explicit proxy
trust policy.

```text
Recommended:
Internet -> trusted ingress/load balancer -> private PROXY-enabled swm-core listener
```

```text
Unsafe:
Internet -> public listener accepting arbitrary PROXY headers
```

The same trust boundary applies to `ws.onUpgrade(meta).ip()`.

##### `ctx.getQuery(name)`

Get query parameter value.

```javascript
const page = ctx.getQuery('page') // ?page=1
```

**Returns:** `string | undefined` - `undefined` when the parameter is absent

##### `ctx.getQuery()`

Get full raw query string.

```javascript
const q = ctx.getQuery() // page=1&limit=20
```

**Returns:** `string`

##### `ctx.getParameter(indexOrName)`

Get URL parameter by index or name (for pattern matching in the `routes` API).

```javascript
// By index
const id = ctx.getParameter(0) // First parameter

// By name (routes API only)
const id = ctx.getParameter('id') // /users/:id

// Multiple parameters
const userId = ctx.getParameter('userId') // /users/:userId/posts/:postId
const postId = ctx.getParameter('postId')
```

**Returns:** `string | undefined` - `undefined` when the parameter is absent

##### `ctx.getReqHeader(name)`

Get request header value.

```javascript
const auth = ctx.getReqHeader('authorization')
```

Header names are case-insensitive. A missing header returns an empty string.

**Returns:** `string`

##### `ctx.getHeaders()`

Get a shallow copy of all incoming request headers. Names are lowercase and
the returned object has a `null` prototype. Mutating it does not affect the
context's internal request cache. This method always requests the complete
header set; it never returns only the selective `ctx.headers` view. As a side
effect, it fills the stable `ctx.headers` object with the complete set.

With selective or disabled header prefetch, call `getHeaders()` synchronously
before the handler yields. After an async boundary, the complete set is
available only if it was already collected or `prefetchHeaders: 'all'` was
configured; otherwise the method throws with code
`REQUEST_HEADERS_NOT_RETAINED`.

```javascript
const headers = ctx.getHeaders()
const auth = headers.authorization
```

**Returns:** `Record<string, string>`

##### `ctx.getContentLength()`

Get a valid non-negative `Content-Length` value. Returns `null` when the header
is absent or invalid.

```javascript
const length = ctx.getContentLength()
```

**Returns:** `number | null`

##### `ctx.body([maxSize])`

Read request body as Buffer.

```javascript
const buffer = await ctx.body()
const buffer = await ctx.body(5 * 1024 * 1024) // 5 MiB, expressed in bytes
```

**Returns:** `Promise<Buffer>`

In `prefetch` mode, `http.maxBodySize` is the hard collection limit. A smaller
per-call `maxSize` is still enforced when the accessor resolves; a larger value
cannot raise the server limit. If `http.maxBodyBudget` is enabled, the same
aggregate budget also applies to manually started lazy readers.

Every `maxSize` argument is a non-negative safe integer byte count. The first
body accessor (or prefetch) fixes the collection limit; later calls reuse one
collector. A smaller later value checks the same materialized bytes, while a
larger value does not restart or expand an in-flight or failed collection.

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

##### `ctx.setStatus(code)`

Set response status code. Returns context for chaining.

```javascript
ctx.setStatus(201).send({ created: true })
```

**Returns:** `HttpContext`

##### `ctx.setHeader(key, value)`

Set or replace a staged response header. Header names are case-insensitive HTTP tokens; invalid names and CR/LF in values throw before crossing into the native transport. Repeated `setHeader()` calls replace previously staged values for the same header. An array emits one header field per item in order, which is useful for repeatable fields such as `Set-Cookie`; matching `node:http`, `Cookie` array values are joined with `; `. Null or undefined scalar values are silently ignored.

```javascript
ctx.setHeader('x-header-any', 'string-value').setStatus(201).send({ created: true })

ctx.setHeader('set-cookie', ['access=...; Path=/; HttpOnly', 'refresh=...; Path=/refresh; HttpOnly'])
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

##### `ctx.replyAndClose([status], [headers], [body])`

Send a complete HTTP response, then close the underlying connection instead of
allowing keep-alive reuse. The response is flushed before the transport closes.

```javascript
ctx.replyAndClose(403, { 'content-type': 'text/plain' }, 'Forbidden')
```

Use this for rejected requests where the client should still receive a valid
HTTP response. Closing the connection does not prevent the client from opening
a new one; authentication, bans, and rate limits remain separate policies.

##### `ctx.terminate()`

Immediately force-close the underlying HTTP connection. No response delivery is
guaranteed.

```javascript
ctx.terminate()
```

Use this for protocol abuse or peers that should not consume more transport
resources. The context follows the normal aborted-request cleanup path.

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
| `ctx.data` | `Object`          | Exact user data object returned by `onUpgrade` (`ctx.data === dataFromOnUpgrade`)                                                                                                               |
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

The reason must fit in 123 UTF-8 bytes. Reserved wire codes cannot be sent.

##### `ctx.terminate()`

Immediately force-close this WebSocket without sending a close frame. The peer
observes an abnormal close and receives no close reason.

```javascript
ctx.terminate()
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

| Context       | Allocated per…            | Valid for…                                 | Safe to retain?                                          |
| ------------- | ------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `HttpContext` | request (pooled, reused)  | response plus pending `http.onError` hooks | No — released after finalization and pending error hooks |
| `WSContext`   | connection (never reused) | the whole connection lifetime              | Yes, for the connection; not past `onClose`              |

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
        if (ctx.getUrl() === '/users' && ctx.getMethod() === 'get') {
          return Array.from(users.values())
        }

        // GET /users/:id
        if (ctx.getUrl().startsWith('/users/') && ctx.getMethod() === 'get') {
          const id = ctx.getUrl().split('/')[2]
          const user = users.get(id)

          if (!user) {
            return ctx.setStatus(404).send({ error: 'User not found' })
          }

          return user
        }

        // POST /users
        if (ctx.getUrl() === '/users' && ctx.getMethod() === 'post') {
          const data = await ctx.json()

          if (!data.name || !data.email) {
            return ctx.setStatus(400).send({ error: 'Missing required fields' })
          }

          const user = { id: Date.now().toString(), ...data }
          users.set(user.id, user)

          return ctx.setStatus(201).send(user)
        }

        // 404
        return ctx.setStatus(404).send({ error: 'Not found' })
      } catch (error) {
        console.error('Route error:', error)
        return ctx.setStatus(500).send({ error: 'Internal server error' })
      }
    },
    onError: (ctx, error) => {
      console.error(`HTTP Error [${ctx.getMethod()} ${ctx.getUrl()}]:`, error)
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
  http: {
    maxBodySize: 10 * 1024 * 1024, // 10 MiB, expressed in bytes
    onRequest: async (ctx) => {
      if (ctx.getUrl() === '/upload' && ctx.getMethod() === 'post') {
        const filename = ctx.getQuery('filename') || 'upload.bin'
        const body = await ctx.body()

        await fs.writeFile(`./uploads/${filename}`, body)

        return ctx.setStatus(201).send({
          success: true,
          filename,
          size: body.length
        })
      }

      return ctx.setStatus(404).send({ error: 'Not found' })
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
      if (ctx.getUrl() === '/download' && ctx.getMethod() === 'get') {
        const filename = ctx.getQuery('file')

        if (!filename) {
          return ctx.setStatus(400).send({ error: 'Missing file parameter' })
        }

        const stream = fs.createReadStream(`./files/${filename}`)

        await ctx.stream(stream, 200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${filename}"`
        })

        return
      }

      return ctx.setStatus(404).send({ error: 'Not found' })
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
    onUpgrade: (meta) => ({ username: meta.getQuery('username') || 'Anonymous' }),
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
        return null
      }

      try {
        const user = await validateToken(token)

        return { userId: user.id, username: user.name }
      } catch (error) {
        return null
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
    onUpgrade: (meta) => ({ userId: meta.getQuery('userId') }),
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
- Use `server.closeConnection(key, code, reason)` for a graceful addressed
  disconnect, or `server.terminateConnection(key)` for an immediate transport
  abort.
- Prefer managing your own `Map` instead? Store `ctx.ws` (identity-stable for the
  connection) rather than `ctx`, and delete it in `onClose`.

For 1-to-many fan-out (rooms, channels, broadcasts) prefer topic pub/sub
(`ctx.subscribe` / `ctx.publish` / `server.publish`) instead of addressing
connections individually.

## Advanced Usage

### Graceful Shutdown

```javascript
const server = new Server({/* ... */})
await server.listen()

let shutdownPromise

function shutdown(signal) {
  if (shutdownPromise !== undefined) return shutdownPromise

  shutdownPromise = (async () => {
    console.log(`${signal} received, shutting down gracefully...`)
    await server.shutdown(10_000)
  })()

  return shutdownPromise
}

function handleSignal(signal) {
  void shutdown(signal).catch((error) => {
    console.error('graceful shutdown failed', error)
    process.exitCode = 1
  })
}

process.once('SIGTERM', () => handleSignal('SIGTERM'))
process.once('SIGINT', () => handleSignal('SIGINT'))
```

### Route before hooks

A route may declare `before` — one function or an array — run before its
`handler` (auth, logging, validation).

```javascript
const requireAuth = (ctx) => {
  if (ctx.getReqHeader('authorization') !== 'Bearer secret') {
    ctx.setStatus(401).send('Unauthorized') // replying short-circuits the chain
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
- Before reading a body after an async hook, enable `http.prefetch` or route
  `prefetch`, or start the body reader inside that hook before its first `await`; see
  [Async Work Before Using the Request Body](#async-work-before-using-the-request-body).
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
routes still take precedence). It confines canonical file paths to `root`, sets
Content-Type by extension, and caches file contents in a byte-bounded LRU.

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
(default `true`; set `false` in dev to pick up edits), `cacheLimit` (non-negative
safe integer; max cached files, default `128`; `0` disables the in-memory cache),
`cacheByteLimit` (default 64 MiB), `maxFileSize` (default 16 MiB),
`maxInflightBytes` (at least `maxFileSize`, default the larger of 64 MiB and
`maxFileSize`), `maxInflightFiles` (default `32`; `0` rejects uncached loads),
and `maxAge` (`Cache-Control` seconds).
Identical simultaneous misses share one read. Files above `maxFileSize` return
`404`; use `ctx.stream()` explicitly for larger assets. Traversal and symlink
escapes return `403`, and non-`GET`/`HEAD` requests return `405`.

The handler opens canonical targets with no-follow semantics and verifies the
opened file before reading it. The supported security boundary requires the
static tree to be non-writable by untrusted users: Node.js does not expose a
portable descriptor-relative `openat2` equivalent that can make attacker-driven
path mutation race-free. On Linux the open descriptor is additionally verified
through `/proc/self/fd`; if that filesystem is unavailable, the request fails
closed with `403`.

### Backpressure Handling

```javascript
const server = new Server({
  http: {
    onRequest: async (ctx) => {
      if (ctx.getUrl() === '/stream') {
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
pnpm test
```

## Stability

The package is currently experimental. Public APIs and runtime behavior may
change before a stable release; changes should be documented and covered by
tests.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Licensed under the MPL-2.0 License.

Copyright Contributors to SwarmMachina.

See [LICENSE](LICENSE) file for details.
