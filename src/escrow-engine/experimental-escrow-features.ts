// Experimental trade slicing is paused at the PRODUCT boundary.
//
// Keep the protocol/replay implementations intact: old relay events and any
// trade that ever held sats must remain readable and recoverable. This flag
// only control creation, discovery, and new user actions. Flipping them back on
// is deliberate and reviewable; removing the old readers would not be.
export const TRADE_SLICING_ENABLED = false;

export function isSlicedTradeShape(state: {
  sliceCount?: number;
  tranche?: unknown;
  tranchePlan?: unknown;
  trancheChild?: unknown;
}): boolean {
  return (state.sliceCount ?? 1) > 1
    || state.tranche !== undefined
    || state.tranchePlan !== undefined
    || state.trancheChild !== undefined;
}
