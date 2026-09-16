import { pickPreferredArbiter } from "../arbiters/pool.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { validateCircleRound } from "./circle.js";
import type { CircleRound, CircleShareLock } from "./types.js";
import { CHAMA_RING_WRITER_ENABLED } from "../escrow-engine/experimental-escrow-features.js";
import { collectorForRound, commitmentLocks, rotationOrder, roundCircleId, roundOutcomeAt } from "./rotation.js";
import { EscrowEventKind, EscrowStatus, Outcome, Role, type CreatePayload, type EscrowState } from "../escrow-engine/types.js";

export function shareEscrowId(circleId: string, memberPubkey: string, roundIndex: number): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(["chama-share-v1", circleId, memberPubkey.toLowerCase(), roundIndex]))));
}

export function circleFromEscrow(state: EscrowState): CircleRound | null {
  if (state.category !== "chama" || !state.chamaCircle) return null;
  return { ...state.chamaCircle, version: 1, circleId: state.id,
    creatorPubkey: state.initiator.pubkey, community: state.community ?? "",
    mintUrl: state.mintUrl, name: state.description, createdAt: state.createdAt };
}

export interface ChamaCycleContext { circles: EscrowState[]; shares: EscrowState[] }

/** Derive the sealed rotation from locally resolved cycle context. Returns
 *  an error string, or the round-1 anchor + the rotation order. Everything
 *  downstream (round ids, collectors, seats) hangs off this one derivation,
 *  so every layer answers identically. */
export function rotationFromCycle(cycle: ChamaCycleContext, proves?: { id: string; roundIndex: number }): { round1Id: string; round1: CircleRound; order: string[] } | string {
  let firstError: string | null = null;
  for (const state of cycle.circles) {
    const c = circleFromEscrow(state);
    if (!c || c.roundIndex !== 1 || c.pot !== "rotation-v2" || validateCircleRound(c).length) continue;
    // When validating a specific round, only the anchor whose deterministic
    // chain PRODUCES that round id may speak for it — a context that happens
    // to contain some other cycle's round 1 must not decide this one
    // (review finding 7: first-match made accept/reject relay-order-dependent).
    if (proves && proves.roundIndex >= 2 && roundCircleId(state.id, proves.roundIndex) !== proves.id) continue;
    const order = rotationOrder({ circleId: state.id, creatorPubkey: c.creatorPubkey }, commitmentLocks(state.id, cycle.shares));
    if (order.length < 3) { firstError = "A rotation needs at least three sealed members"; continue; }
    if (order.length < c.seatThreshold) { firstError = "The commitment round did not fill"; continue; }
    return { round1Id: state.id, round1: c, order };
  }
  return firstError ?? "Rotation cycle context must include a lawful round 1";
}

/** The chained-round law (spec: One cycle = a commitment round + N
 *  collection rounds). Deterministic ids, schedule anchoring, sealed terms,
 *  and previous-round fill — all from locally resolved context. */
function chainedRoundError(c: CircleRound, id: string, pubkey: string, at: number, cycle?: ChamaCycleContext): string | null {
  if (!cycle) return "A rotation round requires cycle context";
  const rot = rotationFromCycle(cycle, { id, roundIndex: c.roundIndex });
  if (typeof rot === "string") return rot;
  const { round1Id, round1, order } = rot;
  if (id !== roundCircleId(round1Id, c.roundIndex)) return "Rotation round id must be deterministic";
  if (c.prevCircleId !== (c.roundIndex === 2 ? round1Id : roundCircleId(round1Id, c.roundIndex - 1))) return "Rotation round must chain to the previous round";
  if (c.roundIndex > order.length + 1) return "No round beyond the rotation";
  if (!order.includes(pubkey.toLowerCase())) return "Only a sealed member can open a rotation round";
  if (c.shareMsats !== round1.shareMsats || c.community !== round1.community || c.mintUrl !== round1.mintUrl) return "Rotation rounds must keep the cycle terms";
  if (c.seatThreshold !== order.length - 1 || c.seatCap !== order.length - 1) return "Rotation round seats must equal the sealed members minus the collector";
  if (c.unlisted !== true) return "Rotation rounds are members-only";
  const duration = round1.roundEndSec - round1.createdAt;
  const fillWindow = round1.fillDeadlineSec - round1.createdAt;
  const start = round1.roundEndSec + (c.roundIndex - 2) * duration;
  if (c.fillDeadlineSec !== start + fillWindow || c.roundEndSec !== start + duration) return "Rotation rounds keep the cycle schedule";
  if (at < start) return "A rotation round cannot open before the previous round ends";
  if (at >= c.fillDeadlineSec) return "This rotation round's fill window has passed";
  if (c.roundIndex > 2) {
    const prevId = roundCircleId(round1Id, c.roundIndex - 1);
    const prevCollector = collectorForRound(round1Id, order, round1.creatorPubkey, cycle.shares, c.roundIndex - 1);
    if (!prevCollector) return "The previous round has no lawful collector";
    const lockedMembers = new Set(cycle.shares
      .filter(e => e.chamaPolicy === "share-v2" && e.parent === prevId && e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK))
      .map(e => e.participants[Role.BUYER]!.toLowerCase()));
    if (!order.every(m => m === prevCollector || lockedMembers.has(m))) return "The previous round did not fill";
  }
  return null;
}

