import assert from "node:assert/strict";
import { applyEvent } from "./state-machine.js";
import { oneSidedEscalationAt } from "./arbiter-substitution.js";
import { EscrowEventKind as K, Outcome as O, Role as R, type EscrowState, type EscrowPayload, type ParsedEscrowEvent } from "./types.js";
declare const __LEGACY_READER__: boolean;
const legacy = typeof __LEGACY_READER__ !== "undefined" && __LEGACY_READER__;
const T = 1900000000, SELLER = "11".repeat(32), BUYER = "22".repeat(32), ARB = "33".repeat(32), ID = "44".repeat(32);
let seq = 0;
const event = (kind: K, payload: EscrowPayload, pubkey: string, at: number, state?: EscrowState): ParsedEscrowEvent => {
  const prevEventId = state?.eventChain.at(-1)?.raw.id ?? null;
  const raw = { kind, id: (++seq).toString(16).padStart(64, "0"), content: JSON.stringify(payload), pubkey,
    sig: "00".repeat(64), created_at: at, tags: [["d", ID], ...(prevEventId ? [["e", prevEventId, "", "reply"]] : [])] };
  return { raw, payload, pubkey, timestamp: at, escrowId: ID, kind, prevEventId };
};
function accepted(state: EscrowState | null, e: ParsedEscrowEvent): EscrowState {
  const result = applyEvent(state, e); assert(result.ok, result.ok ? "" : result.error.message); return result.state;
}
let state = accepted(null, event(K.CREATE, { type: "escrow:create", category: "p2p-trade", description: "Reader compatibility",
  mintUrl: "test", amountMsats: 1000000, platformFeeBps: 0, platformFeePubkey: SELLER,
  arbiterFeeMsats: 0, communityArbiters: [ARB], createdAt: T, expirySeconds: 86400 }, SELLER, T));
state = accepted(state, event(K.LOCK, { type: "escrow:lock", notesHash: "hash", sharePolicy: "holder-only-v1",
  buyerPubkey: BUYER, arbiterPubkey: ARB, sellerReceivesMsats: 1000000, arbiterFeeMsats: 0, lockedAt: T + 1,
  shares: [{shareIndex:0,encryptedFor:{[BUYER]:"buyer"}}, {shareIndex:1,encryptedFor:{[SELLER]:"seller"}},
    {shareIndex:2,encryptedFor:{[ARB]:"arbiter"}}] }, SELLER, T + 1, state));
state = accepted(state, event(K.VOTE, { type: "escrow:vote", role: R.SELLER, outcome: O.REFUND, votedAt: T + 60 }, SELLER, T + 60, state));
const at = T + 60 + 4 * 3600;
const decision = event(K.VOTE, { type: "escrow:vote", role: R.ARBITER, outcome: O.REFUND, votedAt: at }, ARB, at, state);
const result = applyEvent(state, decision);
if (legacy) {
  assert.equal(oneSidedEscalationAt(state), null);
  assert(!result.ok);
  assert.equal(result.error.code, "ARBITER_TOO_EARLY", "pre-6.4.19 clock rejects the same signed-order chain");
} else {
  assert.equal(oneSidedEscalationAt(state), at);
  assert(result.ok, result.ok ? "" : result.error.message);
  const resolved = accepted(result.state, event(K.RESOLVE, { type: "escrow:resolve", outcome: O.REFUND,
    majority: [R.SELLER, R.ARBITER], arbiterInvolved: true, resolvedAt: at + 1 }, SELLER, at + 1, result.state));
  assert.equal(resolved.resolvedOutcome, O.REFUND);
}
console.log(`${legacy ? "Pre-6.4.19" : "6.4.19"} refund reader boundary: passed`);
