import path from 'node:path'
import { BENCHKIT_VERSION, PROTOCOL_VERSION, snapshotEnvironment, TargetProvider } from '@swarmmachina/benchkit'
import { ensureDir } from '@swarmmachina/benchkit/orchestration'
import type { EnvironmentSnapshot } from '@swarmmachina/benchkit/control'
import type { TargetArgs, TargetStartRequest, TargetStartResult } from './types.js'

/**
 * @param {string|null} value
 * @returns {[number, number]|undefined}
 */
function parsePortRange(value: string | null): readonly [number, number] | undefined {
  if (!value) {
    return undefined
  }

  const match = /^(\d+)-(\d+)$/u.exec(value)

  if (!match) {
    throw new Error(`Invalid --port-range=${value} (expected: MIN-MAX)`)
  }

  return [Number(match[1]), Number(match[2])]
}

interface BenchmarkMetadata {
  target: {
    mode: 'local' | 'ssh'
    bindHost: string
    connectHost: string
    environment: EnvironmentSnapshot | null
  }
  loadGeneratorEnvironment: EnvironmentSnapshot
  protocolVersion: number
  benchkitVersion: string
}

export class TargetController {
  #metadata: BenchmarkMetadata
  #provider: TargetProvider
  #portRange: readonly [number, number] | undefined
  #profileRoot: string
  #runtimeEntrypointRoot: string
  #candidateLoader: string

  /**
   * @param {object} args
   * @param {string} projectDir
   * @param {string} runtimeBenchDir
   */
  constructor(args: TargetArgs, projectDir: string, runtimeBenchDir: string) {
    if (args.target !== 'local' && args.target !== 'ssh') {
      throw new Error(`Unknown --target=${args.target} (expected: local, ssh)`)
    }

    if (args.target === 'ssh' && (!args.connectHost || !args.sshDestination || !args.targetDir)) {
      throw new Error('--target=ssh requires --connect-host, --ssh-destination, and --target-dir')
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
            connectHost: args.connectHost!,
            ...(args.bindHost ? { bindHost: args.bindHost } : {}),
            ssh: {
              destination: args.sshDestination!,
              cwd: args.targetDir!
            }
          })
    this.#portRange = parsePortRange(args.portRange)
    this.#profileRoot = path.join(projectDir, 'benchmark', 'profiles')
    this.#runtimeEntrypointRoot = path.relative(projectDir, runtimeBenchDir).split(path.sep).join('/')
    this.#candidateLoader = path
      .relative(
        projectDir,
        path.resolve(runtimeBenchDir, '..', 'tests', 'helpers', 'register-candidate-binding-loader.js')
      )
      .split(path.sep)
      .join('/')
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

  get metadata(): BenchmarkMetadata {
    return this.#metadata
  }

  /**
   * @param {object} options
   * @param {string} options.serverName
   * @param {string} options.fw
   * @param {string} options.testName
   * @param {number} options.runIndex
   * @param {boolean} options.v8prof
   * @param {string} options.runStamp
   * @returns {Promise<object>}
   */
  async start({
    serverName,
    fw,
    testName,
    runIndex,
    v8prof,
    runStamp
  }: TargetStartRequest): Promise<TargetStartResult> {
    const profileDir = await ensureDir(
      path.join(this.#profileRoot, `${testName}-${runStamp}`, `run-${runIndex + 1}`, fw)
    )
    const execArgv = []

    if (fw === 'core-uwebsockets' || fw === 'raw-uwebsockets') {
      execArgv.push('--conditions=uwebsockets-reference')
    } else if (
      fw === 'core-response-batch-off' ||
      fw === 'core-response-batch-on' ||
      fw === 'core-prepared-headers-off' ||
      fw === 'core-prepared-headers-on'
    ) {
      execArgv.push('--import', `./${this.#candidateLoader}`)
    }

    const session = await this.#provider.start({
      entrypoint: `./${this.#runtimeEntrypointRoot}/${serverName}`,
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
