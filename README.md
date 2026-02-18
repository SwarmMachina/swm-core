# @swarmmachina/swm-core

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-1-brightgreen.svg)](#)
[![stability](https://img.shields.io/badge/stability-experimental-yellow.svg)](#)

A zero-dependency, high-performance HTTP/WebSocket server built
on [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js).

## Features

- **Zero dependencies** - Only uses uWebSockets.js for maximum performance
- **HTTP + WebSocket** - Both protocols in a single server instance
- **High performance** - Built on the fastest WebSocket server available
- **Context pooling** - Minimizes garbage collection overhead
- **Graceful shutdown** - Cleanly closes active connections
- **Streaming support** - Efficient handling of large payloads
- **Auto Content-Type detection** - Automatically sets headers based on response type
- **Modern ES modules** - Native ESM support (Node.js 22+)

## Installation

```bash
# Install the package
npm install @swarmmachina/swm-core
```

## Quick Start

### Basic HTTP Server

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  router: (ctx) => {
    return { message: 'Hello World' }
  }
})

await server.listen()
console.log('Server listening on port 3000')
```

### HTTP Server with Routing (Traditional API)

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  router: async (ctx) => {
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
  onHttpError: (ctx, error) => {
    console.error('HTTP Error:', error)
  }
})

await server.listen()
```

### HTTP Server with Native Routing (New API)

For better performance and cleaner code, you can use native uWebSockets.js routing:

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
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
  onHttpError: (ctx, error) => {
    console.error('HTTP Error:', error)
  }
})

await server.listen()
```

**Benefits of Native Routing:**

- **Better Performance** - Routes are registered at C++ level for faster matching
- **URL Parameters** - Built-in support for `:param` syntax
- **Cleaner Code** - Declarative route definitions
- **Method-specific** - Automatic HTTP method routing

### WebSocket Server

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  router: (ctx) => {
    return { message: 'HTTP endpoint' }
  },
  ws: {
    enabled: true,
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

| Option        | Type       | Default        | Description                                             |
| ------------- | ---------- | -------------- | ------------------------------------------------------- |
| `router`      | `Function` | _one required_ | Route handler function `(ctx) => any` (traditional API) |
| `routes`      | `Array`    | _one required_ | Array of route definitions (native routing API)         |
| `onHttpError` | `Function` | `() => {}`     | Error handler `(ctx, error) => void`                    |
| `port`        | `Number`   | `6000`         | Server port (1-65535)                                   |
| `maxBodySize` | `Number`   | `1`            | Max request body size in MB (1-64)                      |
| `ws`          | `Object`   | `null`         | WebSocket configuration (see below)                     |

**Note:** You must provide either `router` or `routes`, but not both.

**Route Definition (for `routes` array):**

| Property  | Type       | Description                                                                                    |
| --------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `method`  | `String`   | HTTP method: `'get'`, `'post'`, `'put'`, `'delete'`, `'patch'`, `'options'`, `'head'`, `'any'` |
| `path`    | `String`   | URL path pattern (supports `:param` syntax)                                                    |
| `handler` | `Function` | Handler function `(ctx) => any \| Promise<any>`                                                |

**WebSocket Options (`ws` object):**

| Option             | Type       | Default                                            | Description                                                                                                                                                                                                         |
| ------------------ | ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `Boolean`  | `false`                                            | Enable WebSocket support. If not set and at least one ws handler is provided, WS will be enabled automatically.                                                                                                     |
| `wsIdleTimeoutSec` | `Number`   | `15`                                               | Idle timeout in seconds (min: 5)                                                                                                                                                                                    |
| `onOpen`           | `Function` | `(ctx) => {}`                                      | Called when client connects                                                                                                                                                                                         |
| `onMessage`        | `Function` | `(ctx, message, isBinary) => {}`                   | Called when message received                                                                                                                                                                                        |
| `onClose`          | `Function` | `(ctx, code, message) => {}`                       | Called when client disconnects                                                                                                                                                                                      |
| `onDrain`          | `Function` | `(ctx) => {}`                                      | Called when socket is writable again                                                                                                                                                                                |
| `onError`          | `Function` | `(ctx, error) => {}`                               | Called on WebSocket error                                                                                                                                                                                           |
| `onUpgrade`        | `Function` | `(meta) => ({isAllowed: true, userData?: object})` | Validate WebSocket upgrade. Receives `meta` object with: `url()`, `ip()`, `getHeader(name)`, `getQuery(key)`, `getParameter(indexOrName)`, `aborted` boolean. Return `userData` to make it available via `ctx.data` |
| `onSubscription`   | `Function` | `(ctx, topic, newCount, oldCount) => {}`           | Called on topic subscription change                                                                                                                                                                                 |

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

### HttpContext API

The `ctx` object passed to the router function:

#### Properties

| Property      | Type      | Description                    |
| ------------- | --------- | ------------------------------ |
| `ctx.replied` | `Boolean` | Whether response has been sent |
| `ctx.aborted` | `Boolean` | Whether request was aborted    |

#### Methods

##### `ctx.method()`

Get request lowercased method.

```javascriptx
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

