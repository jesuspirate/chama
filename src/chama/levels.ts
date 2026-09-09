// ══════════════════════════════════════════════════════════════════════════
// Chama — the five tiers, and who may open what (Jet's ruling, 2026-09-07)
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ THE TWO-LAYER DESIGN. Coarse LEVELS gate capabilities; the continuous
// standingWeight (circle.ts) orders collection. Levels answer "may you?",
// weight answers "when do you?". Both derive from the same chain facts —
// completed circles and sat-days committed — so neither can be bought.
//
// THE GATE SITS ON ROTATION, NOT ON v1 CIRCLES — deliberately. A v1
// commitment pool has no collector: everyone takes back their own exact
// sats, so creating one is riskless and stays open to EVERYONE. That
// openness is the ladder — gating all creation at level 3 would deadlock
// the cold start (circles need creators need participations need circles).
// Opening a ROTATING chama, where members extend real credit to early
// collectors, is the graduation that requires three completed circles.
//
// WHO COLLECTS FIRST is therefore never "the creator, by right": rotation
// order is standing weight, descending — the reward-and-penalty surface
// already locked in the brief. The creator's power is setting the terms;
// the queue position is earned like everyone else's. Self-securing end to
// end: the most trusted extend the most patience, the least trusted collect
// last, where they can harm no one.

/** Completed-circle floors for each level, index = level - 1. A "completed
 *  circle" is a round that reached `complete` with this member's share
 *  locked — refunded circles count for NOTHING and cost NOTHING. */
export const LEVEL_FLOORS = [0, 1, 3, 6, 12] as const;

export type ChamaLevel = 1 | 2 | 3 | 4 | 5;

/** Kiswahili tier names — the identity is the point. */
export const LEVEL_NAMES: Record<ChamaLevel, string> = {
  1: "Mgeni",        // the guest: welcome, watched, unproven
  2: "Mwanachama",   // the member: one circle kept
  3: "Mwenyeji",     // the host: may open a rotating chama
  4: "Mzee",         // the elder: standing that steadies circles
  5: "Bosi Mkubwa",  // the big boss himself
};

/** May open a ROTATING chama (turns to collect) at this level and above. */
export const ROTATION_CREATOR_MIN_LEVEL: ChamaLevel = 3;

export function levelFor(completedCircles: number): ChamaLevel {
  const done = Math.max(0, Math.floor(completedCircles));
  let level: ChamaLevel = 1;
  for (let i = LEVEL_FLOORS.length - 1; i >= 0; i--) {
    if (done >= LEVEL_FLOORS[i]) { level = (i + 1) as ChamaLevel; break; }
  }
  return level;
}

/** Circles still needed to reach the next level (0 at the top). */
export function circlesToNextLevel(completedCircles: number): number {
  const level = levelFor(completedCircles);
  if (level >= 5) return 0;
  const nextFloor: number = LEVEL_FLOORS[level as 1 | 2 | 3 | 4];
  return nextFloor - Math.max(0, Math.floor(completedCircles));
}

/** The rotation-creation gate: three completed circles, in anyone's chamas,
 *  all combined. v1 circle creation deliberately does NOT call this. */
export function canOpenRotatingChama(completedCircles: number): boolean {
  return levelFor(completedCircles) >= ROTATION_CREATOR_MIN_LEVEL;
}

/** Deterministic collection order for a rotating round: standing weight
 *  descending; ties break by earlier lock (punctuality again), then by
 *  pubkey so every client derives the IDENTICAL queue with zero protocol.
 *  The creator appears wherever their standing puts them — no crown here. */
export function rotationOrder(
  members: readonly {
    memberPubkey: string;
    standingWeight: number;
    lockedAtSec: number;
  }[],
): string[] {
  return [...members]
    .sort((a, b) =>
      b.standingWeight - a.standingWeight
      || a.lockedAtSec - b.lockedAtSec
      || a.memberPubkey.localeCompare(b.memberPubkey))
    .map(m => m.memberPubkey);
}
