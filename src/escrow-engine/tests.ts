// ══════════════════════════════════════════════════════════════════════════
// Chama Escrow Engine — Test Suite (PR 1 atomic funding + PR 2 community)
// ══════════════════════════════════════════════════════════════════════════
//
// Run: npx tsx src/escrow-engine/tests.ts
//
// Tests the pure state machine with synthetic events — no relays, no
// crypto, no network. Just state transitions and invariants for:
//
//   PR 1 — atomic funding spine:
//     - LOCK fires directly from CREATED (no FUNDED, no READY ceremony)
//     - LOCK is self-describing: carries buyerPubkey + arbiterPubkey
//     - JOIN is ACK only — records pubkey but does NOT transition state
//     - Double-LOCK rejected (atomic, not idempotent-with-side-effects)
//     - Arbiter must be from communityArbiters pool when present
//     - LOCK pubkeys consistent with any prior JOIN ACKs
//
//   PR 2 — community + listing schema + BLF resolver + vote labels:
//     - Community registry lookup (valid/missing/null slug)
//     - User community storage (default + persistence)
//     - BLF fallback in resolveFederationForCommunity
//     - Fulfillment normalization in handleCreate (auto-set per category)
//     - Vote label dictionary returns the right copy per
//       (category, fulfillment, role, outcome) tuple

// PR 2: minimal localStorage stub for the storage + resolver tests.
// The escrow modules already gate on `typeof localStorage !== "undefined"`,
// so installing this stub before any imports lets the storage-aware code
// paths run under tsx in Node without ceremony.
(globalThis as any).localStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
  };
})();

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

// PR 2 imports
import {
  COMMUNITY_REGISTRY,
  DEFAULT_COMMUNITY_SLUG,
  getCommunityBySlug,
} from "../communities/registry.js";
import {
  getUserCommunitySlug,
  setUserCommunitySlug,
  COMMUNITY_STORAGE_KEY,
} from "../communities/storage.js";
import {
  resolveFederationForCommunity,
  setCustomFederationInvite,
  DEFAULT_FEDERATION_INVITE,
} from "../fedimint/federation-config.js";
import {
  getVoteLabel,
  defaultFulfillmentFor,
  categoryAllowsFulfillmentChoice,
} from "../labels/vote-labels.js";

// PR 3 imports
import {
  RAIL_REGISTRY,
  getRailByKey,
  railsForCommunity,
  railAllowsPublicHandle,
} from "../payments/rail-registry.js";
import {
  SAVED_HANDLES_STORAGE_KEY,
  listSavedHandles,
  getSavedHandle,
  getSavedHandlesByRail,
  addSavedHandle,
  deleteSavedHandle,
  updateSavedHandle,
  setHandleVisibility,
  maskHandle,
  publicHandleDisplay,
  handleDisplayForViewer,
} from "../payments/saved-handles.js";

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
// PR 2 — community + listing schema + BLF resolver + vote labels
// ══════════════════════════════════════════════════════════════════════════

