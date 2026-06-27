import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import createLatencyRecorder from './latency-recorder.js'

// Open-loop echo load: each connection keeps up to `depth` messages in flight
// (pipelining). On every echo received it sends a replacement to refill the
// window, so throughput is no longer capped by a single round-trip; latency is
// recorded under that load. Echo order is preserved per TCP connection, so a
// FIFO queue of send timestamps matches each reply to its request.
/**
 * @param {object} o
 * @param {string} o.url
 * @param {number} o.connections
 * @param {number} o.durationSec
 * @param {number} o.payloadBytes
 * @param {number} o.depth
 * @param {number} [o.idleTimeoutMs]
 * @returns {Promise<{messages: number, msgPerSec: number, latencyAvgMs: number|null, latencyP97_5Ms: number|null, latencyP99Ms: number|null, errors: number}>}
 */
export default async function wsLoadOpen({ url, connections, durationSec, payloadBytes, depth, idleTimeoutMs = 5000 }) {
  const payload = Buffer.alloc(Math.max(1, payloadBytes), 0x61)
  const window = Math.max(1, depth | 0)
  const deadline = performance.now() + durationSec * 1000

  let messages = 0
  let errors = 0

  const latency = createLatencyRecorder()

  const runConnection = () =>
    new Promise((resolve) => {
      const sock = new WebSocket(url, { perMessageDeflate: false })

      const inflight = []
      let idleTimer = null
      let closed = false

      const done = () => {
        if (closed) {
          return
        }

        closed = true

        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }

        try {
          sock.terminate()
        } catch {
          // ignore
        }

        resolve()
      }

      const armIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
        }

        idleTimer = setTimeout(() => {
          errors++
          done()
        }, idleTimeoutMs)
      }

      const sendOne = () => {
        inflight.push(performance.now())
        sock.send(payload, (err) => {
          if (err) {
            errors++
            done()
          }
        })
      }

      sock.on('open', () => {
        for (let i = 0; i < window; i++) {
          sendOne()
        }

        armIdleTimer()
      })

      sock.on('message', () => {
        const sentAt = inflight.shift()

        if (sentAt !== undefined) {
          messages++
          latency.record(performance.now() - sentAt)
        }

        if (performance.now() >= deadline) {
          done()
          return
        }

        armIdleTimer()
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
    latencyP97_5Ms: summary.p97_5Ms,
    latencyP99Ms: summary.p99Ms,
    errors
  }
}
