/**
 * @param {string[]} argv
 * @param {object} defaults
 * @param {Record<string, (out: object, value: string|undefined) => boolean|void>} handlers
 * @returns {object}
 */
export default function parseArgs(argv, defaults, handlers) {
  const out = { ...defaults }

  for (let i = 2; i < argv.length; i++) {
    const name = argv[i]
    const handler = handlers[name]

    if (!handler) {
      continue
    }

    const value = handler(out, argv[i + 1]) !== false

    if (value) {
      i++
    }
  }

  return out
}
