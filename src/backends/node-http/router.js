const COLON = 58
const SLASH = 47

/**
 * @returns {{static: Map<string, object>|null, param: object|null, wildcard: object|null, handlers: object|null}}
 */
function makeNode() {
  return { static: null, param: null, wildcard: null, handlers: null }
}

/**
 * @param {string} path
 * @returns {string[]}
 */
function splitPath(path) {
  if (path.length <= 1) {
    return []
  }

  const raw = path.charCodeAt(0) === SLASH ? path.slice(1) : path

  return raw.split('/')
}

/**
 * @param {object} node
 * @param {string[]} segments
 * @param {number} i
 * @param {string} method
 * @param {string[]} params
 * @returns {Function|null}
 */
function matchNode(node, segments, i, method, params) {
  if (i === segments.length) {
    if (node.handlers) {
      const h = node.handlers[method] || node.handlers.any

      if (h) {
        return h
      }
    }

    // `/*` also matches the empty tail (e.g. path '/').
    if (node.wildcard && node.wildcard.handlers) {
      const h = node.wildcard.handlers[method] || node.wildcard.handlers.any

      if (h) {
        params.push('')
        return h
      }
    }

    return null
  }

  const seg = segments[i]

  if (node.static) {
    const child = node.static.get(seg)

    if (child) {
      const h = matchNode(child, segments, i + 1, method, params)

      if (h) {
        return h
      }
    }
  }

  if (node.param) {
    params.push(seg)

    const h = matchNode(node.param, segments, i + 1, method, params)

    if (h) {
      return h
    }

    params.pop()
  }

  if (node.wildcard && node.wildcard.handlers) {
    const h = node.wildcard.handlers[method] || node.wildcard.handlers.any

    if (h) {
      params.push(i === segments.length ? '' : segments.slice(i).join('/'))
      return h
    }
  }

  return null
}

export default class Router {
  #root = makeNode()

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {Function} handler
   */
  add(method, pattern, handler) {
    const segments = splitPath(pattern)
    let node = this.#root

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]

      if (seg === '*') {
        if (!node.wildcard) {
          node.wildcard = makeNode()
        }

        node = node.wildcard
        // A wildcard consumes the rest of the path; ignore trailing segments.
        break
      } else if (seg.charCodeAt(0) === COLON) {
        if (!node.param) {
          node.param = makeNode()
        }

        node = node.param
      } else {
        if (!node.static) {
          node.static = new Map()
        }

        let child = node.static.get(seg)

        if (!child) {
          child = makeNode()
          node.static.set(seg, child)
        }

        node = child
      }
    }

    if (!node.handlers) {
      node.handlers = Object.create(null)
    }

    node.handlers[method] = handler
  }

  /**
   * @param {string} method
   * @param {string} path
   * @returns {{handler: Function, params: string[]}|null}
   */
  match(method, path) {
    const params = []
    const handler = matchNode(this.#root, splitPath(path), 0, method, params)

    if (!handler) {
      return null
    }

    return { handler, params }
  }
}
