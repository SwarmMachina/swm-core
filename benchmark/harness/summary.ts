import { median } from '@swarmmachina/benchkit/statistics'
import type { BenchmarkRow, BenchmarkSummary } from './types.js'

export function positiveEnvNumber(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[name])

  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function finiteMedian(values: Array<number | null | undefined>, digits = 2): number | null {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  return finite.length ? Number(median(finite).toFixed(digits)) : null
}

export function percentageDelta(
  value: number | null | undefined,
  baseline: number | null | undefined,
  digits = 2
): number | null {
  if (
    value === null ||
    value === undefined ||
    baseline === null ||
    baseline === undefined ||
    !Number.isFinite(value) ||
    !Number.isFinite(baseline) ||
    baseline === 0
  ) {
    return null
  }

  return Number((((value - baseline) / baseline) * 100).toFixed(digits))
}

export function rowsForFramework(bench: BenchmarkSummary, framework: string): BenchmarkRow[] {
  return bench.runs.flatMap((run) => run.rows.filter((row) => row.fw === framework))
}

export interface HttpBenchmarkSummary {
  rps: number | null
  p95Ms: number | null
  p99Ms: number | null
  errors: number
  eluPct: number | null
  rssMB: number | null
}

export function summarizeHttpBenchmark(bench: BenchmarkSummary, framework: string): HttpBenchmarkSummary {
  const medianRow = bench.median.find((row) => row.fw === framework)
  const rows = rowsForFramework(bench, framework)

  return {
    rps: medianRow?.rps ?? null,
    p95Ms: medianRow?.latP95Ms ?? null,
    p99Ms: medianRow?.latP99Ms ?? null,
    errors: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    eluPct: finiteMedian(rows.map((row) => row.eluPct)),
    rssMB: finiteMedian(rows.map((row) => row.rssMB))
  }
}
