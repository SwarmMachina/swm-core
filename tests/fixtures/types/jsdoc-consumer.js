// @ts-check

/// <reference types="@swarmmachina/swm-core/global" />

/**
 * @typedef {object} ContextState
 * @property {?Swm.HttpContext} req
 * @property {?Swm.HttpContext} res
 */

/** @param {ContextState} state */
export function verifyJsdocContextState(state) {
  state.req?.getMethod()
  state.res?.getMethod()
}

// @ts-expect-error Swm is a type-only namespace, not a runtime global.
void Swm // eslint-disable-line no-undef
