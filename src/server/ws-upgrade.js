import { STATUS_TEXT } from '../constants.js'
import { getRemoteAddress } from '../remote-address.js'
import { isPromise, selectWsProtocol } from './utils.js'

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
   * @param {{userData?: object, protocol?: string}} result
   * @param {string} secWebSocketKey
   * @param {string} requestedProtocol
   * @param {string} secWebSocketExtensions
   * @param {import('@swarmmachina/swm-uws').us_socket_context_t} context
   */
  #acceptUpgrade(res, result, secWebSocketKey, requestedProtocol, secWebSocketExtensions, context) {
    let protocol

    try {
      protocol = selectWsProtocol(requestedProtocol, result.protocol)
    } catch (err) {
      res.cork(() => {
        res.writeStatus(STATUS_TEXT[403])
        res.end()
      })
      void this.#server.safeCall(this.#server.onWsError, null, err)

      return
    }

    res.cork(() => {
      res.upgrade(result.userData || {}, secWebSocketKey, protocol, secWebSocketExtensions, context)
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
    const meta = {
      url: () => req.getUrl(),
      ip: () => getRemoteAddress(res),
      getParameter: (index) => req.getParameter(index),
      getQuery: (key) => {
        if (key === undefined) {
          return req.getQuery()
        }

        return req.getQuery(key)
      },
      getHeader: (name) => req.getHeader(name),
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

      void upgradeResult
        .then((result = {}) => {
          if (settled || meta.aborted) {
            return
          }

          settled = true
          clearTimeout(upgradeTimer)
          upgradeTimer = null

          if (result?.isAllowed) {
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
      const result = upgradeResult || {}

      if (result?.isAllowed) {
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
