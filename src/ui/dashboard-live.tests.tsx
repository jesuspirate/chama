import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider, translate } from "../i18n/index.js";
import { EscrowEventKind, EscrowStatus, type EscrowState } from "../escrow-engine/types.js";
import { activeCommittedMsats, countActiveBuyerSellerCommitments } from "./decisions.js";

// Nov 7 2026: the dashboard's "Live now" tile read "28 · 466,639 sats in
// escrow" while Home and the status bar held nothing for Jet. It summed every
// LOCKED or APPROVED trade in the window: expired locks, trades decided for
// someone else and trades the viewer only arbitrated. It now shows exactly
// the status bar's count and sum.
const { DashboardScreen } = await import("./screens/DashboardScreen.js");

const ME = "a".repeat(64), THEM = "b".repeat(64), ARB = "c".repeat(64);
const NOW = Math.floor(Date.now() / 1000);
const LOCK = { kind: EscrowEventKind.LOCK } as never;
let n = 0;
const trade = (over: Partial<EscrowState>): EscrowState => ({
  id: `sm_dash_${n++}`, status: EscrowStatus.LOCKED, amountMsats: 1_000_000, category: "exchange",
  participants: { seller: THEM, buyer: ME, arbiter: ARB }, eventChain: [LOCK],
  lock: { shares: new Map(), notesHash: "deadbeef", lockedAt: NOW - 3_600 },
  createdAt: NOW - 7_200, expiresAt: NOW + 86_400, votes: {}, resolvedOutcome: null,
  ...over,
} as unknown as EscrowState);

const trades = [
  trade({ amountMsats: 2_000_000 }),                                              // mine, locked, live
  trade({ amountMsats: 5_000_000, expiresAt: NOW - 60 }),                          // lock past its deadline
  trade({ amountMsats: 7_000_000, participants: { seller: THEM, buyer: ARB, arbiter: ME } as never }), // I only arbitrate
  trade({ amountMsats: 11_000_000, status: EscrowStatus.CLAIMED }),                // already claimed
  trade({ amountMsats: 13_000_000, status: EscrowStatus.CREATED, eventChain: [], lock: null as never }), // open listing
  trade({ amountMsats: 17_000_000, eventChain: [], lock: null as never }),         // LOCKED with no LOCK behind it
];

assert.equal(countActiveBuyerSellerCommitments({ escrows: trades, userPubkey: ME, nowSec: NOW }), 1);
assert.equal(activeCommittedMsats({ escrows: trades, userPubkey: ME, nowSec: NOW }), 2_000_000);

const html = renderToStaticMarkup(
  <LangProvider><DashboardScreen pubkey={ME} ratings={null} myTrades={trades} /></LangProvider>,
);
const tile = html.slice(html.indexOf(translate("en", "bond.dashStatLive")));
assert.ok(tile.length < html.length, "the Live now tile renders");
assert.match(tile.slice(0, 600), />1</, "Live now counts only the one trade with my sats locked");
assert.ok(html.includes(translate("en", "dash.liveEscrow").replace("{sats}", "2,000")), "sats in escrow = the status bar's figure");
for (const wrong of ["7,000", "9,000", "16,000", "25,000", "55,000"]) {
  assert.ok(!html.includes(translate("en", "dash.liveEscrow").replace("{sats}", wrong)), `never ${wrong}`);
}

// Nothing locked: no sats line at all, and the count reads 0.
const idle = renderToStaticMarkup(
  <LangProvider><DashboardScreen pubkey={ME} ratings={null} myTrades={trades.slice(1)} /></LangProvider>,
);
assert.ok(!idle.includes("sats in escrow"), "no escrow line when nothing of mine is locked");
console.log("PASS dashboard Live now: same count and sats as the status bar (no expired, arbitrated, claimed or unlocked trades)");
