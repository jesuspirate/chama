// ══════════════════════════════════════════════════════════════════════════
// Chama Escrow Engine — Test Suite
// ══════════════════════════════════════════════════════════════════════════
//
// Run: npx tsx src/escrow-engine/tests.ts
//
// Tests the pure state machine with synthetic events — no relays,
// no crypto, no network. Just state transitions.

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
  type ReadyPayload,
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

const BUYER_PK   = "aa".repeat(32);
const SELLER_PK  = "bb".repeat(32);
const ARBITER_PK = "cc".repeat(32);
const PLATFORM_PK = "dd".repeat(32);
const ESCROW_ID  = "test-escrow-001";

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

function createEvent(): ParsedEscrowEvent<CreatePayload> {
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

function lockEvent(prevId: string): ParsedEscrowEvent<LockPayload> {
  return makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock",
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "enc_0_for_buyer", [SELLER_PK]: "enc_0_for_seller", [ARBITER_PK]: "enc_0_for_arbiter" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "enc_1_for_buyer", [SELLER_PK]: "enc_1_for_seller", [ARBITER_PK]: "enc_1_for_arbiter" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "enc_2_for_buyer", [SELLER_PK]: "enc_2_for_seller", [ARBITER_PK]: "enc_2_for_arbiter" } },
    ],
    // v0.1.71: 2-way fee split (was 98_500_000 + 1_000_000 + 500_000).
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
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

function readyEvent(role: Role, pubkey: string, prevId: string): ParsedEscrowEvent<any> {
  return makeParsedEvent(EscrowEventKind.READY, pubkey, {
    type: "escrow:ready",
    role,
    readyAt: NOW + eventCounter,
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

// ══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════════

console.log("\n🧪 Chama Escrow Engine — Test Suite\n");

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
    assert(s.participants[Role.BUYER] === null, "Buyer slot empty");
    assert(s.participants[Role.ARBITER] === null, "Arbiter slot empty");
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

// ── 2. JOIN ───────────────────────────────────────────────────────────────
console.log("\n── JOIN ──");
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (assertOk(r2, "Buyer joins")) {
      assert(r2.state.participants[Role.BUYER] === BUYER_PK, "Buyer pubkey stored");
      assert(r2.state.status === EscrowStatus.CREATED, "Still CREATED (only 2 of 3)");

      const join2 = joinEvent(Role.ARBITER, ARBITER_PK, join1.raw.id);
      const r3 = applyEvent(r2.state, join2);
      if (assertOk(r3, "Arbiter joins → FUNDED")) {
        assert(r3.state.status === EscrowStatus.FUNDED, "Status transitions to FUNDED");
        assert(r3.state.participants[Role.ARBITER] === ARBITER_PK, "Arbiter pubkey stored");
        assert(r3.state.fees.arbiterMsats === 1_000_000, "Arbiter fee recorded");
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
      assertErr(applyEvent(r2.state, join3), "ROLE_TAKEN", "Duplicate role rejected");
    }
  }
}

// Can't join as initiator's role (seller slot already filled by initiator → ROLE_TAKEN)
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join = joinEvent(Role.SELLER, BUYER_PK, create.raw.id);
    assertErr(applyEvent(r1.state, join), "ROLE_TAKEN", "Can't join as initiator's role");
  }
}

// ── 3. LOCK ───────────────────────────────────────────────────────────────
console.log("\n── LOCK ──");
{
  // Get to FUNDED state
  const create = createEvent();
  let state = applyEvent(null, create).ok ? (applyEvent(null, create) as any).state : null;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = applyEvent(state, j1).ok ? (applyEvent(state, j1) as any).state : state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = applyEvent(state, j2).ok ? (applyEvent(state, j2) as any).state : state;

  assert(state.status === EscrowStatus.FUNDED, "Pre-condition: state is FUNDED");

  // All participants must confirm ready before lock
  const rb = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb) as any).state;
  const rs = readyEvent(Role.SELLER, SELLER_PK, rb.raw.id);
  state = (applyEvent(state, rs) as any).state;
  const ra = readyEvent(Role.ARBITER, ARBITER_PK, rs.raw.id);
  state = (applyEvent(state, ra) as any).state;

  const lock = lockEvent(ra.raw.id);
  const r = applyEvent(state, lock);
  if (assertOk(r, "Lock transitions to LOCKED")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status is LOCKED");
    assert(r.state.lock.notesHash === "hash_of_ecash_notes_abc123", "Notes hash stored");
    assert(r.state.lock.shares.size === 3, "3 SSS shares stored");
  }
}

