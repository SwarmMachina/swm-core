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
