/**
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.topN]
 * @returns {object}
 */
export default function parseV8Profile(text, { cwd = '', topN = 10 } = {}) {
  const lines = String(text).split(/\r?\n/)
  const header = parseHeader(lines)
  const sections = parseSections(lines, cwd)
  const summaryRows = sections.get('Summary') || []
  const summary = Object.create(null)

  for (const row of summaryRows) {
    summary[summaryKey(row.name)] = {
      ticks: row.ticks,
      totalPct: row.totalPct,
      nonlibPct: row.nonlibPct
    }
  }

  return {
    totalTicks: header.totalTicks ?? sumTicks(summaryRows),
    unaccountedTicks: header.unaccountedTicks ?? summary.unaccounted?.ticks ?? null,
    excludedTicks: header.excludedTicks ?? null,
    summary,
    topJavaScript: topRows(sections.get('JavaScript'), topN),
    topNative: topRows(sections.get('C++'), topN),
    topSharedLibraries: topRows(sections.get('Shared libraries'), topN)
  }
}

/**
 * @param {string[]} lines
 * @returns {object}
 */
function parseHeader(lines) {
  const first = lines.find((line) => line.startsWith('Statistical profiling result'))
  const match = first?.match(/\((\d+) ticks,\s+(\d+) unaccounted,\s+(\d+) excluded\)/)

  if (!match) {
    return {}
  }

  return {
    totalTicks: Number(match[1]),
    unaccountedTicks: Number(match[2]),
    excludedTicks: Number(match[3])
  }
}

/**
 * @param {string[]} lines
 * @param {string} cwd
 * @returns {Map<string, Array<object>>}
 */
function parseSections(lines, cwd) {
  const sections = new Map()
  let section = null

  for (const line of lines) {
    const sectionMatch = line.match(/^\s+\[(.+?)\]:\s*$/)

    if (sectionMatch) {
      section = sectionMatch[1]
      sections.set(section, [])
      continue
    }

    if (!section) {
      continue
    }

    const row = parseRow(line, cwd)

    if (row) {
      sections.get(section).push(row)
    }
  }

  return sections
}

/**
 * @param {string} line
 * @param {string} cwd
 * @returns {object|null}
 */
function parseRow(line, cwd) {
  const match = line.match(/^\s*(\d+)\s+([\d.]+)%\s+(?:(\d+(?:\.\d+)?)%\s+)?(.+?)\s*$/)

  if (!match || match[4] === 'name') {
    return null
  }

  return {
    ticks: Number(match[1]),
    totalPct: Number(match[2]),
    nonlibPct: match[3] == null ? null : Number(match[3]),
    name: normalizeName(match[4], cwd)
  }
}

/**
 * @param {string} name
 * @param {string} cwd
 * @returns {string}
 */
function normalizeName(name, cwd) {
  let out = name.replaceAll('file://', '')

  if (cwd) {
    out = out.replaceAll(`${cwd}/`, '')
  }

  return out
}

/**
 * @param {string} value
 * @returns {string}
 */
function summaryKey(value) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
}

/**
 * @param {Array<object>|undefined} rows
 * @param {number} topN
 * @returns {Array<object>}
 */
function topRows(rows, topN) {
  return (rows || []).slice(0, topN)
}

/**
 * @param {Array<object>} rows
 * @returns {number|null}
 */
function sumTicks(rows) {
  if (!rows.length) {
    return null
  }

  return rows.reduce((sum, row) => sum + row.ticks, 0)
}
