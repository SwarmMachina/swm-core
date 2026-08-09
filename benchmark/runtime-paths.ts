import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory containing the compiled benchmark executables. */
export const RUNTIME_BENCHMARK_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Repository checkout that owns source baselines, dependencies, and reports. */
export const REPOSITORY_ROOT = path.resolve(RUNTIME_BENCHMARK_DIR, '..', '..')

/** Immutable benchmark inputs retained in the source checkout. */
export const SOURCE_BENCHMARK_DIR = path.join(REPOSITORY_ROOT, 'benchmark')

/** Durable benchmark reports consumed by CI artifact uploads. */
export const BENCHMARK_PROFILES_DIR = path.join(SOURCE_BENCHMARK_DIR, 'profiles')

export function runtimeBenchmarkFile(file: string): string {
  return path.join(RUNTIME_BENCHMARK_DIR, file)
}
