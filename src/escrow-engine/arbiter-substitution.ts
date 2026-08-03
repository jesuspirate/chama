// ══════════════════════════════════════════════════════════════════════════
// Arbiter substitution — deterministic pool priority + eligibility (Stage 1)
// ══════════════════════════════════════════════════════════════════════════
//
// See docs/DESIGN-arbiter-substitution.md (maintainer-locked 2026-06-04).
//
// Holder-only made the assigned arbiter the sole holder of the arbiter Shamir
// share, so an absent arbiter stranded disputes on the expiry refund. These
// helpers are the pure heart of the fix: a deterministic PRIORITY ORDER of
// pool arbiters per escrow (assigned first, then backups via the same
// round-robin pick the LOCK used), and a chain-derived GRACE WINDOW after
// which a backup may cast the arbiter vote. Everything here is a pure
// function of state the event chain already carries, so every client
// converges on the same answers with no coordinator:
//
//   • who may substitute   → arbiterPriorityOrder / arbiterVotePriority
//   • when they may        → disputeStartAt + substitutionEligibleAt
//   • which vote wins      → lowest priority index among arbiter votes in the
//                            chain (the reducer applies this; assigned = 0
//                            always trumps backups pre-settlement)
//
// The grace window is courtesy, not correctness: even if a backup votes the
// moment it opens, a later vote from the assigned arbiter still wins the slot
// until a RESOLVE + CLAIM settles the trade (first accepted wins).

import { Role, EscrowEventKind, Outcome, type EscrowState, type VotePayload } from "./types.js";
import { pickArbiterFromPool } from "../arbiters/pool.js";
import { payoutRecipientFor } from "./recipients.js";

/** Pool members who hold a copy of the arbiter share AND may vote: the
 *  assigned arbiter + 2 backups. Share-holding and vote-eligibility are capped
 *  to the same set so they can never diverge. */
export const ARBITER_POOL_SHARE_CAP = 3;

/** Max exclusivity for the assigned arbiter once a dispute starts. Also the
 *  ceiling a committed `substitutionGraceSeconds` is clamped to — a locker can
 *  only ever make backups eligible SOONER than this, never later (a longer
 *  window would just delay rescue of the locker's own funds, and healing
 *  refunds at expiry regardless, so lengthening has no upside and we forbid
 *  it). */
export const SUBSTITUTION_GRACE_MAX_SECONDS = 4 * 3600;

/** Clamp a requested/committed grace into the legal range [0, MAX]. Non-finite
 *  / negative inputs fall back to the MAX default (legacy 4h behavior), so a
 *  malformed field can never make the window longer than today's ceiling. */
export function clampSubstitutionGraceSeconds(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SUBSTITUTION_GRACE_MAX_SECONDS;
  return Math.max(0, Math.min(SUBSTITUTION_GRACE_MAX_SECONDS, Math.floor(value)));
}

/** INVARIANT(dispute-clock-bounded) — v3.3 (C11). How far past expiry a
 *  dispute-clock anchor may sit before the clamp pins it. Reuses the 4h grace
 *  ceiling so the whole substitution clock thinks in one unit. */
export const DISPUTE_CLOCK_SLACK_SECONDS = SUBSTITUTION_GRACE_MAX_SECONDS;

/** INVARIANT(dispute-clock-bounded) — v3.3 (C11): clamp a dispute-clock anchor
 *  to its CEILING only — `≤ expiresAt + slack(4h)`. The anchors below come from
 *  self-asserted vote `created_at`s; without the ceiling a FUTURE-dated vote
 *  pushes eligibility absurdly far out (frozen escalation). The clamp is a
 *  bound, not the boundary: the deterministic PRIORITY RULE is the real
 *  correctness boundary — the assigned arbiter's later vote beats any backup's
 *  pre-settlement, whatever the timestamps claim (see the header note and the
 *  slot derivation in handleVote).
 *
 *  NOTE — no lower (lockedAt) floor. `lockedAt` is the locker's clock; votes
 *  carry each voter's clock; and there is NO floor gate on buyer/seller votes,
 *  so an HONEST RELEASE vote can legitimately sit slightly before `lockedAt` on
 *  ordinary skew. Flooring it forward would push `eligibleAt` later and reject
 *  a previously-valid arbiter/backup vote (ARBITER_TOO_EARLY /
 *  SUBSTITUTE_TOO_EARLY) — same chain, divergent outcome. The ceiling has no
 *  such hazard: an honest vote is never that late. Pure over committed state;
 *  the ceiling comes from the chain itself, so every client clamps identically. */
