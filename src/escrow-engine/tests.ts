// ══════════════════════════════════════════════════════════════════════════
// Chama Escrow Engine — Test Suite (PR 1: atomic funding)
// ══════════════════════════════════════════════════════════════════════════
//
// Run: npx tsx src/escrow-engine/tests.ts
//
// Tests the pure state machine with synthetic events — no relays, no
// crypto, no network. Just state transitions and invariants for the
// atomic-funding model:
//
//   - LOCK fires directly from CREATED (no FUNDED, no READY ceremony)
//   - LOCK is self-describing: it carries buyerPubkey + arbiterPubkey
//   - JOIN is ACK only: it records a participant pubkey but does NOT
//     transition state
//   - Once LOCKED, a second LOCK is rejected (no double-lock from
//     duplicate payment-detection events)
//   - Arbiter must be from the communityArbiters pool when one exists
//   - LOCK pubkeys must be consistent with any prior JOIN ACKs

import {
  EscrowStatus,
  EscrowEventKind,
  Role,
  Outcome,
  type ParsedEscrowEvent,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type ChatPayload,
  type EscrowPayload,
  type NostrEvent,
} from "./types.js";

import {
  applyEvent,
  replayEventChain,
  canVote,
  getWinner,
  isExpired,
  getSummary,
  type TransitionResult,
} from "./state-machine.js";

import {
  parseEscrowEvent,
  sortEventChain,
  buildEscrowFilter,
} from "./event-parser.js";

// ── Test helpers ──────────────────────────────────────────────────────────

const BUYER_PK    = "aa".repeat(32);
const SELLER_PK   = "bb".repeat(32);
const ARBITER_PK  = "cc".repeat(32);
const ARBITER2_PK = "ee".repeat(32);
const PLATFORM_PK = "dd".repeat(32);
const ESCROW_ID   = "test-escrow-001";

let eventCounter = 0;
const NOW = Math.floor(Date.now() / 1000);

function makeRawEvent(kind: EscrowEventKind, pubkey: string, tags: string[][]): NostrEvent {
  eventCounter++;
  return {
    id: `event_${eventCounter}_${kind}`,
    pubkey,
    created_at: NOW + eventCounter,
    kind,
    tags,
    content: "encrypted",
    sig: "sig_" + eventCounter,
  };
}

function makeParsedEvent<T extends EscrowPayload>(
  kind: EscrowEventKind,
  pubkey: string,
  payload: T,
  prevEventId: string | null = null
): ParsedEscrowEvent<T> {
  const raw = makeRawEvent(kind, pubkey, [
    ["d", ESCROW_ID],
    ...(prevEventId ? [["e", prevEventId, "", "reply"]] : []),
  ]);
  return {
    raw,
    payload,
    escrowId: ESCROW_ID,
    prevEventId,
    kind,
    pubkey,
    timestamp: raw.created_at,
  };
}

// ── Standard event builders ───────────────────────────────────────────────

function createEvent(opts: { communityArbiters?: string[] } = {}): ParsedEscrowEvent<CreatePayload> {
  return makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create",
    description: "Sell 100k sats for $50 USD via Zelle",
    amountMsats: 100_000_000,
    fiatAmount: 50,
    fiatCurrency: "USD",
    category: "p2p-trade",
    mintUrl: "fed11q...",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    arbiterFeeMsats: 1_000_000,
    paymentMethods: ["Zelle", "CashApp"],
    expirySeconds: 86400,
    communityArbiters: opts.communityArbiters,
    createdAt: NOW,
  });
}

function joinEvent(role: Role, pubkey: string, prevId: string): ParsedEscrowEvent<JoinPayload> {
  return makeParsedEvent(EscrowEventKind.JOIN, pubkey, {
    type: "escrow:join",
    role,
    joinedAt: NOW + eventCounter,
    ...(role === Role.ARBITER ? { arbiterFeeMsats: 1_000_000 } : {}),
  }, prevId);
}

