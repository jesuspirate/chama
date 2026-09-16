import { EscrowEventKind, EscrowStatus, Outcome, Role, type EscrowState } from "../escrow-engine/types.js";
import { EARLY_LOCK_BONUS_MAX } from "./types.js";
import { circleFromEscrow } from "./policy.js";
import { sharesForCircle } from "./wiring.js";
import { circleProgress, lockPunctuality } from "./circle.js";

/** Rotation conduct, derived purely from the escrows in view. Feed it a
 *  COMPLETE view (loaded children) — the mark is an accusation, and this
 *  module never accuses from a thin one: a missing lock only counts
 *  against someone when the round's OTHER shares prove the round was real
 *  and short. Cycle identity is the round-1 anchor, PROVEN by walking
 *  prevCircleId through rounds actually in view — an unprovable chain
 *  never mints the sacrifice bonus and never marks anyone. */
export function rotationConduct(escrows: Iterable<EscrowState>, pubkey: string, nowSec: number) {
  const me = pubkey.toLowerCase();
  const v2ByRound = new Map<string, EscrowState[]>();
  for (const e of escrows) {
    if (e.chamaPolicy !== "share-v2" || !e.parent || e.chamaCircle?.pot !== "rotation-v2") continue;
    const list = v2ByRound.get(e.parent) ?? [];
    list.push(e); v2ByRound.set(e.parent, list);
  }
  const circleOf = new Map<string, NonNullable<EscrowState["chamaCircle"]>>();
  for (const [roundId, roundShares] of v2ByRound) circleOf.set(roundId, roundShares[0].chamaCircle!);
  const anchorOf = (roundId: string): string | null => {
    let id = roundId;
    for (let hops = 0; hops < 64; hops++) {
      const c = circleOf.get(id);
      if (!c?.prevCircleId) return null;
      if (c.roundIndex === 2) return c.prevCircleId;
      id = c.prevCircleId;
    }
    return null;
  };
  const collected: { anchor: string | null; roundIndex: number }[] = [];
  const sacrificeShareIds = new Set<string>();
  let brokeAtSec: number | null = null;
  for (const [roundId, roundShares] of v2ByRound) {
    const circle = circleOf.get(roundId)!;
    const seller = roundShares[0].participants[Role.SELLER]?.toLowerCase();
    const lockedCount = roundShares.filter(e => e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK)).length;
    const filled = circle.seatThreshold > 0 && lockedCount >= circle.seatThreshold;
    if (seller === me && filled && nowSec >= circle.roundEndSec) {
      collected.push({ anchor: anchorOf(roundId), roundIndex: circle.roundIndex });
    }
  }
  for (const [roundId, roundShares] of v2ByRound) {
    const circle = circleOf.get(roundId)!;
    const anchor = anchorOf(roundId);
    // Same-cycle proof required for both the bonus and the accusation.
    const myCollection = anchor === null ? undefined
      : collected.find(c => c.anchor === anchor && c.roundIndex < circle.roundIndex);
    if (!myCollection) continue;
    const myLock = roundShares.some(e => e.participants[Role.BUYER]?.toLowerCase() === me
      && e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK));
    const othersLocked = roundShares.filter(e => e.participants[Role.BUYER]?.toLowerCase() !== me
      && e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK)).length;
    if (myLock) {
      // Post-payday lock: the sacrifice round (decision 5). Every share of
      // mine in this round mints at the maximum early bonus.
      for (const e of roundShares) {
        if (e.participants[Role.BUYER]?.toLowerCase() === me) sacrificeShareIds.add(e.id);
      }
    } else if (nowSec >= circle.fillDeadlineSec && othersLocked > 0 && othersLocked + 0 < circle.seatThreshold) {
      // THE MARK (2026-09-16): I collected, a later round of MY cycle
      // failed its fill, my lock is absent while others' locks prove the
      // round was real. Deterministic accusation, no judgment anywhere.
      brokeAtSec = brokeAtSec === null ? circle.fillDeadlineSec : Math.min(brokeAtSec, circle.fillDeadlineSec);
    }
  }
  return { collectedRounds: collected.length, sacrificeShareIds, brokeAfterCollecting: brokeAtSec !== null, brokeAtSec };
}

/** Counts only observed successful member rounds, never host-only rounds. */
export function circleMemberStats(escrows: Iterable<EscrowState>, pubkey: string, nowSec: number) {
  const all = [...escrows], shares = sharesForCircle(all);
  const conduct = rotationConduct(all, pubkey, nowSec);
  let completed = 0, onTime = 0, standing = 0;
  for (const parent of all) {
    const circle = circleFromEscrow(parent);
    if (!circle || circleProgress(circle, shares, nowSec).status !== "complete") continue;
    const mine = shares.find(s => s.circleId === circle.circleId && s.memberPubkey.toLowerCase() === pubkey.toLowerCase());
    if (!mine || mine.status !== "returned" || mine.lockedAtSec === null) continue;
    completed++;
    if (mine.lockedAtSec <= circle.fillDeadlineSec) onTime++;
    standing += lockPunctuality(circle, mine.lockedAtSec).standingWeight;
  }
  // Rotation rounds I paid into that reached the collector (share-v2:
  // RELEASE resolved, sats claimed). A sacrifice-round lock — after my own
  // collection in that cycle — mints at the MAXIMUM early bonus no matter
  // when in the window it landed (decision 5): post-payday locking is the
  // one act with zero financial motive.
  for (const e of all) {
    if (e.chamaPolicy !== "share-v2" || !e.chamaCircle || !e.parent) continue;
    if (e.participants[Role.BUYER]?.toLowerCase() !== pubkey.toLowerCase()) continue;
    if (e.resolvedOutcome !== Outcome.RELEASE || ![EscrowStatus.CLAIMED, EscrowStatus.COMPLETED].includes(e.status)) continue;
    const lock = e.eventChain.find(ev => ev.kind === EscrowEventKind.LOCK);
    if (!lock) continue;
    const parentState = all.find(st => st.id === e.parent);
    const roundCircle = parentState ? circleFromEscrow(parentState) : null;
    if (!roundCircle) continue; // punctuality needs the round's own clock
    completed++;
    if (lock.timestamp <= roundCircle.fillDeadlineSec) onTime++;
    const base = lockPunctuality(roundCircle, lock.timestamp);
    standing += conduct.sacrificeShareIds.has(e.id)
      ? base.satDaysCommitted * (1 + EARLY_LOCK_BONUS_MAX)
      : base.standingWeight;
  }
  // THE MAX PENALTY (2026-09-16): collected, then broke the circle —
  // total forfeiture. Standing never goes negative; it can be lost whole.
  // The mark rides beside the zero so it never reads as newcomer.
  if (conduct.brokeAfterCollecting) standing = 0;
  return { completed, onTime, standing,
    ...(conduct.brokeAfterCollecting ? { mark: { brokeAtSec: conduct.brokeAtSec! } } : {}) };
}
