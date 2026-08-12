import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory containing shared compiled benchmark harness code. */
export const RUNTIME_BENCHMARK_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Root directory containing every compiled benchmark executable. */
export const RUNTIME_BENCHMARK_ROOT = path.resolve(RUNTIME_BENCHMARK_DIR, '..')

/** Repository checkout that owns source baselines, dependencies, and reports. */
export const REPOSITORY_ROOT = path.resolve(RUNTIME_BENCHMARK_ROOT, '..', '..')

/** Immutable benchmark inputs retained in the source checkout. */
export const SOURCE_BENCHMARK_DIR = path.join(REPOSITORY_ROOT, 'benchmark')

/** Durable benchmark reports consumed by CI artifact uploads. */
export const BENCHMARK_PROFILES_DIR = path.join(SOURCE_BENCHMARK_DIR, 'profiles')
