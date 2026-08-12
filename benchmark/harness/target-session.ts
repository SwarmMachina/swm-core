import type { ArgHandler } from '@swarmmachina/benchkit/orchestration'
import type { TargetSession } from '@swarmmachina/benchkit/target-provider'
import type { TargetArgs } from './types.js'

export function targetDefaults(): TargetArgs {
  return {
    target: 'local',
    sshDestination: null,
    targetDir: null,
    connectHost: null,
    bindHost: null,
    portRange: null
  }
}

export const TARGET_ARG_HANDLERS: Record<string, ArgHandler<TargetArgs>> = {
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

export function targetUrl(protocol: 'http' | 'ws', session: Pick<TargetSession, 'endpoint'>, pathname: string): string {
  const host = session.endpoint.host.includes(':') ? `[${session.endpoint.host}]` : session.endpoint.host

  return `${protocol}://${host}:${session.endpoint.port}${pathname}`
}
