import assert from "node:assert/strict";
import { COLLECT_WINDOW_SEC, collectorForRound, rotationOrder, roundCircleId, roundOutcomeAt } from "./rotation.js";
import type { CircleShareLock } from "./types.js";

const HOST = "aa".repeat(32), M1 = "11".repeat(32), M2 = "22".repeat(32), M3 = "33".repeat(32);
const CID = "cc".repeat(32);
const T = 1_900_000_000;
const lock = (member: string, at: number | null, status: CircleShareLock["status"] = "locked", circleId = CID): CircleShareLock =>
  ({ circleId, memberPubkey: member, escrowId: at === null ? null : "ee".repeat(32), lockedAtSec: at, status, readyToClaim: false });
const circle = { circleId: CID, creatorPubkey: HOST };

// ── deterministic round ids ────────────────────────────────────────────────
assert.equal(roundCircleId(CID, 2), roundCircleId(CID.toUpperCase(), 2), "round ids are case-stable");
assert.notEqual(roundCircleId(CID, 2), roundCircleId(CID, 3));
assert.notEqual(roundCircleId(CID, 2), CID);
assert.throws(() => roundCircleId(CID, 1), "round 1 keeps its ordinary escrow id");
assert.throws(() => roundCircleId(CID, 1.5));

// ── rotation order: lock order, host last ─────────────────────────────────
const locks = [lock(M2, T + 30), lock(M1, T + 10), lock(HOST, T + 50), lock(M3, T + 20)];
assert.deepEqual(rotationOrder(circle, locks), [M1, M3, M2, HOST], "first to lock collects first; host pinned last");
assert.deepEqual(rotationOrder(circle, [lock(M1, T + 10), lock(HOST, T + 5)]), [M1, HOST], "host is last even when they locked first");
assert.deepEqual(rotationOrder(circle, [lock(M1, T + 10), lock(M2, T + 10)]), [M1, M2], "lock-time ties break by pubkey");
assert.deepEqual(rotationOrder(circle, [lock(M1, null, "reserved"), lock(M2, T + 10)]), [M2], "reserved seats never enter the rotation");
assert.deepEqual(rotationOrder(circle, [lock(M1, T + 10, "locked", "dd".repeat(32))]), [], "other circles' locks are invisible");
assert.deepEqual(rotationOrder(circle, [lock(M1, T + 10), lock(M1, T + 20)]), [M1], "one member, one seat");
assert.deepEqual(rotationOrder(circle, [lock(M1.toUpperCase(), T + 10)]), [M1], "pubkeys normalize");

// ── collector per round ────────────────────────────────────────────────────
const order = rotationOrder(circle, locks);
assert.equal(collectorForRound(order, 1), M1);
assert.equal(collectorForRound(order, 4), HOST, "the host's payday is the last round");
assert.equal(collectorForRound(order, 0), null);
assert.equal(collectorForRound(order, 5), null, "no round beyond the rotation");
assert.equal(collectorForRound([], 1), null);

// ── the deterministic-outcome law ─────────────────────────────────────────
const round = { fillDeadlineSec: T + 86_400, roundEndSec: T + 604_800 };
// Funding window, not yet filled: nothing resolves.
assert.equal(roundOutcomeAt(round, 2, 3, T + 100), "none");
// Filled early: still nothing until the payday — time only brings it closer.
assert.equal(roundOutcomeAt(round, 3, 3, T + 100), "none");
// Fill failed at the deadline: refund, immediately and forever.
assert.equal(roundOutcomeAt(round, 2, 3, T + 86_400), "refund");
assert.equal(roundOutcomeAt(round, 0, 3, T + 999_999_999), "refund");
// Filled: release from roundEnd through the collect window…
assert.equal(roundOutcomeAt(round, 3, 3, T + 86_400), "none", "filled but the round still runs");
assert.equal(roundOutcomeAt(round, 3, 3, T + 604_800), "release", "payday opens exactly at roundEnd");
assert.equal(roundOutcomeAt(round, 3, 3, T + 604_800 + COLLECT_WINDOW_SEC - 1), "release");
// …and refund again once the collector's window lapses: notes never rot.
assert.equal(roundOutcomeAt(round, 3, 3, T + 604_800 + COLLECT_WINDOW_SEC), "refund");
// Overfill counts as filled; an empty expectation never releases.
assert.equal(roundOutcomeAt(round, 4, 3, T + 604_800), "release");
assert.equal(roundOutcomeAt(round, 0, 0, T + 604_800), "refund", "a round expecting nobody can only refund");
console.log("Rotation v2 core: all assertions passed.");
