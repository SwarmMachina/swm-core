/**
 * @param {number} n
 * @returns {string}
 */
export function fmtBytes(n) {
  const u = ['B', 'KiB', 'MiB', 'GiB']
  let i = 0
  let x = n

  while (x >= 1024 && i < u.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(i === 0 ? 0 : 2)} ${u[i]}`
}

/**
 * @param {string} n
 * @returns {string}
 */
export function fmtNum(n) {
  return n.toLocaleString('en-US')
}

/**
 * @param {Date} d
 * @returns {string}
 */
export function formatYmdHms(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')

  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function msToHuman(ms) {
  if (!isFinite(ms)) {
    return 'n/a'
  }
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`
  }
  const s = ms / 1000

  if (s < 60) {
    return `${s.toFixed(2)}s`
  }
  const m = (s / 60) | 0
  const rest = s - m * 60

  return `${m}m ${rest.toFixed(1)}s`
}