function lockEvent(prevId: string, opts: {
  buyerPubkey?: string;
  arbiterPubkey?: string;
  sellerReceivesMsats?: number;
  arbiterFeeMsats?: number;
  locker?: string;
} = {}): ParsedEscrowEvent<LockPayload> {
  const buyerPk   = opts.buyerPubkey   ?? BUYER_PK;
  const arbiterPk = opts.arbiterPubkey ?? ARBITER_PK;
  return makeParsedEvent(EscrowEventKind.LOCK, opts.locker ?? SELLER_PK, {
    type: "escrow:lock",
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [buyerPk]: "enc_0_b", [SELLER_PK]: "enc_0_s", [arbiterPk]: "enc_0_a" } },
      { shareIndex: 1, encryptedFor: { [buyerPk]: "enc_1_b", [SELLER_PK]: "enc_1_s", [arbiterPk]: "enc_1_a" } },
      { shareIndex: 2, encryptedFor: { [buyerPk]: "enc_2_b", [SELLER_PK]: "enc_2_s", [arbiterPk]: "enc_2_a" } },
    ],
    sellerReceivesMsats: opts.sellerReceivesMsats ?? 99_000_000,
    arbiterFeeMsats:     opts.arbiterFeeMsats     ?? 1_000_000,
    buyerPubkey:   buyerPk,
    arbiterPubkey: arbiterPk,
    lockedAt: NOW + eventCounter,
  }, prevId);
}

function voteEvent(role: Role, pubkey: string, outcome: Outcome, prevId: string): ParsedEscrowEvent<VotePayload> {
  return makeParsedEvent(EscrowEventKind.VOTE, pubkey, {
    type: "escrow:vote",
    outcome,
    role,
    votedAt: NOW + eventCounter,
  }, prevId);
}

function resolveEvent(outcome: Outcome, majority: [Role, Role], arbiterInvolved: boolean, prevId: string): ParsedEscrowEvent<ResolvePayload> {
  return makeParsedEvent(EscrowEventKind.RESOLVE, BUYER_PK, {
    type: "escrow:resolve",
    outcome,
    majority,
    arbiterInvolved,
    resolvedAt: NOW + eventCounter,
  }, prevId);
}

function claimEvent(claimerRole: Role, claimerPk: string, prevId: string): ParsedEscrowEvent<ClaimPayload> {
  return makeParsedEvent(EscrowEventKind.CLAIM, claimerPk, {
    type: "escrow:claim",
    claimerRole,
    notesHashVerification: "hash_of_ecash_notes_abc123",
    claimedAt: NOW + eventCounter,
  }, prevId);
}

function completeEvent(prevId: string): ParsedEscrowEvent<CompletePayload> {
  return makeParsedEvent(EscrowEventKind.COMPLETE, BUYER_PK, {
    type: "escrow:complete",
    completedAt: NOW + eventCounter,
  }, prevId);
}

