/**
 * @returns {string}
 */
export function nowForFile() {
  return new Date()
    .toISOString()
    .replace(/[:.T]/g, '-')
    .replace(/-\d{1,3}Z/, '')
}

/**
 * Format: YYYY-MM-DD_HH-mm-ss-SSS (local time, no T/Z)
 * @returns {string}
 */
export function nowLocalForDir() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0')

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${milliseconds}`
}
