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
