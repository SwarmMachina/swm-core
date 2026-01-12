import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {object} options
 * @param {string} options.expectedPath
 * @param {string} options.runDir
 * @param {number} options.startTimeMs
 * @param {string[]} [options.extraSearchDirs]
 * @returns {{ok: boolean, path?: string, movedFrom?: string, error?: string, searchedDirs?: string[], candidates?: string[]}}
 */
export default function resolveV8LogFile({ expectedPath, runDir, startTimeMs, extraSearchDirs = [process.cwd()] }) {
  if (fs.existsSync(expectedPath)) {
    return {
      ok: true,
      path: expectedPath,
      searchedDirs: [path.dirname(expectedPath)],
      candidates: [expectedPath]
    }
  }

  const searchedDirs = []
  const candidates = []
  const searchTimeThreshold = startTimeMs - 1000

  if (fs.existsSync(runDir) && fs.statSync(runDir).isDirectory()) {
    searchedDirs.push(runDir)
    try {
      const files = fs.readdirSync(runDir)

      for (const file of files) {
        const filePath = path.join(runDir, file)

        try {
          const stats = fs.statSync(filePath)

          if (stats.isFile() && file.endsWith('.log')) {
            const isV8LogCandidate =
              (file.startsWith('isolate-') && file.includes('-v8.log')) || stats.mtimeMs >= searchTimeThreshold

            if (isV8LogCandidate) {
              candidates.push(filePath)
            }
          }
        } catch {
          //
        }
      }
    } catch {
      //
    }
  }

  for (const searchDir of extraSearchDirs) {
    if (!searchDir || !fs.existsSync(searchDir)) {
      continue
    }

    const stat = fs.statSync(searchDir)

    if (!stat.isDirectory()) {
      continue
    }

    searchedDirs.push(searchDir)

    try {
      const files = fs.readdirSync(searchDir)

      for (const file of files) {
        const filePath = path.join(searchDir, file)

        try {
          const stats = fs.statSync(filePath)

          if (stats.isFile() && file.endsWith('.log')) {
            const isV8LogCandidate =
              (file.startsWith('isolate-') && file.includes('-v8.log')) || stats.mtimeMs >= searchTimeThreshold

            if (isV8LogCandidate) {
              candidates.push(filePath)
            }
          }
        } catch {
          //
        }
      }
    } catch {
      //
    }
  }

  candidates.sort((a, b) => {
    try {
      const statA = fs.statSync(a)
      const statB = fs.statSync(b)

      return statB.mtimeMs - statA.mtimeMs
    } catch {
      return 0
    }
  })

  if (candidates.length === 0) {
    return {
      ok: false,
      error: `No v8log candidates found. Searched in: ${searchedDirs.join(', ')}`,
      searchedDirs,
      candidates: []
    }
  }

  const candidatePath = candidates[0]
  const expectedDir = path.dirname(expectedPath)

  fs.mkdirSync(expectedDir, { recursive: true })

  try {
    fs.renameSync(candidatePath, expectedPath)
    return {
      ok: true,
      path: expectedPath,
      movedFrom: candidatePath,
      searchedDirs,
      candidates
    }
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM') {
      try {
        fs.copyFileSync(candidatePath, expectedPath)
        fs.unlinkSync(candidatePath)
        return {
          ok: true,
          path: expectedPath,
          movedFrom: candidatePath,
          searchedDirs,
          candidates
        }
      } catch (copyErr) {
        return {
          ok: false,
          error: `Failed to move v8log from ${candidatePath} to ${expectedPath}: ${copyErr.message}`,
          searchedDirs,
          candidates
        }
      }
    }
    return {
      ok: false,
      error: `Failed to move v8log from ${candidatePath} to ${expectedPath}: ${err.message}`,
      searchedDirs,
      candidates
    }
  }
}
