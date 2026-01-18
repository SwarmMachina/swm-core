/**
 * @param {number[]} values
 * @returns {number}
 */
export default function median(values) {
  const a = values.slice().sort((x, y) => x - y)
  const mid = (a.length / 2) | 0

  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}
