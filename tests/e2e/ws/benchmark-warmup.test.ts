import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { runWsBenchmarkLoad } from '../../../benchmark/ws/load.js'
import { startWsServer } from '../../helpers/e2e-server.js'

test('WS benchmark warms and measures the same connections and excludes warmup messages', async () => {
  let opened = 0
  let received = 0

  const handle = await startWsServer({
    ws: {
      onOpen: () => {
        opened++
      },
      onMessage: (ctx, message, isBinary) => {
        received++
        ctx.send(message, isBinary)
      }
    }
  })

  try {
    const result = await runWsBenchmarkLoad({
      name: 'persistent warmup connections',
      url: handle.wsBaseUrl,
      connections: 8,
      workers: 4,
      msgSize: 64,
      maxInFlight: 1,
      warmupSec: 0.2,
      durationSec: 0.2
    })

    assert.equal(result.errors.total, 0)
    assert.equal(opened, 8)
    assert.equal(result.parameters.warmupMs, 200)
    assert.equal(result.parameters.durationMs, 200)
    assert.ok(result.messages.received > 0)
    assert.ok(received > result.messages.sent + result.transport.inFlightAtStop)
  } finally {
    await handle.close()
  }
})
