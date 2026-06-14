import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import parseArgs from './helpers/parse-args.js'
import runBodyParserSuite from './suites/body-parser.js'
import runHttpSuite from './suites/http.js'
import runWsSuite from './suites/ws.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(__dirname)

const SUITES = {
  http: runHttpSuite,
  'body-parser': runBodyParserSuite,
  ws: runWsSuite
}

/**
 * @param {string[]} argv
 * @returns {{ suites: string[] }}
 */
function parseDriverArgs(argv) {
  return parseArgs(
    argv,
    { suites: Object.keys(SUITES) },
    {
      '--suite': (out, v) => {
        out.suites = String(v)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }
    }
  )
}

/**
 * @param {string} md
 * @returns {Promise<void>}
 */
async function appendStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY

  if (file) {
    await fs.appendFile(file, `${md}\n`)
  } else {
    console.log(md)
  }
}

/**
 * @param {number} v
 * @returns {number}
 */
function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v
}

/**
 * @param {number} v
 * @param {string} [unit]
 * @returns {string}
 */
function fmt(v, unit = '') {
  return Number.isFinite(v) ? `${round(v)}${unit}` : 'n/a'
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')

  return [head, sep, body].join('\n')
}

/**
 * @param {object} res
 * @returns {string}
 */
function renderMarkdown(res) {
  const lines = [`## Regression profile — ${res.suite}`, '']

  if (res.metricRows.length) {
    lines.push(
      mdTable(
        ['case', 'metric', 'value', 'min', 'max', 'status'],
        res.metricRows.map((r) => [
          r.case,
          r.metric,
          fmt(r.value),
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
          r.ticks,
          fmt(r.jsPct, '%'),
          fmt(r.cppPct, '%'),
          fmt(r.gcPct, '%'),
          fmt(r.unaccountedPct, '%')
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
function printConsole(res) {
  if (res.metricRows.length) {
    console.log(`\n[regression-ci] ${res.suite} metric guard`)
    console.table(
      res.metricRows.map((r) => ({
        case: r.case,
        metric: r.metric,
        value: round(r.value),
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
        JS: fmt(r.jsPct, '%'),
        CPP: fmt(r.cppPct, '%'),
        GC: fmt(r.gcPct, '%'),
        unaccounted: fmt(r.unaccountedPct, '%')
      }))
    )
  }
}

/**
 *
 */
async function main() {
  const args = parseDriverArgs(process.argv)
  const outRoot = path.join(__dirname, 'profiles', 'regression-ci')

  await fs.mkdir(outRoot, { recursive: true })

  const allFailures = []

  for (const name of args.suites) {
    const suiteFn = SUITES[name]

    if (!suiteFn) {
      console.error(`[regression-ci] unknown suite: ${name}`)
      process.exitCode = 1
      continue
    }

    console.log(`\n[regression-ci] === suite: ${name} ===`)

    const res = await suiteFn({ benchDir: __dirname, repoRoot: REPO_ROOT, outRoot })

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
