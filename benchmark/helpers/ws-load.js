import { performance } from 'node:perf_hooks'
import { createLatencyRecorder } from '@swarmmachina/benchkit/measurement'
import { WebSocket } from 'ws'

// Closed-loop echo load: each connection keeps exactly one message in flight
// (send -> await echo -> send). Throughput is bounded by round-trip latency, so
// this measures latency rather than peak throughput.
/**
 * @param {object} o
 * @param {string} o.url
 * @param {number} o.connections
 * @param {number} o.durationSec
 * @param {number} o.payloadBytes
 * @param {number} [o.echoTimeoutMs]
 * @returns {Promise<{messages: number, msgPerSec: number, latencyAvgMs: number|null, latencyP95Ms: number|null, latencyP97_5Ms: number|null, latencyP99Ms: number|null, errors: number}>}
 */
export default async function wsLoad({ url, connections, durationSec, payloadBytes, echoTimeoutMs = 5000 }) {
  const payload = Buffer.alloc(Math.max(1, payloadBytes), 0x61)
  const deadline = performance.now() + durationSec * 1000

  let messages = 0
  let errors = 0

  const latency = createLatencyRecorder()
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
        latency.record(performance.now() - sentAt)
        sendOne()
      })
      sock.on('error', () => {
        errors++
        done()
      })
      sock.on('close', () => done())
    })

  await Promise.all(Array.from({ length: connections }, () => runConnection()))

  const summary = latency.summary(messages)

  return {
    messages,
    msgPerSec: messages / durationSec,
    latencyAvgMs: summary.avgMs,
    latencyP95Ms: summary.p95Ms,
    latencyP97_5Ms: summary.p97_5Ms,
    latencyP99Ms: summary.p99Ms,
    errors
  }
}
