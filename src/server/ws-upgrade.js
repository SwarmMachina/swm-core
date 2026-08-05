import { STATUS_TEXT } from '../constants.js'
import { compileHeaderPrefetchPlan, isPromise, parseWsProtocols, validateWsProtocolSelection } from './utils.js'
import WebSocketUpgradeMeta from './ws-upgrade-meta.js'

export const WS_CONTEXT_DATA = Symbol('swm-core.ws-context-data')

/**
 * @param {import('@swarmmachina/swm-uws').HttpResponse} res
 * @param {number} [status]
 */
function rejectUpgrade(res, status = 403) {
  res.cork(() => {
    res.writeStatus(STATUS_TEXT[status])
    res.end()
  })
}

export default class WebSocketUpgradeRuntime {
  #server
  #lifecycle
  #headerSelection = false
  #headerPlan = null

  constructor(server, lifecycle) {
    this.#server = server
    this.#lifecycle = lifecycle
    this.handle = this.handle.bind(this)
  }

  /**
   * @param {false|'all'|readonly string[]} selection
   * @param {(new (options: object) => object)|null|undefined} Plan
   */
  configureHeaderPrefetch(selection, Plan) {
    this.#headerSelection = selection
    this.#headerPlan = compileHeaderPrefetchPlan(selection, Plan)
  }

  /**
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {object} userData
   * @param {string} secWebSocketKey
   * @param {string} requestedProtocol
   * @param {string} secWebSocketExtensions
   * @param {import('@swarmmachina/swm-uws').us_socket_context_t} context
   */
  #acceptUpgrade(res, userData, secWebSocketKey, requestedProtocol, secWebSocketExtensions, context) {
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

  /**
   * @param {import('@swarmmachina/swm-uws').HttpResponse} res
   * @param {import('@swarmmachina/swm-uws').HttpRequest} req
   * @param {import('@swarmmachina/swm-uws').us_socket_context_t} context
   */
  handle(res, req, context) {
    const server = this.#server

    if (this.#lifecycle.draining) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[503])
        res.writeHeader('Connection', 'close')
        res.end()
      })

      return
    }

    const secWebSocketKey = req.getHeader('sec-websocket-key')
    const secWebSocketProtocol = req.getHeader('sec-websocket-protocol')
    const secWebSocketExtensions = req.getHeader('sec-websocket-extensions')

    let prefetchedHeaders = null

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

    let upgradeTimer = null

    res.onAborted(() => {
      meta.aborted = true
      clearTimeout(upgradeTimer)
      upgradeTimer = null
    })

    let upgradeResult

    try {
      upgradeResult = server.onWsUpgrade(meta)
    } catch (err) {
      if (!meta.aborted) {
        rejectUpgrade(res)
        void server.safeCall(server.onWsError, null, err)
      }

      return
    }

    if (isPromise(upgradeResult)) {
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

        const error = new Error(`WebSocket upgrade timed out after ${server.wsUpgradeTimeoutMs}ms`)

        error.code = 'WS_UPGRADE_TIMEOUT'
        void server.safeCall(server.onWsError, null, error)
      }, server.wsUpgradeTimeoutMs)

      void Promise.resolve(upgradeResult)
        .then((result) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true
          clearTimeout(upgradeTimer)
          upgradeTimer = null

          if (result && typeof result === 'object') {
            this.#acceptUpgrade(res, result, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)

            return
          }

          rejectUpgrade(res)
        })
        .catch((err) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true
          clearTimeout(upgradeTimer)
          upgradeTimer = null

          rejectUpgrade(res)

          void server.safeCall(server.onWsError, null, err)
        })

      return
    }

    if (!meta.aborted) {
      const result = upgradeResult

      if (result && typeof result === 'object') {
        this.#acceptUpgrade(res, result, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)
      } else {
        rejectUpgrade(res)
      }
    }
  }
}
