export { default } from './server.js'
export { default as cors } from './cors.js'
export { default as serveStatic } from './serve-static.js'
export { prepareHeaders } from './prepared-headers.js'

import type { ServerOptions } from './server/options.js'

/**
 * Preserve contextual ServerOptions typing for separately declared
 * configuration objects. Runtime validation remains the Server constructor's
 * responsibility.
 */
export function defineConfig<const Options extends ServerOptions>(options: Options): Options {
  return options
}
