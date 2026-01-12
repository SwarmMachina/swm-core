/**
 * @param {object} options
 * @param {Function} [options.onCork]
 * @returns {object}
 */
export function createMockRes(options = {}) {
  const calls = []
  let onDataCb = null
  let getProxiedRemoteAddressAsTextCallCount = 0
  let getRemoteAddressAsTextCallCount = 0
  let proxiedIp = null
  let remoteIp = null

  // Streaming support
  let writeOffset = 0
  let writeResultSequence = []
  let writeResultFn = null
  let tryEndResultSequence = []
  let tryEndResultFn = null
  let onWritableCb = null

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
    cork(fn) {
      calls.push(['cork'])
      if (options.onCork) {
        options.onCork()
      }
      fn()
    },
    writeStatus(s) {
      calls.push(['writeStatus', s])
    },
    writeHeader(k, v) {
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
      res.onDataCb = cb // expose for testing
    },
    getProxiedRemoteAddressAsText() {
      getProxiedRemoteAddressAsTextCallCount++
      return proxiedIp
    },
    getRemoteAddressAsText() {
      getRemoteAddressAsTextCallCount++
      return remoteIp
    },
    // Streaming methods
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
    // Helpers for controlling streaming behavior
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
 * Creates a mock HTTP request object
 * @param {object} options
 * @param {string} [options.method]
 * @param {string} [options.url]
 * @param {Record<string, string>} [options.headers]
 * @param {Record<string, string>} [options.query]
 * @param {string[]} [options.parameters]
 * @returns {object}
 */
export function createMockReq(options = {}) {
  const calls = []
  const headers = { ...(options.headers || {}) }
  const query = { ...(options.query || {}) }
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
      return query[key]
    },
    setQuery(key, value) {
      query[key] = value
    },
    getParameter(i) {
      calls.push(['getParameter', i])
      return parameters[i]
    },
    setParameter(i, value) {
      parameters[i] = value
    }
  }
}
