// ══════════════════════════════════════════════════════════════════════════
// Chama — payout recipient mapping
// ══════════════════════════════════════════════════════════════════════════
//
// Extracted into its own module so both the state machine (getWinner) and the
// holder-only share helpers can use it without a circular import. Pure: depends
// only on types. See docs/DESIGN-holder-only-shares.md (refinement #2).

import { Role, Outcome, type EscrowState } from "./types.js";

/**
 * The recipient mapping as a PURE function of (state, candidate outcome),
 * independent of any resolved field. A voter calls this with THEIR voted
 * outcome to route their vote-carried share to the right key BEFORE the outcome
 * resolves. It MUST NOT read state.resolvedOutcome — at vote time there is none,
 * and on the RELEASE-to-non-funder path a stale read silently routes the share
 * to the wrong key.
 *
 * RELEASE sends sats to the non-locker; REFUND returns to the locker.
 *   p2p-trade:   seller locks → buyer wins release, seller wins refund
 *   bill-pay:    seller locks → buyer wins release, seller wins refund
 *   marketplace: buyer locks  → SELLER wins release, buyer wins refund
 *   lending:     seller locks → buyer wins release, seller wins refund
 *   raw-escrow:  default buyer wins release, seller wins refund
 */
export function payoutRecipientFor(
  state: EscrowState,
  outcome: Outcome,
): { pubkey: string; role: Role } | null {
  if (state.chamaPolicy && outcome !== Outcome.REFUND) return null;
  const isMarketplace = state.category === "marketplace" || state.chamaPolicy === "share-v1";
  const winnerRole: Role = outcome === Outcome.RELEASE
    ? (isMarketplace ? Role.SELLER : Role.BUYER)
    : (isMarketplace ? Role.BUYER : Role.SELLER);
  const pubkey = state.participants[winnerRole];
  if (!pubkey) return null;
  return { pubkey, role: winnerRole };
}