function cancelEvent(prevId: string): ParsedEscrowEvent<CancelPayload> {
  return makeParsedEvent(EscrowEventKind.CANCEL, SELLER_PK, {
    type: "escrow:cancel",
    cancellerRole: Role.SELLER,
    reason: "Changed my mind",
    cancelledAt: NOW + eventCounter,
  }, prevId);
}

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, details?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${details ? ` — ${details}` : ""}`);
  }
}

function assertOk(result: TransitionResult, name: string): result is { ok: true; state: any } {
  if (result.ok) {
    passed++;
    console.log(`  ✅ ${name}`);
    return true;
  } else {
    failed++;
    console.log(`  ❌ ${name} — ${result.error.code}: ${result.error.message}`);
    return false;
  }
}

function assertErr(result: TransitionResult, expectedCode: string, name: string) {
  if (!result.ok && result.error.code === expectedCode) {
    passed++;
    console.log(`  ✅ ${name} (${expectedCode})`);
  } else if (!result.ok) {
    failed++;
    console.log(`  ❌ ${name} — expected ${expectedCode}, got ${result.error.code}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} — expected error ${expectedCode}, got success`);
  }
}

// Helper: drive a fresh chain to LOCKED. Useful for tests downstream of LOCK.
function buildToLocked(): { state: any; lock: ParsedEscrowEvent<LockPayload> } {
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (!r1.ok) throw new Error("CREATE failed in helper");
  const lock = lockEvent(create.raw.id);
  const r2 = applyEvent(r1.state, lock);
  if (!r2.ok) throw new Error("LOCK failed in helper: " + r2.error.message);
  return { state: r2.state, lock };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════════

console.log("\n🧪 Chama Escrow Engine — Test Suite (PR 1 atomic funding)\n");

// ── 1. CREATE ─────────────────────────────────────────────────────────────
console.log("── CREATE ──");
{
  const create = createEvent();
  const result = applyEvent(null, create);

  if (assertOk(result, "CREATE bootstraps initial state")) {
    const s = result.state;
    assert(s.status === EscrowStatus.CREATED, "Status is CREATED");
    assert(s.id === ESCROW_ID, "Escrow ID set correctly");
    assert(s.participants[Role.SELLER] === SELLER_PK, "Seller is initiator");
    assert(s.participants[Role.BUYER] === null, "Buyer slot empty pre-LOCK");
    assert(s.participants[Role.ARBITER] === null, "Arbiter slot empty pre-LOCK");
    assert(s.amountMsats === 100_000_000, "Amount set correctly");
    assert(s.fees.platformBps === 50, "Platform fee BPS set");
    assert(s.fees.platformMsats === 500_000, "Platform fee calculated");
    assert(s.eventChain.length === 1, "Event chain has 1 event");
  }
}

// Duplicate CREATE
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const r2 = applyEvent(r1.state, createEvent());
    assertErr(r2, "DUPLICATE_CREATE", "Duplicate CREATE rejected");
  }
}

// ── 2. JOIN as ACK (no state transition) ─────────────────────────────────
console.log("\n── JOIN (ACK only — does not transition state) ──");
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (assertOk(r2, "Buyer JOIN accepted as ACK")) {
      assert(r2.state.participants[Role.BUYER] === BUYER_PK, "Buyer pubkey recorded");
      assert(r2.state.status === EscrowStatus.CREATED, "Status STAYS CREATED after buyer JOIN");

      const join2 = joinEvent(Role.ARBITER, ARBITER_PK, join1.raw.id);
      const r3 = applyEvent(r2.state, join2);
      if (assertOk(r3, "Arbiter JOIN accepted as ACK")) {
        assert(r3.state.participants[Role.ARBITER] === ARBITER_PK, "Arbiter pubkey recorded");
        assert(r3.state.status === EscrowStatus.CREATED,
          "Status STAYS CREATED even after all participants JOINed (no FUNDED state)");
        assert(r3.state.fees.arbiterMsats === 1_000_000, "Arbiter fee recorded from JOIN payload");
      }
    }
  }
}

// Role already taken
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (r2.ok) {
      const join3 = joinEvent(Role.BUYER, "ee".repeat(32), join1.raw.id);
      assertErr(applyEvent(r2.state, join3), "ROLE_TAKEN", "Different pubkey can't grab a filled slot");
    }
  }
}

// Same pubkey re-joining same role: ALREADY_JOINED (idempotent relay echo)
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, join1) as any).state;
  const join1dup = joinEvent(Role.BUYER, BUYER_PK, join1.raw.id);
  assertErr(applyEvent(state, join1dup), "ALREADY_JOINED", "Same pubkey re-JOIN is benign duplicate");
}

// Can't JOIN as initiator's role
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join = joinEvent(Role.SELLER, BUYER_PK, create.raw.id);
    assertErr(applyEvent(r1.state, join), "ROLE_CONFLICT", "Can't JOIN as initiator's role");
  }
}

// Arbiter must be in communityArbiters pool when one exists
{
  const create = createEvent({ communityArbiters: [ARBITER_PK, ARBITER2_PK] });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const goodArbiter = joinEvent(Role.ARBITER, ARBITER_PK, create.raw.id);
    const ok = applyEvent(r1.state, goodArbiter);
    assertOk(ok, "Arbiter from pool can JOIN");

    const stranger = joinEvent(Role.ARBITER, "ff".repeat(32), create.raw.id);
    assertErr(applyEvent(r1.state, stranger), "ARBITER_NOT_IN_POOL",
      "Non-pool arbiter rejected when pool is non-empty");
  }
}

// Empty pool: any arbiter accepted
{
  const create = createEvent(); // no pool
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const anyArbiter = joinEvent(Role.ARBITER, "99".repeat(32), create.raw.id);
    assertOk(applyEvent(r1.state, anyArbiter),
      "Empty pool means any arbiter pubkey can JOIN");
  }
}

// ── 3. ATOMIC LOCK ───────────────────────────────────────────────────────
console.log("\n── ATOMIC LOCK (CREATED → LOCKED, no FUNDED hop) ──");

// 3a. LOCK fires from CREATED with no prior JOINs
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  assert(state.status === EscrowStatus.CREATED, "Pre-condition: state is CREATED");

  const lock = lockEvent(create.raw.id);
  const r = applyEvent(state, lock);
  if (assertOk(r, "LOCK from CREATED with no prior JOINs (atomic funding)")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status transitions CREATED → LOCKED directly");
    assert(r.state.participants[Role.BUYER] === BUYER_PK, "LOCK populated buyer slot");
    assert(r.state.participants[Role.ARBITER] === ARBITER_PK, "LOCK populated arbiter slot");
    assert(r.state.lock.notesHash === "hash_of_ecash_notes_abc123", "Notes hash stored");
    assert(r.state.lock.shares.size === 3, "3 SSS shares stored");
  }
}

// 3b. LOCK fires from CREATED after JOIN ACKs (consistent pubkeys)
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;

  const lock = lockEvent(j2.raw.id);
  const r = applyEvent(state, lock);
  assertOk(r, "LOCK after consistent JOIN ACKs");
}

// 3c. LOCK with buyer pubkey disagreeing with prior JOIN → BUYER_PUBKEY_MISMATCH
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const lock = lockEvent(j1.raw.id, { buyerPubkey: "ff".repeat(32) });
  assertErr(applyEvent(state, lock), "BUYER_PUBKEY_MISMATCH",
    "LOCK buyerPubkey must match prior buyer JOIN");
}

// 3d. LOCK with arbiter pubkey not in community pool → ARBITER_NOT_IN_POOL
{
  const create = createEvent({ communityArbiters: [ARBITER_PK, ARBITER2_PK] });
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id, { arbiterPubkey: "ff".repeat(32) });
  assertErr(applyEvent(state, lock), "ARBITER_NOT_IN_POOL",
    "LOCK arbiterPubkey must come from communityArbiters pool");
}

// 3e. LOCK missing buyerPubkey → MISSING_BUYER_PUBKEY
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: "",
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  }, create.raw.id);
  assertErr(applyEvent(state, badLock), "MISSING_BUYER_PUBKEY",
    "LOCK with empty buyerPubkey rejected");
}

// 3f. LOCK with wrong amount sum → AMOUNT_MISMATCH
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = lockEvent(create.raw.id, { sellerReceivesMsats: 90_000_000 });
  assertErr(applyEvent(state, badLock), "AMOUNT_MISMATCH",
    "LOCK with wrong amount sum rejected");
}

// 3g. WRONG_LOCKER: buyer can't lock in p2p-trade
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const buyerLock = lockEvent(create.raw.id, { locker: BUYER_PK });
  assertErr(applyEvent(state, buyerLock), "NOT_PARTICIPANT",
    "In p2p-trade, the buyer pubkey is not a participant pre-LOCK so signing as buyer fails NOT_PARTICIPANT");
}

// 3h. DOUBLE-LOCK: a second LOCK after LOCKED is rejected
//
// This is the load-bearing atomic-funding invariant: payment-detection
// can fire twice (relay echo, retry, two browsers), but the chain MUST
// NOT advance past LOCKED twice. Sanity check: applying a second LOCK
// to an already-LOCKED state returns INVALID_STATE.
{
  const { state, lock } = buildToLocked();
  assert(state.status === EscrowStatus.LOCKED, "Pre-condition: first LOCK succeeded");

  const dupLock = lockEvent(lock.raw.id);
  assertErr(applyEvent(state, dupLock), "INVALID_STATE",
    "Double-LOCK after LOCKED is rejected — atomic, not idempotent-with-side-effects");
}

// 3i. DUPLICATE_PARTICIPANT: arbiter == seller
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = lockEvent(create.raw.id, { arbiterPubkey: SELLER_PK });
  assertErr(applyEvent(state, badLock), "DUPLICATE_PARTICIPANT",
    "LOCK can't assign seller pubkey as arbiter");
}

// ── 4. VOTE — Happy Path ─────────────────────────────────────────────────
console.log("\n── VOTE (happy path: buyer+seller agree) ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  const r1 = applyEvent(state, v1);
  if (assertOk(r1, "Buyer votes RELEASE")) {
    assert(r1.state.votes[Role.BUYER] === Outcome.RELEASE, "Buyer vote recorded");
    assert(r1.state.status === EscrowStatus.LOCKED, "Still LOCKED (need 2 votes + RESOLVE)");

    const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
    const r2 = applyEvent(r1.state, v2);
    if (assertOk(r2, "Seller votes RELEASE")) {
      assert(r2.state.votes[Role.SELLER] === Outcome.RELEASE, "Seller vote recorded");

      const cv = canVote(r2.state, ARBITER_PK);
      assert(!cv.canVote, "Arbiter can't vote when buyer+seller agree");

      const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
      const r3 = applyEvent(r2.state, resolve);
      if (assertOk(r3, "RESOLVE → APPROVED")) {
        assert(r3.state.status === EscrowStatus.APPROVED, "Status is APPROVED");
        assert(r3.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

        const winner = getWinner(r3.state);
        assert(winner?.role === Role.BUYER, "Winner is buyer");
        assert(winner?.pubkey === BUYER_PK, "Winner pubkey correct");
      }
    }
  }
}

// ── 5. VOTE — Dispute Path ───────────────────────────────────────────────
console.log("\n── VOTE (dispute: arbiter breaks tie) ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;

  const cv = canVote(state, ARBITER_PK);
  assert(cv.canVote === true, "Arbiter CAN vote after disagreement");

  const v3 = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.REFUND, v2.raw.id);
  const r = applyEvent(state, v3);
  if (assertOk(r, "Arbiter votes REFUND")) {
    const resolve = resolveEvent(Outcome.REFUND, [Role.SELLER, Role.ARBITER], true, v3.raw.id);
    const r2 = applyEvent(r.state, resolve);
    if (assertOk(r2, "RESOLVE with arbiter → APPROVED (refund)")) {
      assert(r2.state.resolvedOutcome === Outcome.REFUND, "Outcome is REFUND");
      const winner = getWinner(r2.state);
      assert(winner?.role === Role.SELLER, "Winner is seller (refund)");
    }
  }
}

// Arbiter tries to vote too early
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const earlyVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, lock.raw.id);
  assertErr(applyEvent(state, earlyVote), "ARBITER_TOO_EARLY",
    "Arbiter can't vote before buyer+seller");
}

// Double vote
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v1dup = voteEvent(Role.BUYER, BUYER_PK, Outcome.REFUND, v1.raw.id);
  assertErr(applyEvent(state, v1dup), "ALREADY_VOTED", "Double vote rejected");
}

// ── 6. CLAIM + COMPLETE ──────────────────────────────────────────────────
console.log("\n── CLAIM + COMPLETE ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  state = (applyEvent(state, resolve) as any).state;

  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  const rc = applyEvent(state, claim);
  if (assertOk(rc, "Buyer claims → CLAIMED")) {
    assert(rc.state.status === EscrowStatus.CLAIMED, "Status is CLAIMED");

    const complete = completeEvent(claim.raw.id);
    const rf = applyEvent(rc.state, complete);
    if (assertOk(rf, "COMPLETE → terminal")) {
      assert(rf.state.status === EscrowStatus.COMPLETED, "Status is COMPLETED");

      const lateVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, complete.raw.id);
      assertErr(applyEvent(rf.state, lateVote), "TERMINAL_STATE", "No events after COMPLETED");
    }
  }

  // Wrong claimer
  const wrongClaim = claimEvent(Role.SELLER, SELLER_PK, resolve.raw.id);
  assertErr(applyEvent(state, wrongClaim), "WRONG_CLAIMER", "Seller can't claim on RELEASE outcome");
}

// ── 7. CANCEL ─────────────────────────────────────────────────────────────
console.log("\n── CANCEL ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  const cancel = cancelEvent(create.raw.id);
  const r = applyEvent(state, cancel);
  if (assertOk(r, "Cancel in CREATED state")) {
    assert(r.state.status === EscrowStatus.CANCELLED, "Status is CANCELLED");
  }
}

// Can't cancel after LOCKED
{
  const { state, lock } = buildToLocked();
  const cancel = cancelEvent(lock.raw.id);
  assertErr(applyEvent(state, cancel), "INVALID_STATE", "Can't cancel after LOCKED");
}

// Non-initiator can't cancel
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const badCancel = makeParsedEvent(EscrowEventKind.CANCEL, BUYER_PK, {
    type: "escrow:cancel" as const,
    cancellerRole: Role.BUYER,
    cancelledAt: NOW,
  }, j1.raw.id);

  assertErr(applyEvent(state, badCancel), "NOT_INITIATOR", "Non-initiator can't cancel");
}

// ── 8. CHAT ───────────────────────────────────────────────────────────────
console.log("\n── CHAT ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const chat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, BUYER_PK, {
    type: "escrow:chat",
    message: "Hey, I'm ready to trade!",
    senderRole: Role.BUYER,
    sentAt: NOW,
  });

  const r = applyEvent(state, chat);
  if (assertOk(r, "Chat message accepted")) {
    assert(r.state.chatMessages.length === 1, "Chat stored in chatMessages");
    assert(r.state.eventChain.length === 2, "Chat NOT in eventChain (state chain)");
  }

  // Non-participant can't chat
  const badChat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, "ff".repeat(32), {
    type: "escrow:chat",
    message: "I'm not part of this",
    senderRole: Role.BUYER,
    sentAt: NOW,
  });
  assertErr(applyEvent(state, badChat), "NOT_PARTICIPANT", "Non-participant can't chat");
}

// ── 9. REPLAY ─────────────────────────────────────────────────────────────
console.log("\n── REPLAY (full happy path from event chain) ──");
{
  eventCounter = 100; // Reset for clean IDs

  const events: ParsedEscrowEvent[] = [];

  const create = createEvent();
  events.push(create);

  // Optional JOIN ACKs (still valid pre-LOCK)
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  events.push(j1);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  events.push(j2);

  const lock = lockEvent(j2.raw.id);
  events.push(lock);

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  events.push(v1);

  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  events.push(v2);

  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  events.push(resolve);

  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  events.push(claim);

  const complete = completeEvent(claim.raw.id);
  events.push(complete);

  const result = replayEventChain(events);
  if (assertOk(result, "Full replay succeeds")) {
    assert(result.state.status === EscrowStatus.COMPLETED, "Final state is COMPLETED");
    assert(result.state.eventChain.length === 9, "All 9 events in chain");
    assert(result.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

    console.log("\n  📋 State summary:");
    console.log("  " + getSummary(result.state).split("\n").join("\n  "));
  }
}

// ── 9b. REPLAY without any JOIN events ───────────────────────────────────
console.log("\n── REPLAY (atomic minimum: CREATE → LOCK → … with NO JOINs) ──");
{
  eventCounter = 200;
  const events: ParsedEscrowEvent[] = [];
  const create = createEvent();           events.push(create);
  const lock = lockEvent(create.raw.id);  events.push(lock);
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);  events.push(v1);
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);  events.push(v2);
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id); events.push(resolve);
  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);            events.push(claim);
  const complete = completeEvent(claim.raw.id);                              events.push(complete);

  const result = replayEventChain(events);
  if (assertOk(result, "Replay succeeds without any JOIN events")) {
    assert(result.state.status === EscrowStatus.COMPLETED,
      "Trade completes from CREATE→LOCK→VOTE→RESOLVE→CLAIM→COMPLETE — no JOIN ceremony required");
    assert(result.state.participants[Role.BUYER] === BUYER_PK,
      "Buyer slot populated by LOCK payload, not JOIN");
    assert(result.state.participants[Role.ARBITER] === ARBITER_PK,
      "Arbiter slot populated by LOCK payload, not JOIN");
  }
}

// ── 10. EVENT PARSER ──────────────────────────────────────────────────────
console.log("\n── EVENT PARSER ──");
{
  const raw: NostrEvent = {
    id: "parser_test_1",
    pubkey: SELLER_PK,
    created_at: NOW,
    kind: EscrowEventKind.CREATE,
    tags: [["d", "test-123"]],
    content: "encrypted_content",
    sig: "sig_test",
  };

  const decrypted = JSON.stringify({
    type: "escrow:create",
    description: "Test listing",
    amountMsats: 50_000_000,
    category: "marketplace",
    mintUrl: "fed://test",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    expirySeconds: 3600,
    createdAt: NOW,
  });

  const result = parseEscrowEvent(raw, decrypted, true);
  assert(result.ok === true, "Parser accepts valid CREATE event");
  if (result.ok) {
    assert(result.event.escrowId === "test-123", "Escrow ID extracted");
    assert(result.event.kind === EscrowEventKind.CREATE, "Kind parsed");
    assert((result.event.payload as CreatePayload).description === "Test listing", "Payload parsed");
  }

  // Bad kind
  const badRaw = { ...raw, kind: 99999, id: "bad_kind" };
  assert(!parseEscrowEvent(badRaw, decrypted, true).ok, "Parser rejects unknown kind");

  // Retired READY kind 38109 — must now reject as INVALID_KIND
  const retiredReady = { ...raw, kind: 38109, id: "retired_ready" };
  assert(!parseEscrowEvent(retiredReady, decrypted, true).ok, "Parser rejects retired READY kind");

  // Retired KICK kind 38110 — must now reject as INVALID_KIND
  const retiredKick = { ...raw, kind: 38110, id: "retired_kick" };
  assert(!parseEscrowEvent(retiredKick, decrypted, true).ok, "Parser rejects retired KICK kind");

  // LOCK without buyerPubkey/arbiterPubkey → INVALID_PAYLOAD
  const badLockContent = JSON.stringify({
    type: "escrow:lock",
    notesHash: "h",
    shares: [
      { shareIndex: 0, encryptedFor: { x: "y" } },
      { shareIndex: 1, encryptedFor: { x: "y" } },
      { shareIndex: 2, encryptedFor: { x: "y" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    lockedAt: NOW,
  });
  const badLockRaw = { ...raw, kind: EscrowEventKind.LOCK, id: "no_pubkeys", tags: [["d", "no-pks"]] };
  assert(!parseEscrowEvent(badLockRaw, badLockContent, true).ok,
    "Parser rejects LOCK without buyerPubkey/arbiterPubkey");

  // Missing d-tag
  const noDTag = { ...raw, tags: [], id: "no_d" };
  assert(!parseEscrowEvent(noDTag, decrypted, true).ok, "Parser rejects missing d-tag");

  // Bad JSON
  assert(!parseEscrowEvent(raw, "not json {{{", true).ok, "Parser rejects invalid JSON");
}

// ── 11. CHAIN SORTING ────────────────────────────────────────────────────
console.log("\n── CHAIN SORTING ──");
{
  eventCounter = 300;

  const create = createEvent();
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);

  const unsorted = [j2, create, j1];
  const sorted = sortEventChain(unsorted);

  assert(sorted[0].raw.id === create.raw.id, "CREATE first after sort");
  assert(sorted[1].raw.id === j1.raw.id, "JOIN (buyer) second");
  assert(sorted[2].raw.id === j2.raw.id, "JOIN (arbiter) third");
}

// ── 12. FILTER BUILDER ───────────────────────────────────────────────────
console.log("\n── FILTER BUILDER ──");
{
  const filter = buildEscrowFilter("my-escrow-123");
  assert(Array.isArray(filter.kinds), "Filter has kinds array");
  assert(filter.kinds.includes(EscrowEventKind.CREATE), "Filter includes CREATE kind");
  assert(filter["#d"]?.[0] === "my-escrow-123", "Filter targets escrow ID");
}

// ── 13. EXPIRY ────────────────────────────────────────────────────────────
console.log("\n── EXPIRY ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  assert(!isExpired(state, NOW + 100), "Not expired within window");
  assert(isExpired(state, NOW + 100_000), "Expired past deadline");
}

// ══════════════════════════════════════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
