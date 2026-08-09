import type { Http1LoadResult, Http1HeaderValue, Http1TlsOptions } from '@swarmmachina/benchkit/load/http1'
import type { TargetSession } from '@swarmmachina/benchkit/target-provider'
import type { BenchmarkProfileArtifacts } from '@swarmmachina/benchkit/results'

export interface TargetArgs {
  target: string
  sshDestination: string | null
  targetDir: string | null
  connectHost: string | null
  bindHost: string | null
  portRange: string | null
}

export interface TargetStartRequest {
  serverName: string
  fw: string
  testName: string
  runIndex: number
  v8prof: boolean
  runStamp: string
}

export interface TargetStartResult {
  session: TargetSession
  profileDir: string
}

export interface BenchmarkLoadOptions {
  method: string
  url: string
  duration: number
  connections: number
  pipelining: number
  headers?: Readonly<Record<string, Http1HeaderValue>>
  body?: string | Uint8Array
  timeout?: number
  socketPath?: string
  tlsOptions?: Http1TlsOptions
  verbose?: boolean
  safe?: boolean
  filePath?: string | null
}

export interface LegacyLoadResult {
  title: string
  url: string
  connections: number
  pipelining: number
  workers: number
  duration: number
  start: Date
  finish: Date
  errors: number
  timeouts: number
  non2xx: number
  statusCodeStats: Record<string, { count: number }>
  latency: {
    average: number | null
    p50: number | null
    p95: number | null
    p97_5: number | null
    p99: number | null
    totalCount: number
  }
  requests: {
    average: number
    sent: number
    total: number
  }
  throughput: {
    average: number
    total: number
  }
}

export interface LoadRun {
  result: LegacyLoadResult
  benchkitResult: Http1LoadResult
}

export type BenchmarkMetric =
  | 'rps'
  | 'msgPerSec'
  | 'upgradesPerSec'
  | 'latAvgMs'
  | 'latP95Ms'
  | 'latP97_5Ms'
  | 'latP99Ms'
  | 'rssMB'
  | 'heapMB'
  | 'eluPct'
  | 'errors'

export interface BenchmarkRow {
  fw: string
  rps?: number | null
  msgPerSec?: number | null
  upgradesPerSec?: number | null
  latAvgMs?: number | null
  latP95Ms?: number | null
  latP97_5Ms?: number | null
  latP99Ms?: number | null
  rssMB?: number | null
  heapMB?: number | null
  eluPct?: number | null
  errors?: number | null
}

export interface BenchmarkRun {
  run: number
  rows: BenchmarkRow[]
}

export interface BenchmarkSummary {
  test?: { name?: string }
  median: BenchmarkRow[]
  runs: BenchmarkRun[]
}

export interface ProfiledBenchmarkRow extends BenchmarkRow {
  scenario?: string
  eldP99ms?: number | null
  externalMB?: number | null
  arrayBuffersMB?: number | null
  v8prof: BenchmarkProfileArtifacts | null
}

export interface ProfiledBenchmarkSummary {
  test?: { name?: string }
  median: ProfiledBenchmarkRow[]
  runs: Array<{ run: number; rows: ProfiledBenchmarkRow[] }>
}

export interface SuiteOptions {
  sourceBenchDir: string
  runtimeBenchDir: string
  repoRoot: string
  outRoot: string
}

export interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function requireMetric(row: BenchmarkRow, metric: BenchmarkMetric, context: string): number {
  return requireFiniteNumber(row[metric], `${context}: ${metric}`)
}

export function requireFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context}: missing finite measurement`)
  }

  return value
}
