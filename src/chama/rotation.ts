// Rotation v2 — the pure core (docs/chama-rotation-v2-spec.md).
//
// Everything in this file is a deterministic function of chain-visible
// facts: no clocks read, no state mutated, no relay touched. The CREATE
// gates, the vote law, the watcher and the UI all derive from these few
// functions so that every layer answers every question identically.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { CircleRound, CircleShareLock } from "./types.js";

/** How long the collector has after roundEndSec to claim the pot before
 *  REFUND becomes the only lawful outcome again (decision 1, sealed
 *  2026-09-15: 7 days; tighten only if it proves a risk). */
export const COLLECT_WINDOW_SEC = 7 * 86_400;

/** Deterministic id for round r (r ≥ 2) of the cycle anchored at round 1.
 *  Anyone can therefore publish the next round's CREATE (no host liveness
 *  dependency) and duplicates are structurally impossible. Round 1's id is
 *  its ordinary escrow id. */
export function roundCircleId(round1CircleId: string, roundIndex: number): string {
  if (!Number.isSafeInteger(roundIndex) || roundIndex < 2) throw new Error("Chained round ids start at round 2");
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(["chama-round-v2", round1CircleId.toLowerCase(), roundIndex]))));
}

/** The rotation: round-1 LOCK order, host pinned last (decisions sealed
 *  2026-09-15 — hosts lock last, hosts collect last). Ties on lock time
 *  break by pubkey so every client derives the identical order. Only
 *  LOCKED round-1 shares seat the rotation; reserved seats never count. */
export function rotationOrder(circle: Pick<CircleRound, "circleId" | "creatorPubkey">, round1Locks: readonly CircleShareLock[]): string[] {
  const host = circle.creatorPubkey.toLowerCase();
  const seen = new Set<string>();
  const members = round1Locks
    .filter(l => l.circleId === circle.circleId && l.lockedAtSec !== null && l.status !== "reserved")
    .map(l => ({ pubkey: l.memberPubkey.toLowerCase(), at: l.lockedAtSec! }))
    .filter(m => { if (seen.has(m.pubkey)) return false; seen.add(m.pubkey); return true; })
    .sort((a, b) => a.at - b.at || (a.pubkey < b.pubkey ? -1 : 1));
  const order = members.filter(m => m.pubkey !== host).map(m => m.pubkey);
  if (seen.has(host)) order.push(host);
  return order;
}

/** Collector for round r (1-based) of a sealed rotation. Null when the
 *  cycle has no such round — callers treat that as "no lawful collector",
 *  never as "anyone". */
export function collectorForRound(order: readonly string[], roundIndex: number): string | null {
  if (!Number.isSafeInteger(roundIndex) || roundIndex < 1 || roundIndex > order.length) return null;
  return order[roundIndex - 1] ?? null;
}

/** THE DETERMINISTIC-OUTCOME LAW (spec §what replaces REFUND-only).
 *  At every moment, fill evidence + the clock admit exactly one lawful
 *  outcome for a share-v2 escrow. No seat ever exercises discretion.
 *
 *  Inputs are counts, not states, so every layer — reducer, parser gate,
 *  watcher, UI — asks the identical question. lockedCount counts LOCKed
 *  shares among the round's expected N-1; expectedCount = members - 1
 *  (the collector sits out, decision 2). */
export type RoundOutcome = "none" | "refund" | "release";
export function roundOutcomeAt(
  round: Pick<CircleRound, "fillDeadlineSec" | "roundEndSec">,
  lockedCount: number,
  expectedCount: number,
  nowSec: number,
): RoundOutcome {
  const filled = lockedCount >= expectedCount && expectedCount > 0;
  // Funding window: nothing resolves while seats can still lock — unless
  // the round is already impossible to fail (filled), in which case the
  // only thing time can do is bring the payday closer.
  if (nowSec < round.fillDeadlineSec && !filled) return "none";
  if (!filled) return "refund";
  if (nowSec < round.roundEndSec) return "none";
  if (nowSec < round.roundEndSec + COLLECT_WINDOW_SEC) return "release";
  // Collector never claimed: notes must not rot because one person vanished.
  return "refund";
}