/** Shared parser/reducer gate. Cross-chain context must come from a replayed parent. */
export function chamaCreateError(p: CreatePayload, id: string, pubkey: string, at: number, parent?: EscrowState, witness?: EscrowState, cycle?: ChamaCycleContext): string | null {
  if (p.category !== "chama" && p.category !== "chama-share" && p.chamaPolicy === undefined && p.chamaCircle === undefined) return null;
  for (const pool of [p.communityArbiters, p.bondedArbiters]) {
    if (pool !== undefined && (!Array.isArray(pool) || !pool.every(pk => typeof pk === "string" && /^[0-9a-f]{64}$/.test(pk)))) return "Invalid circle arbiter pool";
  }
  if (p.bondedArbiters?.some(pk => !p.communityArbiters?.includes(pk))) return "Bonded arbiters must belong to the circle pool";
  if (p.createdAt !== at || !Number.isSafeInteger(at)) return "CREATE timestamp mismatch";
  if (p.escrowMode !== undefined && p.escrowMode !== "ecash") return "Circles and shares require ecash";
  for (const key of ["tranche", "trancheChild", "sliceCount", "settlementPolicy", "items", "stock", "claimedQuantity", "subscription", "amountRange", "minAmountMsats", "maxAmountMsats"] as const) {
    if ((p as unknown as Record<string, unknown>)[key] !== undefined) return `Chama forbids ${key}`;
  }
  if (p.category === "chama") {
    if (!p.chamaCircle || p.chamaPolicy !== undefined || p.parent !== undefined) return "Invalid circle parent shape";
    const c: CircleRound = { ...p.chamaCircle, version: 1, circleId: id, creatorPubkey: pubkey,
      community: p.community ?? "", mintUrl: p.mintUrl, name: p.description, createdAt: at };
    const errors = validateCircleRound(c);
    if (errors.length) return errors.join("; ");
    if (at + p.expirySeconds !== c.roundEndSec) return "Circle expiry must equal round end";
    if (c.pot !== undefined && c.pot !== "rotation-v2") return "Unknown circle pot policy";
    if (c.pot === "rotation-v2") {
      // The custody floor for the whole cycle, judged at ROUND 1 where the
      // terms are set (a seconds-long "cycle" is a standing-farming machine,
      // never a savings circle — review finding 10). Chained rounds inherit
      // the schedule structurally, and a late-but-in-window publication of
      // one must not be rejected for its shrunken remaining window.
      if (c.roundIndex === 1 && (c.fillDeadlineSec - at < 3600 || c.roundEndSec - c.fillDeadlineSec < 3600)) return "Pot circles need at least an hour to fill and an hour to run";
      if (c.roundIndex > 1) {
        const chainError = chainedRoundError(c, id, pubkey, at, cycle);
        if (chainError) return chainError;
        // …and the ARBITER POOL + FEDERATION pinned to round 1 (review
        // finding 1, CRITICAL): the third SSS key of every share seats from
        // this pool, so an unpinned pool would let whoever publishes the
        // round CREATE choose who holds the third key to everyone's sats.
        const rot = rotationFromCycle(cycle!, { id, roundIndex: c.roundIndex });
        if (typeof rot === "string") return rot;
        const round1State = cycle!.circles.find(st => st.id === rot.round1Id)!;
        const original = round1State.eventChain[0].payload as CreatePayload;
        if (JSON.stringify(p.communityArbiters ?? []) !== JSON.stringify(round1State.communityArbiters)
          || JSON.stringify(p.bondedArbiters ?? []) !== JSON.stringify(round1State.bondedArbiters ?? [])) return "Rotation rounds must keep the cycle's arbiter pool";
        if (p.fed !== original.fed || p.fedPrefix !== original.fedPrefix) return "Rotation rounds must keep the cycle's federation";
      }
    }
    return null;
  }
  if (p.category !== "chama-share" || (p.chamaPolicy !== "share-v1" && p.chamaPolicy !== "share-v2") || p.chamaCircle !== undefined) return "Invalid share policy/category";
  const circle = parent && circleFromEscrow(parent);
  if (!parent || !circle || validateCircleRound(circle).length || p.parent !== parent.id) return "A validated circle parent is required";
  if (p.amountMsats !== circle.shareMsats) return "Share amount must equal circle share amount";
  if (at < circle.createdAt || at >= circle.fillDeadlineSec || at + p.expirySeconds !== circle.roundEndSec) return "Share must use the circle's fixed deadlines";
  if (id !== shareEscrowId(parent.id, pubkey, circle.roundIndex)) return "Share id must be deterministic";
  if (!/^[0-9a-f]{64}$/.test(pubkey) || typeof p.sellerPubkey !== "string" || !/^[0-9a-f]{64}$/.test(p.sellerPubkey) || pubkey === p.sellerPubkey) return "Share must seat distinct member and witness";
  const rotationRound = circle.pot === "rotation-v2" && circle.roundIndex >= 2;
  if (rotationRound && p.chamaPolicy !== "share-v2") return "Rotation rounds require share-v2";
  if (!rotationRound && p.chamaPolicy === "share-v2") return "share-v2 requires a rotation round parent";
  if (p.chamaPolicy === "share-v2") {
    // Rotation share: the seller seat is the round's collector — derived
    // from the chain, never trusted from the payload (spec: engine delta 1).
    if (!cycle) return "A rotation share requires cycle context";
    const rot = rotationFromCycle(cycle, { id: parent.id, roundIndex: circle.roundIndex });
    if (typeof rot === "string") return rot;
    if (parent.id !== roundCircleId(rot.round1Id, circle.roundIndex)) return "Rotation share must sit in its cycle's round";
    const collector = collectorForRound(rot.round1Id, rot.order, rot.round1.creatorPubkey, cycle.shares, circle.roundIndex);
    if (!collector || p.sellerPubkey !== collector) return "Rotation share must pay the round's collector";
    if (!rot.order.includes(pubkey.toLowerCase())) return "Only sealed members lock rotation shares";
  } else if (p.sellerPubkey !== circle.creatorPubkey) {
    // v1.1 ring share (host-seat spec, task 1: readers first, writers later).
    // A non-creator witness is legal only when they are a MEMBER whose own
    // share in this circle locked before this share was created — proven by
    // the witness escrow at its deterministic id. This keeps the invariant
    // the old member≠creator law protected: nobody holds two SSS keys to any
    // escrow, and every witness is themselves locked into the same round.
    if (!witness) return "Ring witness share is required";
    if (witness.id !== shareEscrowId(parent.id, p.sellerPubkey, circle.roundIndex)) return "Ring witness share id mismatch";
    if (witness.chamaPolicy !== "share-v1" || witness.parent !== parent.id) return "Ring witness must hold a share in this circle";
    if (witness.participants[Role.BUYER] !== p.sellerPubkey) return "Ring witness must own their share";
    const witnessLock = witness.eventChain.find(e => e.kind === EscrowEventKind.LOCK);
    if (!witnessLock || witnessLock.timestamp > at) return "Ring witness must lock before witnessing";
  }
  if (p.mintUrl !== parent.mintUrl || (p.community ?? null) !== parent.community || p.fed !== (parent.eventChain[0].payload as CreatePayload).fed || p.fedPrefix !== (parent.eventChain[0].payload as CreatePayload).fedPrefix) return "Share federation/community must match parent";
  if (JSON.stringify(p.communityArbiters ?? []) !== JSON.stringify(parent.communityArbiters) || JSON.stringify(p.bondedArbiters ?? []) !== JSON.stringify(parent.bondedArbiters ?? [])) return "Share arbiter pool must match parent";
  if (!pickPreferredArbiter(p.communityArbiters ?? [], p.bondedArbiters ?? [], id, [pubkey, p.sellerPubkey!])) return "Share requires a distinct pool arbiter";
  if (p.platformFeeBps !== 0 || (p.arbiterFeeMsats ?? 0) !== 0) return "Shares return the full amount without fees";
  return null;
}