// Lock with wrong amounts
{
  const create = createEvent();
  let state = applyEvent(null, create).ok ? (applyEvent(null, create) as any).state : null;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = applyEvent(state, j1).ok ? (applyEvent(state, j1) as any).state : state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = applyEvent(state, j2).ok ? (applyEvent(state, j2) as any).state : state;

  // Add READY events for lock test
  const rb2 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb2) as any).state;
  const rs2 = readyEvent(Role.SELLER, SELLER_PK, rb2.raw.id);
  state = (applyEvent(state, rs2) as any).state;
  const ra2 = readyEvent(Role.ARBITER, ARBITER_PK, rs2.raw.id);
  state = (applyEvent(state, ra2) as any).state;

  const badLock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "s0b", [SELLER_PK]: "s0s", [ARBITER_PK]: "s0a" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "s1b", [SELLER_PK]: "s1s", [ARBITER_PK]: "s1a" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "s2b", [SELLER_PK]: "s2s", [ARBITER_PK]: "s2a" } },
    ],
    // v0.1.71: 2-way split, still doesn't add up to 100_000_000
    sellerReceivesMsats: 90_000_000, // Doesn't add up
    arbiterFeeMsats: 1_000_000,
    lockedAt: NOW,
  }, ra2.raw.id);

  assertErr(applyEvent(state, badLock), "AMOUNT_MISMATCH", "Lock with wrong amounts rejected");

  // WRONG_LOCKER: buyer tries to lock in p2p-trade (only seller can)
  const buyerLock = makeParsedEvent(EscrowEventKind.LOCK, BUYER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "bl0b", [SELLER_PK]: "bl0s", [ARBITER_PK]: "bl0a" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "bl1b", [SELLER_PK]: "bl1s", [ARBITER_PK]: "bl1a" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "bl2b", [SELLER_PK]: "bl2s", [ARBITER_PK]: "bl2a" } },
    ],
    // v0.1.71: 2-way split summing to 100_000_000 so AMOUNT_MISMATCH
    // doesn't fire before WRONG_LOCKER does.
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    lockedAt: NOW,
  }, ra2.raw.id);
  assertErr(applyEvent(state, buyerLock), "WRONG_LOCKER", "Buyer can't lock in p2p-trade (seller must lock)");
}

// ── 4. VOTE — Happy Path ─────────────────────────────────────────────────
console.log("\n── VOTE (happy path: buyer+seller agree) ──");
{
  // Build to LOCKED state
  const events: ParsedEscrowEvent[] = [];
  const create = createEvent();
  events.push(create);
  let state = (applyEvent(null, create) as any).state;

  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  events.push(j1);
  state = (applyEvent(state, j1) as any).state;

  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  events.push(j2);
  state = (applyEvent(state, j2) as any).state;

  // Ready confirmations
  const rb3 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  events.push(rb3);
  state = (applyEvent(state, rb3) as any).state;
  const rs3 = readyEvent(Role.SELLER, SELLER_PK, rb3.raw.id);
  events.push(rs3);
  state = (applyEvent(state, rs3) as any).state;
  const ra3 = readyEvent(Role.ARBITER, ARBITER_PK, rs3.raw.id);
  events.push(ra3);
  state = (applyEvent(state, ra3) as any).state;

  const lock = lockEvent(ra3.raw.id);
  events.push(lock);
  state = (applyEvent(state, lock) as any).state;

  // Buyer votes release
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  const r1 = applyEvent(state, v1);
  if (assertOk(r1, "Buyer votes RELEASE")) {
    assert(r1.state.votes[Role.BUYER] === Outcome.RELEASE, "Buyer vote recorded");
    assert(r1.state.status === EscrowStatus.LOCKED, "Still LOCKED (need 2 votes + RESOLVE)");

    // Seller votes release
    const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
    const r2 = applyEvent(r1.state, v2);
    if (assertOk(r2, "Seller votes RELEASE")) {
      assert(r2.state.votes[Role.SELLER] === Outcome.RELEASE, "Seller vote recorded");
      assert(r2.state.status === EscrowStatus.LOCKED, "Still LOCKED (RESOLVE needed)");

      // canVote checks
      const cv = canVote(r2.state, ARBITER_PK);
      assert(!cv.canVote, "Arbiter can't vote when buyer+seller agree");

      // Resolve
      const resolve = resolveEvent(
        Outcome.RELEASE,
        [Role.BUYER, Role.SELLER],
        false,
        v2.raw.id
      );
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
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;
  // Ready
  const rb4 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb4) as any).state;
  const rs4 = readyEvent(Role.SELLER, SELLER_PK, rb4.raw.id);
  state = (applyEvent(state, rs4) as any).state;
  const ra4 = readyEvent(Role.ARBITER, ARBITER_PK, rs4.raw.id);
  state = (applyEvent(state, ra4) as any).state;

  const lock = lockEvent(ra4.raw.id);
  state = (applyEvent(state, lock) as any).state;

  // Buyer wants release, seller wants refund
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;

  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;

  // Arbiter should now be able to vote
  const cv = canVote(state, ARBITER_PK);
  assert(cv.canVote === true, "Arbiter CAN vote after disagreement");

  // Arbiter sides with seller (refund)
  const v3 = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.REFUND, v2.raw.id);
  const r = applyEvent(state, v3);
  if (assertOk(r, "Arbiter votes REFUND")) {
    // Resolve with refund outcome
    const resolve = resolveEvent(
      Outcome.REFUND,
      [Role.SELLER, Role.ARBITER],
      true,
      v3.raw.id
    );
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
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;
  // Ready
  const rb5 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb5) as any).state;
  const rs5 = readyEvent(Role.SELLER, SELLER_PK, rb5.raw.id);
  state = (applyEvent(state, rs5) as any).state;
  const ra5 = readyEvent(Role.ARBITER, ARBITER_PK, rs5.raw.id);
  state = (applyEvent(state, ra5) as any).state;

  const lock = lockEvent(ra5.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const earlyVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, lock.raw.id);
  assertErr(applyEvent(state, earlyVote), "ARBITER_TOO_EARLY", "Arbiter can't vote before buyer+seller");
}

