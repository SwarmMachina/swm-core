/**
 * @param {object} params
 * @param {string[]} params.cases
 * @param {Record<string, Record<string, number>>} params.results
 * @param {Record<string, {guards?: Record<string, {min?: number, max?: number}>}>} params.baselineTests
 * @returns {{ failures: string[], rows: Array<object> }}
 */
export default function metricGuard({ cases, results, baselineTests }) {
  const failures = []
  const rows = []

  for (const name of cases) {
    const actual = results[name] || {}
    const expected = baselineTests?.[name]

    if (!expected) {
      failures.push(`${name}: missing baseline`)
      continue
    }

    const guards = expected.guards || {}

    for (const [metric, bound] of Object.entries(guards)) {
      const value = actual[metric]
      const hasMin = bound.min != null
      const hasMax = bound.max != null
      const row = {
        case: name,
        metric,
        value,
        min: hasMin ? bound.min : null,
        max: hasMax ? bound.max : null,
        status: 'ok'
      }

      if (!Number.isFinite(value)) {
        failures.push(`${name}.${metric}: missing value`)
        row.status = 'FAIL'
      } else {
        if (hasMin && value < bound.min) {
          failures.push(`${name}.${metric}: ${value} < ${bound.min}`)
          row.status = 'FAIL'
        }

        if (hasMax && value > bound.max) {
          failures.push(`${name}.${metric}: ${value} > ${bound.max}`)
          row.status = 'FAIL'
        }
      }

      rows.push(row)
    }
  }

  return { failures, rows }
}