/** THE DETERMINISTIC-OUTCOME LAW at the vote/resolve layer
 *  (docs/chama-rotation-v2-spec.md). share-v1 keeps REFUND-only, forever.
 *  share-v2 admits exactly one outcome from fill evidence + the clock:
 *  refund before/after a failed fill or a lapsed collect window, release
 *  to the collector from roundEnd after a successful fill.
 *
 *  Context rules (mirrors the CREATE gates' locally-resolved-context
 *  doctrine — honest clients converge because loadEscrow resolves the
 *  cycle exactly as it resolves parents):
 *  - RELEASE always requires cycle context proving the payday. No
 *    evidence, no release — the conservative side is REFUND, never
 *    RELEASE.
 *  - A lone REFUND VOTE is recordable without context (it cannot resolve
 *    alone, and the second voter or arbiter carries evidence).
 *  - RESOLVE requires context for BOTH outcomes: finalization is never
 *    evidence-free. */
/** How the caller relates to the event: OBSERVING someone else's signed
 *  principal vote during replay (recorded context-free so every client
 *  converges on the same chain — review finding 6), forming an INTENT to
 *  cast one (strict: never sign what the evidence cannot justify), or
 *  FINALIZING a resolution (strict both outcomes, and the payout target is
 *  re-checked — review finding 4). Arbiter votes are strict even when
 *  observed: their key share moves other people's money. */
