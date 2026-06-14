/**
 * @typedef {object} CpuProfile
 * @property {string} test
 * @property {number} run
 * @property {string} fw
 * @property {object} [profile]
 */

/**
 * @param {object} params
 * @param {CpuProfile[]} params.cpuProfiles
 * @param {object|undefined} params.guard
 * @param {string[]} params.expectedKeys
 * @returns {{ failures: string[], rows: Array<object> }}
 */
export default function cpuGuard({ cpuProfiles, guard, expectedKeys }) {
  if (!guard) {
    return { failures: [], rows: [] }
  }

  const failures = []
  const rows = []
  const expected = new Set(guard.profileRequired ? expectedKeys : [])

  for (const item of cpuProfiles || []) {
    const key = `${item.test}:${item.run}:${item.fw}`
    const profile = item.profile

    expected.delete(key)

    if (!profile) {
      failures.push(`${key}: missing parsed CPU profile`)
      continue
    }

    const gcPct = profile.summary.gc?.totalPct ?? null
    const unaccountedPct = profile.summary.unaccounted?.totalPct ?? null

    rows.push({
      key,
      ticks: profile.totalTicks,
      jsPct: profile.summary.javascript?.totalPct ?? null,
      cppPct: profile.summary.c?.totalPct ?? null,
      gcPct,
      unaccountedPct
    })

    if (!Number.isFinite(profile.totalTicks)) {
      failures.push(`${key}: missing CPU profile tick count`)
    }

    if (
      guard.minTotalTicks != null &&
      Number.isFinite(profile.totalTicks) &&
      profile.totalTicks < guard.minTotalTicks
    ) {
      failures.push(`${key}: CPU profile ticks ${profile.totalTicks} < ${guard.minTotalTicks}`)
    }

    if (guard.maxGcPct != null && Number.isFinite(gcPct) && gcPct > guard.maxGcPct) {
      failures.push(`${key}: GC ${gcPct}% > ${guard.maxGcPct}%`)
    }

    if (
      guard.maxUnaccountedPct != null &&
      Number.isFinite(unaccountedPct) &&
      unaccountedPct > guard.maxUnaccountedPct
    ) {
      failures.push(`${key}: unaccounted ${unaccountedPct}% > ${guard.maxUnaccountedPct}%`)
    }
  }

  for (const missing of expected) {
    failures.push(`${missing}: missing CPU profile`)
  }

  return { failures, rows }
}
