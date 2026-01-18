/**
 * @param {string} url
 * @param {RequestInit} [opt]
 * @returns {Promise<{status: number, headers: Headers, text: string}>}
 */
export async function reqText(url, opt = {}) {
  const res = await fetch(url, opt)
  const text = await res.text()

  return { status: res.status, headers: res.headers, text }
}

/**
 * @param {string} url
 * @param {RequestInit} [opt]
 * @returns {Promise<{status: number, headers: Headers, json: any}>}
 */
export async function reqJson(url, opt = {}) {
  const res = await fetch(url, opt)
  const json = await res.json()

  return { status: res.status, headers: res.headers, json }
}

/**
 * @param {string} url
 * @param {RequestInit} [opt]
 * @returns {Promise<{status: number, headers: Headers, buf: Buffer}>}
 */
export async function reqBin(url, opt = {}) {
  const res = await fetch(url, opt)
  const arrayBuffer = await res.arrayBuffer()
  const buf = Buffer.from(arrayBuffer)

  return { status: res.status, headers: res.headers, buf }
}

/**
 * @param {string} url
 * @returns {Promise<{status: number, headers: Headers, text: string}>}
 */
export async function reqRaw(url) {
  const res = await fetch(url, { headers: { connection: 'close' } })

  return {
    status: res.status,
    text: await res.text(),
    headers: res.headers
  }
}