export type OutcomeJudgment = "observe-principal" | "observe-arbiter" | "intent" | "finalize";

export function chamaOutcomeError(state: EscrowState, outcome: Outcome, at: number, cycle?: ChamaCycleContext, judgment: OutcomeJudgment = "intent", evidence?: { locked: string[] }): string | null {
  if (!state.chamaPolicy) return null;
  if (state.chamaPolicy === "share-v1") return outcome === Outcome.REFUND ? null : "Shares only allow REFUND";
  if (outcome !== Outcome.REFUND && outcome !== Outcome.RELEASE) return "Rotation shares allow REFUND or RELEASE only";
  // A principal's own signed vote is CHAIN, not judgment: both principals
  // may record either outcome (a lone vote moves nothing, and a buyer
  // handing their own key share to the collector early is the spec's
  // accepted victimless case), so acceptance never depends on the
  // observer's view and honest clients converge.
  if (judgment === "observe-principal") return null;
  const circle = state.chamaCircle!;
  if (judgment === "observe-arbiter" || judgment === "finalize") {
    // THE COMMITMENT (evidence-committed RESOLVE, spec bound 2, RESOLVED):
    // arbiter votes and every resolution carry the fill evidence they
    // settled on, and every replay judges THAT — never the replayer's own
    // relay view. Withholding a lock can no longer fork honest clients:
    // the settlement's meaning travels with the settlement. Fabricated
    // evidence is 2-of-3 signed and attributable, moves only money a
    // consenting principal's vote already offered, and is cross-checked
    // against the sealed membership whenever the observer holds the cycle.
    if (!evidence || !Array.isArray(evidence.locked)) return "Rotation share resolution must commit its fill evidence";
    const entries = evidence.locked.map(m => typeof m === "string" ? m.toLowerCase() : "");
    if (entries.length > 128 || entries.some(m => !/^[0-9a-f]{64}$/.test(m)) || new Set(entries).size !== entries.length) return "Malformed fill evidence";
    if (cycle) {
      const rot = rotationFromCycle(cycle, state.parent ? { id: state.parent, roundIndex: circle.roundIndex } : undefined);
      if (typeof rot !== "string") {
        const collector = collectorForRound(rot.round1Id, rot.order, rot.round1.creatorPubkey, cycle.shares, circle.roundIndex);
        if (!collector || !state.parent || state.parent !== roundCircleId(rot.round1Id, circle.roundIndex)) return "Rotation share is not part of this cycle";
        if (outcome === Outcome.RELEASE && state.participants[Role.SELLER]?.toLowerCase() !== collector) return "Share does not pay this round's collector";
        if (entries.some(m => !rot.order.includes(m) || m === collector)) return "Fill evidence names a non-member";
      }
    }
    const lawful = roundOutcomeAt(circle, entries.length, circle.seatThreshold, at);
    if (outcome === Outcome.RELEASE) return lawful === "release" ? null : "Release is only lawful for a filled round at its payday";
    return lawful === "refund" ? null : "Refund is not lawful while the round can still pay its collector";
  }
  // INTENT: strict, judged against the caller's own locally resolved view —
  // never sign what your evidence cannot justify.
  if (!cycle) return outcome === Outcome.REFUND ? null : "Rotation share resolution requires cycle context";
  const rot = rotationFromCycle(cycle, state.parent ? { id: state.parent, roundIndex: circle.roundIndex } : undefined);
  if (typeof rot === "string") return rot;
  const collector = collectorForRound(rot.round1Id, rot.order, rot.round1.creatorPubkey, cycle.shares, circle.roundIndex);
  if (!collector || !state.parent || state.parent !== roundCircleId(rot.round1Id, circle.roundIndex)) return "Rotation share is not part of this cycle";
  // Defense in depth on the one invariant that matters (review finding 4):
  // lawfulness is judged for the round, but the sats go to the seller seat —
  // so the seller seat must BE the chain-derived collector at this layer too.
  if (outcome === Outcome.RELEASE && state.participants[Role.SELLER]?.toLowerCase() !== collector) return "Share does not pay this round's collector";
  const expected = rot.order.filter(m => m !== collector);
  const locked = new Set(cycle.shares
    .filter(e => e.chamaPolicy === "share-v2" && e.parent === state.parent && e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK))
    .map(e => e.participants[Role.BUYER]!.toLowerCase()));
  const lockedCount = expected.filter(m => locked.has(m)).length;
  const lawful = roundOutcomeAt(circle, lockedCount, expected.length, at);
  if (outcome === Outcome.RELEASE) return lawful === "release" ? null : "Release is only lawful for a filled round at its payday";
  return lawful === "refund" ? null : "Refund is not lawful while the round can still pay its collector";
}