// ── 14. COMMUNITY REGISTRY + STORAGE ─────────────────────────────────────
console.log("\n── COMMUNITY REGISTRY + STORAGE ──");
{
  // Registry shape — load-bearing seeds present
  assert(COMMUNITY_REGISTRY.length === 4, "Registry has the 4 PR 2 seeds");
  assert(getCommunityBySlug("sn-cfa")?.currency === "XOF", "sn-cfa is XOF");
  assert(getCommunityBySlug("ke-kes")?.currency === "KES", "ke-kes is KES");
  assert(getCommunityBySlug("sv-usd")?.currency === "USD", "sv-usd is USD");
  assert(getCommunityBySlug("global-usd")?.currency === "USD", "global-usd is USD");
  assert(DEFAULT_COMMUNITY_SLUG === "global-usd", "Default community is global-usd");

  // Lookup with valid + missing slug
  assert(getCommunityBySlug("sn-cfa") !== null, "Valid slug returns community");
  assert(getCommunityBySlug("xx-zz") === null, "Unknown slug returns null");
  assert(getCommunityBySlug(null) === null, "Null slug returns null");
  assert(getCommunityBySlug(undefined) === null, "Undefined slug returns null");

  // All seeds default to BLF (federationInvite === null) for v1
  const allUseBlf = COMMUNITY_REGISTRY.every(c => c.federationInvite === null);
  assert(allUseBlf, "All v1 seed communities fall back to BLF (federationInvite null)");

  // Storage roundtrip — defaults to global-usd when nothing set
  (globalThis as any).localStorage.clear();
  assert(getUserCommunitySlug() === "global-usd",
    "getUserCommunitySlug defaults to global-usd when nothing stored");

  // Set + read
  setUserCommunitySlug("sn-cfa");
  assert(getUserCommunitySlug() === "sn-cfa", "Persisted slug round-trips");

  // Stale/invalid slug falls back to default rather than flowing through
  (globalThis as any).localStorage.setItem(COMMUNITY_STORAGE_KEY, "ghost-fed");
  assert(getUserCommunitySlug() === "global-usd",
    "Unknown stored slug falls back to default (registry validation)");

  // Clear via empty string
  setUserCommunitySlug("ke-kes");
  assert(getUserCommunitySlug() === "ke-kes", "Pre-clear: ke-kes set");
  setUserCommunitySlug("");
  assert(getUserCommunitySlug() === "global-usd", "Empty string clears, falls to default");
}

// ── 15. BLF RESOLVER ─────────────────────────────────────────────────────
console.log("\n── BLF RESOLVER ──");
{
  // No custom invite, no community: pure BLF fallback
  (globalThis as any).localStorage.clear();
  assert(resolveFederationForCommunity(null) === DEFAULT_FEDERATION_INVITE,
    "Null slug → BLF default");
  assert(resolveFederationForCommunity(undefined) === DEFAULT_FEDERATION_INVITE,
    "Undefined slug → BLF default");
  assert(resolveFederationForCommunity("xx-unknown") === DEFAULT_FEDERATION_INVITE,
    "Unknown slug → BLF default");

  // Known community whose federationInvite is null → still BLF (the
  // load-bearing v1 invariant: communities without their own federation
  // are silently backed by BLF, not blocked).
  assert(resolveFederationForCommunity("sn-cfa") === DEFAULT_FEDERATION_INVITE,
    "Community with null federationInvite → BLF fallback");
  assert(resolveFederationForCommunity("ke-kes") === DEFAULT_FEDERATION_INVITE,
    "ke-kes → BLF fallback");
  assert(resolveFederationForCommunity("global-usd") === DEFAULT_FEDERATION_INVITE,
    "global-usd → BLF fallback");

  // Custom invite override beats community resolution
  const fakeCustomInvite = "fed1qcustom_user_pasted_invite_for_resolver_test";
  setCustomFederationInvite(fakeCustomInvite);
  assert(resolveFederationForCommunity("sn-cfa") === fakeCustomInvite,
    "Custom invite overrides community resolution");
  assert(resolveFederationForCommunity(null) === fakeCustomInvite,
    "Custom invite overrides null slug too");

  // Cleanup so other tests aren't poisoned
  setCustomFederationInvite("");
  assert(resolveFederationForCommunity("sn-cfa") === DEFAULT_FEDERATION_INVITE,
    "After clearing custom invite, falls back to BLF again");
}

