import { cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'benchmark', 'http', 'fixtures')
const target = path.join(root, '.benchmark-dist', 'benchmark', 'http', 'fixtures')

mkdirSync(path.dirname(target), { recursive: true })
cpSync(source, target, { recursive: true })