function clampDisputeAnchor(state: EscrowState, at: number): number {
  if (typeof state.expiresAt === "number" && state.expiresAt > 0) {
    const ceiling = state.expiresAt + DISPUTE_CLOCK_SLACK_SECONDS;
    if (at > ceiling) return ceiling;
  }
  return at;
}

/** Low-level deterministic priority order. The LOCK builder calls this with
 *  the pubkeys it is about to commit (the arbiter isn't seated in state yet at
 *  build time); everyone else should prefer arbiterPriorityOrder(state). */
export function arbiterPriorityOrderFor(params: {
  escrowId: string;
  pool: readonly string[];
  buyerPubkey?: string | null;
  sellerPubkey?: string | null;
  assignedArbiter?: string | null;
}): string[] {
  const order: string[] = [];
  if (params.assignedArbiter) order.push(params.assignedArbiter);
  while (order.length < ARBITER_POOL_SHARE_CAP) {
    const next = pickArbiterFromPool(
      [...params.pool],
      params.escrowId,
      [params.buyerPubkey, params.sellerPubkey, ...order],
    );
    if (!next) break;
    order.push(next);
  }
  return order;
}

/** ⭐ Who actually receives an encrypted copy of the ARBITER share at LOCK.
 *
 *  ⚠ DELIBERATELY DIFFERENT FROM `arbiterPriorityOrderFor`, and the difference
 *  is load-bearing. That function feeds TWO consumers:
 *
 *    1. the reducer, which gates the arbiter VOTE on it
 *       (state-machine.ts `NOT_POOL_ARBITER`) — pure, replayed everywhere, so
 *       changing it is a CONSENSUS change that would fork mixed-version chains
 *       on a money path;
 *    2. share distribution at LOCK build time — purely client-side.
 *
 *  Only (2) is safe to change, so only (2) changes. Vote eligibility stays
 *  byte-identical.
 *
 *  THE PROBLEM THIS FIXES. `ARBITER_POOL_SHARE_CAP` is 3 and the default pool
 *  (`BLF_CABINET_NPUBS`) is exactly 3, so every arbiter in the system received a
 *  decryptable share on every pooled trade — seated or not. One principal
 *  colluding with ANY pool member is two shares, which is a redeem: no seat, no
 *  vote, no state machine involved. The seat was never the control it looked
 *  like.
 *
 *  So recipients are capped strictly below the pool: at least the assigned
 *  arbiter, never the whole pool. With a 3-member pool that is assigned + one
 *  backup instead of all three.
 *
 *  ⚠ HONEST ABOUT WHAT THIS IS. It is a reduction, not a fix — "any one of two"
 *  still redeems with a principal. The real fix is nesting the arbiter share
 *  2-of-3 across the panel so no single arbiter is ever sufficient, and that
 *  needs a pool genuinely larger than the cap. Do not let this line make the
 *  screen look solved.
 *
 *  ⚠ THE COST, stated: a backup who is vote-eligible but holds no share can
 *  still cast a valid arbiter vote, and simply cannot contribute the deciding
 *  share with it (`buildVoteShareEnvelope` is best-effort by design). If the
 *  assigned arbiter AND the first backup are both absent, the trade rides to
 *  expiry and refunds rather than being decided. That is availability traded
 *  for custody, and it is the correct direction — an availability failure
 *  resolves to a refund, while a surplus share-holder resolves to a theft. */