// ── 16. FULFILLMENT NORMALIZATION ────────────────────────────────────────
console.log("\n── FULFILLMENT NORMALIZATION (handleCreate) ──");
{
  // Helper to build a CREATE with a specific category + fulfillment
  function createWith(category: string, fulfillment?: "physical" | "service" | "digital") {
    return makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create",
      description: "test",
      amountMsats: 100_000_000,
      category,
      fulfillment,
      community: "sn-cfa",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
  }

  // Marketplace + explicit pick → preserved
  {
    const r = applyEvent(null, createWith("marketplace", "digital"));
    if (assertOk(r, "Marketplace + digital → CREATED")) {
      assert(r.state.fulfillment === "digital", "Marketplace user pick preserved (digital)");
      assert(r.state.community === "sn-cfa", "Community slug propagated to state");
    }
  }
  {
    const r = applyEvent(null, createWith("marketplace", "service"));
    if (assertOk(r, "Marketplace + service → CREATED")) {
      assert(r.state.fulfillment === "service", "Marketplace user pick preserved (service)");
    }
  }

  // Marketplace + missing → defaults to "physical"
  {
    const r = applyEvent(null, createWith("marketplace"));
    if (assertOk(r, "Marketplace + missing fulfillment → CREATED")) {
      assert(r.state.fulfillment === "physical",
        "Marketplace defaults to physical when fulfillment missing");
    }
  }

  // Non-marketplace → forced to "service" regardless of input
  for (const cat of ["p2p-trade", "bill-pay", "lending"]) {
    const r1 = applyEvent(null, createWith(cat));
    if (assertOk(r1, `${cat} + missing fulfillment → CREATED`)) {
      assert(r1.state.fulfillment === "service",
        `${cat} fulfillment defaults to "service" when missing`);
    }
    // Even if a misbehaving client passed "physical", normalize to service
    const r2 = applyEvent(null, createWith(cat, "physical"));
    if (assertOk(r2, `${cat} + (incorrect) physical → CREATED`)) {
      assert(r2.state.fulfillment === "service",
        `${cat} normalizes wire fulfillment back to "service" (chain consistency)`);
    }
  }

  // Community is null when CREATE omits it (pre-PR-2 backwards compat)
  {
    const noCommunity = makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create",
      description: "test",
      amountMsats: 100_000_000,
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const r = applyEvent(null, noCommunity);
    if (assertOk(r, "CREATE without community → CREATED")) {
      assert(r.state.community === null, "community is null when omitted (backwards compat)");
    }
  }
}

