const METHODS = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  DELETE: 'delete',
  PATCH: 'patch',
  OPTIONS: 'options',
  HEAD: 'head',
  CONNECT: 'connect',
  TRACE: 'trace'
}

export default class NodeHttpRequest {
  #url = null
  #query = null

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {string[]} params - Positional route params (may be empty).
   */
  constructor(req, params) {
    this.req = req
    this.params = params
  }

  #splitUrl() {
    if (this.#url !== null) {
      return
    }

    const url = this.req.url
    const qi = url.indexOf('?')

    if (qi === -1) {
      this.#url = url
      this.#query = ''
    } else {
      this.#url = url.slice(0, qi)
      this.#query = url.slice(qi + 1)
    }
  }

  /**
   * @returns {string}
   */
  getMethod() {
    const method = this.req.method

    return METHODS[method] ?? method.toLowerCase()
  }

  /**
   * @returns {string}
   */
  getUrl() {
    this.#splitUrl()

    return this.#url
  }

  /**
   * @param {string} [key]
   * @returns {string|undefined}
   */
  getQuery(key) {
    this.#splitUrl()

    if (key === undefined) {
      return this.#query
    }

    const q = this.#query

    if (!q) {
      return undefined
    }

    let start = 0

    while (start <= q.length) {
      let end = q.indexOf('&', start)

      if (end === -1) {
        end = q.length
      }

      const eq = q.indexOf('=', start)
      const hasEq = eq !== -1 && eq < end
      const name = hasEq ? q.slice(start, eq) : q.slice(start, end)

      if (name === key) {
        return hasEq ? q.slice(eq + 1, end) : ''
      }

      if (end === q.length) {
        break
      }

      start = end + 1
    }

    return undefined
  }

  /**
   * @param {string} name - Already-lowercased header name.
   * @returns {string}
   */
  getHeader(name) {
    const value = this.req.headers[name]

    if (value === undefined) {
      return ''
    }

    return Array.isArray(value) ? value.join(', ') : value
  }

  /**
   * @param {number} index
   * @returns {string|undefined}
   */
  getParameter(index) {
    return this.params ? this.params[index] : undefined
  }

  /**
   * @param {(key: string, value: string) => void} cb
   */
  forEach(cb) {
    const headers = this.req.headers

    for (const key in headers) {
      const value = headers[key]

      cb(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }
}
