import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { bindingRoot, makeTempDir, pack, root } from './package-test-helpers.js'

const temp = makeTempDir('swm-packed-types-')

function createLanguageService(
  consumer: string,
  file: string,
  compilerOptions: ts.CompilerOptions
): ts.LanguageService {
  const host = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '0',
    getScriptSnapshot: (path: string) => {
      const text = ts.sys.readFile(path)

      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => consumer,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath
  }

  return ts.createLanguageService(host)
}

/**
 * Verifies the same completion and hover path used by editors backed by the
 * TypeScript Language Service, including VS Code.
 * @param {string} consumer
 * @param {object} compilerOptions
 */
function assertJavaScriptIdeTypes(consumer: string, compilerOptions: ts.CompilerOptions): void {
  const file = join(consumer, 'ide-consumer.js')
  const source = [
    "import { defineConfig } from '@swarmmachina/swm-core'",
    '',
    'defineConfig({',
    '  http: { maxB }',
    '})',
    ''
  ].join('\n')

  writeFileSync(file, source)

  const service = createLanguageService(consumer, file, compilerOptions)
  const position = source.indexOf('maxB') + 'maxB'.length
  const completions = service.getCompletionsAtPosition(file, position, {})
  const names = new Set(completions?.entries.map((entry) => entry.name))

  assert.ok(names.has('maxBodySize'), 'JavaScript IDE completion is missing maxBodySize')
  assert.ok(names.has('maxBodyBudget'), 'JavaScript IDE completion is missing maxBodyBudget')

  const details = service.getCompletionEntryDetails(file, position, 'maxBodyBudget', {}, undefined, {}, undefined)
  const documentation = ts.displayPartsToString(details?.documentation)
  const defaultTagText = details?.tags?.find((tag) => tag.name === 'defaultValue')?.text
  const defaultValue =
    typeof defaultTagText === 'string' ? defaultTagText : defaultTagText?.map((part) => part.text).join('')

  assert.match(documentation, /Aggregate retained and in-flight HTTP body budget/)
  assert.match(defaultValue ?? '', /268_435_456.*256 MiB/)
}

/**
 * Verifies that the opt-in `Swm.*` namespace exposes the package types
 * directly instead of showing the old internal `Core.*` aliases in editors.
 * @param {string} consumer
 * @param {object} compilerOptions
 */
function assertJavaScriptNamespaceTypes(consumer: string, compilerOptions: ts.CompilerOptions): void {
  const file = join(consumer, 'fixtures/jsdoc-consumer.js')
  const source = readFileSync(file, 'utf8')
  const service = createLanguageService(consumer, file, compilerOptions)
  const position = source.indexOf('Swm.HttpContext') + 'Swm.'.length
  const quickInfo = service.getQuickInfoAtPosition(file, position)
  const display = ts.displayPartsToString(quickInfo?.displayParts)
  const documentation = ts.displayPartsToString(quickInfo?.documentation)

  assert.ok(quickInfo, 'JavaScript IDE quick info is missing for Swm.HttpContext')
  assert.equal(display, 'interface HttpContext')
  assert.match(documentation, /Per-request context passed to HTTP handlers\./)
}

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
  writeFileSync(
    join(consumer, 'pnpm-workspace.yaml'),
    `overrides:\n  '@swarmmachina/swm-uws': 'file:${bindingPack.path}'\n`
  )
  cpSync(join(root, 'tests/fixtures/types'), join(consumer, 'fixtures'), { recursive: true })

  execFileSync('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
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

  assertJavaScriptIdeTypes(consumer, {
    ...shared,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  })
  assertJavaScriptNamespaceTypes(consumer, {
    ...shared,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  })

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
    const expectedResolutions: Array<[string, string]> = [
      ['@swarmmachina/swm-core', 'node_modules/@swarmmachina/swm-core/dist/index.d.ts'],
      ['@swarmmachina/swm-uws', 'node_modules/@swarmmachina/swm-uws/lib/index.d.ts']
    ]

    for (const [specifier, expected] of expectedResolutions) {
      const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule

      assert.ok(resolved, `${mode.name}: ${specifier} did not resolve`)
      assert.equal(realpathSync(resolved.resolvedFileName), realpathSync(join(consumer, expected)))
    }
  }

  console.log('packed consumer types: NodeNext + Bundler + JS/JSDoc + Language Service IntelliSense ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
