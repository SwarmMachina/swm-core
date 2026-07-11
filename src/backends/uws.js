let cached = null

/**
 * @returns {Promise<{App: Function, us_listen_socket_close: Function}>}
 */
export async function load() {
  if (!cached) {
    let mod

    try {
      mod = await import('#uws-binding')
    } catch (err) {
      throw new Error(
        "Failed to load the required 'uwebsockets.js' dependency. Reinstall the package for this platform or explicitly use backend: 'node'.",
        { cause: err }
      )
    }

    cached = { App: mod.App, us_listen_socket_close: mod.us_listen_socket_close }
  }

  return cached
}
