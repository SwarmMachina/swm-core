import Server from '../../src/index.js'

/**
 * @param {number} [port]
 * @returns {Promise<Server>}
 */
export async function startEchoServer(port = 9001) {
  const server = new Server({
    backend: 'node',
    port,
    maxBodySize: 64,
    http: null,
    ws: {
      onMessage: (ctx, message, isBinary) => ctx.send(message, isBinary)
    }
  })

  await server.listen()

  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 9001

  startEchoServer(port)
    .then(() => console.log(`autobahn echo server listening on :${port}`))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
