export const mockCalls = {
  app: [],
  listen: [],
  close: [],
  us_listen_socket_close: []
}

/**
 *
 */
export function resetMocks() {
  mockCalls.app = []
  mockCalls.listen = []
  mockCalls.close = []
  mockCalls.us_listen_socket_close = []
}

/**
 * @returns {object}
 */
export function createMockApp() {
  const calls = []
  let listenCallback = null
  let closeCallCount = 0
  let numSubscribersResult = 0
  let publishResult = true

  const app = {
    calls,
    setListenCallback(cb) {
      listenCallback = cb
    },
    setNumSubscribersResult(value) {
      numSubscribersResult = value
    },
    setPublishResult(value) {
      publishResult = value
    },
    getCloseCallCount() {
      return closeCallCount
    },
    any(path, handler) {
      calls.push({ method: 'any', path, handler })
      return app
    },
    get(path, handler) {
      calls.push({ method: 'get', path, handler })
      return app
    },
    post(path, handler) {
      calls.push({ method: 'post', path, handler })
      return app
    },
    put(path, handler) {
      calls.push({ method: 'put', path, handler })
      return app
    },
    del(path, handler) {
      calls.push({ method: 'del', path, handler })
      return app
    },
    patch(path, handler) {
      calls.push({ method: 'patch', path, handler })
      return app
    },
    options(path, handler) {
      calls.push({ method: 'options', path, handler })
      return app
    },
    head(path, handler) {
      calls.push({ method: 'head', path, handler })
      return app
    },
    ws(path, config) {
      calls.push({ method: 'ws', path, config })
      return app
    },
    listen(port, cb) {
      mockCalls.listen.push({ port, cb })
      if (listenCallback) {
        listenCallback(cb)
      } else {
        cb({ sock: 1 })
      }
      return app
    },
    close() {
      closeCallCount++
      mockCalls.close.push({})
      return app
    },
    publish(topic, message, isBinary) {
      calls.push({ method: 'publish', topic, message, isBinary })
      return publishResult
    },
    numSubscribers(topic) {
      calls.push({ method: 'numSubscribers', topic })
      return numSubscribersResult
    }
  }

  mockCalls.app.push(app)
  return app
}

/**
 * @param {object} userData
 * @returns {object}
 */
export function createMockWebSocket(userData = {}) {
  const calls = []
  let endCallCount = 0

  return {
    calls,
    getUserData() {
      return userData
    },
    end(code, reason) {
      endCallCount++
      calls.push({ method: 'end', code, reason })
    },
    getEndCallCount() {
      return endCallCount
    },
    send(data, isBinary) {
      calls.push({ method: 'send', data, isBinary })
      return 0
    },
    subscribe(topic) {
      calls.push({ method: 'subscribe', topic })
      return true
    },
    unsubscribe(topic) {
      calls.push({ method: 'unsubscribe', topic })
      return true
    }
  }
}

/**
 * @returns {object}
 */
export function createMockHttpResponse() {
  const calls = []
  let abortedCallback = null
  let status = null
  const headers = {}
  let ended = false
  let upgraded = false

  return {
    calls,
    getStatus() {
      return status
    },
    getHeaders() {
      return { ...headers }
    },
    isEnded() {
      return ended
    },
    isUpgraded() {
      return upgraded
    },
    cork(fn) {
      calls.push({ method: 'cork' })
      fn()
    },
    writeStatus(s) {
      status = s
      calls.push({ method: 'writeStatus', status: s })
    },
    writeHeader(key, value) {
      headers[key] = value
      calls.push({ method: 'writeHeader', key, value })
    },
    end() {
      ended = true
      calls.push({ method: 'end' })
    },
    upgrade(userData, secKey, protocol, extensions, context) {
      upgraded = true
      calls.push({ method: 'upgrade', userData, secKey, protocol, extensions, context })
    },
    onAborted(cb) {
      abortedCallback = cb
      calls.push({ method: 'onAborted' })
    },
    triggerAborted() {
      if (abortedCallback) {
        abortedCallback()
      }
    },
    getRemoteAddressAsText() {
      return undefined
    },
    getProxiedRemoteAddressAsText() {
      return undefined
    }
  }
}

/**
 * @returns {object}
 */
export function createMockHttpRequest() {
  const calls = []
  let url = '/'
  const headers = {}
  const query = {}
  const parameters = []

  return {
    calls,
    setUrl(u) {
      url = u
    },
    setHeader(name, value) {
      headers[name] = value
    },
    setQuery(key, value) {
      query[key] = value
    },
    setParameter(index, value) {
      parameters[index] = value
    },
    getUrl() {
      calls.push({ method: 'getUrl' })
      return url
    },
    getHeader(name) {
      calls.push({ method: 'getHeader', name })
      return headers[name]
    },
    getQuery(key) {
      calls.push({ method: 'getQuery', key })
      return query[key]
    },
    getParameter(index) {
      calls.push({ method: 'getParameter', index })
      return parameters[index]
    }
  }
}

/**
 *
 * @param {any} socket
 */
export function us_listen_socket_close(socket) {
  mockCalls.us_listen_socket_close.push({ socket })
}
