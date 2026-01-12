// eslint-disable-next-line n/no-unsupported-features/node-builtins
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./tests/helpers/loader.js', pathToFileURL('./'))
