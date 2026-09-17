import assert from "node:assert/strict";
import { circleCanvasRound, circleCanvasErrors, circleInviteId } from "./canvas.js";
import { nextRoundTemplate } from "./circle.js";
import { circleSurfaceModel, circleCardModel } from "./surface.js";
import { circleMemberStats } from "./stats.js";
import { EscrowEventKind, EscrowStatus, Outcome, type EscrowState } from "../escrow-engine/types.js";
import { circle as en } from "../i18n/en/circle.js";
import { circle as es } from "../i18n/es/circle.js";
import { circle as fr } from "../i18n/fr/circle.js";
import { circle as sw } from "../i18n/sw/circle.js";
const T = 1900000000;
assert.equal(circleInviteId(" https://getchama.app/?trade=sm_circle_123&sim=1 "), "sm_circle_123");
assert.equal(circleInviteId("https://getchama.app/?escrowId=sm_circle_123"), "sm_circle_123");
assert.equal(circleInviteId(" sm_circle_123 "), "sm_circle_123");
for (const malformed of ["", "https://getchama.app/", "https://getchama.app/?trade=invalid", "https://getchama.app/?trade=sm_circle%20extra", "prefix sm_circle_123 suffix", "sm_circle!", "https://getchama.app/sm_circle_123"]) {
  assert.equal(circleInviteId(malformed), null, malformed);
}
const input = { shareSats: 10000, threshold: 5, cap: null, createdAt: T, creatorPubkey: "host", community: "kenya", mintUrl: "fed1test", name: "Your Circle" };
const round = circleCanvasRound(input);
assert.deepEqual(circleCanvasErrors(round), []);
assert.equal(round.shareMsats, 10000000);
assert.equal(round.roundEndSec - T, 7 * 86400);
assert.equal(round.fillDeadlineSec - T, 3 * 86400);
assert(circleCanvasErrors(circleCanvasRound({ ...input, threshold: 1 })).length);
assert(circleCanvasErrors(circleCanvasRound({ ...input, cap: 4 })).length);
assert(circleCanvasErrors(circleCanvasRound({ ...input, shareSats: NaN })).length);
assert(circleCanvasErrors(circleCanvasRound({ ...input, shareSats: 0 })).length);
const fortnight = circleCanvasRound({ ...input, durationSec: 14 * 86400 });
assert.deepEqual(circleCanvasErrors(fortnight), []);
assert.equal(fortnight.fillDeadlineSec - T, 6 * 86400);
assert(circleCanvasErrors(circleCanvasRound({ ...input, durationSec: 15 * 86400 })).length);
const template = nextRoundTemplate({ ...round, circleId: "first" }, { circleId: "", startSec: T + 7 * 86400 });
const next = circleCanvasRound({ ...input, createdAt: template.createdAt, previous: template });
assert.equal(next.roundIndex, 2);
assert.equal(next.prevCircleId, "first");
assert.equal(circleCardModel(round, [], T).seatsLocked, null);
assert.equal(circleSurfaceModel(round, [], "host", T).move, "invite");
assert.equal(circleSurfaceModel(round, [], "member", T).move, "lock");
// Stats must come from completed, redeemed member rounds, not host activity.
const parent = { id: "circle", category: "chama", chamaCircle: { ...round, seatThreshold: 2 }, createdAt: T,
  description: round.name, community: "kenya", mintUrl: "fed1test", initiator: { pubkey: "host" } } as unknown as EscrowState;
const share = (id: string, member: string) => ({ id, category: "chama-share", chamaPolicy: "share-v1", parent: "circle", chamaCircle: parent.chamaCircle,
  participants: { buyer: member }, status: EscrowStatus.CLAIMED, resolvedOutcome: Outcome.REFUND, resolvedAt: round.roundEndSec,
  claim: { claimedAt: round.roundEndSec }, eventChain: [{ kind: EscrowEventKind.LOCK, timestamp: T + 3600 }] } as unknown as EscrowState);
const states = [parent, share("one", "member"), share("two", "other")];
const stats = circleMemberStats(states, "MEMBER", round.roundEndSec + 1);
assert.equal(stats.completed, 1); assert.equal(stats.onTime, 1); assert(stats.standing > 0);
assert.equal(circleMemberStats(states, "host", round.roundEndSec + 1).completed, 0);
assert.equal(circleMemberStats(states, "member", T + 5000).completed, 0);
assert.equal(circleMemberStats([parent, { ...states[1], status: EscrowStatus.APPROVED }, states[2]], "member", round.roundEndSec + 1).completed, 0);
for (const dictionary of [es, fr, sw]) {
  assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert(dictionary[key].trim());
    assert.deepEqual((dictionary[key].match(/\{\w+\}/g) ?? []).sort(), (en[key].match(/\{\w+\}/g) ?? []).sort(), key);
  }
}
console.log("Circle canvas defaults, deadlines, next-round lineage, stats and four-language contracts passed.");
