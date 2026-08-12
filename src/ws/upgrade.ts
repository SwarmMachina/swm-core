import { compileHeaderPrefetchPlan } from '../http/prefetch.js'
import { STATUS_TEXT } from '../http/status.js'
import { isPromise } from '../internal/promise.js'
import { parseWsProtocols, validateWsProtocolSelection } from './protocol.js'
import WebSocketUpgradeMeta from './upgrade-meta.js'

import type {
  HttpRequest,
  HttpResponse,
  RequestPrefetchPlan,
  RequestPrefetchSnapshot,
  SocketContext
} from '@swarmmachina/swm-uws'

type HeaderSelection = false | 'all' | readonly string[]
type HeaderPlanConstructor = new (options: { headers: 'all' | readonly string[] }) => RequestPrefetchPlan
type UpgradeResult = object | null | Promise<object | null>

interface LifecycleState {
  draining: boolean
}

interface UpgradeServer {
  readonly wsProtocolSelector: ((requested: readonly string[], userData: object) => string | undefined) | null
  readonly onWsUpgrade: ((meta: WebSocketUpgradeMeta) => UpgradeResult) | null
  readonly onWsError: unknown
  readonly wsUpgradeTimeoutMs: number
  safeCall(handler: unknown, ...args: unknown[]): Promise<void>
}

export const WS_CONTEXT_DATA = Symbol('swm-core.ws-context-data')

function rejectUpgrade(res: HttpResponse, status = 403): void {
  res.cork(() => {
    res.writeStatus(STATUS_TEXT[status]!)
    res.end()
  })
}

export default class WebSocketUpgradeRuntime {
  readonly #server: UpgradeServer
  readonly #lifecycle: LifecycleState
  #headerSelection: HeaderSelection = false
  #headerPlan: RequestPrefetchPlan | null = null

  constructor(server: UpgradeServer, lifecycle: LifecycleState) {
    this.#server = server
    this.#lifecycle = lifecycle
    this.handle = this.handle.bind(this)
  }

  configureHeaderPrefetch(selection: HeaderSelection, Plan: HeaderPlanConstructor | null | undefined): void {
    this.#headerSelection = selection
    this.#headerPlan = compileHeaderPrefetchPlan(selection, Plan) as RequestPrefetchPlan | null
  }

  #acceptUpgrade(
    res: HttpResponse,
    userData: object,
    secWebSocketKey: string,
    requestedProtocol: string,
    secWebSocketExtensions: string,
    context: SocketContext
  ): void {
    let protocol
    let upgradeData

    try {
      const selector = this.#server.wsProtocolSelector

      if (selector) {
        const requested = parseWsProtocols(requestedProtocol)
        const selected = selector(requested, userData)

        protocol = validateWsProtocolSelection(requested, selected)
      } else {
        protocol = ''
      }

      upgradeData = { ...userData, [WS_CONTEXT_DATA]: userData }
    } catch (err) {
      rejectUpgrade(res)
      void this.#server.safeCall(this.#server.onWsError, null, err)

      return
    }

    res.cork(() => {
      res.upgrade(upgradeData, secWebSocketKey, protocol, secWebSocketExtensions, context)
    })
  }

  handle(res: HttpResponse, req: HttpRequest, context: SocketContext | object): void {
    const server = this.#server

    if (this.#lifecycle.draining) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[503]!)
        res.writeHeader('Connection', 'close')
        res.end()
      })

      return
    }

    const secWebSocketKey = req.getHeader('sec-websocket-key')
    const secWebSocketProtocol = req.getHeader('sec-websocket-protocol')
    const secWebSocketExtensions = req.getHeader('sec-websocket-extensions')

    let prefetchedHeaders: RequestPrefetchSnapshot | null = null

    const headerSelection = this.#headerSelection
    const headerPlan = this.#headerPlan

    try {
      if (headerPlan !== null) {
        if (!req || typeof req.prefetch !== 'function') {
          throw new Error('swm-uws advertised requestPrefetch but HttpRequest.prefetch is unavailable')
        }

        prefetchedHeaders = req.prefetch(headerPlan)

        if (
          !prefetchedHeaders ||
          typeof prefetchedHeaders.getHeader !== 'function' ||
          typeof prefetchedHeaders.getHeaders !== 'function'
        ) {
          throw new Error('swm-uws requestPrefetch did not return an owned header snapshot')
        }
      }
    } catch (err) {
      rejectUpgrade(res)
      void server.safeCall(server.onWsError, null, err)

      return
    }

    const meta = new WebSocketUpgradeMeta(req, res, headerSelection, prefetchedHeaders)

    let upgradeTimer: number | null = null

    res.onAborted(() => {
      meta.aborted = true

      if (upgradeTimer !== null) {
        clearTimeout(upgradeTimer)
      }

      upgradeTimer = null
    })

    let upgradeResult: UpgradeResult
    let asyncUpgrade: boolean

    try {
      // WebSocketRuntime registers this handler only when normalizeWsOptions
      // has accepted an explicit onUpgrade callback.
      upgradeResult = server.onWsUpgrade!(meta)
      asyncUpgrade = isPromise(upgradeResult)
    } catch (err) {
      if (!meta.aborted) {
        rejectUpgrade(res)
        void server.safeCall(server.onWsError, null, err)
      }

      return
    }

    if (asyncUpgrade) {
      try {
        meta.capture()
      } catch (err) {
        void Promise.resolve(upgradeResult).catch(() => {})

        rejectUpgrade(res)

        void server.safeCall(server.onWsError, null, err)

        return
      }

      let settled = false

      upgradeTimer = setTimeout(() => {
        if (settled || meta.aborted) {
          return
        }

        settled = true
        upgradeTimer = null
        rejectUpgrade(res, 408)

        const error = new Error(`WebSocket upgrade timed out after ${server.wsUpgradeTimeoutMs}ms`) as Error & {
          code: string
        }

        error.code = 'WS_UPGRADE_TIMEOUT'
        void server.safeCall(server.onWsError, null, error)
      }, server.wsUpgradeTimeoutMs) as unknown as number

      void Promise.resolve(upgradeResult)
        .then((result) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true

          if (upgradeTimer !== null) {
            clearTimeout(upgradeTimer)
          }

          upgradeTimer = null

          if (result && typeof result === 'object') {
            this.#acceptUpgrade(
              res,
              result,
              secWebSocketKey,
              secWebSocketProtocol,
              secWebSocketExtensions,
              context as SocketContext
            )

            return
          }

          rejectUpgrade(res)
        })
        .catch((err) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true

          if (upgradeTimer !== null) {
            clearTimeout(upgradeTimer)
          }

          upgradeTimer = null

          rejectUpgrade(res)

          void server.safeCall(server.onWsError, null, err)
        })

      return
    }

    if (!meta.aborted) {
      const result = upgradeResult

      if (result && typeof result === 'object') {
        this.#acceptUpgrade(
          res,
          result,
          secWebSocketKey,
          secWebSocketProtocol,
          secWebSocketExtensions,
          context as SocketContext
        )
      } else {
        rejectUpgrade(res)
      }
    }
  }
}
