import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VerifiedBond } from "../bond-multisig/bond-announcement.js";
import { EscrowStatus, Role, type EscrowState } from "../escrow-engine/types.js";
import { LangProvider, LANGS, translate } from "../i18n/index.js";

// Jet, 2026-10-26, production: a Bill Pay listing could not publish because
// "the largest eligible bond here covers up to 29,400 sats today", while the
// arbiter held two bonds (about 30k and 99k). The bond cache kept one bond per
// arbiter, the oldest, and seating looked at one bond per arbiter. The seller
// also only learned the limit after filling everything in.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); },
  removeItem: (k: string) => { values.delete(k); },
} });

const { writeCachedCommunityBonds, readCachedCommunityBonds } = await import("../arbiters/bonded-pool-cache.js");
const { assignableBondedArbiters, largestOnchainCoverSats, arbiterBondCapacities } = await import("../arbiters/exposure.js");
const { seatableOnchainBonds, suggestedEscrowMode, onchainCoverShort } = await import("./onchain-cover.js");
const { OnchainCoverLine } = await import("./components/OnchainCoverLine.js");

const arb = "a".repeat(64), other = "c".repeat(64), seller = "d".repeat(64), key = "b".repeat(64);
const bond = (over: Partial<VerifiedBond>): VerifiedBond => ({
  npub: arb, community: "us-blf", address: "bc1pold", lockUntil: 980_000,
  actualSats: 29_400n, claimedSats: 29_400n, funded: true, active: true,
  roles: ["arbiter"], ownerXonly: key, announcedAt: 100, ...over,
});
const older = bond({});
const topUp = bond({ address: "bc1pnew", lockUntil: 990_000, actualSats: 99_000n, claimedSats: 99_000n, announcedAt: 200 });
const SATS = 1000;

// 1. The cache keeps every bond an arbiter holds. fetchCommunityBonds returns
//    the cache, so this is what CREATE's capacity check reads.
writeCachedCommunityBonds("us-blf", [topUp, older]); // newest first, as fetched
const cached = readCachedCommunityBonds("us-blf")!;
assert.deepEqual(cached.map(b => `${b.address}=${b.actualSats}`).sort(), ["bc1pnew=99000", "bc1pold=29400"],
  "both bonds of one arbiter survive the cache (the top-up was dropped before)");
writeCachedCommunityBonds("us-blf", [{ ...older, funded: false, actualSats: 0n }]);
const after = readCachedCommunityBonds("us-blf")!;
assert.equal(after.length, 2, "a fresh proof replaces only that bond");
assert.equal(after.find(b => b.address === "bc1pold")!.funded, false, "a spent bond's new proof replaces its old one");
assert.equal(after.find(b => b.address === "bc1pnew")!.actualSats, 99_000n, "a partial read never drops the other bond");

// 2. Seating counts the arbiter's total bond, each distinct bond once.
const both = [topUp, older];
assert.deepEqual(assignableBondedArbiters({ bonds: both, tradeMsats: 128_400 * SATS, allTrades: [] }), [arb],
  "29,400 + 99,000 covers a 128,400-sat trade");
assert.deepEqual(assignableBondedArbiters({ bonds: both, tradeMsats: 128_401 * SATS, allTrades: [] }), [],
  "one sat over the total is refused");
assert.deepEqual(assignableBondedArbiters({ bonds: [topUp, topUp, older], tradeMsats: 128_401 * SATS, allTrades: [] }), [],
  "the same bond listed twice counts once");
assert.equal(arbiterBondCapacities([topUp, older, bond({ npub: other, address: "bc1pother", actualSats: 50_000n })]).get(arb), 128_400 * SATS);

const openTrade = (id: string, sats: number, seated = arb) => ({
  id, amountMsats: sats * SATS, status: EscrowStatus.LOCKED, escrowMode: "onchain",
  participants: { [Role.BUYER]: "e".repeat(64), [Role.SELLER]: seller, [Role.ARBITER]: seated },
  lock: { onchain: { fundingTxid: "f".repeat(64), fundingVout: 0, network: "mainnet" } },
}) as unknown as EscrowState;
const open = [openTrade("t1", 60_000), openTrade("t2", 40_000, other)];
assert.deepEqual(assignableBondedArbiters({ bonds: both, tradeMsats: 68_400 * SATS, allTrades: open }), [arb],
  "aggregate cap runs against the total: 128,400 − 60,000 open = 68,400 free");
assert.deepEqual(assignableBondedArbiters({ bonds: both, tradeMsats: 68_401 * SATS, allTrades: open }), []);

// 3. The number shown is the refusal's number, and agrees with seating.
assert.equal(largestOnchainCoverSats({ bonds: both, allTrades: [] }), 128_400, "the limit names the whole bond, not 29,400");
assert.equal(largestOnchainCoverSats({ bonds: both, allTrades: open }), 68_400);
assert.equal(largestOnchainCoverSats({ bonds: both, allTrades: [], excludePubkey: arb }), 0, "a seller is never their own arbiter");
for (const sats of [25_000, 68_399, 68_400, 68_401, 100_000]) {
  const seated = assignableBondedArbiters({ bonds: both, tradeMsats: sats * SATS, allTrades: open }).length > 0;
  assert.equal(seated, sats <= largestOnchainCoverSats({ bonds: both, allTrades: open }), `hint and refusal agree at ${sats}`);
}