// ── 17. VOTE LABEL DICTIONARY ────────────────────────────────────────────
console.log("\n── VOTE LABEL DICTIONARY ──");
{
  // Helpers
  assert(defaultFulfillmentFor("marketplace") === "physical",
    "Marketplace default fulfillment is physical");
  assert(defaultFulfillmentFor("p2p-trade") === "service",
    "p2p-trade default fulfillment is service");
  assert(defaultFulfillmentFor("bill-pay") === "service",
    "bill-pay default fulfillment is service");
  assert(defaultFulfillmentFor(undefined) === "service",
    "Undefined category default fulfillment is service");
  assert(categoryAllowsFulfillmentChoice("marketplace") === true,
    "Marketplace allows fulfillment choice");
  assert(categoryAllowsFulfillmentChoice("p2p-trade") === false,
    "p2p-trade does NOT allow fulfillment choice");
  assert(categoryAllowsFulfillmentChoice("bill-pay") === false,
    "bill-pay does NOT allow fulfillment choice");

  // Marketplace — three fulfillments × buyer/seller × release/refund
  assert(getVoteLabel("marketplace", "physical", Role.BUYER, Outcome.RELEASE) === "I received it",
    "marketplace/physical/buyer/release = 'I received it'");
  assert(getVoteLabel("marketplace", "physical", Role.SELLER, Outcome.RELEASE) === "Item delivered",
    "marketplace/physical/seller/release = 'Item delivered'");
  assert(getVoteLabel("marketplace", "physical", Role.BUYER, Outcome.REFUND) === "I didn't get it",
    "marketplace/physical/buyer/refund = 'I didn't get it'");
  assert(getVoteLabel("marketplace", "service", Role.BUYER, Outcome.RELEASE) === "I received the service",
    "marketplace/service/buyer/release");
  assert(getVoteLabel("marketplace", "service", Role.SELLER, Outcome.RELEASE) === "Service rendered",
    "marketplace/service/seller/release");
  assert(getVoteLabel("marketplace", "digital", Role.BUYER, Outcome.RELEASE) === "I received the file",
    "marketplace/digital/buyer/release");
  assert(getVoteLabel("marketplace", "digital", Role.SELLER, Outcome.RELEASE) === "Delivered",
    "marketplace/digital/seller/release");
  assert(getVoteLabel("marketplace", "digital", Role.BUYER, Outcome.REFUND) === "File never arrived",
    "marketplace/digital/buyer/refund");

  // P2P (always service)
  assert(getVoteLabel("p2p-trade", "service", Role.BUYER, Outcome.RELEASE) === "I sent the fiat",
    "p2p/buyer/release = 'I sent the fiat'");
  assert(getVoteLabel("p2p-trade", "service", Role.SELLER, Outcome.RELEASE) === "Fiat received",
    "p2p/seller/release = 'Fiat received'");

  // Bill Pay — payer is the seller (sats-receiver), payee is the buyer (bill-holder)
  assert(getVoteLabel("bill-pay", "service", Role.BUYER, Outcome.RELEASE) === "My bill was paid",
    "bill-pay/buyer/release = 'My bill was paid'");
  assert(getVoteLabel("bill-pay", "service", Role.SELLER, Outcome.RELEASE) === "Bill has been paid",
    "bill-pay/seller/release = 'Bill has been paid'");

  // Lending (placeholder labels for v1)
  assert(getVoteLabel("lending", "service", Role.BUYER, Outcome.RELEASE) === "I got the loan",
    "lending/buyer/release = 'I got the loan'");
  assert(getVoteLabel("lending", "service", Role.SELLER, Outcome.RELEASE) === "Loan disbursed",
    "lending/seller/release = 'Loan disbursed'");

  // Arbiter neutral fallback
  assert(getVoteLabel("marketplace", "physical", Role.ARBITER, Outcome.RELEASE) === "Side with buyer",
    "Arbiter RELEASE = 'Side with buyer' (neutral)");
  assert(getVoteLabel("p2p-trade", "service", Role.ARBITER, Outcome.REFUND) === "Side with seller",
    "Arbiter REFUND = 'Side with seller' (neutral)");

  // Unknown category falls through to neutral
  assert(getVoteLabel("raw-escrow", "service", Role.BUYER, Outcome.RELEASE) === "Release sats",
    "Unknown category → neutral 'Release sats'");
  assert(getVoteLabel(undefined, undefined, Role.SELLER, Outcome.REFUND) === "Refund sats",
    "Undefined category+fulfillment → neutral 'Refund sats'");

  // Marketplace + missing fulfillment falls back to neutral (the dictionary
  // requires an explicit fulfillment for marketplace; defaultFulfillmentFor
  // is what callers should use to fill it in beforehand).
  // Sanity: when callers DO use the default, marketplace/buyer/release lands.
  assert(getVoteLabel("marketplace", defaultFulfillmentFor("marketplace"), Role.BUYER, Outcome.RELEASE)
    === "I received it",
    "Using defaultFulfillmentFor('marketplace') yields the physical labels");
}

// ══════════════════════════════════════════════════════════════════════════
// PR 3 — saved payment handles + handle reveal in LOCK
// ══════════════════════════════════════════════════════════════════════════

