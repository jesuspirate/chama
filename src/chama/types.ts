// ══════════════════════════════════════════════════════════════════════════
// Chama — the savings circle. The app finally doing the thing it is named
// after. Pure contract only: no events, no spends, no UI. Money enters when
// each share lock becomes an escrow through the existing machinery.
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ THE PREMISE (docs/chama-circle-brief.md, premises locked 2026-09-03):
// a group locks sats TOGETHER for one bounded round. Either the circle fills
// and everyone completes the round, or it doesn't and every locked share
// auto-returns at the deadline. Nobody is ever the only one who showed up.
// Zero credit risk in v1: sats in, the SAME sats back — never a price
// promise, never a fee dock, never a partial circle.
//
// Parentage: Chip In contributed the money engine (threshold + deadline +
// auto-refund IS fill-or-refund); Stack contributed the rhythm and the
// streak (weekly cadence, consecutive clean rounds). Reused, not rebuilt.
//
// Open questions from the brief, DECIDED here (2026-09-07):
// - Equal shares only in v1: YES. One seat, one share, one member.
// - seatThreshold ≥ 2 is a validator law: a circle of one is not a circle.
// - Membership: open to the world until the fill deadline, bounded by an
//   optional cap (cap ≥ threshold). Hitting the cap closes joins, not the
//   round clock.
// - Who may open a circle: anyone. Fill-or-refund means an unknown creator
//   can cost you nothing but time; standing accrues from round one.
// - The round clock is FIXED AT CREATION: fillDeadlineSec and roundEndSec
//   are absolute, agreed before the first lock. Every member gets the same
//   promise ("back by <date>"), which is also the marketing pulse — lock
//   Monday, back by Sunday. A circle that fills early does not start early.

/** Hard federation bound from the brief: never hold locked ecash without
 *  redeem for longer than ~2 weeks. The bound is a FEATURE, said out loud. */
export const MAX_ROUND_SEC = 14 * 86_400;

/** The pulse (Jet's morning ruling, 2026-09-07): weekly rounds by default. */
export const DEFAULT_ROUND_SEC = 7 * 86_400;

/** Early-lock bonus at the instant the circle opens; decays linearly to ZERO
 *  at the fill deadline. On-time is NEVER negative — the system never
 *  punishes someone for doing what the protocol asked. */
export const EARLY_LOCK_BONUS_MAX = 2;

export interface CircleRound {
  version: 1;
  circleId: string;
  creatorPubkey: string;
  community: string;
  mintUrl: string;
  /** Circle identity ("Mama Mboga collective"). Running copy says "Circle";
   *  the vertical is Chama — sharing the app's name is the point. */
  name: string;
  /** Equal shares only (v1): every seat locks exactly this. */
  shareMsats: number;
  /** Fill-or-refund bar: locked seats below this at the fill deadline means
   *  every locked share auto-returns. Minimum 2 — see module header. */
  seatThreshold: number;
  /** Optional ceiling on seats (null = open to the world until deadline).
   *  Must be ≥ seatThreshold when set. */
  seatCap: number | null;
  /** Absolute: last moment a share can lock. Agreed BEFORE any lock. */
  fillDeadlineSec: number;
  /** Absolute: when every locked share returns to its owner. The whole
   *  promise in one number: "locked together, guaranteed back by <date>". */
  roundEndSec: number;
  /** 1-based pulse counter across a re-forming circle's lifetime. */
  roundIndex: number;
  /** Auto-re-entry lineage: the previous round's circleId, null for a
   *  first round. Successful rounds re-form; this is the thread. */
  prevCircleId: string | null;
  createdAt: number;
}

export interface CircleShareLock {
  circleId: string;
  memberPubkey: string;
  /** Escrow id once the share is actually locked; null while the seat is
   *  merely reserved. Mirrors Chip In's pledged/locked honesty: reserved
   *  counts for nothing. */
  escrowId: string | null;
  status: "reserved" | "locked" | "returned" | "refunded";
  /** Unix seconds the lock landed (chain fact, feeds punctuality standing).
   *  Null while reserved. */
  lockedAtSec: number | null;
}

/** Derived, never stored — Chip In's idiom. The status IS the arithmetic. */
export type CircleStatus =
  /** Before the fill deadline: seats can still lock (until cap). */
  | "filling"
  /** Deadline passed with threshold met; shares held until roundEndSec. */
  | "running"
  /** Deadline passed below threshold: every locked share auto-returns.
   *  This outcome costs standing NOTHING — a refunded circle is a plan
   *  that didn't gather, not a promise broken. */
  | "refund-due"
  /** Round end reached from running: shares return to their owners. */
  | "complete";

export type CircleProgress = {
  status: CircleStatus;
  seatsLocked: number;
  seatsReserved: number;
  /** Seats still takeable right now (null when the circle has no cap). */
  seatsOpen: number | null;
  filled: boolean;
  potMsats: number;
  secsToFillDeadline: number;
  secsToRoundEnd: number;
  /** Escrow ids owed back on refund-due / complete — the healing worklist.
   *  Empty in filling/running. Reserved seats never appear: nothing locked,
   *  nothing owed. */
  dueBackEscrowIds: string[];
};

export type SeatRefusal = "closed" | "full" | "already-seated" | "host";

/** Chain-derived punctuality signals for one lock — the standing inputs the
 *  brief locks: early earns (decaying to zero), weighted in sat-days so it
 *  cannot be Sybil-farmed with dust. Calibration constants are product-
 *  tunable; the INVARIANTS (monotone decay, floor at zero, linear sat-day
 *  scaling) are tested and load-bearing for v2 rotation placement. */
export type LockPunctuality = {
  /** 0 at circle open → 1 at the fill deadline (clamped). */
  fillWindowFraction: number;
  /** EARLY_LOCK_BONUS_MAX at open → 0 at deadline. Never negative. */
  earlyBonus: number;
  /** sats × days the share stays committed from lock to round end. */
  satDaysCommitted: number;
  /** The one number rotation placement will read: sat-days scaled by the
   *  early bonus. Earned, never bought. */
  standingWeight: number;
};