/** Build the fill-evidence commitment for a rotation share from the
 *  caller's resolved cycle: the round's LOCKed member pubkeys. */
export function fillEvidenceFor(roundId: string, cycle: ChamaCycleContext): { locked: string[] } {
  const locked = new Set<string>();
  for (const e of cycle.shares) {
    if (e.chamaPolicy !== "share-v2" || e.parent !== roundId) continue;
    if (!e.eventChain.some(ev => ev.kind === EscrowEventKind.LOCK)) continue;
    const m = e.participants[Role.BUYER]?.toLowerCase();
    if (m) locked.add(m);
  }
  return { locked: [...locked].sort() };
}

/** Pre-spend gate shared by the native/browser bridge and regression tests. */
export function chamaFundingError(state: EscrowState, pubkey: string, nowSec: number): string | null {
  if (state.category === "chama") return "Circle parents cannot hold funds";
  if (!state.chamaPolicy) return null;
  if (state.status !== EscrowStatus.CREATED || !state.chamaCircle || nowSec >= state.chamaCircle.fillDeadlineSec) return "Share funding window is closed";
  if (pubkey !== state.participants[Role.BUYER]) return "Only the member can fund their share";
  return null;
}

export function shareCreatePayload(parent: EscrowState, nowSec: number,
  ring?: { buyerPubkey: string; locks: readonly CircleShareLock[]; enabled?: boolean }): CreatePayload {
  const circle = circleFromEscrow(parent);
  if (!circle || validateCircleRound(circle).length) throw new Error("A validated circle parent is required");
  const original = parent.eventChain[0].payload as CreatePayload;
  // Witness selection (ring writer, docs/chama-host-seat-spec.md): the most
  // recently LOCKED member witnesses the next share — each joiner is
  // witnessed by the member who locked just before them, and the creator
  // bootstraps the first share. Fixed at CREATE, immutable after. The host
  // may only take a seat once a member's lock exists to witness theirs.
  let sellerPubkey = circle.creatorPubkey;
  if (ring && (ring.enabled ?? CHAMA_RING_WRITER_ENABLED)) {
    const buyer = ring.buyerPubkey.toLowerCase();
    const candidates = ring.locks.filter(l => l.circleId === parent.id && l.status === "locked"
      && l.lockedAtSec !== null && l.lockedAtSec <= nowSec && l.memberPubkey.toLowerCase() !== buyer);
    const latest = [...candidates].sort((a, b) => b.lockedAtSec! - a.lockedAtSec!)[0];
    if (latest) sellerPubkey = latest.memberPubkey;
    else if (buyer === circle.creatorPubkey.toLowerCase()) throw new Error("Hosts lock last: another member must lock first");
  }
  return { type: "escrow:create", description: circle.name, category: "chama-share", chamaPolicy: "share-v1",
    parent: parent.id, sellerPubkey, amountMsats: circle.shareMsats,
    mintUrl: parent.mintUrl, community: parent.community ?? undefined, fed: original.fed, fedPrefix: original.fedPrefix,
    platformFeeBps: 0, platformFeePubkey: original.platformFeePubkey, arbiterFeeMsats: 0,
    communityArbiters: [...parent.communityArbiters], bondedArbiters: [...(parent.bondedArbiters ?? [])],
    expirySeconds: circle.roundEndSec - nowSec, createdAt: nowSec };
}