// ── 18. RAIL REGISTRY + allowPublicHandle ─────────────────────────────────
console.log("\n── RAIL REGISTRY ──");
{
  // Sanity: registry loaded with v1 seeds
  assert(RAIL_REGISTRY.length > 0, "Rail registry has entries");

  // Sensitive rails (phone-number-based, bank, email-based) MUST NOT
  // allow public handles. This is the defense-in-depth invariant.
  assert(railAllowsPublicHandle("wave") === false,
    "Wave (Senegal mobile money) does NOT allow public handles");
  assert(railAllowsPublicHandle("orange-money") === false,
    "Orange Money does NOT allow public handles");
  assert(railAllowsPublicHandle("m-pesa") === false,
    "M-Pesa does NOT allow public handles");
  assert(railAllowsPublicHandle("bank-transfer") === false,
    "Bank transfer does NOT allow public handles");
  assert(railAllowsPublicHandle("paypal") === false,
    "PayPal (email-based) does NOT allow public handles");
  assert(railAllowsPublicHandle("zelle") === false,
    "Zelle does NOT allow public handles");
  assert(railAllowsPublicHandle("venmo") === false,
    "Venmo defaults to private (handle-can-be-PII-adjacent)");

  // Public-by-design tags MUST allow public handles (the username IS
  // the address — opt-in publishing is the whole point).
  assert(railAllowsPublicHandle("revtag") === true,
    "Revtag allows public handles (public-by-design)");
  assert(railAllowsPublicHandle("cashtag") === true,
    "$cashtag allows public handles");
  assert(railAllowsPublicHandle("zbd") === true,
    "ZBD username allows public handles");
  assert(railAllowsPublicHandle("wise-tag") === true,
    "Wise tag allows public handles");
  assert(railAllowsPublicHandle("strike") === true,
    "Strike allows public handles");

  // Unknown rail → conservative refusal (don't promote unfamiliar
  // handles to public by accident).
  assert(railAllowsPublicHandle("never-heard-of-it") === false,
    "Unknown rail conservatively refuses public");
  assert(railAllowsPublicHandle(null) === false,
    "Null rail conservatively refuses public");

  // railsForCommunity: region-scoped + cross-community filtering
  const senegal = railsForCommunity("sn-cfa");
  assert(senegal.some(r => r.key === "wave"),
    "sn-cfa community shows Wave");
  assert(senegal.some(r => r.key === "orange-money"),
    "sn-cfa community shows Orange Money");
  assert(senegal.some(r => r.key === "revtag"),
    "sn-cfa community ALSO shows global rails (Revtag)");
  assert(!senegal.some(r => r.key === "m-pesa"),
    "sn-cfa community does NOT show m-pesa (Kenya-only)");

  const kenya = railsForCommunity("ke-kes");
  assert(kenya.some(r => r.key === "m-pesa"),
    "ke-kes community shows M-Pesa");
  assert(!kenya.some(r => r.key === "wave"),
    "ke-kes community does NOT show Wave (Senegal-only)");

  // Lookup
  assert(getRailByKey("revtag")?.displayName === "Revtag (Revolut)",
    "getRailByKey returns the right rail");
  assert(getRailByKey("xyz") === null, "Unknown key → null");
  assert(getRailByKey(null) === null, "Null key → null");
}

// ── 19. SAVED HANDLES — CRUD + visibility refusal ────────────────────────
console.log("\n── SAVED HANDLES (CRUD + visibility) ──");
{
  // Reset storage so this section starts clean
  (globalThis as any).localStorage.clear();
  assert(listSavedHandles().length === 0, "Fresh storage starts empty");

  // Add — defaults to private
  const a = addSavedHandle("revtag", "@alice");
  assert(a.id.startsWith("h_"), "addSavedHandle returns a generated ID");
  assert(a.rail === "revtag", "Saved rail matches");
  assert(a.handle === "@alice", "Saved handle matches");
  assert(a.visibility === "private", "New handles default to private");
  assert(typeof a.createdAt === "number", "createdAt set");

  // Round-trip: reading back returns the same shape
  const list1 = listSavedHandles();
  assert(list1.length === 1, "List shows 1 entry after add");
  assert(list1[0].id === a.id, "Round-trip ID matches");

  // Whitespace trimmed
  const trimmed = addSavedHandle("revtag", "  @bob  ");
  assert(trimmed.handle === "@bob", "addSavedHandle trims whitespace");

  // Empty handle rejected
  let threw = false;
  try { addSavedHandle("revtag", "   "); } catch { threw = true; }
  assert(threw, "addSavedHandle rejects empty handle (post-trim)");

  // getSavedHandle by ID
  assert(getSavedHandle(a.id)?.handle === "@alice",
    "getSavedHandle returns matching entry");
  assert(getSavedHandle("h_nope") === null,
    "getSavedHandle returns null for unknown ID");

  // getSavedHandlesByRail filters and orders newest-first
  const senegal = addSavedHandle("wave", "+221 77 555 1234");
  const byRevtag = getSavedHandlesByRail("revtag");
  assert(byRevtag.length === 2, "Two revtag handles");
  assert(byRevtag.every(h => h.rail === "revtag"),
    "getSavedHandlesByRail filters correctly");
  assert(getSavedHandlesByRail("wave").length === 1, "One wave handle");

  // Update
  const updated = updateSavedHandle(a.id, { handle: "@alice.new" });
  assert(updated?.handle === "@alice.new", "updateSavedHandle changes handle");
  assert(updated?.id === a.id, "ID preserved on update");
  assert(getSavedHandle(a.id)?.handle === "@alice.new",
    "Update persisted to storage");

  // Visibility — public allowed for revtag (allowPublicHandle: true)
  const setPublic = setHandleVisibility(a.id, "public");
  assert(setPublic.ok === true, "Setting Revtag handle to public succeeds");
  if (setPublic.ok) {
    assert(setPublic.handle.visibility === "public",
      "Returned handle shows public");
  }
  assert(getSavedHandle(a.id)?.visibility === "public",
    "Public visibility persisted");

  // Visibility — public REJECTED for wave (allowPublicHandle: false).
  // Defense in depth: even if the UI accidentally renders the toggle,
  // this layer refuses the change.
  const setPublicSensitive = setHandleVisibility(senegal.id, "public");
  assert(setPublicSensitive.ok === false,
    "Setting Wave handle to public is REJECTED (defense in depth)");
  if (!setPublicSensitive.ok) {
    assert(/doesn't allow public/i.test(setPublicSensitive.error),
      "Refusal carries an explanatory message");
  }
  // And the storage is unchanged
  assert(getSavedHandle(senegal.id)?.visibility === "private",
    "Sensitive handle remains private after rejected upgrade");

  // Setting back to private is always allowed
  const back = setHandleVisibility(a.id, "private");
  assert(back.ok === true, "Setting back to private always allowed");
  assert(getSavedHandle(a.id)?.visibility === "private",
    "Private downgrade persisted");

  // Visibility on unknown ID errors cleanly
  const setMissing = setHandleVisibility("h_does_not_exist", "private");
  assert(setMissing.ok === false, "Visibility on unknown ID returns error");

  // Delete
  deleteSavedHandle(a.id);
  assert(getSavedHandle(a.id) === null, "deleteSavedHandle removes the entry");
  assert(listSavedHandles().length === 2, "Other entries unaffected by delete");
}