// Double vote
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;
  // Ready
  const rb6 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb6) as any).state;
  const rs6 = readyEvent(Role.SELLER, SELLER_PK, rb6.raw.id);
  state = (applyEvent(state, rs6) as any).state;
  const ra6 = readyEvent(Role.ARBITER, ARBITER_PK, rs6.raw.id);
  state = (applyEvent(state, ra6) as any).state;

  const lock = lockEvent(ra6.raw.id);
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
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;
  // Ready
  const rb7 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb7) as any).state;
  const rs7 = readyEvent(Role.SELLER, SELLER_PK, rb7.raw.id);
  state = (applyEvent(state, rs7) as any).state;
  const ra7 = readyEvent(Role.ARBITER, ARBITER_PK, rs7.raw.id);
  state = (applyEvent(state, ra7) as any).state;

  const lock = lockEvent(ra7.raw.id);
  state = (applyEvent(state, lock) as any).state;
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  state = (applyEvent(state, resolve) as any).state;

  // Buyer claims
  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  const rc = applyEvent(state, claim);
  if (assertOk(rc, "Buyer claims → CLAIMED")) {
    assert(rc.state.status === EscrowStatus.CLAIMED, "Status is CLAIMED");

    // Wrong person tries to claim (should fail but we're past APPROVED now)
    // Complete
    const complete = completeEvent(claim.raw.id);
    const rf = applyEvent(rc.state, complete);
    if (assertOk(rf, "COMPLETE → terminal")) {
      assert(rf.state.status === EscrowStatus.COMPLETED, "Status is COMPLETED");

      // Try to do anything after COMPLETED
      const lateVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, complete.raw.id);
      assertErr(applyEvent(rf.state, lateVote), "TERMINAL_STATE", "No events after COMPLETED");
    }
  }

  // Wrong claimer
  state = (applyEvent(null, create) as any).state;
  state = (applyEvent(state, j1) as any).state;
  state = (applyEvent(state, j2) as any).state;
  state = (applyEvent(state, rb7) as any).state;
  state = (applyEvent(state, rs7) as any).state;
  state = (applyEvent(state, ra7) as any).state;
  state = (applyEvent(state, lock) as any).state;
  state = (applyEvent(state, v1) as any).state;
  state = (applyEvent(state, v2) as any).state;
  state = (applyEvent(state, resolve) as any).state;

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
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;
  // Ready
  const rb8 = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  state = (applyEvent(state, rb8) as any).state;
  const rs8 = readyEvent(Role.SELLER, SELLER_PK, rb8.raw.id);
  state = (applyEvent(state, rs8) as any).state;
  const ra8 = readyEvent(Role.ARBITER, ARBITER_PK, rs8.raw.id);
  state = (applyEvent(state, ra8) as any).state;

  const lock = lockEvent(ra8.raw.id);
  state = (applyEvent(state, lock) as any).state;

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
  }) as unknown as ParsedEscrowEvent<LockPayload>;

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

  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  events.push(j1);

  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  events.push(j2);

  // Ready
  const rbR = readyEvent(Role.BUYER, BUYER_PK, j2.raw.id);
  events.push(rbR);
  const rsR = readyEvent(Role.SELLER, SELLER_PK, rbR.raw.id);
  events.push(rsR);
  const raR = readyEvent(Role.ARBITER, ARBITER_PK, rsR.raw.id);
  events.push(raR);

  const lock = lockEvent(raR.raw.id);
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
    assert(result.state.eventChain.length === 12, "All 12 events in chain");
    assert(result.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

    console.log("\n  📋 State summary:");
    console.log("  " + getSummary(result.state).split("\n").join("\n  "));
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
  const badResult = parseEscrowEvent(badRaw, decrypted, true);
  assert(!badResult.ok, "Parser rejects unknown kind");

  // Missing d-tag
  const noDTag = { ...raw, tags: [], id: "no_d" };
  const noDResult = parseEscrowEvent(noDTag, decrypted, true);
  assert(!noDResult.ok, "Parser rejects missing d-tag");

  // Bad JSON
  const badJson = parseEscrowEvent(raw, "not json {{{", true);
  assert(!badJson.ok, "Parser rejects invalid JSON");
}

// ── 11. CHAIN SORTING ────────────────────────────────────────────────────
console.log("\n── CHAIN SORTING ──");
{
  eventCounter = 200;

  const create = createEvent();
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);

  // Feed them in wrong order
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
