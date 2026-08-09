import { WS_CONTEXT_DATA } from '../../src/server/ws-upgrade.js'

import type { HttpRequest, HttpResponse, WebSocket } from '@swarmmachina/swm-uws'

type RouteHandler = (...args: unknown[]) => unknown
type ListenCallback = (socket: object | null) => void
type DataCallback = (data: ArrayBuffer, isLast: boolean) => void
type HeaderPrefetchPlan = { headers: 'all' | readonly string[] }
type ByteInput = ArrayBuffer | string

export interface MockWsConfig {
  idleTimeout?: number
  upgradeTimeout?: number
  maxPayloadLength?: number
  maxBackpressure?: number
  closeOnBackpressureLimit?: boolean
  open?: RouteHandler
  message?: RouteHandler
  dropped?: RouteHandler
  close?: RouteHandler
  drain?: RouteHandler
  subscription?: RouteHandler
  upgrade?: RouteHandler
}

export interface MockCall {
  method: string
  path?: string
  handler?: RouteHandler
  config?: MockWsConfig
  host?: string
  port?: number
  cb?: ListenCallback
  topic?: string
  message?: ArrayBuffer
  isBinary?: boolean | undefined
  data?: ArrayBuffer
  code?: number | undefined
  reason?: ArrayBuffer | undefined
  status?: string
  key?: string | undefined
  value?: string
  body?: ByteInput | undefined
  closeConnection?: boolean | undefined
  callback?: (() => void) | DataCallback | ((offset: number) => boolean)
  userData?: object
  secKey?: string
  protocol?: string
  extensions?: string
  context?: object
  chunk?: unknown
  socket?: unknown
  plan?: HeaderPrefetchPlan
  name?: string
  index?: number
}

interface MockAppControls {
  calls: MockCall[]
  appOptions: object
  setListenCallback(callback: ((listen: ListenCallback) => void) | null): void
  setNumSubscribersResult(value: number): void
  setPublishResult(value: boolean): void
  getCloseCallCount(): number
}

interface MockWebSocketControls {
  calls: MockCall[]
  getEndCallCount(): number
  getCloseCallCount(): number
}

interface MockWebSocketImplementation extends MockWebSocketControls {
  getUserData(): object
  end(code?: number, reason?: ArrayBuffer): void
  close(): void
  send(data: ArrayBuffer, isBinary?: boolean): number
  subscribe(topic: string): boolean
  unsubscribe(topic: string): boolean
}

interface MockHttpResponseControls {
  calls: MockCall[]
  getStatus(): string | null
  getHeaders(): Record<string, string>
  isEnded(): boolean
  isUpgraded(): boolean
  triggerAborted(): void
  pushData(data: ArrayLike<number> | string, isLast: boolean): void
}

interface MockHttpResponseImplementation extends MockHttpResponseControls {
  cork(fn: () => void): void
  writeStatus(status: string): void
  writeHeader(name: string, value: string): void
  end(body?: ByteInput, closeConnection?: boolean): void
  close(): void
  upgrade(userData: object, secKey: string, protocol: string, extensions: string, context: object): void
  onAborted(callback: () => void): void
  onData(callback: DataCallback): void
  onWritable(callback: (offset: number) => boolean): void
  getWriteOffset(): number
  tryEnd(chunk: unknown): [boolean, boolean]
  write(chunk: unknown): boolean
  getRemoteAddressAsText(): ArrayBuffer
  getProxiedRemoteAddressAsText(): ArrayBuffer
  getRemoteAddress(): ArrayBuffer
  getProxiedRemoteAddress(): ArrayBuffer
}

interface MockHttpRequestControls {
  calls: MockCall[]
  setMethod(method: string): void
  setUrl(url: string): void
  setHeader(name: string, value: string): void
  setQuery(key: string, value: string): void
  setFullQuery(value: string | undefined): void
  setParameter(index: number, value: string): void
}

interface MockHttpRequestImplementation extends MockHttpRequestControls {
  getMethod(): string
  getUrl(): string
  getHeader(name: string): string | undefined
  getQuery(name?: string): string | undefined
  getParameter(index: number): string | undefined
  forEach(callback: (name: string, value: string) => void): void
  prefetch(plan: HeaderPrefetchPlan): {
    getHeader(name: string): string | undefined
    getHeaderValues(name: string): string[] | undefined
    getHeaders(): Record<string, string>
    getHeaderEntries(): string[]
  }
}

export type MockApp = MockAppControls & {
  any(path: string, handler: RouteHandler): MockApp
  get(path: string, handler: RouteHandler): MockApp
  post(path: string, handler: RouteHandler): MockApp
  put(path: string, handler: RouteHandler): MockApp
  del(path: string, handler: RouteHandler): MockApp
  patch(path: string, handler: RouteHandler): MockApp
  options(path: string, handler: RouteHandler): MockApp
  head(path: string, handler: RouteHandler): MockApp
  ws(path: string, config: MockWsConfig): MockApp
  listen(host: string, port: number, callback: ListenCallback): MockApp
  close(): MockApp
  publish(topic: string, message: ArrayBuffer, isBinary: boolean): boolean
  numSubscribers(topic: string): number
}
export type MockWebSocket = WebSocket<object> & MockWebSocketControls
export type MockHttpResponse = HttpResponse & MockHttpResponseControls
export type MockHttpRequest = HttpRequest & MockHttpRequestControls

