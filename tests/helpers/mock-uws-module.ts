import {
  createMockApp,
  createMockHttpRequest,
  createMockHttpResponse,
  createMockWebSocket,
  mockCalls,
  resetMocks,
  us_listen_socket_close as _us_listen_socket_close
} from './mock-uws.js'
import type { MockApp } from './mock-uws.js'

type ListenInterceptor = (listen: (socket: object | null) => void) => void

let currentApp: MockApp | null = null
let pendingListenCallback: ListenInterceptor | null = null

/**
 * @param {object} [options]
 * @returns {object}
 */
export function App(options: object = {}): MockApp {
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
  headers: 'all' | readonly string[]

  constructor({ headers }: { headers: 'all' | readonly string[] }) {
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
export function us_listen_socket_close(socket: unknown): void {
  return _us_listen_socket_close(socket)
}

export { createMockWebSocket, createMockHttpResponse, createMockHttpRequest, resetMocks, mockCalls }

/**
 * @returns {object}
 */
export function getCurrentMockApp(): MockApp | null {
  return currentApp
}

export function requireCurrentMockApp(): MockApp {
  if (!currentApp) {
    throw new Error('Mock app has not been created')
  }

  return currentApp
}

/**
 *
 */
export function resetMockApp(): void {
  currentApp = null
  pendingListenCallback = null
  resetMocks()
}

/**
 * @param {(socket: object) => void} cb
 */
export function setListenCallback(cb: ListenInterceptor): void {
  if (currentApp) {
    currentApp.setListenCallback(cb)
  } else {
    pendingListenCallback = cb
  }
}
