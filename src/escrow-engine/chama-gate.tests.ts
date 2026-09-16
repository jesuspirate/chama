import assert from "node:assert/strict";
import { EscrowEventKind as K, EscrowStatus as S, Outcome as O, Role as R, type CreatePayload, type EscrowState, type EscrowPayload, type NostrEvent, type ParsedEscrowEvent, type LockPayload } from "./types.js";
import { parseEscrowEvent } from "./event-parser.js";
import { applyEvent, canVote, getWinner, replayEventChain } from "./state-machine.js";
import { payoutRecipientFor } from "./recipients.js";
import { oneSidedEscalationAt } from "./arbiter-substitution.js";
import { shareEscrowId, shareCreatePayload, rotationShareCreatePayload, nextRotationRoundPayload } from "../chama/policy.js";
import { roundCircleId } from "../chama/rotation.js";
import { sharesForCircle, createChamaRefundWatcher } from "../chama/wiring.js";
import { canTakeSeat, circleProgress, lockPunctuality } from "../chama/circle.js";
import { circleFromEscrow } from "../chama/policy.js";
import { shouldShowOnBrowse, needsYouReasonFor } from "../ui/decisions.js";
const BUYER = "22".repeat(32), SELLER = "11".repeat(32), ARBITER = "33".repeat(32), BACKUP = "55".repeat(32), ID = "44".repeat(32);
const T = 1_900_000_000, FILL = T + 86400, END = T + 604800;
let seq = 0;
function event(kind: K, payload: EscrowPayload, pk: string, id: string, at: number, state?: EscrowState): ParsedEscrowEvent {
  const raw: NostrEvent = { id: (++seq).toString(16).padStart(64, "0"), kind, pubkey: pk, created_at: at, content: JSON.stringify(payload), sig: "00".repeat(64), tags: [["d", id], ["t", payload.type], ...(state ? [["e", state.eventChain.at(-1)!.raw.id, "", "reply"]] : [])] };
  return { raw, payload, kind, pubkey: pk, escrowId: id, timestamp: at, prevEventId: state?.eventChain.at(-1)!.raw.id ?? null };
}
function accepted(state: EscrowState | null, e: ParsedEscrowEvent): EscrowState {
  const result = applyEvent(state, e); assert(result.ok, result.ok ? "" : result.error.message); return result.state;
}
const parentPayload: CreatePayload = { type: "escrow:create", category: "chama", description: "Weekly circle", amountMsats: 100000, mintUrl: "fed1test", platformFeeBps: 0, platformFeePubkey: SELLER, expirySeconds: END - T, communityArbiters: [ARBITER, BACKUP], createdAt: T,
  chamaCircle: { shareMsats: 100000, seatThreshold: 2, seatCap: 3, fillDeadlineSec: FILL, roundEndSec: END, roundIndex: 1, prevCircleId: null } };
const parentEvent = event(K.CREATE, parentPayload, SELLER, ID, T);
const parent = accepted(null, parentEvent);
assert(parseEscrowEvent(parentEvent.raw, parentEvent.raw.content, true).ok);
const sharePayload: CreatePayload = { ...parentPayload, category: "chama-share", chamaCircle: undefined, chamaPolicy: "share-v1", parent: ID, sellerPubkey: SELLER, createdAt: T + 10, expirySeconds: END - T - 10 };
const shareId = shareEscrowId(ID, BUYER, 1);
const makeShare = (p = sharePayload, pk = BUYER, id = shareId) => ({ ...event(K.CREATE, p, pk, id, p.createdAt), chamaParent: parent });
const shareEvent = makeShare();
const share = accepted(null, shareEvent);
const assigned = share.participants[R.ARBITER]!;
assert.equal(share.participants[R.BUYER], BUYER); assert.equal(share.participants[R.SELLER], SELLER); assert([ARBITER, BACKUP].includes(assigned));
assert.equal(shareEscrowId(ID, BUYER.toUpperCase(), 1), shareId);
assert.notEqual(shareEscrowId(ID, BUYER, 2), shareId);
assert(!applyEvent(share, makeShare()).ok);
assert(!parseEscrowEvent(shareEvent.raw, shareEvent.raw.content, true).ok, "missing parent rejected by parser");
assert(!applyEvent(null, { ...shareEvent, chamaParent: undefined }).ok, "missing parent rejected by reducer");
assert(parseEscrowEvent(shareEvent.raw, shareEvent.raw.content, true, { parent }).ok);
for (const patch of [ { amountMsats: 99999 }, { escrowMode: "onchain" }, { sliceCount: 1 }, { tranche: {} }, { items: [] }, { settlementPolicy: "ecash-mutual-slices-v1" }, { chamaPolicy: undefined }, { category: "marketplace" }, { expirySeconds: END - T }, { sellerPubkey: ARBITER }, { mintUrl: "other" }, { platformFeeBps: 1 }, { arbiterFeeMsats: 1 }, { communityArbiters: [ARBITER] } ]) {
  const e = makeShare({ ...sharePayload, ...patch } as CreatePayload);
  assert(!applyEvent(null, e).ok, JSON.stringify(patch));
  assert(!parseEscrowEvent(e.raw, e.raw.content, true, { parent }).ok, JSON.stringify(patch));
}
assert(!applyEvent(null, makeShare(sharePayload, BUYER, "aa".repeat(32))).ok);
for (const patch of [{ seatThreshold: 1 }, { seatCap: 1 }, { shareMsats: 0 }, { fillDeadlineSec: T }, { roundEndSec: END + 14 * 86400 }, { roundIndex: 0 }, { roundEndSec: Infinity }, { fillDeadlineSec: FILL + 0.5 }]) {
  const e = event(K.CREATE, { ...parentPayload, chamaCircle: { ...parentPayload.chamaCircle!, ...patch } }, SELLER, ID, T);
  assert(!applyEvent(null, e).ok); assert(!parseEscrowEvent(e.raw, e.raw.content, true).ok);
}
const lockPayload: LockPayload = { type: "escrow:lock", notesHash: "hash", shares: [
  { shareIndex: 0, encryptedFor: { [BUYER]: "buyer" } }, { shareIndex: 1, encryptedFor: { [SELLER]: "seller" } }, { shareIndex: 2, encryptedFor: { [ARBITER]: "arbiter", [BACKUP]: "backup" } } ],
  sharePolicy: "holder-only-v1", arbiterPoolShare: true, buyerPubkey: BUYER, arbiterPubkey: assigned, sellerReceivesMsats: 100000, arbiterFeeMsats: 0, lockedAt: T + 20 };
