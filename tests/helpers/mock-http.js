/**
 * @param {object} options
 * @param {() => void} [options.onCork]
 * @returns {object}
 */
export function createMockRes(options = {}) {
  const calls = []
  const warnings = []

  let onDataCb = null
  let collectBodyCb = null
  let getProxiedRemoteAddressAsTextCallCount = 0
  let getRemoteAddressAsTextCallCount = 0
  let getProxiedRemoteAddressCallCount = 0
  let getRemoteAddressCallCount = 0
  let proxiedIp = new ArrayBuffer(0)
  let proxiedAddress = new ArrayBuffer(0)
  let remoteIp = new ArrayBuffer(0)
  let remoteAddress = new ArrayBuffer(0)
  let writeOffset = 0
  let writeResultSequence = []
  let writeResultFn = null
  let tryEndResultSequence = []
  let tryEndResultFn = null
  let onWritableCb = null
  let inCork = false

  const res = {
    calls,
    onDataCb: null,

    /**
     * @param {Buffer|Uint8Array|ArrayBuffer|string} data
     * @param {boolean} isLast
     */
    pushData(data, isLast) {
      if (!onDataCb) {
        throw new Error('onData not called yet')
      }

      const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)

      onDataCb(buffer, isLast)
    },
    setProxiedIp(ip) {
      proxiedIp = ip ? Uint8Array.from(Buffer.from(ip)).buffer : new ArrayBuffer(0)
      proxiedAddress = ipv4Buffer(ip)
    },
    setRemoteIp(ip) {
      remoteIp = ip ? Uint8Array.from(Buffer.from(ip)).buffer : new ArrayBuffer(0)
      remoteAddress = ipv4Buffer(ip)
    },
    setProxiedAddress(bytes, text = '') {
      proxiedAddress = Uint8Array.from(bytes).buffer
      proxiedIp = Uint8Array.from(Buffer.from(text)).buffer
    },
    setRemoteAddress(bytes, text = '') {
      remoteAddress = Uint8Array.from(bytes).buffer
      remoteIp = Uint8Array.from(Buffer.from(text)).buffer
    },
    getProxiedRemoteAddressAsTextCallCount() {
      return getProxiedRemoteAddressAsTextCallCount
    },
    getRemoteAddressAsTextCallCount() {
      return getRemoteAddressAsTextCallCount
    },
    getProxiedRemoteAddressCallCount() {
      return getProxiedRemoteAddressCallCount
    },
    getRemoteAddressCallCount() {
      return getRemoteAddressCallCount
    },
    getWarnings() {
      return [...warnings]
    },
    cork(fn) {
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
    writeStatus(s) {
      calls.push(['writeStatus', s])
    },
    writeHeader(k, v) {
      if (!inCork) {
        warnings.push('Warning: uWS.HttpResponse writes must be made from within a corked callback.')
      }

      calls.push(['writeHeader', k, v])
    },
    end(body, closeConnection) {
      if (closeConnection !== undefined) {
        calls.push(['end', body, closeConnection])
      } else if (body !== undefined) {
        calls.push(['end', body])
      } else {
        calls.push(['end'])
      }
    },
    close() {
      calls.push(['close'])
    },
    endBatch(status, headerLines, body) {
      calls.push(['endBatch', status, headerLines, body])
    },
    beginWrite() {
      calls.push(['beginWrite'])
    },
    collectBody(maxSize, cb) {
      calls.push(['collectBody', maxSize])
      collectBodyCb = cb
    },
    pushCollectedBody(data) {
      if (!collectBodyCb) {
        throw new Error('collectBody not called yet')
      }

      collectBodyCb(data === null ? null : Uint8Array.from(data).buffer)
    },
    onData(cb) {
      calls.push(['onData'])
      onDataCb = cb
      res.onDataCb = cb
    },
    getProxiedRemoteAddressAsText() {
      getProxiedRemoteAddressAsTextCallCount++

      return proxiedIp
    },
    getProxiedRemoteAddress() {
      getProxiedRemoteAddressCallCount++

      return proxiedAddress
    },
    getRemoteAddressAsText() {
      getRemoteAddressAsTextCallCount++

      return remoteIp
    },
    getRemoteAddress() {
      getRemoteAddressCallCount++

      return remoteAddress
    },
    write(chunk) {
      calls.push(['write', chunk])

      if (writeResultFn) {
        return writeResultFn(chunk)
      }

      if (writeResultSequence.length > 0) {
        return writeResultSequence.shift()
      }

      return true
    },
    tryEnd(chunk, totalSize) {
      calls.push(['tryEnd', chunk, totalSize])

      if (tryEndResultFn) {
        return tryEndResultFn(chunk, totalSize)
      }

      if (tryEndResultSequence.length > 0) {
        return tryEndResultSequence.shift()
      }

      return [true, true]
    },
    getWriteOffset() {
      calls.push(['getWriteOffset'])

      return writeOffset
    },
    onWritable(cb) {
      calls.push(['onWritable'])
      onWritableCb = cb
    },
    setWriteResultSequence(results) {
      writeResultSequence = [...results]
      writeResultFn = null
    },
    setWriteResult(fn) {
      writeResultFn = fn
      writeResultSequence = []
    },
    setTryEndResultSequence(results) {
      tryEndResultSequence = results.map((r) => [...r])
      tryEndResultFn = null
    },
    setTryEndResult(fn) {
      tryEndResultFn = fn
      tryEndResultSequence = []
    },
    setWriteOffset(n) {
      writeOffset = n
    },
    advanceWriteOffset(n) {
      writeOffset += n
    },
    triggerWritable(offset) {
      if (onWritableCb) {
        const result = onWritableCb(offset)

        return result
      }

      return true
    }
  }

  return res
}

