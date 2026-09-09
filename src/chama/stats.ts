import type { EscrowState } from "../escrow-engine/types.js";
import { circleFromEscrow } from "./policy.js";
import { sharesForCircle } from "./wiring.js";
import { circleProgress, lockPunctuality } from "./circle.js";

/** Counts only observed successful member rounds, never host-only rounds. */
export function circleMemberStats(escrows: Iterable<EscrowState>, pubkey: string, nowSec: number) {
  const all = [...escrows], shares = sharesForCircle(all);
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
  return { completed, onTime, standing };
}
