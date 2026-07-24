/**
 * @returns {object}
 */
export function targetDefaults() {
  return {
    target: 'local',
    sshDestination: null,
    targetDir: null,
    connectHost: null,
    bindHost: null,
    portRange: null
  }
}

export const TARGET_ARG_HANDLERS = {
  '--target': (out, value) => {
    out.target = String(value)
  },
  '--ssh-destination': (out, value) => {
    out.sshDestination = String(value)
  },
  '--target-dir': (out, value) => {
    out.targetDir = String(value)
  },
  '--connect-host': (out, value) => {
    out.connectHost = String(value)
  },
  '--bind-host': (out, value) => {
    out.bindHost = String(value)
  },
  '--port-range': (out, value) => {
    out.portRange = String(value)
  }
}

/**
 * @param {'http'|'ws'} protocol
 * @param {{endpoint: {host: string, port: number}}} session
 * @param {string} pathname
 * @returns {string}
 */
export function targetUrl(protocol, session, pathname) {
  const host = session.endpoint.host.includes(':') ? `[${session.endpoint.host}]` : session.endpoint.host

  return `${protocol}://${host}:${session.endpoint.port}${pathname}`
}
