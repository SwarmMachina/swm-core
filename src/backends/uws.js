let cached = null

/**
 * @returns {Promise<{App: Function, us_listen_socket_close: Function}>}
 */
export async function load() {
  if (!cached) {
    const mod = await import('uwebsockets.js')

    cached = { App: mod.App, us_listen_socket_close: mod.us_listen_socket_close }
  }

  return cached
}
