import { runWebSocketLoad, type WebSocketLoadResult } from '@swarmmachina/benchkit/load/websocket'

interface WsLoadOptions {
  name: string
  url: string
  connections: number
  workers: number
  msgSize: number
  maxInFlight: number
  warmupSec: number
  durationSec: number
}

export function runWsBenchmarkLoad(options: WsLoadOptions): Promise<WebSocketLoadResult> {
  return runWebSocketLoad({
    name: options.name,
    url: options.url,
    message: new Uint8Array(options.msgSize).fill(0x61),
    connections: options.connections,
    workers: options.workers,
    maxInFlight: options.maxInFlight,
    // One coordinator retains the same workers and connections across both phases.
    warmupMs: options.warmupSec * 1000,
    durationMs: options.durationSec * 1000,
    timeoutMs: 5000
  })
}