const lockEvent = event(K.LOCK, lockPayload, BUYER, shareId, T + 20, share);
const locked = accepted(share, lockEvent);
assert.equal(locked.expiresAt, END, "LOCK must not extend the fixed expiry");
assert(!applyEvent(parent, event(K.LOCK, lockPayload, SELLER, ID, T + 20, parent)).ok);
for (const patch of [{ lockedAt: T + 21 }, { buyerPubkey: SELLER }, { arbiterPoolShare: false }, { arbiterFeeMsats: 1, sellerReceivesMsats: 99999 }]) assert(!applyEvent(share, event(K.LOCK, { ...lockPayload, ...patch }, BUYER, shareId, T + 20, share)).ok);
assert(!applyEvent(share, event(K.LOCK, { ...lockPayload, lockedAt: FILL }, BUYER, shareId, FILL, share)).ok);
assert(!applyEvent(share, event(K.LOCK, lockPayload, SELLER, shareId, T + 20, share)).ok);
assert.equal(payoutRecipientFor(locked, O.REFUND)?.pubkey, BUYER);
assert.equal(payoutRecipientFor(locked, O.RELEASE), null);
function vote(state: EscrowState, role: R, pk: string, outcome: O, at: number) { return event(K.VOTE, { type: "escrow:vote", role, outcome, votedAt: at }, pk, shareId, at, state); }
for (const at of [FILL, END + 1]) for (const role of [R.BUYER, R.SELLER, R.ARBITER]) {
  const pk = locked.participants[role]!;
  const e = vote(locked, role, pk, O.RELEASE, at);
  assert(!canVote(locked, pk, at, O.RELEASE).canVote);
  assert(!parseEscrowEvent(e.raw, e.raw.content, true, { state: locked }).ok);
  assert(!applyEvent(locked, e).ok, "RELEASE including healing rejected");
  const resolution = event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, resolvedAt: at }, BUYER, shareId, at, locked);
  assert(!applyEvent(locked, resolution).ok);
  assert(!parseEscrowEvent(resolution.raw, resolution.raw.content, true, { state: locked }).ok);
}
const firstVote = accepted(locked, vote(locked, R.BUYER, BUYER, O.REFUND, FILL));
const escalation = oneSidedEscalationAt(firstVote)!;
assert(escalation > FILL && escalation < END);
assert(!canVote(firstVote, assigned, escalation - 1, O.REFUND).canVote);
assert(canVote(firstVote, assigned, escalation, O.REFUND).canVote);
const ruled = accepted(firstVote, vote(firstVote, R.ARBITER, assigned, O.REFUND, escalation));
assert.equal(ruled.votes[R.ARBITER], O.REFUND, "ghost creator permits mechanical arbiter refund");
const both = accepted(firstVote, vote(firstVote, R.SELLER, SELLER, O.REFUND, FILL + 1));
const approved = accepted(both, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.REFUND, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, resolvedAt: FILL + 2 }, BUYER, shareId, FILL + 2, both));
assert.equal(getWinner(approved)?.pubkey, BUYER);
const claim = (pk: string) => event(K.CLAIM, { type: "escrow:claim", claimerRole: R.BUYER, notesHashVerification: "hash", claimedAt: FILL + 3 }, pk, shareId, FILL + 3, approved);
assert(!applyEvent(approved, claim(SELLER)).ok);
const claimed = accepted(approved, claim(BUYER));
assert(replayEventChain(claimed.eventChain).ok, "full parent-bound share chain replays");
const backup = assigned === ARBITER ? BACKUP : ARBITER;
const healing = accepted(locked, vote(locked, R.BUYER, BUYER, O.REFUND, END + 1));
assert(accepted(healing, vote(healing, R.ARBITER, backup, O.REFUND, END + 2)).votes[R.ARBITER] === O.REFUND);
assert(shouldShowOnBrowse({ escrow: parent, browseCategory: "all", nowSec: T + 30 }));
assert(!shouldShowOnBrowse({ escrow: share, browseCategory: "all", nowSec: T + 30 }));
assert.equal(needsYouReasonFor(locked, SELLER, T + 30), null);
assert.equal(sharesForCircle([share])[0].status, "reserved");
assert.equal(sharesForCircle([share])[0].escrowId, null);
assert.equal(sharesForCircle([locked])[0].lockedAtSec, lockEvent.timestamp);
assert.equal(sharesForCircle([approved])[0].status, "locked", "approval is not redemption");
assert.equal(sharesForCircle([claimed])[0].status, "refunded");
assert.equal(sharesForCircle([{ ...claimed, resolvedAt: END + 1 }])[0].status, "returned");
assert.equal(sharesForCircle([locked, locked]).length, 1);
assert.equal(circleProgress(circleFromEscrow(parent)!, sharesForCircle([share]), FILL).seatsLocked, 0);
assert.equal(sharesForCircle([locked], "other").length, 0);
let current = locked, attempts = 0, fail = true;
// Thin-view guard: without a completed children refresh a lone share must
// NOT vote itself out of a circle that may have filled elsewhere.
let blindAttempts = 0;
const blindWatcher = createChamaRefundWatcher({ getEscrows: () => [parent, locked], getPubkey: async () => BUYER, vote: async () => { blindAttempts++; } });
await blindWatcher(FILL);
assert.equal(blindAttempts, 0, "a thin view waits rather than self-evicting");
const watcher = createChamaRefundWatcher({ getEscrows: () => [parent, current], getPubkey: async () => BUYER, viewComplete: () => true, vote: async (_id, outcome) => {
  attempts++; assert.equal(outcome, O.REFUND); if (fail) throw new Error("offline"); current = accepted(current, vote(current, R.BUYER, BUYER, outcome, FILL));
} });
await watcher(T + 30); assert.equal(attempts, 0);
await watcher(FILL); assert.equal(attempts, 1);
fail = false; await watcher(FILL); assert.equal(attempts, 2);
await watcher(FILL); assert.equal(attempts, 2, "accepted vote deduplicates later passes");
const legacy = accepted(null, event(K.CREATE, { ...parentPayload, category: "marketplace", chamaCircle: undefined }, SELLER, ID, T));
assert.equal(legacy.chamaPolicy, undefined);
assert.equal(payoutRecipientFor({ ...legacy, participants: { buyer: BUYER, seller: SELLER, arbiter: ARBITER } }, O.RELEASE)?.pubkey, SELLER);
console.log("Chama CREATE, LOCK, voting, recovery, routing, adapter and watcher regression checks passed.");