**Returns:** `string`

##### `ctx.fullQuery()`

Get full raw query string.

```javascript
const q = ctx.fullQuery() // page=1&limit=20
```

**Returns:** `string`

##### `ctx.param(indexOrName)`

Get URL parameter by index or name (for pattern matching in native routing).

```javascript
// By index
const id = ctx.param(0) // First parameter

// By name (native routing only)
const id = ctx.param('id') // /users/:id

// Multiple parameters
const userId = ctx.param('userId') // /users/:userId/posts/:postId
const postId = ctx.param('postId')
```

**Returns:** `string`

##### `ctx.header(name)`

Get request header value.

```javascript
const auth = ctx.header('authorization')
```

**Returns:** `string`

##### `ctx.body([maxSize])`

Read request body as Buffer.

```javascript
const buffer = await ctx.body()
const buffer = await ctx.body(5 * 1024 * 1024) // 5MB limit
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

Set a response header. Returns context for chaining.

```javascript
ctx.setHeader('x-header-any', 'string-value').status(201).send({ created: true })
```

**Returns:** `HttpContext`

##### `ctx.send(data)`

Send response with automatic content-type detection.

```javascript
ctx.send({ message: 'OK' }) // application/json
ctx.send('Hello') // text/plain
ctx.send(Buffer.from('data')) // application/octet-stream
ctx.send(null) // 204 No Content
```

**Supported types:** Object, String, Buffer, null, undefined

##### `ctx.reply(status, headers, body)`

Send response with full control over status, headers, and body.

```javascript
ctx.reply(200, { 'content-type': 'application/json' }, '{"ok":true}')
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

Start streaming response manually (for advanced use cases).

```javascript
ctx.startStreaming(200, { 'content-type': 'text/plain' })
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

##### `ctx.tryEnd(chunk)`

Try to end the streaming response with a final chunk. Calculates `totalSize = getWriteOffset() + chunkLen` and calls
`res.tryEnd(chunk, totalSize)`.

```javascript
const [ok, done] = ctx.tryEnd('final chunk')
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

| Property   | Type        | Description                                                |
| ---------- | ----------- | ---------------------------------------------------------- |
| `ctx.data` | `Object`    | User data from `onUpgrade` return value (`userData` field) |
| `ctx.ws`   | `WebSocket` | Raw uWS WebSocket object                                   |

#### Methods

##### `ctx.send(data, [isBinary])`

Send message to this client.

```javascript
ctx.send('Hello client!')
ctx.send(Buffer.from([1, 2, 3]), true) // binary
```

**Returns:** `number` - Send status

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

## Examples

### REST API with Error Handling

```javascript
import Server from '@swarmmachina/swm-core'

const users = new Map()

const server = new Server({
  port: 3000,
  router: async (ctx) => {
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
  onHttpError: (ctx, error) => {
    console.error(`HTTP Error [${ctx.method()} ${ctx.url()}]:`, error)
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
  router: async (ctx) => {
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
})

await server.listen()
```

### File Streaming

```javascript
import Server from '@swarmmachina/swm-core'
import fs from 'fs'

const server = new Server({
  port: 3000,
  router: async (ctx) => {
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
})

await server.listen()
```

### WebSocket Chat Room

```javascript
import Server from '@swarmmachina/swm-core'

const server = new Server({
  port: 3000,
  router: (ctx) => {
    return { message: 'WebSocket chat server' }
  },
  ws: {
    enabled: true,
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
  router: (ctx) => ({ ok: true }),
  ws: {
    enabled: true,
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

### Custom Response Headers

```javascript
const server = new Server({
  router: (ctx) => {
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
})
```

### Backpressure Handling

```javascript
const server = new Server({
  router: async (ctx) => {
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
})
```

## Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm test:coverage
```

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
