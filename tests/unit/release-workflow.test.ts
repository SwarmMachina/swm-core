import { match, ok } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')

test('publish accepts a successful package after an intentionally skipped performance gate', () => {
  const publishJob = workflow.match(/\n {2}publish:\n([\s\S]*?)(?=\n {2}\S|$)/)?.[1]

  ok(publishJob, 'publish job must exist')
  match(publishJob, /\balways\(\) &&/)
  match(publishJob, /needs\.package\.result == 'success'/)
  match(publishJob, /startsWith\(github\.ref, 'refs\/tags\/v'\)/)
})
