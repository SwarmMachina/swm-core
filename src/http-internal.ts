import type { HttpResponse } from '@swarmmachina/swm-uws'

/** Internal owner contract for the aggregate request-body memory budget. */
export interface HttpBodyBudget {
  tryReserve(bytes: number, owner: object): boolean
  resize(bytes: number, owner: object): boolean
  release(owner: object): void
}

/** Native capabilities used by the HTTP body collector. */
export interface HttpBindingCapabilities {
  readonly collectBody?: boolean
}

/**
 * Narrow interface consumed by BodyParser.
 *
 * The full HttpContext implementation owns response lifecycle and pooling;
 * this leaf contract intentionally exposes only data collection dependencies.
 */
export interface HttpBodyContext {
  readonly aborted: boolean
  readonly res: HttpResponse | null
  readonly server: {
    readonly httpBodyBudget: HttpBodyBudget | null
    readonly bindingCapabilities: HttpBindingCapabilities
  } | null
  getContentLength(): number | null
}

/** Minimal response lifecycle surface used by ResStreamer. */
export interface HttpStreamingContext {
  aborted: boolean
  streaming: boolean
  readonly res: HttpStreamingResponse | null
  readonly server: { readonly bindingCapabilities: { readonly beginWrite?: boolean } } | null
  getStatus(status?: number): string
  flushHeaders(headers: object | null): void
  finalize(): void
}

/** Native response extension advertised by the fast write capability. */
export type HttpStreamingResponse = HttpResponse & { beginWrite?: () => void }
