import path from 'node:path'
import { BENCHKIT_VERSION, PROTOCOL_VERSION, createTargetProvider, snapshotEnvironment } from '@swarmmachina/benchkit'
import { ensureDir } from '@swarmmachina/benchkit/orchestration'

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

/**
 * @param {string|null} value
 * @returns {[number, number]|undefined}
 */
function parsePortRange(value) {
  if (!value) {
    return undefined
  }

  const match = /^(\d+)-(\d+)$/u.exec(value)

  if (!match) {
    throw new Error(`Invalid --port-range=${value} (expected: MIN-MAX)`)
  }

  return [Number(match[1]), Number(match[2])]
}

/**
 * @param {object} args
 * @param {string} projectDir
 * @returns {object}
 */
export function createTargetController(args, projectDir) {
  if (args.target !== 'local' && args.target !== 'ssh') {
    throw new Error(`Unknown --target=${args.target} (expected: local, ssh)`)
  }

  const provider =
    args.target === 'local'
      ? createTargetProvider({
          mode: 'local',
          cwd: projectDir,
          ...(args.bindHost ? { bindHost: args.bindHost } : {}),
          ...(args.connectHost ? { connectHost: args.connectHost } : {})
        })
      : createTargetProvider({
          mode: 'ssh',
          connectHost: args.connectHost,
          ...(args.bindHost ? { bindHost: args.bindHost } : {}),
          ssh: {
            destination: args.sshDestination,
            cwd: args.targetDir
          }
        })
  const portRange = parsePortRange(args.portRange)
  const metadata = {
    target: {
      mode: provider.mode,
      bindHost: provider.bindHost,
      connectHost: provider.connectHost,
      environment: null
    },
    loadGeneratorEnvironment: snapshotEnvironment(),
    protocolVersion: PROTOCOL_VERSION,
    benchkitVersion: BENCHKIT_VERSION
  }

  return {
    metadata,

    /**
     * @param {object} options
     * @param {string} options.benchDir
     * @param {string} options.serverName
     * @param {string} options.fw
     * @param {string} options.testName
     * @param {number} options.runIndex
     * @param {boolean} options.v8prof
     * @param {string} options.runStamp
     * @returns {Promise<object>}
     */
    async start({ benchDir, serverName, fw, testName, runIndex, v8prof, runStamp }) {
      const profileDir = await ensureDir(
        path.join(benchDir, 'profiles', `${testName}-${runStamp}`, `run-${runIndex + 1}`, fw)
      )
      const execArgv =
        fw === 'core-uwebsockets' || fw === 'raw-uwebsockets' ? ['--conditions=uwebsockets-reference'] : []
      const session = await provider.start({
        entrypoint: `./benchmark/${serverName}`,
        args: ['--fw', fw, '--test', testName],
        execArgv,
        ...(portRange ? { port: { range: portRange } } : {}),
        profile: v8prof ? { directory: profileDir } : false
      })

      metadata.target.environment = session.targetEnvironment

      try {
        await session.waitReachable()
      } catch (error) {
        await session.stop().catch(() => {})
        throw error
      }

      return { session, profileDir }
    }
  }
}
