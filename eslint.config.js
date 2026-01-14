import config from '@swarmmachina/standards/code-style/eslint.config.mjs'

config.push({
  rules: {
    'promise/always-return': 'off',
    'n/no-process-exit': 'off',
    'n/no-unsupported-features/es-syntax': 'off'
  }
})

export default config
