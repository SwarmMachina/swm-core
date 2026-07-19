import autocannon from 'autocannon'
import histogramPercentiles from 'hdr-histogram-percentiles-obj'
import os from 'node:os'

// Autocannon omits p95 from its default histogram projection. Add it once so
// benchmark JSON contains the percentile without approximating between p90 and
// p97.5. The underlying HDR histogram remains the source of truth.
if (!histogramPercentiles.percentiles.includes(95)) {
  const index = histogramPercentiles.percentiles.findIndex((value) => value > 95)

  histogramPercentiles.percentiles.splice(index, 0, 95)
}

/**
 * @param {string} name
 * @param {object} opts - autocannon options
 * @param {object} [o]
 * @param {boolean} [o.track]
 * @param {boolean} [o.verbose]
 * @returns {Promise<object>} autocannon result
 */
export default function runLoad(name, opts, { track = false, verbose = false }) {
  return new Promise((resolve, reject) => {
    const instance = autocannon({ ...opts, title: name, workers: Math.min(4, os.cpus().length) }, (err, result) => {
      if (err) {
        return reject(err)
      }

      resolve({ result })
    })

    if (track || verbose) {
      autocannon.track(instance, {
        renderProgressBar: true,
        renderResultsTable: Boolean(verbose),
        renderLatencyTable: false
      })
    }
  })
}