// Exercise the real client seams with an in-memory relay; no wallet or network.
const { EscrowClient } = await import("./escrow-client.js");
const { EscrowFedimintBridge } = await import("../fedimint/escrow-bridge.js");
const { chamaFundingError } = await import("../chama/policy.js");
const signer = {
  async getPublicKey() { return BUYER; },
  async signEvent(e: import("./escrow-client.js").UnsignedEvent): Promise<NostrEvent> { return { ...e, id: (++seq).toString(16).padStart(64, "0"), pubkey: BUYER, sig: "00".repeat(64) }; },
  async nip44Encrypt(text: string) { return text; }, async nip44Decrypt(text: string) { return text; },
};
const client = new EscrowClient(signer, { relays: [] });
const seam = client as any;
const publications: NostrEvent[] = [];
seam.relayManager.publish = async (e: NostrEvent) => { publications.push(e); return { accepted: 1, rejected: 0, errors: [] }; };
seam.relayManager.fetchOnce = async () => [parentEvent.raw];
seam.watchEscrow = () => {}; seam.watchChildren = () => {};
client.loadEscrow = async () => null;
client.loadChildren = async () => [];
const resolvedParent = await seam.parseWithChamaContext(shareEvent.raw, shareEvent.raw.content);
assert(resolvedParent.ok && resolvedParent.event.chamaParent.id === ID, "share parser resolves the real parent CREATE");
const saveNow = Date.now;
try {
  Date.now = () => (T + 10) * 1000;
  const created = await client.createChamaShare(ID);
  assert.equal(created.escrowId, shareId);
  assert.equal(created.state.expiresAt, END);
  assert.equal(publications.length, 1);
  assert.equal((await client.createChamaShare(ID)).escrowId, shareId);
  assert.equal(publications.length, 1, "retry does not publish another CREATE");
  const envelopeCount = publications.length;
  seam.states.set(shareId, locked);
  await assert.rejects(client.vote(shareId, O.RELEASE), /Shares only allow REFUND/);
  assert.equal(publications.length, envelopeCount, "RELEASE blocked before encrypting/publishing a vote");
  seam.states.set(shareId, share);
  Date.now = () => FILL * 1000;
  let walletTouched = false;
  const wallet = new Proxy({}, { get() { walletTouched = true; throw new Error("wallet must not be accessed"); } });
  const bridge = new EscrowFedimintBridge(client, wallet as any, signer);
  await assert.rejects(bridge.lockAndPublish(shareId), /funding window is closed/);
  assert.equal(walletTouched, false, "late funding rejected before any wallet call");
  await assert.rejects(bridge.lockAndPublish(ID), /parents cannot hold funds/);
  assert.equal(walletTouched, false);
} finally { Date.now = saveNow; }
assert.equal(chamaFundingError(share, BUYER, T + 30), null);
assert(chamaFundingError(share, SELLER, T + 30));
for (const patch of [ { sharePolicy: undefined }, { shares: lockPayload.shares.map(s => ({ ...s, encryptedFor: { [BUYER]: "x", [SELLER]: "x", [ARBITER]: "x" } })) }, { shares: [lockPayload.shares[0], lockPayload.shares[0], lockPayload.shares[2]] } ]) {
  assert(!applyEvent(share, event(K.LOCK, { ...lockPayload, ...patch }, BUYER, shareId, T + 20, share)).ok, "unenforced/duplicated custody is rejected");
}
const envelope = vote(locked, R.SELLER, SELLER, O.REFUND, FILL);
envelope.payload = { ...envelope.payload, shareEnvelope: { shareIndex: 1, outcome: O.REFUND, notesHash: "hash", recipientPubkey: SELLER, encryptedFor: { [SELLER]: "stolen" } } } as EscrowPayload;
assert(!applyEvent(locked, envelope).ok, "REFUND envelope cannot leak the second share to creator");
let finish!: () => void;
let overlaps = 0;
const concurrent = createChamaRefundWatcher({ getEscrows: () => [parent, locked], getPubkey: async () => BUYER,
  viewComplete: () => true,
  vote: async () => { overlaps++; await new Promise<void>(resolve => { finish = resolve; }); } });
const active = concurrent(FILL);
await Promise.resolve();
await concurrent(FILL);
assert.equal(overlaps, 1, "overlapping ticks never publish two votes");
finish(); await active;
console.log("Chama client parent resolution, idempotent creation, encryption and pre-spend regressions passed.");

seam.states.set(shareId, { ...legacy, id: shareId });
await assert.rejects(client.createChamaShare(ID), /occupied by a different escrow/);
assert(!applyEvent(share, event(K.LOCK, { ...lockPayload, lockedAt: T + 1 }, BUYER, shareId, T + 1, share)).ok, "LOCK cannot precede share CREATE");

for (const pool of ["invalid", [1], ["short-pubkey"]]) {
  const e = event(K.CREATE, { ...parentPayload, communityArbiters: pool } as CreatePayload, SELLER, ID, T);
  assert(!parseEscrowEvent(e.raw, e.raw.content, true).ok, "malformed pool cannot crash parent hydration");
  assert(!applyEvent(null, e).ok);
}

const anotherMember = "66".repeat(32);
const otherShare = { ...locked, id: shareEscrowId(ID, anotherMember, 1), participants: { ...locked.participants, buyer: anotherMember } };
const due: string[] = [];
const runningWatcher = createChamaRefundWatcher({ getEscrows: () => [parent, locked, otherShare], getPubkey: async () => SELLER,
  vote: async id => { due.push(id); } });
await runningWatcher(FILL); assert.equal(due.length, 0, "filled circle stays locked until round end");
await runningWatcher(END + 1); assert.equal(due.length, 2, "creator votes to return both shares at round end");
const outsiderWatcher = createChamaRefundWatcher({ getEscrows: () => [parent, locked], getPubkey: async () => "77".repeat(32),
  vote: async () => { throw new Error("outsider cannot vote"); } });
