// Experimental trade slicing is paused at the PRODUCT boundary.
//
// Keep the protocol/replay implementations intact: old relay events and any
// trade that ever held sats must remain readable and recoverable. This flag
// only control creation, discovery, and new user actions. Flipping them back on
// is deliberate and reviewable; removing the old readers would not be.
export const TRADE_SLICING_ENABLED = false;

// LiveTradeSurface — the guided, question/vote view of a LIVE trade (the
// counterpart to AssistedCanvas for the create/browse half). Off by default:
// TradeDetail stays the shipping view. When on, matched trades open on the
// chat-left / votes-right surface driven by decideVotePrompt, with a
// "More options" door back to the full TradeDetail for everything past the
// happy path. Flip deliberately once eyeballed.
export const LIVE_TRADE_SURFACE_ENABLED = true;

// Guided slice-choice question (phase 2): shows the fiat-sender a "how do you
// want to pay it out?" chooser at join and captures the preference. This is the
// VISIBLE step only — it does not materialize a tranche plan or move money, so
// the v6 "slicing remains paused" tripwire stays intact. Wiring the preference
// through to plan_start + walking the slices is the deliberate next step.
// OFF for 6.3.1: the chooser would capture a promise the money path can't
// honor yet. Flip back on when the preference threads into plan_start.
export const GUIDED_SLICE_CHOICE_ENABLED = false;

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
