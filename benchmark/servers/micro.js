import http from 'node:http'
import { serve, json } from 'micro'
import { TESTS } from '../tests.js'

const [port] = process.argv.slice(2)

console.log(process.argv.slice(2))

const router = async (req, res) => {
  const method = req.method
  const url = req.url

  if (method === 'GET' && url === '/base') {
    return TESTS.get('base').payload
  }

  if (method === 'POST' && url === '/base') {
    const query = await json(req)

    return query
  }

  res.statusCode = 404
  return 'Not Found'
}

const server = new http.Server(serve(router))

server.on('error', console.error)

server.listen(port ? Number(port) : 6000, () => {
  console.log('Server listening on port', server.address().port)

  if (process.send) {
    process.send('ready')
  }
})

const shutdown = async () => {
  return new Promise((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM:Shutdown server')
  await shutdown()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('SIGINT:Shutdown server')
  await shutdown()
  process.exit(0)
})
