import assert from "node:assert/strict";
import { EscrowStatus, type EscrowState } from "../escrow-engine/types.js";
import {
  activeCommittedMsats,
  countActiveBuyerSellerCommitments,
  hasLockEvidence,
  liveCommitmentForViewer,
} from "./decisions.js";
import { EscrowEventKind } from "../escrow-engine/types.js";

const LOCK_EVENT = { kind: EscrowEventKind.LOCK } as never;

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const NOW = 1_800_000_000;

function trade(over: Partial<EscrowState>): EscrowState {
  return {
    id: "sm_test",
    status: EscrowStatus.APPROVED,
    amountMsats: 2_000_000,
    participants: { seller: THEM, buyer: ME },
    eventChain: [LOCK_EVENT],
    lock: { shares: new Map(), notesHash: "deadbeef", lockedAt: NOW - 200_000 },
    ...over,
  } as unknown as EscrowState;
}

const one = (e: EscrowState) => ({
  count: countActiveBuyerSellerCommitments({ escrows: [e], userPubkey: ME, nowSec: NOW }),
  msats: activeCommittedMsats({ escrows: [e], userPubkey: ME, nowSec: NOW }),
  live: liveCommitmentForViewer(e, ME, NOW),
});

// The trade that started this: decided, past its window, waiting to be claimed.
const approvedExpired = one(trade({ status: EscrowStatus.APPROVED, expiresAt: NOW - 86_400 }));
assert.equal(approvedExpired.msats, 2_000_000, "an approved payout is still the viewer's money");
assert.equal(approvedExpired.count, 1, "…so it counts as an active commitment");
assert.equal(approvedExpired.live, true, "…and the row it names can be highlighted");

// A LOCKED trade past its deadline is resolving via auto-refund: not live.
const lockedExpired = one(trade({ status: EscrowStatus.LOCKED, expiresAt: NOW - 86_400 }));
assert.equal(lockedExpired.msats, 0);
assert.equal(lockedExpired.count, 0);
assert.equal(lockedExpired.live, false);

// Ordinary cases are unchanged.
const lockedLive = one(trade({ status: EscrowStatus.LOCKED, expiresAt: NOW + 86_400 }));
assert.equal(lockedLive.count, 1);
assert.equal(lockedLive.msats, 2_000_000);
assert.equal(lockedLive.live, true);

const created = one(trade({ status: EscrowStatus.CREATED }));
assert.equal(created.count, 0);
assert.equal(created.msats, 0);

// The invariant the Math.max(1, …) clamp was hiding. Any state that carries
// committed sats must also carry a count, or the pill quotes a number for a
// trade that is in nobody's live set and therefore cannot be highlighted.
for (const status of [EscrowStatus.LOCKED, EscrowStatus.APPROVED]) {
  for (const expiresAt of [NOW - 86_400, NOW + 86_400, 0]) {
    const r = one(trade({ status, expiresAt }));
    assert.ok(
      r.msats === 0 || r.count > 0,
      `committed sats without an active count: ${String(status)} expiresAt=${expiresAt}`,
    );
    assert.equal(r.count > 0, r.live, "the count and the row predicate must agree");
  }
}

console.log("Escrow pill: one deadline rule across count, sats and row highlight");

// ── A summary is not an escrow ─────────────────────────────────────────────
// The chain could not be rebuilt on this device, so the saved summary supplies
// the status and the amount. EVENT_KIND_TRANSITIONS only reaches APPROVED from
// LOCKED, so this state asserts a LOCK — but there is none, on any relay or in
// this chain. It must not read as money in escrow. (sm_mtnxzb5y_zpepqcpj)
const summaryOnly = trade({
  status: EscrowStatus.APPROVED,
  expiresAt: NOW - 86_400,
  eventChain: [],
  lock: { shares: new Map() } as never,
});
assert.equal(hasLockEvidence(summaryOnly), false, "no LOCK event and no notes hash");
const phantom = one(summaryOnly);
assert.equal(phantom.msats, 0, "a summary without a LOCK holds no sats in escrow");
assert.equal(phantom.count, 0);
assert.equal(phantom.live, false);

// Either witness on its own is enough for a real trade.
assert.equal(hasLockEvidence(trade({ eventChain: [LOCK_EVENT], lock: { shares: new Map() } as never })), true);
assert.equal(hasLockEvidence(trade({ eventChain: [], lock: { shares: new Map(), lockedAt: 1 } as never })), true);
assert.equal(hasLockEvidence(trade({ eventChain: [], lock: { shares: new Map(), notesHash: "", lockedAt: 5 } as never })), true,
  "an on-chain lock has an empty notes hash — lockedAt is the witness");