export function arbiterShareRecipientsFor(params: {
  escrowId: string;
  pool: readonly string[];
  buyerPubkey?: string | null;
  sellerPubkey?: string | null;
  assignedArbiter?: string | null;
}): string[] {
  const order = arbiterPriorityOrderFor(params);
  const poolSize = params.pool.length;
  // Never the whole pool; always at least the assigned arbiter (a single-arbiter
  // community must still be able to rule at all).
  const limit = Math.max(1, Math.min(ARBITER_POOL_SHARE_CAP, poolSize - 1));
  return order.slice(0, limit);
}

/** Deterministic arbiter priority order for this escrow: index 0 is the
 *  assigned arbiter (as committed in the LOCK), then backups derived by
 *  iterating the same deterministic pool pick the LOCK used, excluding
 *  buyer/seller and everyone already ordered. Capped at
 *  ARBITER_POOL_SHARE_CAP. Pure over (participants, communityArbiters, id) —
 *  every client computes the identical order. */
export function arbiterPriorityOrder(state: EscrowState): string[] {
  return arbiterPriorityOrderFor({
    escrowId: state.id,
    pool: state.communityArbiters ?? [],
    buyerPubkey: state.participants[Role.BUYER],
    sellerPubkey: state.participants[Role.SELLER],
    assignedArbiter: state.participants[Role.ARBITER],
  });
}

/** Priority index of `pubkey` in the order above (0 = assigned, 1-2 =
 *  backups), or null when the pubkey is not substitution-eligible here. */
export function arbiterVotePriority(state: EscrowState, pubkey: string): number | null {
  const idx = arbiterPriorityOrder(state).indexOf(pubkey);
  return idx === -1 ? null : idx;
}

/** When the dispute started, the anchor for the substitution clock. Two arms,
 *  both pure over the event chain so they replay identically everywhere:
 *   1. Two-sided: the created_at of the LATER of buyer's and seller's votes,
 *      when both exist and disagree.
 *   2. One-sided (v2.9): a standing RELEASE from the non-locker with the locker
 *      SILENT has no two-sided start, but once its escalation window opens the
 *      dispute is DEEMED to start then (= oneSidedEscalationAt). This unfreezes
 *      substitutionEligibleAt so BACKUP arbiters become reachable through the
 *      same gate — otherwise a ghosting locker plus a no-show assigned arbiter
 *      would still win the expiry refund.
 *  Null when neither arm applies (no dispute → no substitution clock). */
export function disputeStartAt(state: EscrowState): number | null {
  let buyer: { outcome: Outcome; at: number } | null = null;
  let seller: { outcome: Outcome; at: number } | null = null;
  for (const ve of state.eventChain) {
    if (ve.kind !== EscrowEventKind.VOTE) continue;
    const p = ve.payload as VotePayload | undefined;
    if (!p) continue;
    const at = (ve as { raw?: { created_at?: number } }).raw?.created_at ?? 0;
    if (p.role === Role.BUYER && !buyer) buyer = { outcome: p.outcome, at };
    else if (p.role === Role.SELLER && !seller) seller = { outcome: p.outcome, at };
  }
  if (buyer && seller && buyer.outcome !== seller.outcome) {
    // C11: clamp the self-asserted anchor to its ceiling (≤ expiresAt + slack).
    return clampDisputeAnchor(state, Math.max(buyer.at, seller.at));
  }
  return oneSidedEscalationAt(state);
}

/** The moment a BACKUP becomes eligible to cast the arbiter vote:
 *  disputeStartAt + min(ceiling, half the trade's remaining life). The ceiling
 *  is the locker's committed `substitutionGraceSeconds` (v2.3), clamped to
 *  [0, 4h]; absent ⇒ the legacy 4h default, so old locks are unchanged. The
 *  adaptive half-life floor keeps backups viable on short trades (a 2h-to-
 *  expiry dispute gives the assigned arbiter 1h, not never); an already-expired
 *  edge floors at 0 so a merit resolution can still beat the expiry refund.
 *  Pure over committed state — every client converges. Null while there is no
 *  dispute. */
