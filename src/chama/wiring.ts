import { circleProgress } from "./circle.js";
import { COLLECT_WINDOW_SEC } from "./rotation.js";
import { CHAMA_ROTATION_ENABLED } from "../escrow-engine/experimental-escrow-features.js";
import { circleFromEscrow } from "./policy.js";
import type { CircleShareLock } from "./types.js";
import { EscrowEventKind, EscrowStatus, Outcome, Role, type EscrowState } from "../escrow-engine/types.js";
import { canVote } from "../escrow-engine/state-machine.js";

/** Only accepted LOCK events count. Payload clocks and unfunded reservations do not. */
export function sharesForCircle(escrows: Iterable<EscrowState>, circleId?: string): CircleShareLock[] {
  const seen = new Set<string>();
  const result: CircleShareLock[] = [];
  for (const e of escrows) {
    if ((e.chamaPolicy !== "share-v1" && e.chamaPolicy !== "share-v2") || !e.parent || (circleId && e.parent !== circleId) || seen.has(e.id)) continue;
    seen.add(e.id);
    const lock = e.eventChain.find(event => event.kind === EscrowEventKind.LOCK);
    const settled = e.resolvedOutcome === Outcome.REFUND && [EscrowStatus.APPROVED, EscrowStatus.CLAIMED, EscrowStatus.COMPLETED].includes(e.status);
    // APPROVED is still owed: resolution does not prove redemption. The
    // same honesty for rotation paydays: RELEASE resolved is a promise,
    // "paid" only once the collector actually claimed.
    const returned = settled && (e.status === EscrowStatus.CLAIMED || e.status === EscrowStatus.COMPLETED);
    const paid = e.chamaPolicy === "share-v2" && e.resolvedOutcome === Outcome.RELEASE
      && (e.status === EscrowStatus.CLAIMED || e.status === EscrowStatus.COMPLETED);
    result.push({ circleId: e.parent, memberPubkey: e.participants[Role.BUYER]!,
      escrowId: lock ? e.id : null, lockedAtSec: lock?.timestamp ?? null,
      readyToClaim: settled && e.status === EscrowStatus.APPROVED,
      status: !lock ? "reserved" : paid ? "paid" : returned
        ? ((e.resolvedAt ?? e.claim.claimedAt ?? Infinity) < e.chamaCircle!.roundEndSec ? "refunded" : "returned") : "locked" });
  }
  return result;
}

/** Client orchestration. The publisher owns durable retry; failures remain eligible next pass. */
export function createChamaRefundWatcher(deps: {
  getEscrows: () => Iterable<EscrowState>;
  getPubkey: () => Promise<string>;
  vote: (id: string, outcome: Outcome) => Promise<unknown>;
  /** True once this client has COMPLETED a children refresh for the circle:
   *  its view is then as good as the relays can make it, and a short circle
   *  is a real failed fill rather than a thin view. Absent → the
   *  conservative heuristic below decides. */
  viewComplete?: (circleId: string) => boolean;
  /** Open the next collection round for a rotation cycle (deterministic id
   *  — duplicate attempts are structurally harmless). Absent → rounds are
   *  only opened by hand. */
  openNextRound?: (roundId: string) => Promise<unknown>;
  /** Writer flag override for tests; production callers leave it to the
   *  flag file. Voting on EXISTING v2 shares is never flag-gated (the
   *  flag-file doctrine: never strand recoverable money). */
  rotationEnabled?: boolean;
  onError?: (id: string, error: unknown) => void;
}) {
  let running = false;
  return async (nowSec = Math.floor(Date.now() / 1000)): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const pubkey = await deps.getPubkey();
      const escrows = [...deps.getEscrows()];
      const shares = sharesForCircle(escrows);
      for (const parent of escrows) {
        const circle = circleFromEscrow(parent);
        if (!circle) continue;
        // ⚠ THIN-VIEW GUARD. An early REFUND is only ever an OPTIMISATION —
        // roundEnd healing returns the sats unconditionally either way. But a
        // client whose relays returned only its own share sees "below
        // threshold" and would vote itself out of a circle that actually
        // filled (proven by probe, 2026-09-07). Money is safe in both
        // directions, so when the view is thin, wait: never strip a member
        // from a healthy circle to save a few days on a dead one.
        const seen = shares.filter(share => share.circleId === parent.id).length;
        const trusted = deps.viewComplete?.(parent.id) === true;
        if (!trusted && seen < 2 && circle.seatThreshold > 1 && nowSec < circle.roundEndSec) continue;
        for (const id of circleProgress(circle, shares, nowSec).dueBackEscrowIds) {
          const state = [...deps.getEscrows()].find(e => e.id === id);
          if (!state || !canVote(state, pubkey, nowSec, Outcome.REFUND).canVote) continue;
          try { await deps.vote(id, Outcome.REFUND); }
          catch (error) { deps.onError?.(id, error); }
        }
        // Rotation cadence (decision 3): the moment a rotation round ends,
        // any member's client opens the next one. Deterministic ids make
        // simultaneous attempts collapse into one round.
        if ((deps.rotationEnabled ?? CHAMA_ROTATION_ENABLED) && deps.openNextRound && circle.pot === "rotation-v2" && nowSec >= circle.roundEndSec
            && !escrows.some(e => e.chamaCircle?.pot === "rotation-v2" && e.chamaCircle.prevCircleId === parent.id)) {
          try { await deps.openNextRound(parent.id); }
          catch (error) { deps.onError?.(parent.id, error); }
        }
      }
      // Rotation shares: the payday and its lapse are mechanical. The vote
      // path re-derives cycle evidence and its law refuses anything the
      // evidence does not admit, so unlawful candidates die locally, cheap.
      for (const e of escrows) {
        if (e.chamaPolicy !== "share-v2" || !e.chamaCircle || e.resolvedOutcome != null) continue;
        const role = ([Role.BUYER, Role.SELLER] as const).find(r => e.participants[r] === pubkey);
        if (role === undefined || e.votes[role] !== undefined) continue;
        if (!e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK)) continue;
        const c = e.chamaCircle;
        const candidates: Outcome[] = nowSec >= c.roundEndSec + COLLECT_WINDOW_SEC ? [Outcome.REFUND]
          : nowSec >= c.roundEndSec ? [Outcome.RELEASE, Outcome.REFUND]
          : nowSec >= c.fillDeadlineSec && deps.viewComplete?.(e.parent ?? "") === true ? [Outcome.REFUND]
          : [];
        for (const [index, want] of candidates.entries()) {
          try { await deps.vote(e.id, want); break; }
          catch (error) { if (index === candidates.length - 1) deps.onError?.(e.id, error); }
        }
      }
    } finally { running = false; }
  };
}