// ── 20. MASKING + handleDisplayForViewer ─────────────────────────────────
console.log("\n── MASKING + viewer-aware display ──");
{
  // Phone-shaped: keep prefix + last 4
  assert(maskHandle("+221 77 123 4567").includes("•••"),
    "Phone handle gets masked");
  assert(maskHandle("+221 77 123 4567").endsWith("4567"),
    "Phone handle keeps last 4 digits");
  assert(maskHandle("+221 77 123 4567").startsWith("+221"),
    "Phone handle keeps country prefix");

  // Email-shaped: mask local + domain
  const masked = maskHandle("alice@example.com");
  assert(masked.includes("@"), "Email handle keeps the @");
  assert(masked.startsWith("a•••"), "Email keeps first char of local");

  // Generic short handle
  assert(maskHandle("@x") === "•••", "Very short handle fully masked");
  assert(maskHandle("@username").includes("•••"),
    "Generic handle gets masked");

  // handleDisplayForViewer — viewer-context decides everything
  assert(handleDisplayForViewer("+221 77 555 1234", true) === "+221 77 555 1234",
    "Participant viewer sees cleartext");
  assert(handleDisplayForViewer("+221 77 555 1234", false).includes("•••"),
    "Non-participant viewer sees masked output");
  // Critical invariant: non-participants see masked REGARDLESS of how
  // the data got into client state (e.g. legacy plaintext on wire).
  // The flag the seller set is irrelevant to viewer-side rendering.
  assert(handleDisplayForViewer("@public-handle", false).includes("•••"),
    "Non-participants see masked even for public-by-design handles");

  // publicHandleDisplay — visibility flag + rail policy gate
  (globalThis as any).localStorage.clear();
  const publicTag = addSavedHandle("revtag", "@bob");
  setHandleVisibility(publicTag.id, "public");
  const publicTagAfter = getSavedHandle(publicTag.id)!;
  assert(publicHandleDisplay(publicTagAfter) === "@bob",
    "publicHandleDisplay returns cleartext when public + allowed");

  const sensitive = addSavedHandle("wave", "+221 77 555 1234");
  // setHandleVisibility refused public above, so it's still private
  const sensitiveAfter = getSavedHandle(sensitive.id)!;
  assert(publicHandleDisplay(sensitiveAfter).includes("•••"),
    "publicHandleDisplay masks private (and sensitive-by-policy) handles");
}

