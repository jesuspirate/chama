// Rotation v2 — the pure core (docs/chama-rotation-v2-spec.md).
//
// Everything in this file is a deterministic function of chain-visible
// facts: no clocks read, no state mutated, no relay touched. The CREATE
// gates, the vote law, the watcher and the UI all derive from these few
// functions so that every layer answers every question identically.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { CircleRound, CircleShareLock } from "./types.js";
import { EscrowEventKind, Role, type EscrowState } from "../escrow-engine/types.js";

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

/** THE WEEKLY RACE (spec: Turn order, amended 2026-09-15). Collector for
 *  the circle at roundIndex r = the fastest LOCKer of round r-1 among the
 *  sealed members who have not yet collected this cycle, host pinned to the
 *  final round regardless of speed. Round 1 is the COMMITMENT round (no
 *  collector). Deterministic: round r opens at round r-1's roundEnd, long
 *  after round r-1's fill window closed, so every ranking timestamp is
 *  final on-chain when the collector must be named. Ties break by pubkey.
 *  Null means "no lawful collector", never "anyone". */
export function collectorForRound(
  round1Id: string,
  order: readonly string[],
  hostPubkey: string,
  shares: readonly EscrowState[],
  roundIndex: number,
): string | null {
  if (!Number.isSafeInteger(roundIndex) || roundIndex < 2 || roundIndex > order.length + 1) return null;
  const host = hostPubkey.toLowerCase();
  const hostSeated = order.includes(host) ? host : null;
  const collected = new Set<string>();
  let collector: string | null = null;
  for (let r = 2; r <= roundIndex; r++) {
    if (hostSeated && r === order.length + 1) { collector = collected.has(hostSeated) ? null : hostSeated; break; }
    const prevId = r === 2 ? round1Id.toLowerCase() : roundCircleId(round1Id, r - 1);
    const prevPolicy = r === 2 ? "share-v1" : "share-v2";
    const ranked: { m: string; at: number }[] = [];
    for (const e of shares) {
      if (e.chamaPolicy !== prevPolicy || e.parent?.toLowerCase() !== prevId) continue;
      const lock = e.eventChain.find(ev => ev.kind === EscrowEventKind.LOCK);
      const m = e.participants[Role.BUYER]?.toLowerCase();
      if (!lock || !m || !order.includes(m)) continue;
      ranked.push({ m, at: lock.timestamp });
    }
    ranked.sort((a, b) => a.at - b.at || (a.m < b.m ? -1 : 1));
    collector = ranked.find(x => !collected.has(x.m) && x.m !== hostSeated)?.m ?? null;
    if (!collector) return null;
    collected.add(collector);
  }
  return collector;
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

/** The commitment round's LOCKed seats, derived from raw share escrows —
 *  the one input the rotation needs. Kept here (not wiring.ts) so the pure
 *  gate layer can use it without an import cycle. Only share-v1 children of
 *  round 1 count: the commitment round IS the shipped v1 product. */
export function commitmentLocks(round1CircleId: string, shares: readonly EscrowState[]): CircleShareLock[] {
  const seen = new Set<string>();
  const out: CircleShareLock[] = [];
  for (const e of shares) {
    if (e.chamaPolicy !== "share-v1" || e.parent !== round1CircleId || seen.has(e.id)) continue;
    seen.add(e.id);
    const lock = e.eventChain.find(ev => ev.kind === EscrowEventKind.LOCK);
    if (!lock) continue;
    out.push({ circleId: round1CircleId, memberPubkey: e.participants[Role.BUYER]!,
      escrowId: e.id, lockedAtSec: lock.timestamp, status: "locked", readyToClaim: false });
  }
  return out;
}

/** Everything a rotation round's surface needs, derived from raw states
 *  (no policy import — this stays the dependency floor). Works for the
 *  commitment round too (roundIndex 1): collector null, queue provisional.
 *  Null when the chain back to round 1 is not in view. */
export interface RotationView {
  round1Id: string;
  order: string[];
  totalRounds: number;
  /** This round's collector (null for the commitment round). */
  collector: string | null;
  /** Provisional collectors for the remaining rounds, computed from locks
   *  so far — the LIVE standings; entries go null where no race has run. */
  queue: { roundIndex: number; collector: string | null }[];
}

export function rotationView(states: readonly EscrowState[], circleId: string, roundIndex: number, prevCircleId: string | null): RotationView | null {
  const byId = new Map(states.map(s => [s.id, s]));
  let round1Id: string | null = roundIndex === 1 ? circleId : null;
  let cursor = prevCircleId;
  for (let hops = 0; round1Id === null && cursor && hops < 64; hops++) {
    const state = byId.get(cursor);
    if (!state?.chamaCircle) return null;
    if (state.chamaCircle.roundIndex === 1) { round1Id = state.id; break; }
    cursor = state.chamaCircle.prevCircleId;
  }
  if (!round1Id) return null;
  const round1 = byId.get(round1Id);
  if (!round1) return null;
  const host = round1.initiator.pubkey;
  const order = rotationOrder({ circleId: round1Id, creatorPubkey: host }, commitmentLocks(round1Id, states));
  const totalRounds = order.length + 1;
  const collector = roundIndex >= 2 ? collectorForRound(round1Id, order, host, states, roundIndex) : null;
  const queue: { roundIndex: number; collector: string | null }[] = [];
  for (let k = Math.max(2, roundIndex + 1); k <= totalRounds; k++) {
    queue.push({ roundIndex: k, collector: collectorForRound(round1Id, order, host, states, k) });
  }
  return { round1Id, order, totalRounds, collector, queue };
}
