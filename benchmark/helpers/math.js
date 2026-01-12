/**
 * @param {number[]} arr
 * @returns {number}
 */
export function getMedian(arr) {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * @param {ArrayLike<number>} arr
 * @returns {number}
 */
export function getMin(arr) {
  const n = arr?.length ?? 0

  if (n === 0) {
    throw new RangeError('[getMin] Empty array')
  }

  let min = arr[0]

  for (let i = 1; i < n; i++) {
    const v = arr[i]

    if (v < min) {
      min = v
    }
  }

  return min
}

/**
 * @param {ArrayLike<number>} arr
 * @returns {number}
 */
export function getMax(arr) {
  const length = arr?.length ?? 0

  if (length === 0) {
    throw new RangeError('[getMax] Empty array')
  }

  let max = arr[0]

  for (let i = 1; i < length; i++) {
    const v = arr[i]

    if (v > max) {
      max = v
    }
  }

  return max
}
