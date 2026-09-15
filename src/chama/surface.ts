// ══════════════════════════════════════════════════════════════════════════
// Chama — what a circle SAYS and what it OFFERS, as pure functions
// ══════════════════════════════════════════════════════════════════════════
//
// The LiveTradeSurface idiom is one status, one move. Encoding that contract
// here (rather than in a component) is what keeps the rule testable: every
// state × every viewer is an assertion, and the screens stay dumb renderers
// with no fill logic of their own. Same discipline as decisions.ts.

import { canTakeSeat, circleProgress } from "./circle.js";
import type {
  CircleRound,
  CircleShareLock,
  CircleStatus,
  SeatRefusal,
} from "./types.js";

/** How long after a failed fill before the member is offered the MANUAL
 *  refund. The watcher votes automatically within seconds; this escape
 *  hatch exists for the case where it could not (offline, thin relay view),
 *  and it must not appear so early that it makes the automatic path look
 *  broken. */
export const MANUAL_REFUND_GRACE_SEC = 600;

export type CircleMove =
  /** Take a seat, or finish funding one already reserved. */
  | "lock"
  /** REFUND resolved, redemption pending: the member collects their sats.
      The one move that actually brings the money home — found missing at
      the first real completion (Jet, 2026-09-14): "Your sats are coming
      back" was a promise with no hands. */
  | "collect"
  /** Seated and waiting on others — help the circle fill. */
  | "invite"
  /** Filled and running. Calm on purpose: there is nothing to do. */
  | "wait"
  /** Refund in flight, automatic. Reassure, do not prompt. */
  | "returning"
  /** The automatic path had its chance; offer the manual REFUND. */
  | "return-now"
  /** Completed round: the host may re-form the circle. */
  | "next-round"
  | "none";

export type CircleSurfaceModel = {
  status: CircleStatus;
  move: CircleMove;
  /** Why no seat is on offer while filling (null unless that is the case). */
  refusal: SeatRefusal | null;
  /** This viewer holds a seat (reserved or locked) in this round. */
  seated: boolean;
  isHost: boolean;
  /** Threshold met — the round WILL go ahead. Copy must stop counting down
   *  ("waiting for 0 more" is a bug, Jet 2026-09-07) and start reassuring. */
  filled: boolean;
  /** More seats can still be taken (no cap, or cap not reached). When false
   *  there is nobody left to invite. */
  seatsStillOpen: boolean;
  seatsLocked: number;
  seatThreshold: number;
  potMsats: number;
  secsToFillDeadline: number;
  secsToRoundEnd: number;
};

function seatOf(
  circle: CircleRound,
  shares: readonly CircleShareLock[],
  pubkey: string,
): CircleShareLock | null {
  const member = pubkey.trim().toLowerCase();
  return shares.find(
    share =>
      share.circleId === circle.circleId
      && share.memberPubkey.trim().toLowerCase() === member,
  ) ?? null;
}

/** The whole surface contract. One status in, one move out. */
export function circleSurfaceModel(
  circle: CircleRound,
  shares: readonly CircleShareLock[],
  viewerPubkey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): CircleSurfaceModel {
  const progress = circleProgress(circle, shares, nowSec);
  const seat = seatOf(circle, shares, viewerPubkey);
  const seated = seat !== null && (seat.status === "reserved" || seat.status === "locked");
  const isHost =
    circle.creatorPubkey.trim().toLowerCase() === viewerPubkey.trim().toLowerCase();

  const seatsStillOpen = progress.seatsOpen === null || progress.seatsOpen > 0;
  const base = {
    status: progress.status,
    refusal: null as SeatRefusal | null,
    seated,
    isHost,
    filled: progress.filled,
    seatsStillOpen,
    seatsLocked: progress.seatsLocked,
    seatThreshold: circle.seatThreshold,
    potMsats: progress.potMsats,
    secsToFillDeadline: progress.secsToFillDeadline,
    secsToRoundEnd: progress.secsToRoundEnd,
  };

  if (progress.status === "filling") {
    // A reserved seat is an unfunded one: the move is still "lock", because
    // the member's money has not actually moved yet and nothing counts until
    // it does. Finishing that funding is the same button.
    if (seat?.status === "reserved") return { ...base, move: "lock" };
    // Inviting is only a move while there is a seat left to offer. A circle
    // at its cap has nobody to invite — it is sealed and simply waiting for
    // the round to start (the clock is fixed: filling early never starts
    // early). Threshold-met with seats still open is NOT full: an uncapped
    // circle keeps welcoming people right up to the deadline.
    if (seat?.status === "locked") {
      return { ...base, move: seatsStillOpen ? "invite" : "wait" };
    }
    if (isHost) return { ...base, move: seatsStillOpen ? "invite" : "wait" };
    const takeable = canTakeSeat(circle, shares, viewerPubkey, nowSec);
    if (takeable.ok) return { ...base, move: "lock" };
    return { ...base, move: "none", refusal: takeable.reason };
  }

  if (progress.status === "running") {
    return { ...base, move: "wait" };
  }

  if (progress.status === "refund-due") {
    if (seat?.status !== "locked") return { ...base, move: "none" };
    // Resolution already landed: the manual REFUND vote is moot — the only
    // thing left is to take the sats.
    if (seat.readyToClaim) return { ...base, move: "collect" };
    const sinceFailure = nowSec - circle.fillDeadlineSec;
    return {
      ...base,
      move: sinceFailure >= MANUAL_REFUND_GRACE_SEC ? "return-now" : "returning",
    };
  }

  // complete
  if (seat?.status === "locked") {
    return { ...base, move: seat.readyToClaim ? "collect" : "returning" };
  }
  return { ...base, move: isHost ? "next-round" : "none" };
}

export type CircleCardModel = {
  status: CircleStatus;
  shareMsats: number;
  /** null = this client cannot honestly say yet. Render "open", never a
   *  confident "0 of 5" that a slow relay pass would contradict. */
  seatsLocked: number | null;
  seatThreshold: number;
  seatCap: number | null;
  secsToFillDeadline: number;
};

/** The Browse card. No price, no counterparty, no rails — a circle is not
 *  an offer to trade, it is an invitation to save together. */
export function circleCardModel(
  circle: CircleRound,
  shares: readonly CircleShareLock[],
  nowSec: number = Math.floor(Date.now() / 1000),
  opts: { childrenLoaded?: boolean } = {},
): CircleCardModel {
  const progress = circleProgress(circle, shares, nowSec);
  const known =
    opts.childrenLoaded === false
      ? false
      : opts.childrenLoaded === true || shares.some(s => s.circleId === circle.circleId);
  return {
    status: progress.status,
    shareMsats: circle.shareMsats,
    seatsLocked: known ? progress.seatsLocked : null,
    seatThreshold: circle.seatThreshold,
    seatCap: circle.seatCap,
    secsToFillDeadline: progress.secsToFillDeadline,
  };
}
