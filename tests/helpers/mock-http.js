/**
 * @param {object} options
 * @param {Function} [options.onCork]
 * @returns {object}
 */
export function createMockRes(options = {}) {
  const calls = []
  const warnings = []
  let onDataCb = null
  let getProxiedRemoteAddressAsTextCallCount = 0
  let getRemoteAddressAsTextCallCount = 0
  let proxiedIp = null
  let remoteIp = null

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
      proxiedIp = ip ? Buffer.from(ip) : null
    },
    setRemoteIp(ip) {
      remoteIp = ip ? Buffer.from(ip) : null
    },
    getProxiedRemoteAddressAsTextCallCount() {
      return getProxiedRemoteAddressAsTextCallCount
    },
    getRemoteAddressAsTextCallCount() {
      return getRemoteAddressAsTextCallCount
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
    end(body) {
      if (body !== undefined) {
        calls.push(['end', body])
      } else {
        calls.push(['end'])
      }
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
    getRemoteAddressAsText() {
      getRemoteAddressAsTextCallCount++
      return remoteIp
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
 * Creates a mock readable stream object
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
 * Creates a mock HTTP request object
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
    }
  }
}
