import assert from "node:assert/strict";
import { COLLECT_WINDOW_SEC, collectorForRound, rotationOrder, roundCircleId, roundOutcomeAt } from "./rotation.js";
import type { CircleShareLock } from "./types.js";
import { EscrowEventKind, Role, type EscrowState } from "../escrow-engine/types.js";

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

// ── collector per round: THE WEEKLY RACE ──────────────────────────────────
const order = rotationOrder(circle, locks);
const shareState = (parent: string, m: string, lockAt: number | null, policy: "share-v1" | "share-v2" = "share-v2") => ({
  chamaPolicy: policy, parent, participants: { [Role.BUYER]: m },
  eventChain: lockAt === null ? [] : [{ kind: EscrowEventKind.LOCK, timestamp: lockAt }],
} as unknown as EscrowState);
const R2C = roundCircleId(CID, 2), R3C = roundCircleId(CID, 3), R4C = roundCircleId(CID, 4);
const commit = [shareState(CID, M1, T + 10, "share-v1"), shareState(CID, M3, T + 20, "share-v1"),
  shareState(CID, M2, T + 30, "share-v1"), shareState(CID, HOST, T + 50, "share-v1")];
const U = T + 700_000, V = T + 1_400_000;
const race2 = [shareState(R2C, HOST, U + 1), shareState(R2C, M2, U + 5), shareState(R2C, M3, U + 9)];
const race3 = [shareState(R3C, M3, V + 1), shareState(R3C, HOST, V + 2), shareState(R3C, M1, V + 3)];
const all = [...commit, ...race2, ...race3];
assert.equal(collectorForRound(CID, order, HOST, all, 1), null, "round 1 is the commitment round — no collector");
assert.equal(collectorForRound(CID, order, HOST, all, 2), M1, "the fastest commitment locker collects first");
assert.equal(collectorForRound(CID, order, HOST, all, 3), M2, "the race re-runs: M2 out-locked M3 in round 2 and overtakes");
assert.equal(collectorForRound(CID, order, HOST, all, 4), M3, "the remaining member collects next");
assert.equal(collectorForRound(CID, order, HOST, all, 5), HOST, "the host collects last, regardless of speed");
assert.equal(collectorForRound(CID, order, HOST, all, 0), null);
assert.equal(collectorForRound(CID, order, HOST, all, 6), null, "no round beyond the rotation");
assert.equal(collectorForRound(CID, order, HOST, [...commit, ...race3], 3), null, "no round-2 locks, no lawful round-3 collector");
assert.equal(collectorForRound(CID, [], HOST, all, 2), null);
// A backdating tie collapses to the pubkey tiebreak — degenerate but deterministic.
const tied = [...commit, shareState(R2C, M2, U), shareState(R2C, M3, U)];
assert.equal(collectorForRound(CID, order, HOST, tied, 3), M2 < M3 ? M2 : M3, "ties break by pubkey");
// Non-members racing in a round are invisible to the queue.
const crashed = [...commit, shareState(R2C, "99".repeat(32), U - 50), ...race2];
assert.equal(collectorForRound(CID, order, HOST, crashed, 3), M2, "outsider locks never rank");

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

// Canvas: sub-day test-drive rounds get a real (unquantized) fill window.
import { circleCanvasRound } from "./canvas.js";
import { validateCircleRound } from "./circle.js";
const testDrive = circleCanvasRound({ shareSats: 1000, threshold: 2, cap: 3, durationSec: 600,
  createdAt: T, creatorPubkey: HOST, community: "", mintUrl: "fed1sim", name: "Test drive" });
assert.equal(testDrive.fillDeadlineSec, T + 300, "half the drive is tab-gathering time");
assert.equal(testDrive.roundEndSec, T + 600);
assert.equal(validateCircleRound(testDrive).length, 0, "a five-minute circle is structurally lawful");
console.log("Sim canvas assertions passed.");
