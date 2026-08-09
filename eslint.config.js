import config from '@swarmmachina/standards/eslint-typescript'

config.push({
  ignores: [
    'dist/**',
    '.scripts-dist/**',
    '.test-dist/**',
    '.benchmark-dist/**',
    'release-artifact/**',
    'src/index.d.ts',
    'tests/fixtures/**'
  ]
})

config.push({
  rules: {
    'promise/always-return': 'off',
    'n/no-process-exit': 'off',
    'n/no-unsupported-features/es-syntax': 'off'
  }
})

export default config
