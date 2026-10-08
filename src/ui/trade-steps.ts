// ══════════════════════════════════════════════════════════════════════════
// Chama — the trade room's step strip (v7 redesign, Figma "A trade")
// ══════════════════════════════════════════════════════════════════════════
//
// Locked · Paid · Released · Collected, read only from committed escrow
// state. Display only: nothing here decides who may vote or claim. Shown for
// the money-for-sats trades (Exchange, Bill Pay), where "Paid" means the
// fiat leg; other trade types and refunded or closed trades show no strip.

import { EscrowStatus, Outcome, type EscrowState } from "../escrow-engine/types.js";

export const TRADE_STEPS = ["locked", "paid", "released", "collected"] as const;
export type TradeStep = typeof TRADE_STEPS[number];

/** How many of the four steps are done, or null when the strip is hidden. */
export function tradeStepsDone(state: EscrowState): number | null {
  if (state.category !== "p2p-trade" && state.category !== "bill-pay") return null;
  const released = state.resolvedOutcome !== Outcome.REFUND;
  const locked = !!state.lock?.notesHash || state.lock?.lockedAt != null;
  const anyRelease = Object.values(state.votes ?? {}).some(v => v === Outcome.RELEASE);
  switch (state.status) {
    case EscrowStatus.CREATED: return 0;
    case EscrowStatus.LOCKED: return anyRelease ? 2 : 1;
    case EscrowStatus.EXPIRED: return locked ? (anyRelease ? 2 : 1) : null;
    case EscrowStatus.APPROVED:
    case EscrowStatus.CLAIMED: return released ? 3 : null;
    case EscrowStatus.COMPLETED: return released ? 4 : null;
    default: return null;
  }
}
