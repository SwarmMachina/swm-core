import { createServer } from 'net'

/**
 * @returns {Promise<number>}
 */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()

    server.listen(0, () => {
      const port = server.address().port

      server.close(() => resolve(port))
    })

    server.on('error', reject)
  })
}
