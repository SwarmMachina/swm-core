let cached = null

/**
 * @returns {Promise<{App: Function, us_listen_socket_close: Function}>}
 */
export async function load() {
  if (!cached) {
    let mod

    try {
      mod = await import('uwebsockets.js')
    } catch (err) {
      throw new Error(
        "The 'uws' backend requires the optional 'uwebsockets.js' dependency. Install it (npm i uwebsockets.js) or use backend: 'node'.",
        { cause: err }
      )
    }

    cached = { App: mod.App, us_listen_socket_close: mod.us_listen_socket_close }
  }

  return cached
}