// ── 21. LOCK PAYLOAD HANDLE PROPAGATION ──────────────────────────────────
console.log("\n── LOCK HANDLE PROPAGATION (atomic-funding flow) ──");
{
  // CREATE → LOCK with handleId/handle/rail in payload, verify state
  // captures the resolved handle on EscrowState.lock.handle.
  eventCounter = 400;

  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  assert(state.lock.handle === null,
    "Pre-LOCK: state.lock.handle is null");

  // Build a LOCK payload with handle fields
  const lockWithHandle = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    handleId: "h_seller_local_id_xyz",
    handle: "+221 77 555 1234",
    rail: "wave",
    lockedAt: NOW,
  }, create.raw.id);

  const r = applyEvent(state, lockWithHandle);
  if (assertOk(r, "LOCK with handle/rail/handleId → LOCKED")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status is LOCKED");
    assert(r.state.lock.handle !== null,
      "state.lock.handle populated by LOCK payload");
    assert(r.state.lock.handle?.value === "+221 77 555 1234",
      "Resolved handle cleartext stored on EscrowState");
    assert(r.state.lock.handle?.id === "h_seller_local_id_xyz",
      "handleId audit reference preserved");
    assert(r.state.lock.handle?.rail === "wave",
      "Rail key preserved");
  }

  // LOCK without handle fields (non-fiat trade) leaves lock.handle null
  eventCounter = 500;
  const create2 = createEvent();
  let state2 = (applyEvent(null, create2) as any).state;
  const lockBare = lockEvent(create2.raw.id);
  const r2 = applyEvent(state2, lockBare);
  if (assertOk(r2, "LOCK without handle fields → LOCKED")) {
    assert(r2.state.lock.handle === null,
      "state.lock.handle stays null when LOCK omits handle");
  }

  // Defense-in-depth: the masking gate at the render boundary still
  // applies even when state has cleartext locally. Non-participant
  // sees masked output regardless of what's in state.lock.handle.value.
  if (r.ok && r.state.lock.handle) {
    const cleartext = r.state.lock.handle.value;
    assert(handleDisplayForViewer(cleartext, true) === cleartext,
      "Participant view: full cleartext from LOCK");
    assert(handleDisplayForViewer(cleartext, false).includes("•••"),
      "Non-participant view: masked even though cleartext sits in state");
  }
}

// ── 22. EVENT PARSER — handle field validation ────────────────────────────
console.log("\n── EVENT PARSER (PR 3 LOCK handle fields) ──");
{
  const baseLock = {
    type: "escrow:lock" as const,
    notesHash: "h",
    shares: [
      { shareIndex: 0, encryptedFor: { x: "y" } },
      { shareIndex: 1, encryptedFor: { x: "y" } },
      { shareIndex: 2, encryptedFor: { x: "y" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  };
  const raw = {
    id: "lock_parse_test",
    pubkey: SELLER_PK,
    created_at: NOW,
    kind: EscrowEventKind.LOCK,
    tags: [["d", "lock-parse"]],
    content: "x",
    sig: "s",
  };

  // Valid: with all PR 3 fields
  const okWith = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, handleId: "h_x", handle: "@alice", rail: "revtag",
  }), true);
  assert(okWith.ok === true, "Parser accepts LOCK with handle fields");

  // Valid: without (optional)
  const okWithout = parseEscrowEvent(raw, JSON.stringify(baseLock), true);
  assert(okWithout.ok === true, "Parser accepts LOCK without handle fields");

  // Invalid: empty-string handle
  const badEmpty = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, handle: "",
  }), true);
  assert(!badEmpty.ok, "Parser rejects LOCK with empty-string handle");

  // Invalid: non-string rail
  const badRailType = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, rail: 123,
  }), true);
  assert(!badRailType.ok, "Parser rejects LOCK with non-string rail");
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
