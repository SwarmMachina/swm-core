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
 * @returns {object}
 */
export function App() {
  if (!currentApp) {
    currentApp = createMockApp()

    if (pendingListenCallback) {
      currentApp.setListenCallback(pendingListenCallback)
      pendingListenCallback = null
    }
  }

  return currentApp
}

/**
 * @param {any} socket
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
 * @param {Function} cb
 */
export function setListenCallback(cb) {
  if (currentApp) {
    currentApp.setListenCallback(cb)
  } else {
    pendingListenCallback = cb
  }
}