console.log("Escrow pill: a saved summary without a LOCK is never counted as escrow");

// Part A: construction provenance is independent of a remembered status.
import { canOfferClaim, needsTradeHistory, stateProvenance } from "./decisions.js";
import { buildMeTradeCounts, filterMeTrades, isLiveTrade, isOpenListing, isDoneTrade, type MeTradeFilter } from "./me-trade-filters.js";
assert.equal(stateProvenance(summaryOnly), "summary");
assert.equal(canOfferClaim(summaryOnly), false);
assert.equal(needsTradeHistory(summaryOnly), true);
assert.equal(canOfferClaim(trade({ provenance: "summary" })), false, "even a summary with a remembered lock cannot promise a payout");
assert.equal(canOfferClaim(trade({ provenance: "replayed", eventChain: [], lock: {} as never })), false);
assert.equal(canOfferClaim(trade({ provenance: "replayed" })), true);
const statuses = Object.values(EscrowStatus);
const fixtures = statuses.flatMap(status => [false, true].flatMap(witness =>
  [NOW - 86400, NOW + 86400, 0].map(expiresAt => trade({
    id: `${status}-${witness}-${expiresAt}`, status, expiresAt,
    provenance: witness ? "replayed" : "summary",
    eventChain: witness ? [LOCK_EVENT] : [], lock: witness ? { lockedAt: 1 } as never : {} as never,
  }))));
for (const e of fixtures) {
  assert.ok(isLiveTrade(e) || isOpenListing(e) || isDoneTrade(e), `unreachable trade ${e.id}`);
  const r = one(e);
  assert.ok(r.msats === 0 || r.count > 0);
  assert.ok(r.count === 0 || filterMeTrades([e], [], "live").length > 0, `headline without a Live row ${e.id}`);
}
const needs = fixtures.slice(0, 3);
const counts = buildMeTradeCounts(fixtures, needs);
for (const filter of ["all", "needs", "live", "listings", "done"] as MeTradeFilter[]) {
  assert.equal(counts[filter], filterMeTrades(fixtures, needs, filter).length);
}
console.log("Part A: provenance, claim witness, partition and headline reachability");

// Exercise the actual detail renderer's copy decision, before any outcome branch.
import { detailNextStep } from "./screens/TradeDetail.js";
import { translate } from "../i18n/index.js";
for (const lang of ["en", "es", "fr", "sw"] as const) {
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const copy = detailNextStep({ state: summaryOnly, iAmWinner: true, t } as Parameters<typeof detailNextStep>[0]);
  assert.equal(copy.title, t("trade.historyUnverified"));
  assert.equal(copy.body, t("app.archivedIncomplete"));
  assert.notEqual(copy.title, t("trade.nsRefundedSatsBack"));
  assert.notEqual(copy.kicker, t("trade.nsReadyToClaim"));
}

assert.equal(one(trade({ provenance: "summary" })).count, 0, "a demoted snapshot cannot rehydrate a headline from a remembered timestamp");
assert.equal(one(trade({ provenance: "summary" })).msats, 0);
assert.equal(needsTradeHistory(trade({ provenance: "replayed", status: EscrowStatus.EXPIRED, eventChain: [], lock: {} as never })), false,
  "a replayed never-funded expiry is a verified history, not a failed reconstruction");

// A live seat must remain reachable when its circle's parent is still CREATED.
// Collapsing before filtering used to remove the only Live row from this set.
const circleParent = trade({ id: "circle", status: EscrowStatus.CREATED, category: "chama",
  chamaCircle: {} as never, initiator: { pubkey: ME } as never });
const ownSeat = trade({ id: "seat", parent: "circle", chamaPolicy: "share-v1", status: EscrowStatus.LOCKED,
  provenance: "replayed", expiresAt: NOW + 1000 });
const circleSet = [circleParent, ownSeat];
assert.equal(countActiveBuyerSellerCommitments({ escrows: circleSet, userPubkey: ME, nowSec: NOW }), 1);
assert.ok(filterMeTrades(circleSet, [], "live").length > 0, "circle collapse must not hide the headline's only live commitment");
for (const filter of ["all", "needs", "live", "listings", "done"] as MeTradeFilter[]) {
  assert.equal(buildMeTradeCounts(circleSet, [ownSeat])[filter], filterMeTrades(circleSet, [ownSeat], filter).length);
}