await outsiderWatcher(FILL);
// Cold hydration applies the policy even when VOTE arrives before CREATE.
const cold = new EscrowClient(signer, { relays: [] });
const coldSeam = cold as any;
coldSeam.watchEscrow = () => {}; coldSeam.watchChildren = () => {};
coldSeam.relayManager.fetchOnce = async () => [parentEvent.raw];
coldSeam.relayManager.fetchEscrowEvents = async () => [vote(locked, R.SELLER, SELLER, O.RELEASE, FILL).raw, shareEvent.raw, lockEvent.raw];
const coldLoaded = await cold.loadEscrow(shareId);
assert.equal(coldLoaded?.status, S.LOCKED, "invalid RELEASE cannot hide a recoverable share during cold hydration");
console.log("Chama running-round and cold-hydration regressions passed.");

// ── v1.1 ring shares (host-seat spec task 1: readers first) ───────────────
const MEMBER2 = "66".repeat(32);
const ringId = shareEscrowId(ID, MEMBER2, 1);
const ringPayload: CreatePayload = { ...sharePayload, sellerPubkey: BUYER, createdAt: T + 30, expirySeconds: END - T - 30 };
const makeRing = (p = ringPayload, witness: EscrowState | null = locked) =>
  ({ ...event(K.CREATE, p, MEMBER2, shareEscrowId(ID, MEMBER2, 1), p.createdAt), chamaParent: parent, ...(witness ? { chamaWitness: witness } : {}) });
const ringEvent = makeRing();
const ring = accepted(null, ringEvent);
assert.equal(ring.participants[R.BUYER], MEMBER2);
assert.equal(ring.participants[R.SELLER], BUYER, "witness seated as counterparty");
assert(parseEscrowEvent(ringEvent.raw, ringEvent.raw.content, true, { parent, witness: locked }).ok, "parser accepts a witnessed ring share");
assert(!applyEvent(null, makeRing(ringPayload, null)).ok, "ring share without witness proof rejected");
assert(!parseEscrowEvent(ringEvent.raw, ringEvent.raw.content, true, { parent }).ok, "parser rejects ring share without witness");
assert(!applyEvent(null, makeRing(ringPayload, share)).ok, "unlocked witness rejected");
const early = { ...ringPayload, createdAt: T + 15, expirySeconds: END - T - 15 };
assert(!applyEvent(null, makeRing(early)).ok, "witness must lock before the share is created");
assert(!applyEvent(null, { ...makeRing({ ...ringPayload, sellerPubkey: ARBITER }), chamaWitness: locked }).ok, "witness id must match the named witness");
assert(!applyEvent(null, makeRing(ringPayload, { ...locked, participants: { ...locked.participants, [R.BUYER]: SELLER } })).ok, "witness must own their share");
assert(!applyEvent(null, { ...event(K.CREATE, { ...ringPayload, sellerPubkey: MEMBER2 }, MEMBER2, ringId, ringPayload.createdAt), chamaParent: parent, chamaWitness: locked }).ok, "buyer may never witness their own share");
assert(!applyEvent(null, makeRing(ringPayload, parent)).ok, "circle parent is not a witness share");
assert([ARBITER, BACKUP].includes(ring.participants[R.ARBITER]!));
assert.equal(sharesForCircle([locked, ring]).length, 2, "ring share counts toward the circle");

// ── ring writer (flag-gated; explicit enabled:true / hostSeat:true below) ──
const circleView = circleFromEscrow(parent)!;
const ringLocks = sharesForCircle([locked]);
// Flag OFF defaults: v1 law intact — host refused, creator witnesses.
assert.equal((canTakeSeat(circleView, ringLocks, SELLER, T + 40) as { ok: false; reason: string }).reason, "host");
assert.equal(shareCreatePayload(parent, T + 40, { buyerPubkey: MEMBER2, locks: ringLocks }).sellerPubkey, SELLER);
// Writer ON: hosts lock last — refused until a member's lock exists…
assert.equal((canTakeSeat(circleView, [], SELLER, T + 5, true) as { ok: false; reason: string }).reason, "host-waits");
assert.equal((canTakeSeat(circleView, sharesForCircle([share]), SELLER, T + 15, true) as { ok: false; reason: string }).reason, "host-waits", "a reserved (unlocked) share is no witness");
// …then seated like any member.
assert(canTakeSeat(circleView, ringLocks, SELLER, T + 40, true).ok);
// The most recent lock witnesses the next share; bootstrap falls back to the creator.
assert.equal(shareCreatePayload(parent, T + 40, { buyerPubkey: MEMBER2, locks: ringLocks, enabled: true }).sellerPubkey, BUYER);
assert.equal(shareCreatePayload(parent, T + 5, { buyerPubkey: MEMBER2, locks: [], enabled: true }).sellerPubkey, SELLER);
// Never yourself: the buyer's own lock is not a witness candidate.
assert.equal(shareCreatePayload(parent, T + 40, { buyerPubkey: BUYER, locks: ringLocks, enabled: true }).sellerPubkey, SELLER);
// Hosts lock last is enforced at build time too.
assert.throws(() => shareCreatePayload(parent, T + 5, { buyerPubkey: SELLER, locks: [], enabled: true }));
// End to end: the host's ring share round-trips the reader gate.
const hostPayload = shareCreatePayload(parent, T + 40, { buyerPubkey: SELLER, locks: ringLocks, enabled: true });
assert.equal(hostPayload.sellerPubkey, BUYER);
const hostShare = accepted(null, { ...event(K.CREATE, hostPayload, SELLER, shareEscrowId(ID, SELLER, 1), T + 40), chamaParent: parent, chamaWitness: locked });
assert.equal(hostShare.participants[R.BUYER], SELLER);
assert.equal(hostShare.participants[R.SELLER], BUYER, "host witnessed by the locked member");
assert.equal((canTakeSeat(circleView, sharesForCircle([locked, hostShare]), SELLER, T + 50, true) as { ok: false; reason: string }).reason, "already-seated");

// ── rotation v2 gates (commitment round + chained collection rounds) ──────
const M3 = "77".repeat(32);
const P2 = "88".repeat(32);
const r1Payload: CreatePayload = { ...parentPayload, description: "Merry-go-round",
  chamaCircle: { ...parentPayload.chamaCircle!, pot: "rotation-v2" } };
const r1 = accepted(null, event(K.CREATE, r1Payload, SELLER, P2, T));
const commitShare = (m: string) => accepted(null, { ...event(K.CREATE,
  { ...sharePayload, parent: P2, createdAt: T + 5, expirySeconds: END - T - 5 }, m, shareEscrowId(P2, m, 1), T + 5), chamaParent: r1 });
