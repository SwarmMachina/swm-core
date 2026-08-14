import config from '@swarmmachina/standards/eslint-typescript'

const publicTypeContexts = [
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration > TSInterfaceBody > TSPropertySignature',
  'TSInterfaceDeclaration > TSInterfaceBody > TSMethodSignature',
  'TSInterfaceDeclaration > TSInterfaceBody > TSIndexSignature',
  'TSTypeAliasDeclaration TSPropertySignature',
  'TSTypeAliasDeclaration TSMethodSignature',
  'ClassDeclaration > ClassBody > PropertyDefinition:not([key.type="PrivateIdentifier"])'
]
const publicRuntimeFiles = [
  'src/index.ts',
  'src/server/server.ts',
  'src/http/cors.ts',
  'src/http/headers.ts',
  'src/static/serve-static.ts'
]

config.push({
  ignores: [
    'dist/**',
    '.scripts-dist/**',
    '.test-dist/**',
    '.benchmark-dist/**',
    'release-artifact/**',
    'tests/fixtures/**'
  ]
})

config.push({
  files: ['src/index.d.ts'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    'jsdoc/check-tag-names': 'off',
    'jsdoc/escape-inline-tags': 'off',
    'jsdoc/require-jsdoc': [
      'error',
      {
        contexts: publicTypeContexts,
        require: { ClassDeclaration: true, FunctionDeclaration: true, MethodDefinition: true }
      }
    ],
    'jsdoc/require-description': 'error',
    'jsdoc/require-throws-type': 'off',
    'jsdoc/tag-lines': 'off'
  }
})

config.push({
  files: publicRuntimeFiles,
  rules: {
    'jsdoc/require-jsdoc': [
      'error',
      {
        publicOnly: true,
        require: { ClassDeclaration: true, FunctionDeclaration: true, MethodDefinition: true }
      }
    ]
  }
})

config.push({
  rules: {
    'promise/always-return': 'off',
    'n/no-process-exit': 'off',
    'n/no-unsupported-features/es-syntax': 'off'
  }
})

export default config
