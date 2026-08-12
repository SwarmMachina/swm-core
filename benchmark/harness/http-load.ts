import os from 'node:os'
import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'
import type { BenchmarkLoadOptions, HttpLoadMetrics } from './types.js'

export default async function runLoad(name: string, opts: BenchmarkLoadOptions): Promise<HttpLoadMetrics> {
  const connections = opts.connections ?? 10
  const pipelining = opts.pipelining ?? 1
  const workers = Math.min(4, os.availableParallelism(), connections)
  const durationMs = (opts.duration ?? 10) * 1000
  const loadOptions = {
    name,
    url: opts.url,
    method: opts.method,
    ...(opts.headers === undefined ? {} : { headers: opts.headers }),
    ...(opts.body === undefined ? {} : { body: opts.body }),
    connections,
    pipelining,
    workers,
    durationMs,
    ...(opts.timeout === undefined ? {} : { timeoutMs: opts.timeout * 1000 }),
    ...(opts.socketPath === undefined ? {} : { socketPath: opts.socketPath }),
    ...(opts.tlsOptions === undefined ? {} : { tls: opts.tlsOptions })
  }
  const result = await runHttp1Load(loadOptions)

  return {
    rps: result.requests.averagePerSecond,
    latencyAvgMs: result.latencyMs.averageMs,
    latencyP95Ms: result.latencyMs.p95Ms,
    latencyP97_5Ms: result.latencyMs.p97_5Ms,
    latencyP99Ms: result.latencyMs.p99Ms,
    errors: result.errors.total
  }
}
