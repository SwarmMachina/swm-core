import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

import * as runtime from '../../src/index.js'

/**
 * @param {string} file
 * @returns {string[]}
 */
function declarationValueExports(file) {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(file)
  const moduleSymbol = checker.getSymbolAtLocation(source)

  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      if (
        symbol.declarations?.every(
          (declaration) =>
            ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)
        )
      ) {
        return false
      }

      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

      return Boolean(target.flags & ts.SymbolFlags.Value)
    })
    .map((symbol) => symbol.name)
    .sort()
}

test('declaration value exports exactly match runtime exports', () => {
  assert.deepEqual(
    declarationValueExports(new URL('../../src/index.d.ts', import.meta.url).pathname),
    Object.keys(runtime).sort()
  )
})

test('defineConfig preserves object identity and defers validation to Server', () => {
  const options = { http: { onRequest: () => 'ok' } }

  assert.equal(runtime.defineConfig(options), options)
})