const commitLock = (st: EscrowState, m: string, at: number) => accepted(st, event(K.LOCK,
  { ...lockPayload, buyerPubkey: m, lockedAt: at, arbiterPubkey: st.participants[R.ARBITER]!,
    shares: [ { shareIndex: 0, encryptedFor: { [m]: "buyer" } }, { shareIndex: 1, encryptedFor: { [SELLER]: "seller" } },
      { shareIndex: 2, encryptedFor: { [ARBITER]: "arbiter", [BACKUP]: "backup" } } ] }, m, st.id, at, st));
const c1 = commitLock(commitShare(BUYER), BUYER, T + 100);
const c2 = commitLock(commitShare(MEMBER2), MEMBER2, T + 200);
const c3 = commitLock(commitShare(M3), M3, T + 300);
const cycle = { circles: [r1], shares: [c1, c2, c3] };
const R2 = roundCircleId(P2, 2);
const DUR = END - T, WIN = FILL - T;
const r2Circle = { shareMsats: 100000, seatThreshold: 2, seatCap: 2, fillDeadlineSec: END + WIN,
  roundEndSec: END + DUR, roundIndex: 2, prevCircleId: P2, pot: "rotation-v2" as const, unlisted: true };
const r2Payload: CreatePayload = { ...parentPayload, chamaCircle: r2Circle, createdAt: END, expirySeconds: DUR };
const mkR2 = (patch: Partial<typeof r2Circle> = {}, pk = M3, at = END, withCycle = true) => {
  const payload = { ...r2Payload, chamaCircle: { ...r2Circle, ...patch }, createdAt: at, expirySeconds: (patch.roundEndSec ?? r2Circle.roundEndSec) - at };
  return { ...event(K.CREATE, payload, pk, roundCircleId(P2, patch.roundIndex ?? 2), at), ...(withCycle ? { chamaCycle: cycle } : {}) };
};
const r2 = accepted(null, mkR2());
assert.equal(r2.chamaCircle!.roundIndex, 2, "a sealed member opens the first collection round");
assert(!applyEvent(null, mkR2({}, M3, END, false)).ok, "rotation rounds require cycle context");
assert(!applyEvent(null, mkR2({}, ARBITER)).ok, "outsiders cannot open a rotation round");
assert(!applyEvent(null, mkR2({}, SELLER)).ok, "the host without a commitment lock is not in the rotation");
assert(!applyEvent(null, mkR2({ unlisted: undefined as unknown as boolean })).ok, "rotation rounds are members-only");
assert(!applyEvent(null, mkR2({ seatThreshold: 3, seatCap: 3 })).ok, "seats must be members minus collector");
assert(!applyEvent(null, mkR2({ shareMsats: 99000 })).ok, "share amount is a cycle term");
assert(!applyEvent(null, mkR2({ fillDeadlineSec: END + WIN + 1 })).ok, "the schedule is anchored to round 1");
assert(!applyEvent(null, mkR2({}, M3, END - 1)).ok, "a round cannot open before the previous ends");
assert(!applyEvent(null, mkR2({}, M3, END + WIN)).ok, "a round published past its fill window is dead");
assert(!applyEvent(null, mkR2({ roundIndex: 5, prevCircleId: roundCircleId(P2, 4) }, M3, END + 3 * DUR)).ok, "no round beyond the rotation");
// Rotation shares: the collector (first commitment locker = BUYER) is paid by everyone else.
const sv2 = (m: string, seller = BUYER, at = END + 10, withCycle = true) => ({ ...event(K.CREATE,
  { ...sharePayload, chamaPolicy: "share-v2" as const, parent: R2, sellerPubkey: seller, createdAt: at, expirySeconds: (END + DUR) - at },
  m, shareEscrowId(R2, m, 2), at), chamaParent: r2, ...(withCycle ? { chamaCycle: cycle } : {}) });
const pay1 = accepted(null, sv2(MEMBER2));
assert.equal(pay1.participants[R.SELLER], BUYER, "the round's collector holds the seller seat");
assert.equal(pay1.participants[R.BUYER], MEMBER2);
assert(accepted(null, sv2(M3)), "every non-collector member pays in");
assert(!applyEvent(null, sv2(MEMBER2, M3)).ok, "paying anyone but the collector is unlawful");
assert(!applyEvent(null, sv2(BUYER, MEMBER2)).ok, "the collector sits out their own round");
assert(!applyEvent(null, sv2(ARBITER)).ok, "outsiders cannot lock rotation shares");
assert(!applyEvent(null, sv2(MEMBER2, BUYER, END + 10, false)).ok, "rotation shares require cycle context");
assert(!applyEvent(null, { ...event(K.CREATE, { ...sharePayload, parent: R2, createdAt: END + 10, expirySeconds: DUR - 10 }, MEMBER2, shareEscrowId(R2, MEMBER2, 2), END + 10), chamaParent: r2, chamaCycle: cycle }).ok, "share-v1 is unlawful in a rotation round");
assert(!applyEvent(null, { ...sv2(MEMBER2), chamaParent: parent }).ok, "share-v2 requires a rotation round parent");
console.log("Rotation v2 gate assertions passed.");

// ── rotation v2 outcome law: the payday lifecycle ─────────────────────────
const END2 = END + DUR, FILL2 = END + WIN;
const v2Lock = (st: EscrowState, m: string, at: number) => accepted(st, { ...event(K.LOCK,
  { ...lockPayload, buyerPubkey: m, lockedAt: at, arbiterPubkey: st.participants[R.ARBITER]!,
    shares: [ { shareIndex: 0, encryptedFor: { [m]: "buyer" } }, { shareIndex: 1, encryptedFor: { [BUYER]: "seller" } },
      { shareIndex: 2, encryptedFor: { [ARBITER]: "arbiter", [BACKUP]: "backup" } } ] }, m, st.id, at, st), chamaCycle: cycle });
const p1 = v2Lock(pay1, MEMBER2, END + 100);
const p2 = v2Lock(accepted(null, sv2(M3)), M3, END + 200);
const cycleFull = { circles: [r1, r2], shares: [c1, c2, c3, p1, p2] };
const cycleShort = { circles: [r1, r2], shares: [c1, c2, c3, p1] };
const v2vote = (st: EscrowState, role: R, pk: string, o: O, at: number, cyc?: typeof cycleFull) =>
  ({ ...event(K.VOTE, { type: "escrow:vote", role, outcome: o, votedAt: at }, pk, st.id, at, st), ...(cyc ? { chamaCycle: cyc } : {}) });
