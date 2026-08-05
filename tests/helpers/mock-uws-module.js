import {
  createMockApp,
  createMockHttpRequest,
  createMockHttpResponse,
  createMockWebSocket,
  mockCalls,
  resetMocks,
  us_listen_socket_close as _us_listen_socket_close
} from './mock-uws.js'

let currentApp = null
let pendingListenCallback = null

/**
 * @param {object} [options]
 * @returns {object}
 */
export function App(options) {
  if (!currentApp) {
    currentApp = createMockApp(options)

    if (pendingListenCallback) {
      currentApp.setListenCallback(pendingListenCallback)
      pendingListenCallback = null
    }
  }

  return currentApp
}

/** Mock compiled request-prefetch plan. */
export class RequestPrefetchPlan {
  constructor({ headers }) {
    this.headers = headers
  }
}

/** @returns {Record<string, boolean>} */
export function capabilities() {
  return {
    beginWrite: true,
    collectBody: true,
    httpTransportConfig: true,
    requestPause: true,
    requestPrefetch: true,
    responseBatch: true
  }
}

/**
 * @param {unknown} socket
 * @returns {void}
 */
export function us_listen_socket_close(socket) {
  return _us_listen_socket_close(socket)
}

export { createMockWebSocket, createMockHttpResponse, createMockHttpRequest, resetMocks, mockCalls }

/**
 * @returns {object}
 */
export function getCurrentMockApp() {
  return currentApp
}

/**
 *
 */
export function resetMockApp() {
  currentApp = null
  pendingListenCallback = null
  resetMocks()
}

/**
 * @param {(socket: object) => void} cb
 */
export function setListenCallback(cb) {
  if (currentApp) {
    currentApp.setListenCallback(cb)
  } else {
    pendingListenCallback = cb
  }
}
