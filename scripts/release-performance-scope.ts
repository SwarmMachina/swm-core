import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const SAFE_MANIFEST_FIELDS = new Set([
  'author',
  'bugs',
  'description',
  'files',
  'homepage',
  'keywords',
  'license',
  'name',
  'packageManager',
  'publishConfig',
  'repository',
  'types',
  'version'
])
const SAFE_SUPPORT_SCRIPTS = new Set([
  'scripts/copy-public-types.ts',
  'scripts/release-performance-scope.ts',
  'scripts/test-package.ts',
  'scripts/test-packed-types.ts'
])

type Manifest = Record<string, unknown>

export interface ReleasePerformanceScope {
  reasons: string[]
  requiresPerformance: boolean
}

function isTypesOnlyExport(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const entries = Object.entries(value)

  return (
    entries.length > 0 &&
    entries.every(
      ([condition, target]) => condition === 'types' && typeof target === 'string' && target.endsWith('.d.ts')
    )
  )
}

function exportsRequirePerformance(previous: unknown, current: unknown): boolean {
  if (isDeepStrictEqual(previous, current)) {
    return false
  }

  if (
    previous == null ||
    current == null ||
    typeof previous !== 'object' ||
    typeof current !== 'object' ||
    Array.isArray(previous) ||
    Array.isArray(current)
  ) {
    return true
  }

  const before = previous as Record<string, unknown>
  const after = current as Record<string, unknown>

  if (!isDeepStrictEqual(before['.'], after['.'])) {
    return true
  }

  const subpaths = new Set([...Object.keys(before), ...Object.keys(after)])

  subpaths.delete('.')

  for (const subpath of subpaths) {
    if (isDeepStrictEqual(before[subpath], after[subpath])) {
      continue
    }

    const previousEntry = before[subpath]
    const currentEntry = after[subpath]

    if (
      (previousEntry !== undefined && !isTypesOnlyExport(previousEntry)) ||
      (currentEntry !== undefined && !isTypesOnlyExport(currentEntry))
    ) {
      return true
    }
  }

  return false
}

function manifestPerformanceReasons(previous: Manifest, current: Manifest): string[] {
  const reasons: string[] = []
  const fields = new Set([...Object.keys(previous), ...Object.keys(current)])

  for (const field of fields) {
    if (isDeepStrictEqual(previous[field], current[field])) {
      continue
    }

    if (field === 'exports') {
      if (exportsRequirePerformance(previous[field], current[field])) {
        reasons.push('package.json:exports changes runtime exports')
      }

      continue
    }

    if (!SAFE_MANIFEST_FIELDS.has(field)) {
      reasons.push(`package.json:${field} changed`)
    }
  }

  return reasons
}

function pathRequiresPerformance(path: string): boolean {
  if (
    path === 'LICENSE' ||
    path.endsWith('.md') ||
    path.startsWith('.github/') ||
    (path.startsWith('src/') && path.endsWith('.d.ts')) ||
    path.startsWith('tests/') ||
    path.startsWith('types/') ||
    SAFE_SUPPORT_SCRIPTS.has(path)
  ) {
    return false
  }

  return path !== 'package.json'
}

export function classifyReleasePerformance(
  changedPaths: readonly string[],
  previousManifest: Manifest,
  currentManifest: Manifest
): ReleasePerformanceScope {
  const reasons = changedPaths.filter(pathRequiresPerformance).map((path) => `${path} may affect runtime performance`)

  if (changedPaths.includes('package.json')) {
    reasons.push(...manifestPerformanceReasons(previousManifest, currentManifest))
  }

  return { reasons, requiresPerformance: reasons.length > 0 }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function manifestAt(ref: string): Manifest {
  return JSON.parse(git('show', `${ref}:package.json`)) as Manifest
}

function inspectRelease(
  head: string
): ReleasePerformanceScope & { changedPaths: string[]; previousTag: string | null } {
  let previousTag: string

  try {
    previousTag = git('describe', '--tags', '--match', 'v*', '--abbrev=0', `${head}^`)
  } catch {
    return {
      changedPaths: [],
      previousTag: null,
      reasons: ['no previous release tag was found'],
      requiresPerformance: true
    }
  }

  const changed = git('diff', '--name-only', '--diff-filter=ACDMRT', `${previousTag}...${head}`)
  const changedPaths = changed === '' ? [] : changed.split('\n')
  const scope = classifyReleasePerformance(changedPaths, manifestAt(previousTag), manifestAt(head))

  return { ...scope, changedPaths, previousTag }
}

function main(): void {
  const head = process.argv[2] ?? 'HEAD'
  const scope = inspectRelease(head)

  console.error(
    `[release-scope] previous=${scope.previousTag ?? 'none'} changed=${scope.changedPaths.length} ` +
      `requires-performance=${scope.requiresPerformance}`
  )

  for (const reason of scope.reasons) {
    console.error(`[release-scope] ${reason}`)
  }

  console.log(scope.requiresPerformance ? 'true' : 'false')
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  main()
}
