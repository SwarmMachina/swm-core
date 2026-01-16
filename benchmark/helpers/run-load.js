import autocannon from 'autocannon'
import os from 'node:os'

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
