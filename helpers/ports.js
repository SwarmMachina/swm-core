import { createServer } from 'node:net'

/**
 * @returns {Promise<number>}
 */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()

    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0

      server.close(() => resolve(port))
    })

    server.on('error', reject)
  })
}
