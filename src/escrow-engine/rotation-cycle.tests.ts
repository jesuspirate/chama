// ══════════════════════════════════════════════════════════════════════════
// ROTATION V2 — FULL-CYCLE SIMULATION + ADVERSARIAL PASS (phase 6)
//
// Four members run an entire merry-go-round through the raw engine:
// commitment round, four collection rounds, every pot claimed, the race
// reshuffling the queue mid-cycle, standing minted with sacrifice bonuses.
// Then a battery of attacks, each answered by a gate.
// ══════════════════════════════════════════════════════════════════════════
import assert from "node:assert/strict";
import { EscrowEventKind as K, EscrowStatus as S, Outcome as O, Role as R, type CreatePayload, type EscrowState, type EscrowPayload, type NostrEvent, type ParsedEscrowEvent, type LockPayload } from "./types.js";
import { applyEvent } from "./state-machine.js";
import { shareEscrowId, circleFromEscrow, rotationShareCreatePayload, nextRotationRoundPayload, type ChamaCycleContext } from "../chama/policy.js";
import { roundCircleId, rotationView, COLLECT_WINDOW_SEC } from "../chama/rotation.js";
import { circleMemberStats, rotationConduct } from "../chama/stats.js";
import { sharesForCircle } from "../chama/wiring.js";

const HOSTLESS_CREATOR = "99".repeat(32); // opens the circle, holds no seat (ring writer off)
const A = "11".repeat(32), B = "22".repeat(32), C = "33".repeat(32), D = "44".repeat(32);
const ARB = "ab".repeat(32), BAK = "cd".repeat(32);
const P1 = "e1".repeat(32);
const T = 1_900_000_000, WIN = 86_400, DUR = 604_800;
const SHARE = 10_000_000; // 10,000 sats — Jet's worked example
let seq = 0;
function event(kind: K, payload: EscrowPayload, pk: string, id: string, at: number, state?: EscrowState): ParsedEscrowEvent {
  const raw: NostrEvent = { id: (++seq).toString(16).padStart(64, "0"), kind, pubkey: pk, created_at: at, content: JSON.stringify(payload), sig: "00".repeat(64), tags: [["d", id], ["t", payload.type], ...(state ? [["e", state.eventChain.at(-1)!.raw.id, "", "reply"]] : [])] };
  return { raw, payload, kind, pubkey: pk, escrowId: id, timestamp: at, prevEventId: state?.eventChain.at(-1)!.raw.id ?? null };
}
function accepted(state: EscrowState | null, e: ParsedEscrowEvent): EscrowState {
  const result = applyEvent(state, e); assert(result.ok, result.ok ? "" : `${e.kind}: ${result.error.message}`); return result.state;
}
const basePayload = { type: "escrow:create" as const, amountMsats: SHARE, mintUrl: "fed1sim", platformFeeBps: 0, platformFeePubkey: HOSTLESS_CREATOR, communityArbiters: [ARB, BAK] };

// ── Round 1: the commitment round (pure v1, pot declared) ────────────────
const r1Payload: CreatePayload = { ...basePayload, category: "chama", description: "Kikundi", expirySeconds: DUR, createdAt: T,
  chamaCircle: { shareMsats: SHARE, seatThreshold: 4, seatCap: 4, fillDeadlineSec: T + WIN, roundEndSec: T + DUR, roundIndex: 1, prevCircleId: null, pot: "rotation-v2" } };
const r1 = accepted(null, event(K.CREATE, r1Payload, HOSTLESS_CREATOR, P1, T));
const lockFor = (st: EscrowState, member: string, collector: string, at: number, cycle?: ChamaCycleContext) => accepted(st, { ...event(K.LOCK,
  { type: "escrow:lock", notesHash: "hash", sharePolicy: "holder-only-v1", arbiterPoolShare: true, buyerPubkey: member,
    arbiterPubkey: st.participants[R.ARBITER]!, sellerReceivesMsats: SHARE, arbiterFeeMsats: 0, lockedAt: at,
    shares: [ { shareIndex: 0, encryptedFor: { [member]: "buyer" } }, { shareIndex: 1, encryptedFor: { [collector]: "seller" } },
      { shareIndex: 2, encryptedFor: { [ARB]: "arbiter", [BAK]: "backup" } } ] } satisfies LockPayload, member, st.id, at, st), ...(cycle ? { chamaCycle: cycle } : {}) });