/** Rotation share CREATE (writer). Throws with the human reason when the
 *  caller has no lawful seat; the engine gate re-verifies everything. */
export function rotationShareCreatePayload(parent: EscrowState, nowSec: number, buyerPubkey: string, cycle: ChamaCycleContext): CreatePayload {
  const circle = circleFromEscrow(parent);
  if (!circle || circle.pot !== "rotation-v2" || circle.roundIndex < 2) throw new Error("A rotation round parent is required");
  const rot = rotationFromCycle(cycle);
  if (typeof rot === "string") throw new Error(rot);
  const collector = collectorForRound(rot.round1Id, rot.order, rot.round1.creatorPubkey, cycle.shares, circle.roundIndex);
  if (!collector) throw new Error("No lawful collector for this round");
  if (buyerPubkey.toLowerCase() === collector) throw new Error("The collector sits out their own round");
  if (!rot.order.includes(buyerPubkey.toLowerCase())) throw new Error("Only sealed members lock rotation shares");
  return { ...shareCreatePayload(parent, nowSec), chamaPolicy: "share-v2", sellerPubkey: collector };
}

/** The next chained round's deterministic id + CREATE payload, derived
 *  entirely from the cycle (any member may publish it — spec decision 3:
 *  the new race starts the moment the previous round ends). Returns a
 *  human reason when no next round can lawfully open right now. */
export function nextRotationRoundPayload(cycle: ChamaCycleContext, nowSec: number): { escrowId: string; payload: CreatePayload } | string {
  const rot = rotationFromCycle(cycle);
  if (typeof rot === "string") return rot;
  const { round1Id, round1, order } = rot;
  let last = 1;
  for (const state of cycle.circles) {
    const c = circleFromEscrow(state);
    if (!c || c.pot !== "rotation-v2" || c.roundIndex < 2) continue;
    if (state.id === roundCircleId(round1Id, c.roundIndex) && c.roundIndex > last) last = c.roundIndex;
  }
  const next = last + 1;
  if (next > order.length + 1) return "The cycle is complete";
  const duration = round1.roundEndSec - round1.createdAt;
  const fillWindow = round1.fillDeadlineSec - round1.createdAt;
  const start = round1.roundEndSec + (next - 2) * duration;
  if (nowSec < start) return "The previous round has not ended";
  if (nowSec >= start + fillWindow) return "The round's fill window has passed";
  const round1State = cycle.circles.find(st => st.id === round1Id)!;
  const original = round1State.eventChain[0].payload as CreatePayload;
  return {
    escrowId: roundCircleId(round1Id, next),
    payload: { type: "escrow:create", description: round1.name, category: "chama",
      chamaCircle: { shareMsats: round1.shareMsats, seatThreshold: order.length - 1, seatCap: order.length - 1,
        unlisted: true, fillDeadlineSec: start + fillWindow, roundEndSec: start + duration,
        roundIndex: next, prevCircleId: next === 2 ? round1Id : roundCircleId(round1Id, next - 1), pot: "rotation-v2" },
      amountMsats: round1.shareMsats, mintUrl: round1.mintUrl, community: round1.community || undefined,
      fed: original.fed, fedPrefix: original.fedPrefix, platformFeeBps: 0, platformFeePubkey: original.platformFeePubkey,
      arbiterFeeMsats: 0, communityArbiters: [...round1State.communityArbiters], bondedArbiters: [...(round1State.bondedArbiters ?? [])],
      expirySeconds: start + duration - nowSec, createdAt: nowSec },
  };
}
