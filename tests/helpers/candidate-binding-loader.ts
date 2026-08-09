import { pathToFileURL } from 'node:url'

interface ResolveContext {
  parentURL?: string
}

interface ResolveResult {
  url: string
  shortCircuit?: boolean
}

type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult | Promise<ResolveResult>

/** Resolve swm-core's private binding import to the selected runtime candidate. */
export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): ResolveResult | Promise<ResolveResult> {
  if (specifier !== '#uws-binding') {
    return nextResolve(specifier, context)
  }

  const entry = process.env.SWM_UWS_CANDIDATE_ENTRY

  if (!entry) {
    throw new Error('SWM_UWS_CANDIDATE_ENTRY is required by the candidate binding loader')
  }

  return {
    shortCircuit: true,
    url: pathToFileURL(entry).href
  }
}
