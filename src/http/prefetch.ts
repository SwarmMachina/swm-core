/**
 * Compile a reusable native header-retention plan during route registration.
 * The factory exists only because the concrete plan implementation belongs to
 * the selected transport binding.
 */
export function compileHeaderPrefetchPlan(
  selection: false | 'all' | readonly string[],
  Plan: (new (options: { headers: 'all' | readonly string[] }) => object) | null | undefined
): object | null {
  if (selection === false) {
    return null
  }

  if (typeof Plan !== 'function') {
    throw new Error('prefetchHeaders requires a swm-uws binding with the requestPrefetch capability')
  }

  return new Plan({ headers: selection })
}

export function mergeHeaderPrefetch(
  selection: false | 'all' | readonly string[],
  required: readonly string[]
): false | 'all' | readonly string[] {
  if (selection === 'all' || required.length === 0) {
    return selection
  }

  if (selection === false) {
    return required
  }

  const merged = selection.slice()
  const seen = new Set(selection)

  for (let i = 0; i < required.length; i++) {
    const name = required[i]!

    if (!seen.has(name)) {
      seen.add(name)
      merged.push(name)
    }
  }

  return merged.length === selection.length ? selection : Object.freeze(merged)
}
