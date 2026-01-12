import Server from '../../src/index.js'
import { TESTS } from '../tests.js'

const router = async (ctx) => {
  const method = ctx.method()
  const url = ctx.url()

  if (method === 'get' && url === '/base') {
    return TESTS.get('base').payload
  }

  if (method === 'post' && url === '/base') {
    const query = await ctx.json()

    return query
  }

  ctx.status(404)
  return 'Not Found'
}

const [port] = process.argv.slice(2)

console.log(process.argv.slice(2))

const options = { onHttpError: console.error, router }

if (port) {
  options.port = Number(port)
}

const server = new Server(options)

await server.listen()

console.log('Server listening on port', server.port)

if (process.send) {
  process.send('ready')
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM:Shutdown server')
  await server.shutdown()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('SIGINT:Shutdown server')
  await server.shutdown()
  process.exit(0)
})
