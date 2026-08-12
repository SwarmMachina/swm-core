import type { RequestPrefetchPlan } from '@swarmmachina/swm-uws'

interface NativeBindingModule {
  App: (...args: unknown[]) => object
  RequestPrefetchPlan?: new (options: { headers: 'all' | readonly string[] }) => RequestPrefetchPlan
  capabilities?: () => Record<string, boolean>
  us_listen_socket_close: (socket: unknown) => void
}

interface NativeBinding {
  App: (...args: unknown[]) => object
  RequestPrefetchPlan?: new (options: { headers: 'all' | readonly string[] }) => RequestPrefetchPlan
  capabilities: Record<string, boolean>
  us_listen_socket_close: (socket: unknown) => void
}

let cached: NativeBinding | null = null

const DEFAULT_NATIVE_FAST_PATHS = new Set([
  'beginWrite',
  'collectBody',
  'collectBodyLength',
  'httpTransportConfig',
  'requestPrefetch'
])

/**
 */
function selectCapabilities(advertised: Record<string, boolean>): Record<string, boolean> {
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
            .map((name: string) => name.trim())
            .filter(Boolean)
        )

  return Object.fromEntries(
    Object.entries(advertised).map(([name, available]) => [name, available && enabled.has(name)])
  )
}

/**
 */
export async function load(): Promise<NativeBinding> {
  if (cached) {
    return cached
  }

  let mod: NativeBindingModule

  try {
    mod = (await import('#uws-binding')) as unknown as NativeBindingModule
  } catch (err) {
    throw new Error(
      "Failed to load the required '@swarmmachina/swm-uws' dependency. Reinstall the package for a supported platform.",
      { cause: err }
    )
  }

  const advertised = typeof mod.capabilities === 'function' ? mod.capabilities() : {}
  const binding: NativeBinding = {
    App: mod.App,
    ...(mod.RequestPrefetchPlan === undefined ? {} : { RequestPrefetchPlan: mod.RequestPrefetchPlan }),
    us_listen_socket_close: mod.us_listen_socket_close,
    capabilities: selectCapabilities(advertised)
  }

  cached = binding

  return binding
}