// 4. Only bonds that can be seated on-chain count toward the limit.
const merchantOnly = bond({ npub: other, address: "bc1pshop", actualSats: 500_000n, roles: ["merchant"] });
const keyless = bond({ npub: other, address: "bc1pkeyless", actualSats: 500_000n, ownerXonly: undefined });
const expired = bond({ npub: other, address: "bc1pexpired", actualSats: 500_000n, active: false });
assert.deepEqual(seatableOnchainBonds([older, merchantOnly, keyless, expired]), [older],
  "storefront-only, keyless and expired bonds never raise the limit");
const createForm = readFileSync(new URL("./screens/CreateForm.tsx", import.meta.url), "utf8");
assert.match(createForm, /const activeBonds = bonds\.filter\(b => b\.funded && b\.active && declaresArbiterRole\(b\)\);/,
  "Publish seats only bonds that license arbitration");
assert.match(createForm, /const coverageMsats = wantsOnchain \? onchainCoverageMsats\(menuItems, amountMsats\) : amountMsats;/,
  "Publish and the amount hint share one coverage rule");
assert.match(createForm, /const exposureTrades = await readUnspentExposure\(allTrades\);/,
  "Publish and the amount hint share one exposure read");
assert.match(createForm, /largestOnchainCoverSats\(\{ bonds: keyedBonds/, "the refusal's number comes from the shared helper");
assert.doesNotMatch(createForm, /'s bond is covering:/, "the covering lines are translated, not built in English");
assert.match(createForm, /const escrowMode = form\.escrowMode \?\? defaultEscrowModeForAmount\(/,
  "Publish never re-steers the rail on its own: a late cover read can't switch who holds the sats");
assert.match(createForm, /setForm\(f => f\.escrowMode \? f : \{ \.\.\.f, escrowMode: steered \}\)/,
  "leaving the amount step pins the rail it showed");

// 5. The default rail steers away from on-chain only when cover is known short.
const ready = (sats: number) => ({ status: "ready" as const, sats });
assert.equal(suggestedEscrowMode(150_000, 150_000, ready(29_400)), "ecash", "the production case now defaults to ecash");
assert.equal(suggestedEscrowMode(150_000, 150_000, ready(128_400)), "ecash");
assert.equal(suggestedEscrowMode(150_000, 150_000, ready(150_000)), "onchain", "a trade that fits stays on-chain");
assert.equal(suggestedEscrowMode(150_000, 150_000, { status: "loading" }), "onchain", "unknown cover never moves the default");
assert.equal(suggestedEscrowMode(150_000, 150_000, { status: "unchecked" }), "onchain");
assert.equal(suggestedEscrowMode(50_000, 50_000, ready(0)), "ecash", "below the on-chain default nothing changes");
assert.equal(onchainCoverShort(200_000, { status: "loading" }), false);

// 6. The line under the rail choice.
const line = (cover: Parameters<typeof OnchainCoverLine>[0]["cover"], coverageSats: number) =>
  renderToStaticMarkup(<LangProvider><OnchainCoverLine cover={cover} coverageSats={coverageSats} /></LangProvider>);
assert.match(line(ready(128_400), 150_000), /up to 128,400 sats today\. Above that, use ecash or lower the amount\./);
assert.equal(line(ready(128_400), 128_400), "", "silent when the amount fits");
assert.equal(line({ status: "loading" }, 150_000), "", "never shows a number it has not read");
assert.match(line(ready(20_000), 150_000), /No arbiter here can cover an on-chain trade this size today/, "under the on-chain minimum there is no on-chain choice to name");
assert.match(line({ status: "unchecked" }, 150_000), /Couldn&#x27;t check arbiter cover just now/);
for (const lang of LANGS) {
  for (const k of ["onchain.coverLimit", "onchain.coverNone", "onchain.coverUnchecked", "onchain.bondCovering", "onchain.bondCoveringTrade", "create.coverUseEcash", "create.coverChangeAmount"]) {
    assert.notEqual(translate(lang, k), k, `${lang} ${k}`);
  }
  assert.doesNotMatch(translate(lang, "onchain.noCapableArbiter"), /another|otro árbitro|autre arbitre|msuluhishi mwingine/, `${lang}: no "another arbiter"`);
}

// 7. The canvas reads the same cover and steers the same way.
const canvas = readFileSync(new URL("./screens/AssistedCanvas.tsx", import.meta.url), "utf8");
assert.match(canvas, /useCommunityBonds\(coverWanted \? browseCommunity : null, fetchCommunityBonds\)/);
assert.match(canvas, /<OnchainCoverLine cover=\{onchainCover\} coverageSats=\{coverageSats\} \/>/);
assert.match(readFileSync(new URL("./App.tsx", import.meta.url), "utf8"),
  /allEscrows=\{\[\.\.\.escrows\.values\(\)\]\}\n\s+circleChildrenLoaded=\{circleChildrenLoaded\}\n\s+fetchCommunityBonds=\{actions\.fetchCommunityBonds\}/,
  "the canvas is given the bond reader");

console.log("Arbiter cover: every bond counts, hint equals refusal, default steers to ecash, en/es/fr/sw copy passed");
