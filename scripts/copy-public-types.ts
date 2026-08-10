import { cpSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

cpSync(resolve(root, 'src/index.d.ts'), resolve(root, 'dist/index.d.ts'))
cpSync(resolve(root, 'types/global.d.ts'), resolve(root, 'dist/global.d.ts'))