export const mockCalls: {
  app: MockApp[]
  listen: MockCall[]
  close: MockCall[]
  us_listen_socket_close: MockCall[]
} = {
  app: [],
  listen: [],
  close: [],
  us_listen_socket_close: []
}

/**
 *
 */
export function resetMocks(): void {
  mockCalls.app = []
  mockCalls.listen = []
  mockCalls.close = []
  mockCalls.us_listen_socket_close = []
}

/**
 * @param {object} [options]
 * @returns {object}
 */
export function createMockApp(options: object = {}): MockApp {
  const calls: MockCall[] = []

  let listenCallback: ((listen: ListenCallback) => void) | null = null
  let closeCallCount = 0
  let numSubscribersResult = 0
  let publishResult = true

  const app = {
    calls,
    appOptions: options,
    setListenCallback(cb: ((listen: ListenCallback) => void) | null): void {
      listenCallback = cb
    },
    setNumSubscribersResult(value: number): void {
      numSubscribersResult = value
    },
    setPublishResult(value: boolean): void {
      publishResult = value
    },
    getCloseCallCount(): number {
      return closeCallCount
    },
    any(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'any', path, handler })

      return app
    },
    get(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'get', path, handler })

      return app
    },
    post(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'post', path, handler })

      return app
    },
    put(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'put', path, handler })

      return app
    },
    del(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'del', path, handler })

      return app
    },
    patch(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'patch', path, handler })

      return app
    },
    options(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'options', path, handler })

      return app
    },
    head(path: string, handler: RouteHandler): MockApp {
      calls.push({ method: 'head', path, handler })

      return app
    },
    ws(path: string, config: MockWsConfig): MockApp {
      calls.push({ method: 'ws', path, config })

      return app
    },
    listen(host: string, port: number, cb: ListenCallback): MockApp {
      mockCalls.listen.push({ method: 'listen', host, port, cb })

      if (listenCallback) {
        listenCallback(cb)
      } else {
        cb({ sock: 1 })
      }

      return app
    },
    close(): MockApp {
      closeCallCount++
      mockCalls.close.push({ method: 'close' })

      return app
    },
    publish(topic: string, message: ArrayBuffer, isBinary: boolean): boolean {
      calls.push({ method: 'publish', topic, message, isBinary })

      return publishResult
    },
    numSubscribers(topic: string): number {
      calls.push({ method: 'numSubscribers', topic })

      return numSubscribersResult
    }
  } satisfies MockApp

  mockCalls.app.push(app)

  return app as MockApp
}

/**
 * @param {object} userData
 * @returns {object}
 */
export function createMockWebSocket(userData: object = {}): MockWebSocket {
  const calls: MockCall[] = []

  let endCallCount = 0
  let closeCallCount = 0

  const ws = {
    calls,
    getUserData(): object {
      calls.push({ method: 'getUserData' })

      return ws
    },
    end(code?: number, reason?: ArrayBuffer): void {
      endCallCount++
      calls.push({ method: 'end', code, reason })
    },
    getEndCallCount(): number {
      return endCallCount
    },
    close(): void {
      closeCallCount++
      calls.push({ method: 'close' })
    },
    getCloseCallCount(): number {
      return closeCallCount
    },
    send(data: ArrayBuffer, isBinary?: boolean): number {
      calls.push({ method: 'send', data, isBinary })

      return 0
    },
    subscribe(topic: string): boolean {
      calls.push({ method: 'subscribe', topic })

      return true
    },
    unsubscribe(topic: string): boolean {
      calls.push({ method: 'unsubscribe', topic })

      return true
    }
  } satisfies MockWebSocketImplementation

  Object.assign(ws, userData, { [WS_CONTEXT_DATA]: userData })

  return ws as unknown as MockWebSocket
}

/**
 * @returns {object}
 */
