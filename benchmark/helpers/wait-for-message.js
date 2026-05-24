/**
 * @param {ChildProcess} p
 * @param {Function} predicate
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
export default function waitForMessage(p, predicate, timeoutMs = 30_000) {
  const { promise, resolve, reject } = Promise.withResolvers()

  const onExit = (code, signal) => {
    cleanup()
    reject(new Error(`child exited before IPC message (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
  }

  const onError = (err) => {
    cleanup()
    reject(err)
  }

  const onMessage = (msg) => {
    try {
      if (predicate(msg)) {
        cleanup()
        resolve(msg)
      }
    } catch (e) {
      cleanup()
      reject(e)
    }
  }

  const t = setTimeout(() => {
    cleanup()
    reject(new Error(`timeout waiting for IPC message after ${timeoutMs}ms`))
  }, timeoutMs)

  const cleanup = () => {
    clearTimeout(t)
    p.off('exit', onExit)
    p.off('error', onError)
    p.off('message', onMessage)
  }

  p.once('exit', onExit)
  p.once('error', onError)
  p.on('message', onMessage)

  return promise
}
