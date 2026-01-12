import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

class EventLoopProfiler {
  constructor(outFile) {
    this.outFile = outFile
    this.h = null
    this.elu0 = null
    this.startedAt = null
    this.startedPerf = null
    this.meta = null
    this.isMonitoring = false
  }

  static nsToMs(ns) {
    return Number(ns) / 1e6
  }

  start(meta = null) {
    if (this.isMonitoring) {
      return
    }

    this.startedAt = Date.now()
    this.startedPerf = performance.now()
    this.meta = meta || null

    this.h = monitorEventLoopDelay({ resolution: 1 })
    this.h.enable()
    this.elu0 = performance.eventLoopUtilization()
    this.isMonitoring = true
  }

  stop(sendAck = false) {
    if (!this.isMonitoring || !this.h) {
      if (sendAck && process.send) {
        try {
          process.send({
            type: 'eventloop:stopped',
            ok: false,
            meta: this.meta || null,
            outFile: null,
            error: 'Monitoring was not started'
          })
        } catch {
          // ignore
        }
      }
      return false
    }

    try {
      this.h.disable()

      const elapsedMs = performance.now() - this.startedPerf
      const elu = performance.eventLoopUtilization(this.elu0)

      const data = {
        startedAt: this.startedAt,
        stoppedAt: Date.now(),
        durationMs: elapsedMs,
        meta: this.meta || null,

        eventLoopDelayMs: {
          mean: EventLoopProfiler.nsToMs(this.h.mean),
          p50: EventLoopProfiler.nsToMs(this.h.percentile(50)),
          p90: EventLoopProfiler.nsToMs(this.h.percentile(90)),
          p99: EventLoopProfiler.nsToMs(this.h.percentile(99))
        },

        eventLoopUtilization: {
          utilization: elu.utilization,
          active: elu.active,
          idle: elu.idle
        }
      }

      fs.mkdirSync(path.dirname(this.outFile), { recursive: true })
      fs.writeFileSync(this.outFile, JSON.stringify(data, null, 2))

      this.h = null
      this.elu0 = null
      this.isMonitoring = false

      if (sendAck && process.send) {
        try {
          process.send({
            type: 'eventloop:stopped',
            ok: true,
            meta: this.meta || null,
            outFile: this.outFile
          })
        } catch {
          // ignore
        }
      }

      return true
    } catch (error) {
      if (sendAck && process.send) {
        try {
          process.send({
            type: 'eventloop:stopped',
            ok: false,
            meta: this.meta || null,
            outFile: null,
            error: error.message
          })
        } catch {
          // ignore
        }
      }
      return false
    }
  }

  write() {
    if (this.isMonitoring && this.h) {
      this.stop()
    }
  }

  setupProcessListeners() {
    if (process.send) {
      process.on('message', (msg) => {
        if (msg && typeof msg === 'object') {
          if (msg.type === 'eventloop:start') {
            this.start(msg.meta)
          } else if (msg.type === 'eventloop:stop') {
            this.stop(true) // Send ACK
          }
        }
      })
    }

    // Fallback: write on exit if monitoring was started
    process.once('exit', () => this.write())

    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, () => {
        this.write()
        process.exit(128)
      })
    }
  }
}

const outFile = process.env.EVENTLOOP_PROFILE_FILE

if (!outFile) {
  process.on('exit', () => {})
} else {
  const profiler = new EventLoopProfiler(outFile)

  profiler.setupProcessListeners()
}

export { EventLoopProfiler }
