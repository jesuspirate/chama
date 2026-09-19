// ══════════════════════════════════════════════════════════════════════════
// Chama — the expired, never-funded listing
// ══════════════════════════════════════════════════════════════════════════
//
// A listing that reached its expiry while still CREATED never held a satoshi:
// nobody locked, so there is nothing to settle, claim or heal. The client
// drops these from local state on sight (they are the bulk of relay noise on
// an old account), which is right — but it means anything still POINTING at
// one (a durable index entry, a "latest trade" hero, a tapped history row)
// points at something the app will refuse to keep. That mismatch is what made
// a tapped expired listing spin on "Opening trade…" forever (Jet, 2026-09-18).
//
// One shared definition, so the code that hides these and the code that must
// explain them can never disagree.

import { EscrowStatus, Role, type EscrowState } from "./types.js";
import type { TradeIndexEntry } from "./trade-index.js";

export function isExpiredUnfundedListing(
  state: EscrowState,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return (
    state.status === EscrowStatus.CREATED
    && typeof state.expiresAt === "number"
    && state.expiresAt > 0
    && nowSec > state.expiresAt
  );
}

/**
 * A remembered entry that was only ever WINDOW SHOPPING: the viewer took a
 * join hold on someone else's listing and never locked. The hold lapses on
 * its own, and the listing may since have expired and been dropped — so this
 * must never be anyone's "latest trade" (Jet: "user got kicked out of window
 * shopping, justifiably"). Deliberately scoped to REMEMBERED entries: a hold
 * that is still live shows up in the loaded set, where effective-participant
 * rules already cover it.
 */
export function isLapsedWindowShopping(entry: TradeIndexEntry): boolean {
  return entry.role === Role.BUYER && entry.lastStatus === EscrowStatus.CREATED;
}
