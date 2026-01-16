import os from 'node:os'
import { eventLoopUtilization, monitorEventLoopDelay, performance } from 'node:perf_hooks'

/**
 * @param {number} bytes
 * @returns {number}
 */
function mb(bytes) {
  return bytes / 1024 / 1024
}

export default class Metrics {
  #running = false

  #sampleMs = 250
  #timer = null

  #t0 = 0
  #cpu0 = null
  #elu0 = null
  #eld = null

  #peakRss = 0
  #peakHeap = 0
  #peakExternal = 0
  #peakArrayBuffers = 0

  #loadSum = [0, 0, 0]
  #loadPeak = [0, 0, 0]
  #samples = 0

  start({ sampleMs } = {}) {
    if (this.#running) {
      return
    }

    this.#running = true
    this.#sampleMs = Number.isFinite(sampleMs) ? Math.max(50, sampleMs) : 250

    this.#t0 = performance.now()
    this.#cpu0 = process.cpuUsage()
    this.#elu0 = eventLoopUtilization()

    this.#peakRss = 0
    this.#peakHeap = 0
    this.#peakExternal = 0
    this.#peakArrayBuffers = 0
    this.#loadSum = [0, 0, 0]
    this.#loadPeak = [0, 0, 0]
    this.#samples = 0

    this.#eld = monitorEventLoopDelay({ resolution: 20 })
    this.#eld.enable()

    this.#timer = setInterval(() => this.#sample(), this.#sampleMs)
    this.#timer.unref?.()
  }

  stop() {
    if (!this.#running) {
      return null
    }
    this.#running = false

    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }

    if (this.#eld) {
      this.#eld.disable()
    }

    this.#sample()

    const dtMs = Math.max(1, performance.now() - this.#t0)
    const cpu = process.cpuUsage(this.#cpu0)
    const cpuMs = (cpu.user + cpu.system) / 1000

    const cpuCorePct = (cpuMs / dtMs) * 100
    const cpuHostPct = (cpuMs / (dtMs * os.cpus().length)) * 100

    const elu = eventLoopUtilization(this.#elu0)
    const eluPct = (elu.utilization || 0) * 100

    const eld = this.#eld
    const eldP50 = eld ? eld.percentile(50) / 1e6 : null
    const eldP90 = eld ? eld.percentile(90) / 1e6 : null
    const eldP99 = eld ? eld.percentile(99) / 1e6 : null
    const eldMax = eld ? eld.max / 1e6 : null

    const loadAvg = this.#samples ? this.#loadSum.map((x) => x / this.#samples) : os.loadavg()

    return {
      wallMs: dtMs,
      cpuMs,
      cpuCorePct,
      cpuHostPct,
      eluPct,
      eventLoopDelayMs: {
        p50: eldP50,
        p90: eldP90,
        p99: eldP99,
        max: eldMax
      },
      memMB: {
        rssPeak: mb(this.#peakRss),
        heapUsedPeak: mb(this.#peakHeap),
        externalPeak: mb(this.#peakExternal),
        arrayBuffersPeak: mb(this.#peakArrayBuffers)
      },
      loadAvg,
      loadPeak: this.#loadPeak
    }
  }

  #sample() {
    const mu = process.memoryUsage()

    this.#peakRss = Math.max(this.#peakRss, mu.rss)
    this.#peakHeap = Math.max(this.#peakHeap, mu.heapUsed)
    this.#peakExternal = Math.max(this.#peakExternal, mu.external)
    this.#peakArrayBuffers = Math.max(this.#peakArrayBuffers, mu.arrayBuffers || 0)

    const load = os.loadavg()

    this.#loadSum[0] += load[0]
    this.#loadSum[1] += load[1]
    this.#loadSum[2] += load[2]
    this.#loadPeak[0] = Math.max(this.#loadPeak[0], load[0])
    this.#loadPeak[1] = Math.max(this.#loadPeak[1], load[1])
    this.#loadPeak[2] = Math.max(this.#loadPeak[2], load[2])
    this.#samples++
  }
}
