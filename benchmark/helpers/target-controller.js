import path from 'node:path'
import { BENCHKIT_VERSION, PROTOCOL_VERSION, snapshotEnvironment, TargetProvider } from '@swarmmachina/benchkit'
import { ensureDir } from '@swarmmachina/benchkit/orchestration'

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

export class TargetController {
  #metadata
  #provider
  #portRange

  /**
   * @param {object} args
   * @param {string} projectDir
   */
  constructor(args, projectDir) {
    if (args.target !== 'local' && args.target !== 'ssh') {
      throw new Error(`Unknown --target=${args.target} (expected: local, ssh)`)
    }

    this.#provider =
      args.target === 'local'
        ? new TargetProvider({
            mode: 'local',
            cwd: projectDir,
            ...(args.bindHost ? { bindHost: args.bindHost } : {}),
            ...(args.connectHost ? { connectHost: args.connectHost } : {})
          })
        : new TargetProvider({
            mode: 'ssh',
            connectHost: args.connectHost,
            ...(args.bindHost ? { bindHost: args.bindHost } : {}),
            ssh: {
              destination: args.sshDestination,
              cwd: args.targetDir
            }
          })
    this.#portRange = parsePortRange(args.portRange)
    this.#metadata = {
      target: {
        mode: this.#provider.mode,
        bindHost: this.#provider.bindHost,
        connectHost: this.#provider.connectHost,
        environment: null
      },
      loadGeneratorEnvironment: snapshotEnvironment(),
      protocolVersion: PROTOCOL_VERSION,
      benchkitVersion: BENCHKIT_VERSION
    }
  }

  get metadata() {
    return this.#metadata
  }

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

    let execArgv = []

    if (fw === 'core-uwebsockets' || fw === 'raw-uwebsockets') {
      execArgv = ['--conditions=uwebsockets-reference']
    } else if (fw === 'core-response-batch-off' || fw === 'core-response-batch-on') {
      execArgv = ['--import', './tests/helpers/register-candidate-binding-loader.js']
    }

    const session = await this.#provider.start({
      entrypoint: `./benchmark/${serverName}`,
      args: ['--fw', fw, '--test', testName],
      execArgv,
      ...(this.#portRange ? { port: { range: this.#portRange } } : {}),
      profile: v8prof ? { directory: profileDir } : false
    })

    this.#metadata.target.environment = session.targetEnvironment

    try {
      await session.waitReachable()
    } catch (error) {
      await session.stop().catch(() => {})
      throw error
    }

    return { session, profileDir }
  }
}
