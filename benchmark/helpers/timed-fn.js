/**
 * @param {Function} fn
 * @returns {object}
 */
export default async function timed(fn) {
  const t0 = performance.now()

  try {
    const r = await fn()
    const t1 = performance.now()

    return { result: r, ms: t1 - t0 }
  } catch (e) {
    const t1 = performance.now()

    e._timedMs = t1 - t0
    throw e
  }
}