export function createMockHttpResponse(): MockHttpResponse {
  const calls: MockCall[] = []

  let abortedCallback: (() => void) | null = null
  let dataCallback: DataCallback | null = null
  let status: string | null = null

  const headers: Record<string, string> = {}

  let ended = false
  let upgraded = false

  const response = {
    calls,
    getStatus(): string | null {
      return status
    },
    getHeaders(): Record<string, string> {
      return { ...headers }
    },
    isEnded(): boolean {
      return ended
    },
    isUpgraded(): boolean {
      return upgraded
    },
    cork(fn: () => void): void {
      calls.push({ method: 'cork' })
      fn()
    },
    writeStatus(s: string): void {
      status = s
      calls.push({ method: 'writeStatus', status: s })
    },
    writeHeader(key: string, value: string): void {
      headers[key] = value
      calls.push({ method: 'writeHeader', key, value })
    },
    end(body?: ArrayBuffer | string, closeConnection?: boolean): void {
      ended = true
      calls.push({ method: 'end', body, closeConnection })
    },
    close(): void {
      calls.push({ method: 'close' })

      if (abortedCallback) {
        abortedCallback()
      }
    },
    upgrade(userData: object, secKey: string, protocol: string, extensions: string, context: object): void {
      upgraded = true
      calls.push({ method: 'upgrade', userData, secKey, protocol, extensions, context })
    },
    onAborted(cb: () => void): void {
      abortedCallback = cb
      calls.push({ method: 'onAborted', callback: cb })
    },
    triggerAborted(): void {
      if (abortedCallback) {
        abortedCallback()
      }
    },
    onData(cb: DataCallback): void {
      dataCallback = cb
      calls.push({ method: 'onData', callback: cb })
    },
    pushData(data: ArrayLike<number> | string, isLast: boolean): void {
      if (!dataCallback) {
        throw new Error('onData not called yet')
      }

      dataCallback(Uint8Array.from(typeof data === 'string' ? Buffer.from(data) : data).buffer, isLast)
    },
    onWritable(cb: (offset: number) => boolean): void {
      calls.push({ method: 'onWritable', callback: cb })
    },
    getWriteOffset(): number {
      return 0
    },
    tryEnd(chunk: unknown): [boolean, boolean] {
      calls.push({ method: 'tryEnd', chunk })

      return [true, true]
    },
    write(chunk: unknown): boolean {
      calls.push({ method: 'write', chunk })

      return true
    },
    getRemoteAddressAsText(): ArrayBuffer {
      return new ArrayBuffer(0)
    },
    getProxiedRemoteAddressAsText(): ArrayBuffer {
      return new ArrayBuffer(0)
    },
    getRemoteAddress(): ArrayBuffer {
      return new ArrayBuffer(0)
    },
    getProxiedRemoteAddress(): ArrayBuffer {
      return new ArrayBuffer(0)
    }
  } satisfies MockHttpResponseImplementation

  return response as unknown as MockHttpResponse
}

/**
 * @returns {object}
 */
export function createMockHttpRequest(): MockHttpRequest {
  const calls: MockCall[] = []

  let method = 'get'
  let url = '/'

  const headers: Record<string, string> = {}
  const query: Record<string, string> = {}

  let fullQuery: string | undefined

  const parameters: string[] = []

  const request = {
    calls,
    setMethod(m: string): void {
      method = m
    },
    setUrl(u: string): void {
      url = u
    },
    setHeader(name: string, value: string): void {
      headers[name] = value
    },
    setQuery(key: string, value: string): void {
      query[key] = value
      fullQuery = undefined
    },
    setFullQuery(value: string | undefined): void {
      fullQuery = value
    },
    setParameter(index: number, value: string): void {
      parameters[index] = value
    },
    getMethod(): string {
      calls.push({ method: 'getMethod' })

      return method
    },
    getUrl(): string {
      calls.push({ method: 'getUrl' })

      return url
    },
    getHeader(name: string): string | undefined {
      calls.push({ method: 'getHeader', name })

      return headers[name]
    },
    getQuery(key?: string): string | undefined {
      calls.push({ method: 'getQuery', key })

      if (key === undefined) {
        if (typeof fullQuery === 'string') {
          return fullQuery
        }

        const pairs = []

        for (const name in query) {
          const value = query[name]

          pairs.push(value === '' ? name : `${name}=${value}`)
        }

        return pairs.join('&')
      }

      return query[key]
    },
    getParameter(index: number): string | undefined {
      calls.push({ method: 'getParameter', index })

      return parameters[index]
    },
    forEach(cb: (name: string, value: string) => void): void {
      calls.push({ method: 'forEach' })

      for (const name in headers) {
        const value = headers[name]

        if (value !== undefined) {
          cb(name, value)
        }
      }
    },
    prefetch(plan: HeaderPrefetchPlan) {
      calls.push({ method: 'prefetch', plan })

      const names = plan.headers === 'all' ? Object.keys(headers) : plan.headers
      const retained: Record<string, string> = {}

      for (const name of names) {
        if (Object.hasOwn(headers, name)) {
          const value = headers[name]

          if (value !== undefined) {
            retained[name] = value
          }
        }
      }

      return {
        getHeader(name: string): string | undefined {
          return Object.hasOwn(retained, name) ? retained[name] : undefined
        },
        getHeaderValues(name: string): string[] | undefined {
          const value = retained[name]

          return value === undefined ? undefined : [value]
        },
        getHeaders(): Record<string, string> {
          return Object.assign(Object.create(null), retained)
        },
        getHeaderEntries(): string[] {
          return Object.entries(retained).flat()
        }
      }
    }
  } satisfies MockHttpRequestImplementation

  return request as unknown as MockHttpRequest
}

/**
 *
 * @param {unknown} socket
 */
export function us_listen_socket_close(socket: unknown): void {
  mockCalls.us_listen_socket_close.push({ method: 'us_listen_socket_close', socket })
}