export function substitutionEligibleAt(state: EscrowState): number | null {
  const start = disputeStartAt(state);
  if (start === null) return null;
  const ceiling = clampSubstitutionGraceSeconds(state.lock?.substitutionGraceSeconds);
  const half = state.expiresAt
    ? Math.max(0, Math.floor((state.expiresAt - start) / 2))
    : ceiling;
  return start + Math.min(ceiling, half);
}

// ── One-sided RELEASE escalation — the ghosting-locker fix (v2.9) ───────────
//
// The expiry default ("refund the locker") encodes "nobody performed." A
// standing RELEASE from the NON-LOCKER — the party who does NOT hold the locked
// sats: the buyer who sent fiat in exchange/bill-pay/lending, the SELLER who
// shipped goods in marketplace (buyer locks there) — falsifies that: someone
// claims to have performed. recipients.payoutRecipientFor(state, RELEASE) IS the
// non-locker by construction, so the marketplace inversion is handled without a
// hand-rolled per-category map (one source of truth). The locker's OWN RELEASE
// is deliberately out of scope: a locker conceding then going silent gets
// refunded against their stated intent, but that is locker-favorable, not theft.

/** The non-locker's standing-RELEASE anchor when the locker is SILENT (the
 *  one-sided case that the two-sided disputeStart arm misses). Carries the
 *  RELEASE vote's created_at — the anchor for the escalation clock. Null if the
 *  non-locker has not voted RELEASE, the locker HAS voted (then it is a
 *  two-sided dispute → disputeStartAt arm 1), or no such RELEASE vote is in the
 *  chain. Pure over committed state. */
export function oneSidedReleaseAnchor(
  state: EscrowState,
): { nonLockerRole: Role; releaseVoteAt: number } | null {
  const nonLocker = payoutRecipientFor(state, Outcome.RELEASE);
  const locker = payoutRecipientFor(state, Outcome.REFUND);
  if (!nonLocker || !locker) return null;
  if (state.votes[locker.role] !== undefined) return null;          // locker not silent → two-sided
  if (state.votes[nonLocker.role] !== Outcome.RELEASE) return null; // no standing RELEASE
  const nonLockerPk = state.participants[nonLocker.role];
  if (!nonLockerPk) return null;
  for (const ve of state.eventChain) {
    if (ve.kind !== EscrowEventKind.VOTE || ve.pubkey !== nonLockerPk) continue;
    const p = ve.payload as VotePayload | undefined;
    if (p?.outcome !== Outcome.RELEASE) continue;
    const at = (ve as { raw?: { created_at?: number } }).raw?.created_at ?? 0;
    // C11: same ceiling clamp as the two-sided arm — one clock, one bound.
    return { nonLockerRole: nonLocker.role, releaseVoteAt: clampDisputeAnchor(state, at) };
  }
  return null;
}

/** When the arbiter's window over a ONE-SIDED standing RELEASE opens: the
 *  RELEASE vote's created_at + min(committed grace clamped to [0,4h] (else the
 *  4h default), half the trade's remaining life at that anchor). Identical
 *  formula to substitutionEligibleAt, re-anchored on the lone RELEASE vote so
 *  no second patience knob exists. The half-life floor keeps it strictly before
 *  expiry, so a performer can win before the expiry refund. Null when there is
 *  no one-sided standing RELEASE. */
export function oneSidedEscalationAt(state: EscrowState): number | null {
  const anchor = oneSidedReleaseAnchor(state);
  if (!anchor) return null;
  const ceiling = clampSubstitutionGraceSeconds(state.lock?.substitutionGraceSeconds);
  const half = state.expiresAt
    ? Math.max(0, Math.floor((state.expiresAt - anchor.releaseVoteAt) / 2))
    : ceiling;
  return anchor.releaseVoteAt + Math.min(ceiling, half);
}

