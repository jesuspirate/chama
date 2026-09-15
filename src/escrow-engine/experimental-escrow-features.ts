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

// Chama Circles — the savings-circle vertical (create a circle, discover
// circles in Browse, the circle canvas/surface). Held for the 6.4 "Big Boss
// Chama" launch. OFF gates CREATION, DISCOVERY, and marketing only — never
// the readers: an existing circle a member already locked into stays visible
// and refundable in Me, and all relay/replay code remains intact. 6.4 flips
// this to true (and un-comments the landing card marked CHAMA_CIRCLES).
//
// (Shipped un-gated by accident in 6.3.4 when ship.sh's `git add -A` swept the
// in-progress tree; 6.3.5 re-darkened it via this flag.)
// FLIPPED for the 6.4 "Big Boss Chama" launch (2026-09-14, the night the
// first real circle completed its round trip).
export const CHAMA_CIRCLES_ENABLED = true;

// Ring witnessing / the host's seat (docs/chama-host-seat-spec.md v1.1).
// OFF gates the WRITER only: shareCreatePayload keeps seating the creator as
// witness and canTakeSeat keeps refusing the host. The READER relaxation
// (chamaCreateError accepting proven ring shares) shipped un-gated on main
// after 6.4.0 — readers first, writers later. Do NOT flip this until 6.4.1+
// readers have real deployment in the field: a 6.4.0 client REJECTS ring
// shares at parse, so an early writer would present thin circle views to
// old clients. Decisions locked with Jet 2026-09-15: hosts lock last (no
// arbiter bootstrap), witness fixed at share CREATE, immutable.
export const CHAMA_RING_WRITER_ENABLED = false;

// Rotation v2 — collection (docs/chama-rotation-v2-spec.md). OFF gates the
// WRITER only: no client creates share-v2 escrows or chained-round circles
// until the v2 READERS (the deterministic-outcome law) have shipped and the
// fleet has updated. Flips in the same release as CHAMA_RING_WRITER_ENABLED
// — one sealed upgrade, decided with Jet 2026-09-15.
export const CHAMA_ROTATION_ENABLED = false;

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
