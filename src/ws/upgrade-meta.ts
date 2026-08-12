import { getRemoteAddress } from '../net/remote-address.js'

import type { HttpRequest, HttpResponse, RequestPrefetchSnapshot } from '@swarmmachina/swm-uws'

type HeaderSelection = false | 'all' | readonly string[]
type HeaderRecord = Record<string, string>

interface CapturedRequest {
  url: string
  ip: string
  query: string
  params: readonly [string | undefined]
}

export default class WebSocketUpgradeMeta {
  readonly #req: HttpRequest
  readonly #res: HttpResponse
  readonly #headerSelection: HeaderSelection
  readonly #prefetchedHeaders: RequestPrefetchSnapshot | null
  #capturedRequest: CapturedRequest | null = null
  #capturedQuery: URLSearchParams | null = null
  #headersView: HeaderRecord | null = null
  #headersMaterialized = false

  aborted = false

  constructor(
    req: HttpRequest,
    res: HttpResponse,
    headerSelection: HeaderSelection,
    prefetchedHeaders: RequestPrefetchSnapshot | null
  ) {
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

  url(): string {
    return this.#capturedRequest ? this.#capturedRequest.url : this.#req.getUrl()
  }

  ip(): string {
    return this.#capturedRequest ? this.#capturedRequest.ip : getRemoteAddress(this.#res)
  }

  get headers(): HeaderRecord {
    if (this.#headersMaterialized) {
      return this.#headersView!
    }

    const headers = (this.#headersView ??= Object.create(null) as HeaderRecord)

    this.#headersMaterialized = true

    if (this.#headerSelection !== false) {
      const retained = this.#prefetchedHeaders?.getHeaders?.()

      if (retained && typeof retained === 'object') {
        for (const name in retained) {
          const value = retained[name]

          if (value !== undefined) {
            headers[name.toLowerCase()] = value
          }
        }
      }
    }

    return headers
  }

  getParameter(index: number): string | undefined {
    return this.#capturedRequest ? this.#capturedRequest.params[index] : this.#req.getParameter(index)
  }

  getQuery(key?: string): string | undefined {
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

  getHeader(name: string): string {
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
      const headers = (this.#headersView ??= Object.create(null) as HeaderRecord)

      headers[headerName] = value
    }

    return value
  }

  capture(): void {
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
  get: Object.getOwnPropertyDescriptor(WebSocketUpgradeMeta.prototype, 'headers')!.get! as () => HeaderRecord
})
