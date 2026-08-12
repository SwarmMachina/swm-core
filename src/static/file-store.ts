import { constants as bufferConstants } from 'node:buffer'
import type { BigIntStats } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { open, readlink, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import ByteBoundedLru from './byte-bounded-lru.js'
import InflightBudget from './inflight-budget.js'
import { headersFor } from './mime.js'

export interface StaticEntry {
  readonly buf: Buffer
  readonly headers: Readonly<Record<string, string>>
}

export type StaticLoadResult =
  | { readonly kind: 'file'; readonly entry: StaticEntry }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'busy' }

export interface StaticFileStoreOptions {
  readonly cache?: {
    readonly byteLimit: number
    readonly limit: number
  }
  readonly inflight: {
    readonly maxBytes: number
    readonly maxFiles: number
  }
  readonly maxFileSize: number
}

interface CachedEntry {
  readonly byteLength: number
  readonly entry: StaticEntry
}

const MISSING: StaticLoadResult = Object.freeze({ kind: 'missing' })
const FORBIDDEN: StaticLoadResult = Object.freeze({ kind: 'forbidden' })
const BUSY: StaticLoadResult = Object.freeze({ kind: 'busy' })
const BUSY_PROMISE: Promise<StaticLoadResult> = Promise.resolve(BUSY)

function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export default class StaticFileStore {
  readonly #rootDir: string
  readonly #rootDirWithSeparator: string
  readonly #canonicalRoot: Promise<string | null>
  readonly #cache: ByteBoundedLru<string, CachedEntry> | null
  readonly #pending = new Map<string, Promise<StaticLoadResult>>()
  readonly #maxFileSize: number
  readonly #inflight: InflightBudget

  #canonicalRootValue: string | null | undefined
  #canonicalRootWithSeparator = ''

  constructor(root: string, options: StaticFileStoreOptions) {
    this.#rootDir = resolve(root)
    this.#rootDirWithSeparator = withTrailingSeparator(this.#rootDir)
    this.#canonicalRoot = realpath(this.#rootDir).then(
      (canonicalRoot) => {
        this.#canonicalRootValue = canonicalRoot
        this.#canonicalRootWithSeparator = withTrailingSeparator(canonicalRoot)

        return canonicalRoot
      },
      () => {
        this.#canonicalRootValue = null

        return null
      }
    )
    this.#maxFileSize = options.maxFileSize
    this.#inflight = new InflightBudget(options.inflight.maxBytes, options.inflight.maxFiles)
    this.#cache =
      options.cache && options.cache.limit > 0 && options.cache.byteLimit > 0
        ? new ByteBoundedLru(options.cache.limit, options.cache.byteLimit)
        : null
  }

  resolvePath(relativePath: string): string | null {
    const candidate = resolve(this.#rootDir, relativePath)

    return this.#isWithinRawRoot(candidate) ? candidate : null
  }

  load(absPath: string): Promise<StaticLoadResult> {
    const cached = this.#cache?.get(absPath)

    if (cached) {
      return Promise.resolve({ kind: 'file', entry: cached.entry })
    }

    const pending = this.#pending.get(absPath)

    if (pending) {
      return pending
    }

    if (!this.#inflight.tryReserveFile()) {
      return BUSY_PROMISE
    }

    const loading = this.#loadAndCache(absPath)

    this.#pending.set(absPath, loading)

    return loading
  }

  async #loadAndCache(absPath: string): Promise<StaticLoadResult> {
    try {
      const result = await this.#loadUncached(absPath)

      if (result.kind === 'file') {
        this.#cacheEntry(absPath, result.entry)
      }

      return result
    } finally {
      this.#pending.delete(absPath)
      this.#inflight.releaseFile()
    }
  }

  async #loadUncached(absPath: string): Promise<StaticLoadResult> {
    let canonicalRoot = this.#canonicalRootValue

    if (canonicalRoot === undefined) {
      canonicalRoot = await this.#canonicalRoot
    }

    if (!canonicalRoot) {
      return MISSING
    }

    const canonicalPath = await this.#canonicalPathFor(absPath)

    if (!canonicalPath) {
      return MISSING
    }

    if (!this.#isWithinCanonicalRoot(canonicalPath)) {
      return FORBIDDEN
    }

    const file = await this.#openCanonicalPath(canonicalPath)

    if (!file) {
      return MISSING
    }

    try {
      return await this.#readOpenedFile(absPath, canonicalPath, file)
    } catch {
      return MISSING
    } finally {
      try {
        await file.close()
      } catch {
        // The response result is already determined; a close error cannot be
        // recovered here and must not turn a successful bounded read into 404.
      }
    }
  }

  async #canonicalPathFor(absPath: string): Promise<string | null> {
    try {
      return await realpath(absPath)
    } catch {
      return null
    }
  }

  async #openCanonicalPath(canonicalPath: string): Promise<FileHandle | null> {
    try {
      return await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    } catch {
      return null
    }
  }

  async #readOpenedFile(requestedPath: string, canonicalPath: string, file: FileHandle): Promise<StaticLoadResult> {
    const info = await file.stat()

    if (!info.isFile() || info.size > this.#maxFileSize) {
      return MISSING
    }

    if (!(await this.#openedFileRemainsConfined(requestedPath, file))) {
      return FORBIDDEN
    }

    if (!this.#inflight.tryReserveBytes(info.size)) {
      return BUSY
    }

    try {
      const buf = await this.#readExact(file, info.size)

      if (!buf) {
        return MISSING
      }

      return {
        kind: 'file',
        entry: { buf, headers: headersFor(canonicalPath) }
      }
    } finally {
      this.#inflight.releaseBytes(info.size)
    }
  }

  async #openedFileRemainsConfined(requestedPath: string, file: FileHandle): Promise<boolean> {
    if (process.platform !== 'linux') {
      try {
        const verifiedPath = await realpath(requestedPath)

        if (!this.#isWithinCanonicalRoot(verifiedPath)) {
          return false
        }

        const openedInfo = await file.stat({ bigint: true })

        return sameFile(openedInfo, await stat(verifiedPath, { bigint: true }))
      } catch {
        return false
      }
    }

    try {
      const openedPath = await readlink(`/proc/self/fd/${file.fd}`)

      return this.#isWithinCanonicalRoot(openedPath)
    } catch {
      return false
    }
  }

  async #readExact(file: FileHandle, size: number): Promise<Buffer | null> {
    if (size > bufferConstants.MAX_LENGTH) {
      return null
    }

    const buf = Buffer.allocUnsafe(size)

    let offset = 0

    while (offset < size) {
      const { bytesRead } = await file.read(buf, offset, size - offset, offset)

      if (bytesRead === 0) {
        return null
      }

      offset += bytesRead
    }

    return buf
  }

  #cacheEntry(absPath: string, entry: StaticEntry): void {
    this.#cache?.set(absPath, { entry, byteLength: entry.buf.byteLength })
  }

  #isWithinRawRoot(candidate: string): boolean {
    return candidate === this.#rootDir || candidate.startsWith(this.#rootDirWithSeparator)
  }

  #isWithinCanonicalRoot(candidate: string): boolean {
    const canonicalRoot = this.#canonicalRootValue

    return (
      canonicalRoot != null && (candidate === canonicalRoot || candidate.startsWith(this.#canonicalRootWithSeparator))
    )
  }
}
