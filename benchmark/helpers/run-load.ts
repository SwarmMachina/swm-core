import os from 'node:os'
import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'
import type { BenchmarkLoadOptions, LoadRun } from '../types.js'

/**
 * Keep the benchmark callers independent of the load-generator implementation.
 * The returned `result` exposes the Autocannon fields that the existing reports
 * consume while `benchkitResult` retains the complete native result.
 */
export default async function runLoad(
  name: string,
  opts: BenchmarkLoadOptions,
  { track = false, verbose = false }: { track?: boolean; verbose?: boolean } = {}
): Promise<LoadRun> {
  const connections = opts.connections ?? 10
  const pipelining = opts.pipelining ?? 1
  const workers = Math.min(4, os.availableParallelism(), connections)
  const durationMs = (opts.duration ?? 10) * 1000
  const startedAt = performance.now()
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
  const benchkitResult = await runHttp1Load(loadOptions)
  const elapsedMs = performance.now() - startedAt
  const latency = benchkitResult.latencyMs
  const errors = benchkitResult.errors
  const requestRate = benchkitResult.requests.averagePerSecond
  const result = {
    title: name,
    url: benchkitResult.parameters.url,
    connections,
    pipelining,
    workers,
    duration: benchkitResult.durationMs / 1000,
    start: new Date(benchkitResult.startedAt),
    finish: new Date(benchkitResult.finishedAt),
    errors: errors.total,
    timeouts: errors.timeout,
    non2xx: benchkitResult.non2xx,
    statusCodeStats: Object.fromEntries(
      Object.entries(benchkitResult.statusCodes).map(([statusCode, count]) => [statusCode, { count }])
    ),
    latency: {
      average: latency.averageMs,
      p50: latency.p50Ms,
      p95: latency.p95Ms,
      p97_5: latency.p97_5Ms,
      p99: latency.p99Ms,
      totalCount: latency.count
    },
    requests: {
      average: requestRate,
      sent: benchkitResult.requests.sent,
      total: benchkitResult.requests.completed
    },
    throughput: {
      average: benchkitResult.requests.bytesRead / (benchkitResult.durationMs / 1000),
      total: benchkitResult.requests.bytesRead
    }
  }

  if (track || verbose) {
    console.log(
      `[load] ${name}: ${Math.round(requestRate)} req/s, ` +
        `p99=${latency.p99Ms?.toFixed(2) ?? 'n/a'}ms, errors=${errors.total}, elapsed=${(elapsedMs / 1000).toFixed(2)}s`
    )
  }

  return { result, benchkitResult }
}
