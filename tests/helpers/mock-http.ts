import type { HttpRequest, HttpResponse, NativeData } from '@swarmmachina/swm-uws'
import type { Readable } from 'node:stream'

export type MockCall = [method: string, ...args: unknown[]]
export type WriteHeaderCall = ['writeHeader', string, string]
type ByteInput = Buffer | Uint8Array | ArrayBuffer | string
type DataCallback = (data: ArrayBuffer, isLast: boolean) => void
type CollectBodyCallback = (data: ArrayBuffer | null) => void
type WritableCallback = (offset: number) => boolean

export function isWriteHeaderCall(call: MockCall): call is WriteHeaderCall {
  return call[0] === 'writeHeader' && typeof call[1] === 'string' && typeof call[2] === 'string'
}

interface MockResControls {
  calls: MockCall[]
  onDataCb: DataCallback | null
  pushData(data: ByteInput, isLast: boolean): void
  setProxiedIp(ip: string | null | undefined): void
  setRemoteIp(ip: string | null | undefined): void
  setProxiedAddress(bytes: ArrayLike<number>, text?: string): void
  setRemoteAddress(bytes: ArrayLike<number>, text?: string): void
  getProxiedRemoteAddressAsTextCallCount(): number
  getRemoteAddressAsTextCallCount(): number
  getProxiedRemoteAddressCallCount(): number
  getRemoteAddressCallCount(): number
  getWarnings(): string[]
  endBatch(status: string, headerLines: string[], body?: NativeData): this
  beginWrite(): void
  pushCollectedBody(data: ArrayLike<number> | null): void
  setWriteResultSequence(results: boolean[]): void
  setWriteResult(fn: (chunk: unknown) => boolean): void
  setTryEndResultSequence(results: Array<readonly [boolean, boolean]>): void
  setTryEndResult(fn: (chunk: unknown, totalSize: number) => [boolean, boolean]): void
  setWriteOffset(offset: number): void
  advanceWriteOffset(delta: number): void
  triggerWritable(offset: number): boolean
}

interface MockReqControls {
  calls: MockCall[]
  setMethod(method: string): void
  setUrl(url: string): void
  setHeader(name: string, value: string): void
  setQuery(key: string, value: string): void
  setParameter(index: number, value: string): void
}

interface MockReadableControls {
  emit(event: string, arg: unknown): void
  getPauseCallCount(): number
  getResumeCallCount(): number
  getDestroyCallCount(): number
}

export type MockRes = HttpResponse & MockResControls
export type MockReq = HttpRequest & MockReqControls
export type MockReadable = Readable & MockReadableControls

export interface MockResOptions {
  onCork?: () => void
}

/**
 * @param {object} options
 * @param {() => void} [options.onCork]
 * @returns {object}
 */
