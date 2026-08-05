import { pathToFileURL } from 'node:url'

/**
 * Resolve swm-core's private binding import to the candidate selected by the
 * runtime integration gate.
 * @param {string} specifier
 * @param {object} context
 * @param {(specifier: string, context: object) => object|Promise<object>} nextResolve
 * @returns {object|Promise<object>}
 */
export function resolve(specifier, context, nextResolve) {
  if (specifier !== '#uws-binding') {
    return nextResolve(specifier, context)
  }

  const entry = process.env.SWM_UWS_CANDIDATE_ENTRY

  if (!entry) {
    throw new Error('SWM_UWS_CANDIDATE_ENTRY is required by the candidate binding loader')
  }

  return {
    shortCircuit: true,
    url: pathToFileURL(entry).href
  }
}