// Principal votes are CHAIN: recorded context-free so honest clients
// converge (review finding 6) — but INTENT stays strict, and nothing
// finalizes early.
const evFull = { locked: [MEMBER2, M3].sort() };
const earlyVote = accepted(p1, v2vote(p1, R.SELLER, BUYER, O.RELEASE, END + 300, cycleFull));
assert(!canVote(p1, BUYER, END + 300, O.RELEASE, cycleFull).canVote, "no honest client CASTS a release before roundEnd");
assert(!applyEvent(accepted(earlyVote, v2vote(earlyVote, R.BUYER, MEMBER2, O.RELEASE, END + 301, cycleFull)),
  event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: evFull, resolvedAt: END + 302 }, MEMBER2, p1.id, END + 302, earlyVote)).ok,
  "two early votes still cannot finalize before the payday, even fully evidenced");
assert(!canVote(p1, MEMBER2, FILL2 + 1, O.REFUND, cycleFull).canVote, "no honest client casts a refund on a filled round");
// Arbiter votes stay strict even as observations: their key share moves
// other people's money.
assert(!applyEvent(p1, { ...v2vote(p1, R.ARBITER, p1.participants[R.ARBITER]!, O.RELEASE, END + 300, cycleFull), payload: { type: "escrow:vote", role: R.ARBITER, outcome: O.RELEASE, fillEvidence: evFull, votedAt: END + 300 } }).ok, "an arbiter release before the payday is rejected on sight");
assert(!applyEvent(p1, v2vote(p1, R.ARBITER, p1.participants[R.ARBITER]!, O.RELEASE, END2, undefined)).ok, "an arbiter release without committed evidence is rejected on sight");
// The payday: collector + member vote RELEASE, resolve, collector claims.
const rv1 = accepted(p1, v2vote(p1, R.SELLER, BUYER, O.RELEASE, END2, cycleFull));
const rv2 = accepted(rv1, v2vote(rv1, R.BUYER, MEMBER2, O.RELEASE, END2 + 1, cycleFull));
const rres = accepted(rv2, { ...event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: evFull, resolvedAt: END2 + 2 }, MEMBER2, p1.id, END2 + 2, rv2), chamaCycle: cycleFull });
// THE COMMITMENT is the whole point: the same resolution validates with NO
// cycle context at all — settlement carries its own meaning, so a client
// hydrating from a thin relay converges on the same chain.
assert(applyEvent(rv2, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: evFull, resolvedAt: END2 + 2 }, MEMBER2, p1.id, END2 + 2, rv2)).ok, "an evidenced resolution needs no observer view");
assert(!applyEvent(rv2, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: { locked: [MEMBER2] }, resolvedAt: END2 + 2 }, MEMBER2, p1.id, END2 + 2, rv2)).ok, "short evidence cannot justify a release");
assert(!applyEvent(rv2, { ...event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: { locked: [MEMBER2, ARBITER] }, resolvedAt: END2 + 2 }, MEMBER2, p1.id, END2 + 2, rv2), chamaCycle: cycleFull }).ok, "evidence naming a non-member dies when the observer holds the cycle");
assert.equal(getWinner(rres)?.pubkey, BUYER, "the collector wins the pot");
assert.equal(payoutRecipientFor(p1, O.RELEASE)?.pubkey, BUYER, "release pays the collector");
assert.equal(payoutRecipientFor(p1, O.REFUND)?.pubkey, MEMBER2, "refund returns to the member");
const rclaim = accepted(rres, event(K.CLAIM, { type: "escrow:claim", claimerRole: R.SELLER, notesHashVerification: "hash", claimedAt: END2 + 3 }, BUYER, p1.id, END2 + 3, rres));
assert(replayEventChain(rclaim.eventChain).ok, "the full collection chain replays");
// Resolution is never evidence-free, either outcome.
assert(!applyEvent(rv2, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, resolvedAt: END2 + 2 }, MEMBER2, p1.id, END2 + 2, rv2)).ok, "resolve must commit its fill evidence");
// A short round (M3 never locked): refund intent opens at the deadline, release never.
assert(!canVote(p1, MEMBER2, END + 400, O.REFUND, cycleShort).canVote, "no refund cast while seats can still fill");
assert(canVote(p1, MEMBER2, FILL2, O.REFUND, cycleShort).canVote, "failed fill refunds at the deadline");
assert(!canVote(p1, BUYER, END2, O.RELEASE, cycleShort).canVote, "a short round never releases");
// The collect window lapses: the pot refunds back to the members.
import { COLLECT_WINDOW_SEC } from "../chama/rotation.js";
assert(!canVote(p1, MEMBER2, END2 + COLLECT_WINDOW_SEC - 1, O.REFUND, cycleFull).canVote, "no refund cast inside the collect window");
assert(canVote(p1, MEMBER2, END2 + COLLECT_WINDOW_SEC, O.REFUND, cycleFull).canVote, "an unclaimed pot refunds after the window");
assert(!canVote(p1, BUYER, END2 + COLLECT_WINDOW_SEC, O.RELEASE, cycleFull).canVote, "release lapses with the window");
import { isPerformanceContest } from "./arbiter-substitution.js";
assert(isPerformanceContest(rv1, END2 + 100), "a standing collector RELEASE is a live contest inside the window");
assert(!isPerformanceContest(rv1, END2 + COLLECT_WINDOW_SEC), "the lapsed window ends the contest — healing may return the sats");
// A lone REFUND vote is recordable without context but cannot finalize.
const lone = accepted(p1, v2vote(p1, R.BUYER, MEMBER2, O.REFUND, FILL2 + 1));
assert(!applyEvent(lone, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.REFUND, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, resolvedAt: FILL2 + 2 }, MEMBER2, p1.id, FILL2 + 2, lone)).ok, "evidence-free refund never finalizes");
assert(!applyEvent(lone, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.REFUND, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: evFull, resolvedAt: FILL2 + 2 }, MEMBER2, p1.id, FILL2 + 2, lone)).ok, "committed full evidence forbids refunding a filled round");
// canVote mirrors the law.
assert(!canVote(p1, BUYER, END + 300, O.RELEASE, cycleFull).canVote);
assert(canVote(p1, BUYER, END2, O.RELEASE, cycleFull).canVote, "the collector may vote release at the payday");
assert(!canVote(p1, MEMBER2, END2, O.REFUND, cycleFull).canVote);
console.log("Rotation v2 outcome-law assertions passed.");

