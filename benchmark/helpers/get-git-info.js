import { execSync } from 'node:child_process'

/**
 * @returns {{commitSha: string|null, dirty: boolean}}
 */
export default function getGitInfo() {
  try {
    const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8', stdio: 'pipe' }).trim()
    let dirty = false

    try {
      execSync('git diff --quiet', { stdio: 'pipe' })
    } catch {
      dirty = true
    }

    if (!dirty) {
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf-8', stdio: 'pipe' }).trim()

        dirty = status.length > 0
      } catch {
        // ignore
      }
    }

    return { commitSha, dirty }
  } catch {
    return { commitSha: null, dirty: false }
  }
}
