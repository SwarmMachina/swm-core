import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'

const MAX_LAT_SAMPLES = 100_000

/**
 * @param {Float64Array} buf
 * @param {number} count
 * @param {number} p
 * @returns {number|null}
 */
function percentile(buf, count, p) {
  if (!count) {
    return null
  }

  const sorted = Float64Array.prototype.slice.call(buf, 0, count).sort()
  const idx = Math.min(count - 1, Math.floor((p / 100) * count))

  return sorted[idx]
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {number} o.connections
 * @param {number} o.durationSec
 * @param {number} o.payloadBytes
 * @param {number} [o.echoTimeoutMs]
 * @returns {Promise<{messages: number, msgPerSec: number, latencyAvgMs: number|null, latencyP97_5Ms: number|null, latencyP99Ms: number|null, errors: number}>}
 */
export default async function wsLoad({ url, connections, durationSec, payloadBytes, echoTimeoutMs = 5000 }) {
  const payload = Buffer.alloc(Math.max(1, payloadBytes), 0x61)
  const deadline = performance.now() + durationSec * 1000

  let messages = 0
  let errors = 0
  let latSum = 0

  const lat = new Float64Array(MAX_LAT_SAMPLES)
  let latCount = 0
  let latIdx = 0

  const recordLatency = (ms) => {
    latSum += ms
    lat[latIdx] = ms
    latIdx = (latIdx + 1) % MAX_LAT_SAMPLES

    if (latCount < MAX_LAT_SAMPLES) {
      latCount++
    }
  }

  const runConnection = () =>
    new Promise((resolve) => {
      const sock = new WebSocket(url, { perMessageDeflate: false })

      let sentAt = 0
      let timer = null
      let closed = false

      const done = () => {
        if (closed) {
          return
        }

        closed = true

        if (timer) {
          clearTimeout(timer)
          timer = null
        }

        try {
          sock.terminate()
        } catch {
          // ignore
        }

        resolve()
      }

      const sendOne = () => {
        if (performance.now() >= deadline) {
          done()
          return
        }

        sentAt = performance.now()
        timer = setTimeout(() => {
          errors++
          done()
        }, echoTimeoutMs)

        sock.send(payload, (err) => {
          if (err) {
            errors++
            done()
          }
        })
      }

      sock.on('open', sendOne)
      sock.on('message', () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }

        messages++
        recordLatency(performance.now() - sentAt)
        sendOne()
      })
      sock.on('error', () => {
        errors++
        done()
      })
      sock.on('close', () => done())
    })

  await Promise.all(Array.from({ length: connections }, () => runConnection()))

  return {
    messages,
    msgPerSec: messages / durationSec,
    latencyAvgMs: messages ? latSum / messages : null,
    latencyP97_5Ms: percentile(lat, latCount, 97.5),
    latencyP99Ms: percentile(lat, latCount, 99),
    errors
  }
}
