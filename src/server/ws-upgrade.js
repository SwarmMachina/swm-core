import { STATUS_TEXT } from '../constants.js'
import { getRemoteAddress } from '../remote-address.js'
import { isPromise, parseWsProtocols, validateWsProtocolSelection } from './utils.js'

const UPGRADE_PARAMETER_COUNT = 1

/**
 * @param {import('@swarmmachina/swm-uws').HttpRequest} req
 * @param {import('@swarmmachina/swm-uws').HttpResponse} res
 * @returns {{url: string, ip: string, query: string, headers: Record<string, string>, params: Array<string|undefined>}}
 */
function snapshotUpgradeRequest(req, res) {
  let snapshot

  if (typeof req.snapshot === 'function') {
    snapshot = req.snapshot(UPGRADE_PARAMETER_COUNT)
  } else {
    const headers = Object.create(null)

    req.forEach((name, value) => {
      headers[name.toLowerCase()] = value
    })

    snapshot = {
      url: req.getUrl(),
      query: req.getQuery(),
      headers,
      params: [req.getParameter(0)]
    }
  }

  return {
    url: snapshot.url,
    ip: getRemoteAddress(res),
    query: snapshot.query,
    headers: snapshot.headers,
    params: snapshot.params
  }
}

export default class WebSocketUpgradeRuntime {
  #server
  #lifecycle

  constructor(server, lifecycle) {
    this.#server = server
    this.#lifecycle = lifecycle
    this.handle = this.handle.bind(this)
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

    try {
      const selector = this.#server.wsProtocolSelector

      if (selector) {
        const requested = parseWsProtocols(requestedProtocol)
        const selected = selector(requested, userData)

        protocol = validateWsProtocolSelection(requested, selected)
      } else {
        protocol = ''
      }
    } catch (err) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[403])
        res.end()
      })
      void this.#server.safeCall(this.#server.onWsError, null, err)

      return
    }

    res.cork(() => {
      res.upgrade(userData, secWebSocketKey, protocol, secWebSocketExtensions, context)
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

    let requestSnapshot = null
    let snapshotQuery = null

    const meta = {
      url: () => (requestSnapshot ? requestSnapshot.url : req.getUrl()),
      ip: () => (requestSnapshot ? requestSnapshot.ip : getRemoteAddress(res)),
      getParameter: (index) => (requestSnapshot ? requestSnapshot.params[index] : req.getParameter(index)),
      getQuery: (key) => {
        if (requestSnapshot) {
          if (key === undefined) {
            return requestSnapshot.query
          }

          snapshotQuery ??= new URLSearchParams(requestSnapshot.query)

          const value = snapshotQuery.get(key)

          return value === null ? undefined : value
        }

        if (key === undefined) {
          return req.getQuery()
        }

        return req.getQuery(key)
      },
      getHeader: (name) =>
        requestSnapshot ? (requestSnapshot.headers[name.toLowerCase()] ?? '') : req.getHeader(name),
      aborted: false
    }

    let upgradeTimer = null

    res.onAborted(() => {
      meta.aborted = true
      clearTimeout(upgradeTimer)
      upgradeTimer = null
    })

    let upgradeResult
    let upgradeError
    let isAsync = false

    try {
      upgradeResult = server.onWsUpgrade(meta)
      isAsync = isPromise(upgradeResult)
    } catch (err) {
      upgradeError = err
    }

    if (upgradeError) {
      if (!meta.aborted) {
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[403])
          res.end()
        })
        void server.safeCall(server.onWsError, null, upgradeError)
      }

      return
    }

    if (isAsync) {
      try {
        requestSnapshot = snapshotUpgradeRequest(req, res)
      } catch (err) {
        void Promise.resolve(upgradeResult).catch(() => {})

        res.cork(() => {
          res.writeStatus(STATUS_TEXT[403])
          res.end()
        })

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
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[408])
          res.end()
        })

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

          res.cork(() => {
            res.writeStatus(STATUS_TEXT[403])
            res.end()
          })
        })
        .catch((err) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true
          clearTimeout(upgradeTimer)
          upgradeTimer = null

          res.cork(() => {
            res.writeStatus(STATUS_TEXT[403])
            res.end()
          })

          void server.safeCall(server.onWsError, null, err)
        })

      return
    }

    if (!meta.aborted) {
      const result = upgradeResult

      if (result && typeof result === 'object') {
        this.#acceptUpgrade(res, result, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)
      } else {
        res.cork(() => {
          res.writeStatus(STATUS_TEXT[403])
          res.end()
        })
      }
    }
  }
}
