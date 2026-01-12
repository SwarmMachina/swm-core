import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * @param {string} specifier
 * @param {object} context
 * @param {Function} nextResolve
 * @returns {object}
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'uwebsockets.js') {
    const mockModulePath = pathToFileURL(join(__dirname, 'mock-uws-module.js')).href

    return {
      shortCircuit: true,
      url: mockModulePath
    }
  }

  return nextResolve(specifier, context)
}