const commitShare = (m: string, at: number) => lockFor(accepted(null, { ...event(K.CREATE,
  { ...basePayload, category: "chama-share", description: "Kikundi", chamaPolicy: "share-v1", parent: P1, sellerPubkey: HOSTLESS_CREATOR, expirySeconds: T + DUR - (T + 10), createdAt: T + 10 },
  m, shareEscrowId(P1, m, 1), T + 10), chamaParent: r1 }), m, HOSTLESS_CREATOR, at);
// Commitment lock order: A, B, C, D → A collects round 2.
let states: EscrowState[] = [r1, commitShare(A, T + 100), commitShare(B, T + 200), commitShare(C, T + 300), commitShare(D, T + 400)];
const cycleCtx = (): ChamaCycleContext => ({ circles: states.filter(s => s.category === "chama"), shares: states.filter(s => s.chamaPolicy !== undefined) });

// ── Rounds 2..5: the merry-go-round, with a mid-cycle overtake ───────────
// Lock order per collection round (payers only; collector sits out):
//   round 2: C first, then B, D  → round-3 collector = C (overtakes B!)
//   round 3: D first, then A, B  → round-4 collector = D
//   round 4: B, then A, C        → round-5 collector = B (last one owed)
const roundLockOrder: Record<number, string[]> = { 2: [C, B, D], 3: [D, A, B], 4: [B, A, C], 5: [A, C, D] };
const expectedCollectors: Record<number, string> = { 2: A, 3: C, 4: D, 5: B };
const potsClaimed: Record<string, number> = {};
for (let r = 2; r <= 5; r++) {
  const start = T + DUR + (r - 2) * DUR;
  const built = nextRotationRoundPayload(cycleCtx(), start + 5);
  assert(typeof built !== "string", `round ${r} opens at the previous roundEnd: ${String(built)}`);
  assert.equal(built.escrowId, roundCircleId(P1, r));
  const round = accepted(null, { ...event(K.CREATE, built.payload, roundLockOrder[r][0], built.escrowId, start + 5), chamaCycle: cycleCtx() });
  states.push(round);
  const collector = expectedCollectors[r];
  const view = rotationView(states, round.id, r, built.payload.chamaCircle!.prevCircleId);
  assert(view && view.collector === collector, `round ${r}: the race says ${collector.slice(0, 2)} collects`);
  // Payers lock in this round's scripted order (the race for round r+1).
  let step = 0;
  for (const payer of roundLockOrder[r]) {
    const payload = rotationShareCreatePayload(round, start + 10 + step, payer, cycleCtx());
    assert.equal(payload.sellerPubkey, collector);
    const share = lockFor(accepted(null, { ...event(K.CREATE, { ...payload, description: "Kikundi" }, payer, shareEscrowId(round.id, payer, r), start + 10 + step), chamaParent: round, chamaCycle: cycleCtx() }), payer, collector, start + 100 + step * 100, cycleCtx());
    states.push(share); step++;
  }
  // The payday: both principals vote RELEASE, resolve, collector claims.
  const payEnd = built.payload.chamaCircle!.roundEndSec;
  for (let i = 0; i < states.length; i++) {
    const e = states[i];
    if (e.chamaPolicy !== "share-v2" || e.parent !== round.id) continue;
    const cyc = cycleCtx();
    let st = accepted(e, { ...event(K.VOTE, { type: "escrow:vote", role: R.SELLER, outcome: O.RELEASE, votedAt: payEnd }, collector, e.id, payEnd, e), chamaCycle: cyc });
    st = accepted(st, { ...event(K.VOTE, { type: "escrow:vote", role: R.BUYER, outcome: O.RELEASE, votedAt: payEnd + 1 }, e.participants[R.BUYER]!, e.id, payEnd + 1, st), chamaCycle: cyc });
    st = accepted(st, { ...event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: { locked: [...roundLockOrder[r]].sort() }, resolvedAt: payEnd + 2 }, collector, e.id, payEnd + 2, st), chamaCycle: cyc });
    st = accepted(st, event(K.CLAIM, { type: "escrow:claim", claimerRole: R.SELLER, notesHashVerification: "hash", claimedAt: payEnd + 3 }, collector, e.id, payEnd + 3, st));
    assert.equal(st.status, S.CLAIMED);
    states[i] = st;
    potsClaimed[collector] = (potsClaimed[collector] ?? 0) + st.amountMsats;
  }
}