/**
 * @param {unknown} ip
 * @returns {ArrayBuffer}
 */
function ipv4Buffer(ip) {
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
export function createMockReadable() {
  const listeners = {}

  let pauseCallCount = 0
  let resumeCallCount = 0
  let destroyCallCount = 0

  return {
    off(event, cb) {
      if (listeners[event]) {
        const index = listeners[event].indexOf(cb)

        if (index > -1) {
          listeners[event].splice(index, 1)
        }
      }
    },
    removeListener(event, cb) {
      if (listeners[event]) {
        const index = listeners[event].indexOf(cb)

        if (index > -1) {
          listeners[event].splice(index, 1)
        }
      }
    },
    on(event, cb) {
      if (!listeners[event]) {
        listeners[event] = []
      }

      listeners[event].push(cb)
    },
    emit(event, arg) {
      if (listeners[event]) {
        for (const cb of listeners[event]) {
          cb(arg)
        }
      }
    },
    pause() {
      pauseCallCount++
    },
    resume() {
      resumeCallCount++
    },
    destroy() {
      destroyCallCount++
    },
    getPauseCallCount() {
      return pauseCallCount
    },
    getResumeCallCount() {
      return resumeCallCount
    },
    getDestroyCallCount() {
      return destroyCallCount
    }
  }
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
export function createMockReq(options = {}) {
  const calls = []
  const headers = { ...(options.headers || {}) }
  const query = { ...(options.query || {}) }

  let fullQuery = options.fullQuery

  const parameters = [...(options.parameters || [])]

  let method = options.method || ''
  let url = options.url || ''

  return {
    calls,
    getMethod() {
      calls.push(['getMethod'])

      return method
    },
    setMethod(m) {
      method = m
    },
    getUrl() {
      calls.push(['getUrl'])

      return url
    },
    setUrl(u) {
      url = u
    },
    getHeader(name) {
      calls.push(['getHeader', name])

      return headers[name]
    },
    setHeader(name, value) {
      headers[name] = value
    },
    getQuery(key) {
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
    setQuery(key, value) {
      query[key] = value
      fullQuery = undefined
    },
    getParameter(i) {
      calls.push(['getParameter', i])

      return parameters[i]
    },
    setParameter(i, value) {
      parameters[i] = value
    },
    forEach(cb) {
      calls.push(['forEach'])

      for (const name in headers) {
        cb(name, headers[name])
      }
    },
    snapshot(paramCount = 0) {
      calls.push(['snapshot', paramCount])

      return {
        method,
        url,
        query: typeof fullQuery === 'string' ? fullQuery : new URLSearchParams(query).toString(),
        headers: Object.assign(Object.create(null), headers),
        params: parameters.slice(0, paramCount)
      }
    }
  }
}
