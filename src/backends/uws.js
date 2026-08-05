let cached = null

const DEFAULT_NATIVE_FAST_PATHS = new Set(['beginWrite', 'collectBody', 'httpTransportConfig', 'requestPrefetch'])

/**
 * @param {Record<string, boolean>} advertised
 * @returns {Record<string, boolean>}
 */
function selectCapabilities(advertised) {
  const configured = process.env.SWM_UWS_NATIVE_FAST_PATHS

  if (configured === 'all') {
    return advertised
  }

  const enabled =
    configured === undefined
      ? DEFAULT_NATIVE_FAST_PATHS
      : new Set(
          configured
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        )

  return Object.fromEntries(
    Object.entries(advertised).map(([name, available]) => [name, available && enabled.has(name)])
  )
}

/**
 * @returns {Promise<{App: (...args: unknown[]) => object, RequestPrefetchPlan?: new (options: object) => object, us_listen_socket_close: (socket: unknown) => void, capabilities: object}>}
 */
export async function load() {
  if (!cached) {
    let mod

    try {
      mod = await import('#uws-binding')
    } catch (err) {
      throw new Error(
        "Failed to load the required '@swarmmachina/swm-uws' dependency. Reinstall the package for a supported platform.",
        { cause: err }
      )
    }

    const advertised = typeof mod.capabilities === 'function' ? mod.capabilities() : {}
    const capabilities = selectCapabilities(advertised)

    cached = {
      App: mod.App,
      RequestPrefetchPlan: mod.RequestPrefetchPlan,
      us_listen_socket_close: mod.us_listen_socket_close,
      capabilities
    }
  }

  return cached
}
