export { default } from './server/server.js'
export { default as cors } from './http/cors.js'
export { serveStatic } from './static/index.js'
export { prepareHeaders } from './http/headers.js'

import type { ServerOptions } from './server/options.js'

/**
 * Preserve contextual ServerOptions typing for separately declared
 * configuration objects. Runtime validation remains the Server constructor's
 * responsibility.
 */
export function defineConfig<const Options extends ServerOptions>(options: Options): Options {
  return options
}