/** Suppression predicate (v2.9): a standing RELEASE from the non-locker means
 *  the trade is a performance CONTEST, not abandonment, so the expiry/healing
 *  REFUND default must NOT auto-pay the locker. It LIFTS the moment an arbiter
 *  affirmatively rules REFUND (votes[ARBITER] === REFUND) — that lets the
 *  locker's expiry refund complete a legitimate 2-of-3 REFUND; without the lift,
 *  a buyer could vote RELEASE without paying and freeze the locker's funds
 *  forever. Covers the one-sided case (locker silent) AND the two-sided
 *  RELEASE/REFUND split with an absent arbiter — the same theft. Pure over
 *  committed state. */
export function isPerformanceContest(state: EscrowState): boolean {
  // payoutRecipientFor is null only when a participant is unseated, which can
  // only happen pre-LOCK. Suppression is evaluated only post-LOCK (a contest
  // needs a recorded vote), so a null here is the honest "no contest" answer,
  // never a silently-disabled guard.
  const nonLocker = payoutRecipientFor(state, Outcome.RELEASE);
  if (!nonLocker || state.votes[nonLocker.role] !== Outcome.RELEASE) return false;
  if (state.votes[Role.ARBITER] === Outcome.REFUND) return false; // arbiter adjudicated against the claim
  return true;
}

// ── Arbiter no-show (accountability #1) ───────────────────────────────────
//
// Substitution already rescues the trade when the assigned arbiter never
// answers a dispute. What it doesn't do is REMEMBER. These helpers derive the
// no-show purely from the committed chain, so every client agrees without a new
// event kind, a new assignment era, or any reducer change.
//
// A no-show is deliberately narrow — it must never libel an arbiter who simply
// wasn't needed:
//   • a dispute actually started (disputeStartAt),
//   • the backup window actually opened (substitutionEligibleAt ≤ now),
//   • the ASSIGNED arbiter cast no vote at all, and
//   • somebody else's arbiter vote is in the chain (a backup did the work).
// The last clause is what makes it evidence rather than an accusation: a
// dispute nobody has resolved yet is still live, and being slow is not the same
// as being absent.

/** Did the assigned arbiter vote on this trade? */
function assignedArbiterVoted(state: EscrowState): boolean {
  const assigned = state.participants[Role.ARBITER];
  if (!assigned) return false;
  return state.eventChain.some(ve =>
    ve.kind === EscrowEventKind.VOTE &&
    (ve.payload as VotePayload | undefined)?.role === Role.ARBITER &&
    (ve as { raw?: { pubkey?: string } }).raw?.pubkey === assigned
  );
}

/** A backup arbiter (anyone but the assigned one) cast the arbiter vote. */
function backupArbiterVoted(state: EscrowState): boolean {
  const assigned = state.participants[Role.ARBITER];
  return state.eventChain.some(ve => {
    if (ve.kind !== EscrowEventKind.VOTE) return false;
    if ((ve.payload as VotePayload | undefined)?.role !== Role.ARBITER) return false;
    const voter = (ve as { raw?: { pubkey?: string } }).raw?.pubkey;
    return !!voter && voter !== assigned;
  });
}

/** True when the assigned arbiter demonstrably left a live dispute to a backup.
 *  `nowSec` is passed so this stays pure and testable. */
export function isArbiterNoShow(state: EscrowState, nowSec: number): boolean {
  if (!state.participants[Role.ARBITER]) return false;
  const eligibleAt = substitutionEligibleAt(state);
  if (eligibleAt === null || nowSec < eligibleAt) return false;
  if (assignedArbiterVoted(state)) return false;
  return backupArbiterVoted(state);
}

/** The npub that failed to show on this trade, or null. */
export function arbiterNoShowNpub(state: EscrowState, nowSec: number): string | null {
  return isArbiterNoShow(state, nowSec) ? state.participants[Role.ARBITER] ?? null : null;
}

/** How many of `states` a given arbiter no-showed on. Dedups by escrow id so a
 *  trade loaded twice can never inflate the count. */
export function countArbiterNoShows(
  states: readonly EscrowState[],
  npub: string,
  nowSec: number,
): number {
  const seen = new Set<string>();
  for (const state of states) {
    if (seen.has(state.id)) continue;
    if (arbiterNoShowNpub(state, nowSec) === npub) seen.add(state.id);
  }
  return seen.size;
}
