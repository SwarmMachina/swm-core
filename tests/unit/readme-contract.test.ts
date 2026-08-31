import { readFileSync } from 'node:fs'
import { doesNotMatch, match } from 'node:assert'
import test from 'node:test'

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
const CONFIGURATION_EXAMPLES =
  README.match(/#### Configuration examples\n([\s\S]*?)\n#### JavaScript configuration typing/)?.[1] ?? ''
const JAVASCRIPT_EXAMPLES = [...README.matchAll(/```javascript\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')
const SERVER_EXAMPLES = JAVASCRIPT_EXAMPLES.filter((example) => example.includes('new Server('))
const REMOVED_HTTP_CONTEXT_READERS = [
  'getHeader',
  'ip',
  'method',
  'url',
  'fullQuery',
  'query',
  'param',
  'header',
  'contentLength',
  'status'
]

test('README examples use the published HttpContext request-reader contract', () => {
  const examples = JAVASCRIPT_EXAMPLES.join('\n')

  match(examples, /ctx\.getReqHeader\(/)

  for (const reader of REMOVED_HTTP_CONTEXT_READERS) {
    doesNotMatch(examples, new RegExp(`\\bctx\\.${reader}\\s*\\(`), `README examples reference removed ctx.${reader}()`)
  }
})

test('README configuration examples cover every public Server option', () => {
  const optionNames = [
    'host',
    'port',
    'onServerError',
    'transport',
    'http',
    'ws',
    'maxHeaderSize',
    'maxHeaderCount',
    'headersTimeoutMs',
    'keepAliveTimeoutMs',
    'bodyIdleTimeoutMs',
    'minBodyRateBytesPerSec',
    'responseWriteTimeoutMs',
    'prefetch',
    'prefetchHeaders',
    'maxBodySize',
    'maxStreamBodySize',
    'maxBodyBudget',
    'requestTimeoutMs',
    'onRequest',
    'routes',
    'onError',
    'method',
    'path',
    'handler',
    'before',
    'maxPayloadLength',
    'maxBackpressure',
    'closeOnBackpressureLimit',
    'idleTimeoutSec',
    'upgradeTimeoutMs',
    'onUpgrade',
    'selectProtocol',
    'connectionKey',
    'onOpen',
    'onMessage',
    'onDropped',
    'onDrain',
    'onSubscription',
    'onClose'
  ]

  for (const name of optionNames) {
    match(CONFIGURATION_EXAMPLES, new RegExp(`\\b${name}\\s*:`), `README has no example for ${name}`)
  }
})

test('README route configuration demonstrates async database work before and in the handler', () => {
  match(CONFIGURATION_EXAMPLES, /before:\s*\[\s*async \(ctx\)/)
  match(CONFIGURATION_EXAMPLES, /await db\.users\.findByAccessToken\(token\)/)
  match(CONFIGURATION_EXAMPLES, /await db\.accounts\.canWrite\(user\.id, accountId\)/)
  match(CONFIGURATION_EXAMPLES, /handler: async \(ctx\)/)
  match(CONFIGURATION_EXAMPLES, /return db\.accounts\.update\(ctx\.getParameter\('accountId'\), update\)/)
})

test('every README WebSocket configuration authorizes upgrades explicitly', () => {
  for (const example of SERVER_EXAMPLES) {
    if (/\bws\s*:\s*{/.test(example)) {
      match(example, /\bonUpgrade\s*:/, 'WebSocket example omits required ws.onUpgrade')
    }
  }
})
