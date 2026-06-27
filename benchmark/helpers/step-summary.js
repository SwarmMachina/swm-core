import fs from 'node:fs/promises'

/**
 * @param {string} md
 * @returns {Promise<void>}
 */
export async function appendStepSummary(md) {
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
export function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v
}

/**
 * @param {number} v
 * @param {string} [unit]
 * @returns {string}
 */
export function fmt(v, unit = '') {
  return Number.isFinite(v) ? `${round(v)}${unit}` : 'n/a'
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
export function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')

  return [head, sep, body].join('\n')
}
