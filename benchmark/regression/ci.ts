import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { appendStepSummary, fmt, mdTable, round } from '@swarmmachina/benchkit/reporting'
import type { CpuGuardRow, MetricGuardRow } from '@swarmmachina/benchkit/regression'
import runBodyParserSuite from './suites/body-parser.js'
import runHttpSuite from './suites/http.js'
import runWsSuite from './suites/ws.js'
import runWsUpgradeSuite from './suites/ws-upgrade.js'
import {
  BENCHMARK_PROFILES_DIR,
  REPOSITORY_ROOT,
  RUNTIME_BENCHMARK_ROOT,
  SOURCE_BENCHMARK_DIR
} from '../harness/runtime-paths.js'
import type { SuiteOptions } from '../harness/types.js'

const SUITE_NAMES = ['http', 'body-parser', 'ws', 'ws-upgrade'] as const

type SuiteName = (typeof SUITE_NAMES)[number]

interface SuiteResult {
  suite: string
  failures: string[]
  metricRows: MetricGuardRow[]
  cpuRows: CpuGuardRow[]
}

type SuiteRunner = (options: SuiteOptions) => Promise<SuiteResult>

function isSuiteName(value: string): value is SuiteName {
  return SUITE_NAMES.some((name) => name === value)
}

const SUITES: Record<SuiteName, SuiteRunner> = {
  http: runHttpSuite,
  'body-parser': runBodyParserSuite,
  ws: runWsSuite,
  'ws-upgrade': runWsUpgradeSuite
}

/**
 * @param {string[]} argv
 * @returns {{ suites: string[] }}
 */
function parseDriverArgs(argv: string[]): { suites: string[] } {
  const defaults: { suites: SuiteName[] } = { suites: [...SUITE_NAMES] }

  return parseArgs(argv, defaults, {
    '--suite': (out, v) => {
      const requested = String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const suites: SuiteName[] = []

      for (const name of requested) {
        if (!isSuiteName(name)) {
          throw new Error(`Unknown --suite=${name} (expected: ${SUITE_NAMES.join(', ')})`)
        }

        suites.push(name)
      }

      out.suites = suites
    }
  })
}

function formatOptional(value: number | null | undefined, unit?: string): string {
  return value === null || value === undefined ? 'n/a' : fmt(value, unit)
}

function renderMarkdown(res: SuiteResult): string {
  const lines = [`## Regression profile — ${res.suite}`, '']

  if (res.metricRows.length) {
    lines.push(
      mdTable(
        ['case', 'metric', 'value', 'min', 'max', 'status'],
        res.metricRows.map((r) => [
          r.case,
          r.metric,
          formatOptional(r.value),
          r.min ?? '—',
          r.max ?? '—',
          r.status === 'ok' ? '✅' : '❌'
        ])
      )
    )
    lines.push('')
  }

  if (res.cpuRows.length) {
    lines.push('CPU profiles:', '')
    lines.push(
      mdTable(
        ['profile', 'ticks', 'JS', 'C++', 'GC', 'unaccounted'],
        res.cpuRows.map((r) => [
          r.key,
          formatOptional(r.ticks),
          formatOptional(r.jsPct, '%'),
          formatOptional(r.cppPct, '%'),
          formatOptional(r.gcPct, '%'),
          formatOptional(r.unaccountedPct, '%')
        ])
      )
    )
    lines.push('')
  }

  if (res.failures.length) {
    lines.push(`**Result:** ❌ ${res.failures.length} failure(s)`)

    for (const f of res.failures) {
      lines.push(`- ${f}`)
    }
  } else {
    lines.push('**Result:** ✅ all guards passed')
  }

  lines.push('')

  return lines.join('\n')
}

/**
 * @param {object} res
 */
function printConsole(res: SuiteResult): void {
  if (res.metricRows.length) {
    console.log(`\n[regression-ci] ${res.suite} metric guard`)
    console.table(
      res.metricRows.map((r) => ({
        case: r.case,
        metric: r.metric,
        value: r.value === undefined ? 'n/a' : round(r.value),
        min: r.min ?? 'n/a',
        max: r.max ?? 'n/a',
        status: r.status
      }))
    )
  }

  if (res.cpuRows.length) {
    console.log(`[regression-ci] ${res.suite} cpu guard`)
    console.table(
      res.cpuRows.map((r) => ({
        profile: r.key,
        ticks: r.ticks,
        JS: formatOptional(r.jsPct, '%'),
        CPP: formatOptional(r.cppPct, '%'),
        GC: formatOptional(r.gcPct, '%'),
        unaccounted: formatOptional(r.unaccountedPct, '%')
      }))
    )
  }
}

/**
 *
 */
async function main() {
  const args = parseDriverArgs(process.argv)
  const outRoot = path.join(BENCHMARK_PROFILES_DIR, 'regression-ci')

  await fs.mkdir(outRoot, { recursive: true })

  const allFailures: string[] = []

  for (const name of args.suites) {
    const suiteFn = SUITES[name as SuiteName]

    if (!suiteFn) {
      console.error(`[regression-ci] unknown suite: ${name}`)
      process.exitCode = 1
      continue
    }

    console.log(`\n[regression-ci] === suite: ${name} ===`)

    const res = await suiteFn({
      sourceBenchDir: SOURCE_BENCHMARK_DIR,
      runtimeBenchDir: RUNTIME_BENCHMARK_ROOT,
      repoRoot: REPOSITORY_ROOT,
      outRoot
    })

    printConsole(res)
    await appendStepSummary(renderMarkdown(res))

    if (res.failures.length) {
      allFailures.push(...res.failures.map((f) => `${name}: ${f}`))
    }
  }

  if (allFailures.length) {
    console.error('\n[regression-ci] FAILURES')

    for (const f of allFailures) {
      console.error(`- ${f}`)
    }

    process.exitCode = 1
  } else {
    console.log('\n[regression-ci] all suites passed')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