export function createMockRes(options: MockResOptions = {}): MockRes {
  const calls: MockCall[] = []
  const warnings: string[] = []

  let onDataCb: DataCallback | null = null
  let collectBodyCb: CollectBodyCallback | null = null
  let getProxiedRemoteAddressAsTextCallCount = 0
  let getRemoteAddressAsTextCallCount = 0
  let getProxiedRemoteAddressCallCount = 0
  let getRemoteAddressCallCount = 0
  let proxiedIp = new ArrayBuffer(0)
  let proxiedAddress = new ArrayBuffer(0)
  let remoteIp = new ArrayBuffer(0)
  let remoteAddress = new ArrayBuffer(0)
  let writeOffset = 0
  let writeResultSequence: boolean[] = []
  let writeResultFn: ((chunk: unknown) => boolean) | null = null
  let tryEndResultSequence: Array<[boolean, boolean]> = []
  let tryEndResultFn: ((chunk: unknown, totalSize: number) => [boolean, boolean]) | null = null
  let onWritableCb: WritableCallback | null = null
  let inCork = false

  const res = {
    calls,
    onDataCb: null as DataCallback | null,

    /**
     * @param {Buffer|Uint8Array|ArrayBuffer|string} data
     * @param {boolean} isLast
     */
    pushData(data: ByteInput, isLast: boolean): void {
      if (!onDataCb) {
        throw new Error('onData not called yet')
      }

      const buffer = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data)

      onDataCb(Uint8Array.from(buffer).buffer, isLast)
    },
    setProxiedIp(ip: string | null | undefined): void {
      proxiedIp = ip ? Uint8Array.from(Buffer.from(ip)).buffer : new ArrayBuffer(0)
      proxiedAddress = ipv4Buffer(ip)
    },
    setRemoteIp(ip: string | null | undefined): void {
      remoteIp = ip ? Uint8Array.from(Buffer.from(ip)).buffer : new ArrayBuffer(0)
      remoteAddress = ipv4Buffer(ip)
    },
    setProxiedAddress(bytes: ArrayLike<number>, text = ''): void {
      proxiedAddress = Uint8Array.from(bytes).buffer
      proxiedIp = Uint8Array.from(Buffer.from(text)).buffer
    },
    setRemoteAddress(bytes: ArrayLike<number>, text = ''): void {
      remoteAddress = Uint8Array.from(bytes).buffer
      remoteIp = Uint8Array.from(Buffer.from(text)).buffer
    },
    getProxiedRemoteAddressAsTextCallCount(): number {
      return getProxiedRemoteAddressAsTextCallCount
    },
    getRemoteAddressAsTextCallCount(): number {
      return getRemoteAddressAsTextCallCount
    },
    getProxiedRemoteAddressCallCount(): number {
      return getProxiedRemoteAddressCallCount
    },
    getRemoteAddressCallCount(): number {
      return getRemoteAddressCallCount
    },
    getWarnings(): string[] {
      return [...warnings]
    },
    cork(fn: () => void): void {
      calls.push(['cork'])

      if (options.onCork) {
        options.onCork()
      }

      inCork = true
      try {
        fn()
      } finally {
        inCork = false
      }
    },
    writeStatus(s: string): void {
      calls.push(['writeStatus', s])
    },
    writeHeader(k: string, v: string): void {
      if (!inCork) {
        warnings.push('Warning: uWS.HttpResponse writes must be made from within a corked callback.')
      }

      calls.push(['writeHeader', k, v])
    },
    end(body?: ByteInput, closeConnection?: boolean): void {
      if (closeConnection !== undefined) {
        calls.push(['end', body, closeConnection])
      } else if (body !== undefined) {
        calls.push(['end', body])
      } else {
        calls.push(['end'])
      }
    },
    close(): void {
      calls.push(['close'])
    },
    endBatch(status: string, headerLines: string[], body?: NativeData) {
      calls.push(['endBatch', status, headerLines, body])

      return this
    },
    beginWrite(): void {
      calls.push(['beginWrite'])
    },
    collectBody(maxSize: number, cb: CollectBodyCallback): void {
      calls.push(['collectBody', maxSize])
      collectBodyCb = cb
    },
    pushCollectedBody(data: ArrayLike<number> | null): void {
      if (!collectBodyCb) {
        throw new Error('collectBody not called yet')
      }

      collectBodyCb(data === null ? null : Uint8Array.from(data).buffer)
    },
    onData(cb: DataCallback): void {
      calls.push(['onData'])
      onDataCb = cb
      res.onDataCb = cb
    },
    getProxiedRemoteAddressAsText(): ArrayBuffer {
      getProxiedRemoteAddressAsTextCallCount++

      return proxiedIp
    },
    getProxiedRemoteAddress(): ArrayBuffer {
      getProxiedRemoteAddressCallCount++

      return proxiedAddress
    },
    getRemoteAddressAsText(): ArrayBuffer {
      getRemoteAddressAsTextCallCount++

      return remoteIp
    },
    getRemoteAddress(): ArrayBuffer {
      getRemoteAddressCallCount++

      return remoteAddress
    },
    write(chunk: unknown): boolean {
      calls.push(['write', chunk])

      if (writeResultFn) {
        return writeResultFn(chunk)
      }

      if (writeResultSequence.length > 0) {
        return writeResultSequence.shift() ?? true
      }

      return true
    },
    tryEnd(chunk: unknown, totalSize: number): [boolean, boolean] {
      calls.push(['tryEnd', chunk, totalSize])

      if (tryEndResultFn) {
        return tryEndResultFn(chunk, totalSize)
      }

      if (tryEndResultSequence.length > 0) {
        return tryEndResultSequence.shift() ?? [true, true]
      }

      return [true, true]
    },
    getWriteOffset(): number {
      calls.push(['getWriteOffset'])

      return writeOffset
    },
    onWritable(cb: WritableCallback): void {
      calls.push(['onWritable'])
      onWritableCb = cb
    },
    setWriteResultSequence(results: boolean[]): void {
      writeResultSequence = [...results]
      writeResultFn = null
    },
    setWriteResult(fn: (chunk: unknown) => boolean): void {
      writeResultFn = fn
      writeResultSequence = []
    },
    setTryEndResultSequence(results: Array<readonly [boolean, boolean]>): void {
      tryEndResultSequence = results.map((r) => [...r])
      tryEndResultFn = null
    },
    setTryEndResult(fn: (chunk: unknown, totalSize: number) => [boolean, boolean]): void {
      tryEndResultFn = fn
      tryEndResultSequence = []
    },
    setWriteOffset(n: number): void {
      writeOffset = n
    },
    advanceWriteOffset(n: number): void {
      writeOffset += n
    },
    triggerWritable(offset: number): boolean {
      if (onWritableCb) {
        const result = onWritableCb(offset)

        return result
      }

      return true
    }
  } satisfies MockResControls & Record<string, unknown>

  return res as unknown as MockRes
}