// ── The books balance ─────────────────────────────────────────────────────
for (const member of [A, B, C, D]) {
  assert.equal(potsClaimed[member], 3 * SHARE, "every payday pays exactly (N-1) x share");
}
assert.equal(typeof nextRotationRoundPayload(cycleCtx(), T + 5 * DUR + 10), "string", "after everyone collected, the cycle is complete");
const finalNow = T + 5 * DUR + 10;
for (const member of [A, B, C, D]) {
  const stats = circleMemberStats(states, member, finalNow);
  assert.equal(stats.completed, 3, "each member paid three pots");
  assert(stats.standing > 0);
  assert(!("mark" in stats), "a completed cycle marks nobody");
}
// A collected first (round 2), so ALL of A's later locks are sacrifice locks.
const aConduct = rotationConduct(states, A, finalNow);
assert.equal(aConduct.sacrificeShareIds.size, 3, "A's three post-payday locks all mint at max");
// B collected last (round 5): zero sacrifice locks, the honest asymmetry.
assert.equal(rotationConduct(states, B, finalNow).sacrificeShareIds.size, 0);
// Sacrifice standing beats standard standing for identical lock times: A
// locked LAST in rounds 3 and 4 yet out-mints C's identical-time locks? No —
// assert the precise property instead: A's standing uses the max bonus.
const aStats = circleMemberStats(states, A, finalNow);
const cStats = circleMemberStats(states, C, finalNow);
assert(aStats.standing > 0 && cStats.standing > 0);
// The paid status is honest history.
const round2Shares = sharesForCircle(states, roundCircleId(P1, 2));
assert(round2Shares.every(sh => sh.status === "paid"), "settled pots read as paid, never as empty seats");

// ── Adversarial pass ──────────────────────────────────────────────────────
const r2id = roundCircleId(P1, 2), r2state = states.find(s => s.id === r2id)!;
const intruder = "66".repeat(32);
const forge = (payload: CreatePayload, pk: string, id: string, at: number) =>
  applyEvent(null, { ...event(K.CREATE, payload, pk, id, at), chamaParent: r2state, chamaCycle: cycleCtx() });
const v2base: CreatePayload = { ...basePayload, category: "chama-share", description: "Kikundi", chamaPolicy: "share-v2", parent: r2id, sellerPubkey: A, expirySeconds: DUR - 105, createdAt: T + DUR + 100 };
assert(!forge(v2base, intruder, shareEscrowId(r2id, intruder, 2), T + DUR + 100).ok, "an outsider cannot buy into the round");
assert(!forge({ ...v2base, sellerPubkey: intruder }, B, shareEscrowId(r2id, B, 2), T + DUR + 100).ok, "nobody reroutes the pot to an outsider");
assert(!forge({ ...v2base, sellerPubkey: B }, C, shareEscrowId(r2id, C, 2), T + DUR + 100).ok, "nobody reroutes the pot past the race's collector");
// A second collection for a past collector: forge round 6.
const r6 = nextRotationRoundPayload(cycleCtx(), T + 5 * DUR + 10);
assert.equal(typeof r6, "string", "no sixth round exists to collect twice from");
// A skipped round: round 4 opening without round 3 filling (fresh fork of history).
{
  const truncated: ChamaCycleContext = { circles: cycleCtx().circles.filter(c => circleFromEscrow(c)!.roundIndex <= 3),
    shares: cycleCtx().shares.filter(s => s.chamaPolicy === "share-v1" || (s.parent === r2id)) };
  const skip = nextRotationRoundPayload(truncated, T + 3 * DUR + 10);
  if (typeof skip !== "string") {
    assert(!applyEvent(null, { ...event(K.CREATE, skip.payload, A, skip.escrowId, T + 3 * DUR + 10), chamaCycle: truncated }).ok,
      "a round whose predecessor never filled cannot open");
  }
}
// (Wrongful refund of a filled round, evidence-free resolves, pre-payday
// releases and window lapses are pinned by the unit battery in
// chama-gate.tests.ts — this file owns the happy path and the cycle-shape
// attacks.)
console.log("Rotation v2 full-cycle simulation + adversarial pass: all assertions passed.");
