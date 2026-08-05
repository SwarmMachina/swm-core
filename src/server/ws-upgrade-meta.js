import { getRemoteAddress } from '../remote-address.js'

export default class WebSocketUpgradeMeta {
  #req
  #res
  #headerSelection
  #prefetchedHeaders
  #capturedRequest = null
  #capturedQuery = null
  #headersView = null
  #headersMaterialized = false

  aborted = false

  /**
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {false|'all'|readonly string[]} headerSelection
   * @param {object|null} prefetchedHeaders
   */
  constructor(req, res, headerSelection, prefetchedHeaders) {
    this.#req = req
    this.#res = res
    this.#headerSelection = headerSelection
    this.#prefetchedHeaders = prefetchedHeaders

    // UpgradeMeta methods have historically been enumerable own properties.
    // Reuse prototype functions to preserve that surface without allocating
    // one closure per method and upgrade request.
    this.url = META_URL
    this.ip = META_IP
    this.getParameter = META_GET_PARAMETER
    this.getQuery = META_GET_QUERY
    this.getHeader = META_GET_HEADER
    Object.defineProperty(this, 'headers', META_HEADERS)
  }

  url() {
    return this.#capturedRequest ? this.#capturedRequest.url : this.#req.getUrl()
  }

  ip() {
    return this.#capturedRequest ? this.#capturedRequest.ip : getRemoteAddress(this.#res)
  }

  get headers() {
    if (this.#headersMaterialized) {
      return this.#headersView
    }

    const headers = (this.#headersView ??= Object.create(null))

    this.#headersMaterialized = true

    if (this.#headerSelection !== false) {
      const retained = this.#prefetchedHeaders?.getHeaders?.()

      if (retained && typeof retained === 'object') {
        for (const name in retained) {
          headers[name.toLowerCase()] = retained[name]
        }
      }
    }

    return headers
  }

  getParameter(index) {
    return this.#capturedRequest ? this.#capturedRequest.params[index] : this.#req.getParameter(index)
  }

  getQuery(key) {
    if (!this.#capturedRequest) {
      return key === undefined ? this.#req.getQuery() : this.#req.getQuery(key)
    }

    if (key === undefined) {
      return this.#capturedRequest.query
    }

    this.#capturedQuery ??= new URLSearchParams(this.#capturedRequest.query)

    const value = this.#capturedQuery.get(key)

    return value === null ? undefined : value
  }

  getHeader(name) {
    const headerName = name.toLowerCase()
    const cached = this.#headersView?.[headerName]

    if (cached !== undefined) {
      return cached
    }

    const isPrefetched =
      this.#headerSelection === 'all' ||
      (Array.isArray(this.#headerSelection) && this.#headerSelection.includes(headerName))

    let value

    if (isPrefetched) {
      value = this.#prefetchedHeaders?.getHeader?.(headerName) ?? ''
    } else if (this.#capturedRequest) {
      value = ''
    } else {
      value = this.#req.getHeader(name) ?? ''
    }

    if (value !== '') {
      const headers = (this.#headersView ??= Object.create(null))

      headers[headerName] = value
    }

    return value
  }

  capture() {
    this.#capturedRequest = {
      url: this.#req.getUrl(),
      ip: getRemoteAddress(this.#res),
      query: this.#req.getQuery(),
      params: [this.#req.getParameter(0)]
    }
  }
}

const META_URL = WebSocketUpgradeMeta.prototype.url
const META_IP = WebSocketUpgradeMeta.prototype.ip
const META_GET_PARAMETER = WebSocketUpgradeMeta.prototype.getParameter
const META_GET_QUERY = WebSocketUpgradeMeta.prototype.getQuery
const META_GET_HEADER = WebSocketUpgradeMeta.prototype.getHeader
const META_HEADERS = Object.freeze({
  configurable: true,
  enumerable: true,
  get: Object.getOwnPropertyDescriptor(WebSocketUpgradeMeta.prototype, 'headers').get
})