// ── rotation v2 client wiring: builders + watcher ─────────────────────────
const built3 = nextRotationRoundPayload({ circles: [r1, r2], shares: cycleFull.shares }, END2 + 5);
assert(typeof built3 !== "string", "round 3 opens the moment round 2 ends");
assert.equal(built3.escrowId, roundCircleId(P2, 3));
assert.equal(built3.payload.chamaCircle!.prevCircleId, R2);
assert.equal(built3.payload.chamaCircle!.roundEndSec, END2 + DUR, "the schedule stays anchored to round 1");
const r3 = accepted(null, { ...event(K.CREATE, built3.payload, MEMBER2, built3.escrowId, END2 + 5), chamaCycle: cycleFull });
const cycle3 = { circles: [r1, r2, r3], shares: cycleFull.shares };
const pay3 = rotationShareCreatePayload(r3, END2 + 10, M3, cycle3);
assert.equal(pay3.sellerPubkey, MEMBER2, "round 3's collector = fastest round-2 locker still owed");
assert.throws(() => rotationShareCreatePayload(r3, END2 + 10, MEMBER2, cycle3), "the collector sits out at build time too");
assert.throws(() => rotationShareCreatePayload(r3, END2 + 10, ARBITER, cycle3), "outsiders cannot build rotation shares");
assert.equal(typeof nextRotationRoundPayload({ circles: [r1], shares: [c1, c2, c3] }, T + 100), "string", "no next round before round 1 ends");
assert.equal(typeof nextRotationRoundPayload({ circles: [r1, r2], shares: cycleFull.shares }, END2 + WIN), "string", "a missed fill window never opens late");
// The watcher services paydays mechanically and opens rounds on time.
{
  const calls: [string, O][] = [];
  const watcher = createChamaRefundWatcher({ getEscrows: () => [p1], getPubkey: async () => MEMBER2,
    vote: async (id: string, o: O) => { calls.push([id, o]); } });
  await watcher(END2 + 5);
  assert.deepEqual(calls, [[p1.id, O.RELEASE]], "the member co-signs the payday");
  calls.length = 0;
  await watcher(END + 500);
  assert.deepEqual(calls, [] as [string, O][], "nothing to do while the round runs");
  const opened: string[] = [];
  const opener = createChamaRefundWatcher({ getEscrows: () => [r2, p1, p2], getPubkey: async () => M3,
    vote: async (id: string, o: O) => { calls.push([id, o]); }, openNextRound: async id => { opened.push(id); }, rotationEnabled: true });
  await opener(END2 + 5);
  assert.deepEqual(opened, [r2.id], "any member's watcher opens the next round at roundEnd");
  const openerOff = createChamaRefundWatcher({ getEscrows: () => [r2, p1, p2], getPubkey: async () => M3,
    vote: async () => {}, openNextRound: async id => { opened.push(id); }, rotationEnabled: false });
  opened.length = 0;
  await openerOff(END2 + 5);
  assert.deepEqual(opened, [] as string[], "the writer flag gates round opening, never share servicing");
}
console.log("Rotation v2 wiring assertions passed.");

// ── standing: the sacrifice mint, total forfeiture, and the mark ──────────
import { circleMemberStats, rotationConduct } from "../chama/stats.js";
const R3 = built3.escrowId, END3 = END2 + DUR, FILL3 = END2 + WIN;
const sv3 = (m: string, at = END2 + 40) => ({ ...event(K.CREATE,
  { ...sharePayload, chamaPolicy: "share-v2" as const, parent: R3, sellerPubkey: MEMBER2, createdAt: at, expirySeconds: (END2 + DUR) - at },
  m, shareEscrowId(R3, m, 3), at), chamaParent: r3, chamaCycle: cycle3 });
const lock3 = (st: EscrowState, m: string, at: number) => accepted(st, { ...event(K.LOCK,
  { ...lockPayload, buyerPubkey: m, lockedAt: at, arbiterPubkey: st.participants[R.ARBITER]!,
    shares: [ { shareIndex: 0, encryptedFor: { [m]: "buyer" } }, { shareIndex: 1, encryptedFor: { [MEMBER2]: "seller" } },
      { shareIndex: 2, encryptedFor: { [ARBITER]: "arbiter", [BACKUP]: "backup" } } ] }, m, st.id, at, st), chamaCycle: cycle3 });
