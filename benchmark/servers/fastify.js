import Fastify from 'fastify'
import { TESTS } from '../tests.js'

const router = async (request, reply) => {
  const method = request.method
  const url = request.url

  if (method === 'GET' && url === '/base') {
    return reply.code(200).send(TESTS.get('base').payload)
  }

  if (method === 'POST' && url === '/base') {
    const body = request.body

    return reply.code(200).send(body)
  }

  reply.code(404).send('Not Found')
}

const [port] = process.argv.slice(2)

console.log(process.argv.slice(2))

const options = {
  logger: false
}

if (port) {
  options.port = Number(port)
} else {
  options.port = 6000
}

const fastify = Fastify(options)

fastify.setErrorHandler((error, request, reply) => {
  console.error(error)
  reply.code(500).send('Internal Server Error')
})

fastify.all('/*', router)

await fastify.listen({ port: options.port })

console.log('Server listening on port', fastify.server.address().port)

if (process.send) {
  process.send('ready')
}

const shutdown = async () => {
  await fastify.close()
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