/**
 * @param {unknown} ip
 * @returns {ArrayBuffer}
 */
function ipv4Buffer(ip: unknown): ArrayBuffer {
  if (typeof ip !== 'string') {
    return new ArrayBuffer(0)
  }

  const octets = ip.split('.').map(Number)

  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? Uint8Array.from(octets).buffer
    : new ArrayBuffer(0)
}

/**
 * @returns {object}
 */
export function createMockReadable(): MockReadable {
  const listeners: Record<string, Array<(arg: unknown) => void>> = {}

  let pauseCallCount = 0
  let resumeCallCount = 0
  let destroyCallCount = 0

  const readable: MockReadableControls = {
    emit(event: string, arg: unknown): void {
      if (listeners[event]) {
        for (const callback of listeners[event]) {
          callback(arg)
        }
      }
    },
    getPauseCallCount(): number {
      return pauseCallCount
    },
    getResumeCallCount(): number {
      return resumeCallCount
    },
    getDestroyCallCount(): number {
      return destroyCallCount
    }
  }

  const stream = {
    off(event: string, cb: (arg: unknown) => void): void {
      if (listeners[event]) {
        const index = listeners[event].indexOf(cb)

        if (index > -1) {
          listeners[event].splice(index, 1)
        }
      }
    },
    removeListener(event: string, cb: (arg: unknown) => void): void {
      if (listeners[event]) {
        const index = listeners[event].indexOf(cb)

        if (index > -1) {
          listeners[event].splice(index, 1)
        }
      }
    },
    on(event: string, cb: (arg: unknown) => void): void {
      if (!listeners[event]) {
        listeners[event] = []
      }

      listeners[event].push(cb)
    },
    pause(): void {
      pauseCallCount++
    },
    resume(): void {
      resumeCallCount++
    },
    destroy(): void {
      destroyCallCount++
    },
    ...readable
  }

  return stream as unknown as MockReadable
}

/**
 * @param {object} options
 * @param {string} [options.method]
 * @param {string} [options.url]
 * @param {Record<string, string>} [options.headers]
 * @param {Record<string, string>} [options.query]
 * @param {string} [options.fullQuery]
 * @param {string[]} [options.parameters]
 * @returns {object}
 */
export function createMockReq(
  options: {
    method?: string
    url?: string
    headers?: Record<string, string | undefined>
    query?: Record<string, string>
    fullQuery?: string
    parameters?: string[]
  } = {}
): MockReq {
  const calls: MockCall[] = []
  const headers = { ...(options.headers || {}) }
  const query = { ...(options.query || {}) }

  let fullQuery = options.fullQuery

  const parameters = [...(options.parameters || [])]

  let method = options.method || ''
  let url = options.url || ''

  const req = {
    calls,
    getMethod(): string {
      calls.push(['getMethod'])

      return method
    },
    setMethod(m: string): void {
      method = m
    },
    getUrl(): string {
      calls.push(['getUrl'])

      return url
    },
    setUrl(u: string): void {
      url = u
    },
    getHeader(name: string): string | undefined {
      calls.push(['getHeader', name])

      return headers[name]
    },
    setHeader(name: string, value: string): void {
      headers[name] = value
    },
    getQuery(key?: string): string | undefined {
      calls.push(['getQuery', key])

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
    setQuery(key: string, value: string): void {
      query[key] = value
      fullQuery = undefined
    },
    getParameter(i: number): string | undefined {
      calls.push(['getParameter', i])

      return parameters[i]
    },
    setParameter(i: number, value: string): void {
      parameters[i] = value
    },
    forEach(cb: (name: string, value: string | undefined) => void): void {
      calls.push(['forEach'])

      for (const name in headers) {
        cb(name, headers[name])
      }
    }
  } satisfies MockReqControls & Record<string, unknown>

  return req as unknown as MockReq
}