const q1 = lock3(accepted(null, sv3(BUYER)), BUYER, END2 + 100);
const q2 = lock3(accepted(null, sv3(M3)), M3, END2 + 200);
const cycle3Full = { circles: [r1, r2, r3], shares: [...cycleFull.shares, q1, q2] };
const q1a = accepted(q1, v2vote(q1, R.SELLER, MEMBER2, O.RELEASE, END3, cycle3Full as typeof cycleFull));
const q1b = accepted(q1a, v2vote(q1a, R.BUYER, BUYER, O.RELEASE, END3 + 1, cycle3Full as typeof cycleFull));
const q1res = accepted(q1b, { ...event(K.RESOLVE, { type: "escrow:resolve", outcome: O.RELEASE, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: { locked: [BUYER, M3].sort() }, resolvedAt: END3 + 2 }, BUYER, q1.id, END3 + 2, q1b), chamaCycle: cycle3Full });
const q1c = accepted(q1res, event(K.CLAIM, { type: "escrow:claim", claimerRole: R.SELLER, notesHashVerification: "hash", claimedAt: END3 + 3 }, MEMBER2, q1.id, END3 + 3, q1res));
const r3circle = circleFromEscrow(r3)!;
{
  // BUYER collected round 2, then kept locking: round 3's lock is the
  // sacrifice round and mints at the MAXIMUM early bonus.
  const view = [r1, r2, r3, c1, c2, c3, p1, p2, q1c, q2];
  const conduct = rotationConduct(view, BUYER, END3 + 10);
  assert.equal(conduct.collectedRounds, 1);
  assert(conduct.sacrificeShareIds.has(q1.id), "the post-payday lock is a sacrifice lock");
  assert(!conduct.brokeAfterCollecting);
  const stats = circleMemberStats(view, BUYER, END3 + 10);
  assert.equal(stats.completed, 1);
  const expected = lockPunctuality(r3circle, END2 + 100).satDaysCommitted * 3;
  assert(Math.abs(stats.standing - expected) < 1e-9, "sacrifice locks mint at max bonus regardless of lock time");
  // MEMBER2's round-2 share (pre-collection) mints the standard weight.
  const m2 = circleMemberStats([...view, rclaim], MEMBER2, END3 + 10);
  const m2expected = lockPunctuality(circleFromEscrow(r2)!, END + 100).standingWeight;
  assert(Math.abs(m2.standing - m2expected) < 1e-9, "pre-collection locks mint the standard weight");
  assert(!("mark" in m2));
}
{
  // BUYER collected round 2 and never locked round 3 while M3 did. The
  // accusation demands chain-POSITIVE proof of failure: the round's early
  // REFUND resolution (2-of-3 signed, only lawful on a short round).
  const cycleShort3 = { circles: [r1, r2, r3], shares: [...cycleFull.shares, q2] };
  let qr = accepted(q2, v2vote(q2, R.BUYER, M3, O.REFUND, FILL3, cycleShort3 as typeof cycleFull));
  qr = accepted(qr, v2vote(qr, R.SELLER, MEMBER2, O.REFUND, FILL3 + 1, cycleShort3 as typeof cycleFull));
  qr = accepted(qr, { ...event(K.RESOLVE, { type: "escrow:resolve", outcome: O.REFUND, majority: [R.BUYER, R.SELLER], arbiterInvolved: false, fillEvidence: { locked: [M3] }, resolvedAt: FILL3 + 2 }, M3, q2.id, FILL3 + 2, qr), chamaCycle: cycleShort3 });
  const view = [r1, r2, r3, c1, c2, c3, p1, p2, qr];
  const conduct = rotationConduct(view, BUYER, FILL3 + 10);
  assert(conduct.brokeAfterCollecting, "collected-then-absent in a real, short round is the mark");
  const stats = circleMemberStats(view, BUYER, FILL3 + 10);
  assert.equal(stats.standing, 0, "total forfeiture: everything zeroes at once");
  assert("mark" in stats && (stats as { mark: { brokeAtSec: number } }).mark.brokeAtSec === FILL3);
  assert(!rotationConduct(view, M3, FILL3 + 10).brokeAfterCollecting, "the member who showed up carries no mark");
  assert(!rotationConduct(view, MEMBER2, FILL3 + 10).brokeAfterCollecting, "round 3's collector owes nothing to round 3");
  // The eclipse defense (review finding 5): a withheld view of a round
  // that has NO early refund resolution accuses nobody — an innocent
  // member cannot be framed by hiding their lock.
  const eclipsed = [r1, r2, r3, c1, c2, c3, p1, p2, q2];
  assert(!rotationConduct(eclipsed, BUYER, FILL3 + 10).brokeAfterCollecting, "no refund proof, no mark — eclipse cannot frame the innocent");
  // Decision 4: M3 locked into the round that died and got refunded — they
  // mint the standing their sats actually sat for, not zero.
  const qrClaimed = accepted(qr, event(K.CLAIM, { type: "escrow:claim", claimerRole: R.BUYER, notesHashVerification: "hash", claimedAt: FILL3 + 3 }, M3, q2.id, FILL3 + 3, qr));
  const m3Stats = circleMemberStats([r1, r2, r3, c1, c2, c3, p1, p2, qrClaimed], M3, FILL3 + 10);
  assert(m3Stats.standing > 0, "showing up for a failed round still mints the standard rate");
}
console.log("Rotation v2 standing assertions passed.");

// ── review-driven regressions ─────────────────────────────────────────────
// Finding 1 (CRITICAL): the round opener must not choose who holds the
// third key — arbiter pool and federation pin to round 1.
assert(!applyEvent(null, { ...event(K.CREATE, { ...r2Payload, communityArbiters: [ARBITER, "77".repeat(32)] }, M3, R2, END), chamaCycle: cycle }).ok,
  "a swapped arbiter pool never opens a round");
assert(!applyEvent(null, { ...event(K.CREATE, { ...r2Payload, communityArbiters: [ARBITER, BACKUP], bondedArbiters: [ARBITER] }, M3, R2, END), chamaCycle: cycle }).ok,
  "a changed bonded set never opens a round");
// Finding 10: pot circles need real durations — a seconds-long "cycle" is a
// standing farm, not a savings circle.
assert(!applyEvent(null, event(K.CREATE, { ...r1Payload, expirySeconds: 7200,
  chamaCircle: { ...r1Payload.chamaCircle!, fillDeadlineSec: T + 60, roundEndSec: T + 7200 } }, SELLER, "f7".repeat(32), T)).ok,
  "a one-minute fill window never opens a pot circle");
// Finding 2: at the payday, the watcher services the collect — it never
// refunds a filled rotation round out from under its collector.
{
  const calls2: [string, O][] = [];
  const payday = createChamaRefundWatcher({ getEscrows: () => [r2, p1, p2], getPubkey: async () => M3,
    vote: async (id: string, o: O) => { calls2.push([id, o]); }, rotationEnabled: true, openNextRound: async () => {} });
  await payday(END2 + 5);
  assert(calls2.every(([, o]) => o !== O.REFUND), "no watcher refunds a filled round at its payday");
  assert(calls2.some(([id, o]) => id === p2.id && o === O.RELEASE), "the member watcher co-signs the payday instead");
}
console.log("Review-driven regression assertions passed.");

// ── sim circles: a week in five minutes, mock money only ──────────────────
{
  const simPayload: CreatePayload = { ...r1Payload, expirySeconds: 300,
    chamaCircle: { ...r1Payload.chamaCircle!, fillDeadlineSec: T + 120, roundEndSec: T + 300 } };
  const simEvent = event(K.CREATE, simPayload, SELLER, "f8".repeat(32), T);
  simEvent.raw.tags.push(["chama-sim", "v1"]);
  assert(applyEvent(null, simEvent).ok, "a sim-tagged pot circle may compress a week into minutes");
  assert(!applyEvent(null, event(K.CREATE, simPayload, SELLER, "f9".repeat(32), T)).ok, "the same shape without the sim tag stays floored — real sats keep the hour rule");
}
console.log("Sim-circle assertions passed.");
