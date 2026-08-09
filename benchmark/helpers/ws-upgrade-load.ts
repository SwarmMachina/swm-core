import { performance } from 'node:perf_hooks'
import { LatencyRecorder } from '@swarmmachina/benchkit/measurement'
import { WebSocket } from 'ws'

export interface WsUpgradeLoadOptions {
  url: string
  concurrency: number
  durationSec: number
  connectTimeoutMs?: number
}

export interface WsUpgradeLoadResult {
  upgrades: number
  upgradesPerSec: number
  latencyAvgMs: number | null
  latencyP95Ms: number | null
  latencyP97_5Ms: number | null
  latencyP99Ms: number | null
  errors: number
}

/** Continuously opens WebSocket connections at fixed concurrency. */
export default async function wsUpgradeLoad({
  url,
  concurrency,
  durationSec,
  connectTimeoutMs = 5000
}: WsUpgradeLoadOptions): Promise<WsUpgradeLoadResult> {
  const deadline = performance.now() + durationSec * 1000
  const latency = new LatencyRecorder()

  let upgrades = 0
  let errors = 0

  const runWorker = async () => {
    while (performance.now() < deadline) {
      const startedAt = performance.now()

      await new Promise<void>((resolve) => {
        const socket = new WebSocket(url, { perMessageDeflate: false })

        let settled = false
        let opened = false
        let timer = setTimeout(fail, connectTimeoutMs)

        /**
         *
         */
        function finish() {
          if (settled) {
            return
          }

          settled = true
          clearTimeout(timer)
          resolve()
        }

        /**
         *
         */
        function fail() {
          if (settled) {
            return
          }

          errors++
          try {
            socket.terminate()
          } catch {
            // ignore teardown races
          }

          finish()
        }

        socket.once('open', () => {
          opened = true
          upgrades++
          latency.record(performance.now() - startedAt)
          clearTimeout(timer)
          timer = setTimeout(fail, connectTimeoutMs)
          socket.close(1000)
        })
        socket.once('error', fail)
        socket.once('close', () => {
          if (settled) {
            return
          }

          if (!opened) {
            errors++
          }

          finish()
        })
      })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()))

  const summary = latency.summary(upgrades)

  return {
    upgrades,
    upgradesPerSec: upgrades / durationSec,
    latencyAvgMs: summary.avgMs,
    latencyP95Ms: summary.p95Ms,
    latencyP97_5Ms: summary.p97_5Ms,
    latencyP99Ms: summary.p99Ms,
    errors
  }
}
