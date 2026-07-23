export { default } from './server.js'
export { default as cors } from './cors.js'
export { default as serveStatic } from './serve-static.js'
export { prepareHeaders } from './prepared-headers.js'

/**
 * Preserve contextual ServerOptions typing for separately declared
 * configuration objects. Runtime validation remains the Server constructor's
 * responsibility.
 * @template {object} Options
 * @param {Options} options
 * @returns {Options}
 */
export function defineConfig(options) {
  return options
}
