import assert from "node:assert/strict";
import { EscrowEventKind as K, EscrowStatus as S, Outcome as O, Role as R, type CreatePayload, type EscrowState, type EscrowPayload, type NostrEvent, type ParsedEscrowEvent, type LockPayload } from "./types.js";
import { parseEscrowEvent } from "./event-parser.js";
import { applyEvent, canVote, getWinner, replayEventChain } from "./state-machine.js";
import { payoutRecipientFor } from "./recipients.js";
import { oneSidedEscalationAt } from "./arbiter-substitution.js";
import { shareEscrowId, shareCreatePayload } from "../chama/policy.js";
import { sharesForCircle, createChamaRefundWatcher } from "../chama/wiring.js";
import { canTakeSeat, circleProgress } from "../chama/circle.js";
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
