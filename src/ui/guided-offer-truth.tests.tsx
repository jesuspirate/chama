import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EscrowStatus, Role, type EscrowState } from "../escrow-engine/types.js";
import { matchGuidedListings, rankGuidedCandidates, recommendGuidedCandidates } from "../guided/match-listings.js";
import { Match, guidedChooseTitleKey } from "./screens/AssistedCanvas.js";

// Exercise the actual per-amount searches that the guided canvas merges.
function offer(id: string, sats: number, fiat: number, currency = "USD", category = "p2p-trade") {
  const listing = {
    id, category, status: EscrowStatus.CREATED, amountMsats: sats * 1000,
    fiatAmount: fiat, fiatCurrency: currency, description: "Help with this month’s utilities",
    expiresAt: 2000, participants: { [Role.SELLER]: id }, paymentMethods: ["strike"],
    fees: { platformMsats: 0, arbiterMsats: 0 },
    ...(category === "bill-pay" ? { items: [{ id: "utilities", label: "Utilities", kind: "bill", amountMsats: sats * 1000 }] } : {}),
  } as EscrowState;
  return matchGuidedListings({ version: 1, direction: "buy_sats", amountSats: sats,
    paymentRails: ["strike"], strategy: "available_now" }, [{ listing }], { nowSec: 1000 }).candidates[0]!;
}
const a = offer("a", 2459, 2);
const b = offer("b", 3183, 2);
const ranked = rankGuidedCandidates([a, b]);
assert.equal(ranked[0].listing.id, "b");
assert.ok(ranked[0].score.price > ranked[1].score.price);
assert.equal(recommendGuidedCandidates(ranked, "USD").lowestPrice?.listing.id, "b");
const tie = rankGuidedCandidates([offer("z", 2000, 2), offer("a", 3000, 3)]);
assert.equal(tie[0].score.price, tie[1].score.price);
assert.equal(recommendGuidedCandidates(tie).lowestPrice?.listing.id, "a", "equal rates use existing ID tiebreak");
const trustedTie = { ...tie[1], score: { ...tie[1].score, total: tie[1].score.total + 50 } };
assert.equal(recommendGuidedCandidates([tie[0], trustedTie]).lowestPrice?.listing.id, "z", "total score breaks equal rates before ID");
const mixed = rankGuidedCandidates([a, offer("eur", 100000, 1, "EUR")]);
assert.equal(mixed[0].score.price, mixed[1].score.price, "each currency is scored independently");
assert.equal(recommendGuidedCandidates(mixed, "USD").lowestPrice?.listing.id, "a");
assert.equal(recommendGuidedCandidates([{ ...a, fiatQuote: undefined }]).lowestPrice, null);
const bill = { ...offer("bill", 2459, 2, "USD", "bill-pay"), ratings: { count: 20, positive: 20, negative: 0 } };
const lanes = recommendGuidedCandidates(rankGuidedCandidates([bill, b]), "USD");
assert.equal(lanes.bestOverall?.listing.id, "b");
assert.equal(lanes.lowestPrice?.listing.id, "b");
assert.equal(lanes.mostTrusted?.listing.id, "bill");
const bargainBill = { ...bill, amountSats: 10000 };
const billFirst = rankGuidedCandidates([bargainBill, b]);
assert.equal(billFirst[0].listing.id, "bill", "fixture bill leads the combined score");
const sellerLanes = recommendGuidedCandidates(billFirst, "USD");
assert.equal(sellerLanes.bestOverall?.listing.id, "b", "even a higher-scored bill stays in its own lane");
assert.equal(sellerLanes.lowestPrice?.listing.id, "b", "even a cheaper bill cannot take the seller price badge");
assert.equal(recommendGuidedCandidates([bill]).bestOverall?.listing.id, "bill");
assert.equal(recommendGuidedCandidates([bill]).lowestPrice, null);
const html = renderToStaticMarkup(<Match candidate={bill} labels={["Bill Pay"]} onOpen={() => {}} />);
assert.ok(html.includes("Pay a 2 USD Utilities bill"));
assert.ok(html.includes(`Get ${bill.amountSats.toLocaleString()} sats`));
assert.ok(html.includes(bill.listing.description));
const sellerHtml = renderToStaticMarkup(<Match candidate={b} labels={[]} onOpen={() => {}} />);
assert.ok(sellerHtml.includes(`${b.amountSats.toLocaleString()} sats`));
assert.ok(!sellerHtml.includes("Pay a"));
assert.equal(guidedChooseTitleKey([b]), "canvas.chooseTitle");
assert.equal(guidedChooseTitleKey([bill, b]), "canvas.chooseMixedTitle");
assert.equal(guidedChooseTitleKey([bill]), "canvas.chooseMixedTitle");
assert.equal(guidedChooseTitleKey([]), "canvas.chooseTitle");
const bracket = { ...b, listing: { ...b.listing, items: [{ id: "range", label: "Sats", kind: "exchange-bracket" as const, amountMsats: 3183000, minAmountMsats: 1000000, maxAmountMsats: 5000000 }] } };
assert.equal(recommendGuidedCandidates([a, bracket], "USD").lowestPrice?.listing.id, "b", "range price uses the candidate amount, as the card does");
console.log("PASS guided offer truth: unit prices, currencies, lanes, bill copy, visible-result heading, and ranges");
