import express from 'express'
import { TESTS } from '../tests.js'

const router = async (req, res) => {
  const method = req.method
  const url = req.url

  if (method === 'GET' && url === '/base') {
    return res.status(200).json(TESTS.get('base').payload)
  }

  if (method === 'POST' && url === '/base') {
    return res.status(200).json(req.body)
  }

  res.status(404).send('Not Found')
}

const [port] = process.argv.slice(2)

console.log(process.argv.slice(2))

const app = express()

app.disable('x-powered-by')
app.set('etag', false)

app.use(express.json())
app.all(/.*/, router)
app.on('error', console.error)

const server = app.listen(port ? Number(port) : 6000, () => {
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
