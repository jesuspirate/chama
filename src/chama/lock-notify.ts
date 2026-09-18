// ══════════════════════════════════════════════════════════════════════════
// Chama — circle seat-lock notification context
// ══════════════════════════════════════════════════════════════════════════
//
// The host locks LAST. That is the whole shape of a circle: members take
// their seats, and the host's lock is what seals the round — until it lands
// there is no round, and therefore no round two. So the host must be told,
// every time a seat fills, and told unmistakably the moment everyone else is
// in and only their own lock is missing.
//
// This module owns the CIRCLE rules (who hosts, which seats are locked, whose
// turn it is); src/notifications/trade-notifications.ts owns the copy and the
// dedup tag. Pure and side-effect free, so every case is testable.

import { circleFromEscrow } from "./policy.js";
import { sharesForCircle } from "./wiring.js";
import type { CircleLockContext } from "../notifications/trade-notifications.js";
import type { EscrowState } from "../escrow-engine/types.js";

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Context for a share escrow that just locked, or null when this escrow is not
 * a circle share (or the circle parent isn't in view — a thin relay view must
 * never invent a "your turn" that isn't true).
 *
 * `escrows` must already include the freshly-locked `share`, otherwise the
 * seat count is one short — the caller merges it in.
 */
export function circleLockContextFor(
  share: EscrowState,
  escrows: Iterable<EscrowState>,
  viewerPubkey: string | null | undefined,
): CircleLockContext | null {
  if (share.chamaPolicy !== "share-v1" && share.chamaPolicy !== "share-v2") return null;
  if (!share.parent || !viewerPubkey) return null;

  const all = [...escrows];
  const parentState = all.find(e => e.id === share.parent);
  const circle = parentState ? circleFromEscrow(parentState) : null;
  if (!circle) return null;

  const viewerIsHost = same(circle.creatorPubkey, viewerPubkey);
  const locked = sharesForCircle(all, circle.circleId).filter(s => s.escrowId !== null);
  const lockedSeats = locked.length;
  const viewerSeatLocked = locked.some(s => same(s.memberPubkey, viewerPubkey));

  // "Everyone else is in": the target minus the host's own seat. A host who
  // has already locked is never told it's their turn, and a circle still
  // short of that mark gets quiet progress instead.
  const hostTurn = viewerIsHost
    && !viewerSeatLocked
    && lockedSeats >= Math.max(1, circle.seatThreshold - 1);

  return {
    circleId: circle.circleId,
    circleName: circle.name,
    roundIndex: circle.roundIndex,
    lockedSeats,
    seatTarget: circle.seatThreshold,
    viewerIsHost,
    hostTurn,
  };
}
