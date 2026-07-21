import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { bindingRoot, makeTempDir, pack, root } from './package-test-helpers.js'

const temp = makeTempDir('swm-packed-types-')

try {
  const artifacts = join(temp, 'artifacts')
  const consumer = join(temp, 'consumer')

  mkdirSync(artifacts)
  mkdirSync(consumer)

  const corePack = pack(root, artifacts)
  const bindingPack = pack(bindingRoot, artifacts)

  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@swarmmachina/swm-core': `file:${corePack.path}`,
          '@swarmmachina/swm-uws': `file:${bindingPack.path}`
        }
      },
      null,
      2
    )
  )
  cpSync(join(root, 'tests/fixtures/types'), join(consumer, 'fixtures'), { recursive: true })

  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumer,
    stdio: 'inherit'
  })

  const shared = {
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: true,
    skipLibCheck: false,
    types: ['node'],
    typeRoots: [join(root, 'node_modules/@types')]
  }
  const modes = [
    { name: 'nodenext', module: 'NodeNext', moduleResolution: 'NodeNext' },
    { name: 'bundler', module: 'ESNext', moduleResolution: 'Bundler' }
  ]

  for (const mode of modes) {
    const config = join(consumer, `tsconfig.${mode.name}.json`)

    writeFileSync(
      config,
      JSON.stringify(
        {
          compilerOptions: { ...shared, module: mode.module, moduleResolution: mode.moduleResolution },
          include: ['fixtures/*']
        },
        null,
        2
      )
    )
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['--project', config, '--pretty', 'false'], {
      cwd: consumer,
      stdio: 'inherit'
    })

    const options = ts.convertCompilerOptionsFromJson(
      { ...shared, module: mode.module, moduleResolution: mode.moduleResolution },
      consumer
    ).options
    const containingFile = join(consumer, 'fixtures/consumer.ts')

    for (const [specifier, expected] of [
      ['@swarmmachina/swm-core', 'node_modules/@swarmmachina/swm-core/src/index.d.ts'],
      ['@swarmmachina/swm-uws', 'node_modules/@swarmmachina/swm-uws/lib/index.d.ts']
    ]) {
      const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule

      assert.ok(resolved, `${mode.name}: ${specifier} did not resolve`)
      assert.equal(resolved.resolvedFileName, join(realpathSync(consumer), expected))
    }
  }

  console.log('packed consumer types: NodeNext + Bundler + JS/JSDoc ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
