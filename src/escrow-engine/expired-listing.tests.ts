import assert from "node:assert/strict";
import { EscrowStatus, Role, type EscrowState } from "./types.js";
import type { TradeIndexEntry } from "./trade-index.js";
import { isExpiredUnfundedListing, isLapsedWindowShopping } from "./expired-listing.js";
import { latestParticipantTradePointer } from "../ui/latest-trade.js";

const NOW = 1_900_000_000;
const listing = (over: Partial<EscrowState>) => ({
  status: EscrowStatus.CREATED, expiresAt: NOW - 10, ...over,
} as unknown as EscrowState);

// ── What counts as an expired, never-funded listing ─────────────────────────
assert.equal(isExpiredUnfundedListing(listing({}), NOW), true,
  "CREATED past its expiry never held a satoshi");
assert.equal(isExpiredUnfundedListing(listing({ expiresAt: NOW + 10 }), NOW), false,
  "a listing still inside its window is alive");
assert.equal(isExpiredUnfundedListing(listing({ status: EscrowStatus.LOCKED }), NOW), false,
  "a LOCKED trade past its expiry holds real money — never silently dropped");
assert.equal(isExpiredUnfundedListing(listing({ status: EscrowStatus.EXPIRED }), NOW), false,
  "an EXPIRED trade is a settlement problem, not an empty listing");
assert.equal(isExpiredUnfundedListing(listing({ expiresAt: 0 }), NOW), false,
  "a listing with no expiry set never expires by accident");

// ── Window shopping is not a trade ──────────────────────────────────────────
const entry = (over: Partial<TradeIndexEntry>) => ({
  id: "sm_shopped", category: "marketplace", amountMsats: 50_000_000,
  community: "us-blf", role: Role.BUYER, counterparty: "seller",
  description: "IT Services", lastStatus: EscrowStatus.CREATED,
  createdAt: NOW - 86_400, enteredAt: NOW - 86_000, updatedAt: NOW * 1000,
  ...over,
} as TradeIndexEntry);

assert.equal(isLapsedWindowShopping(entry({})), true,
  "a remembered buyer-side listing that never locked was only a hold");
assert.equal(isLapsedWindowShopping(entry({ lastStatus: EscrowStatus.LOCKED })), false,
  "once sats locked it is a real trade, expired or not");
assert.equal(isLapsedWindowShopping(entry({ role: Role.SELLER })), false,
  "the seller's own open listing stays theirs");

// The hero: a lapsed hold must never be offered as "your latest trade",
// because tapping it opens a listing the client has already dropped.
const older = entry({ id: "sm_real", role: Role.SELLER, lastStatus: EscrowStatus.COMPLETED, enteredAt: NOW - 200_000 });
assert.equal(latestParticipantTradePointer([], [entry({}), older])?.id, "sm_real",
  "the hero skips the newer dead hold and shows the real trade behind it");
assert.equal(latestParticipantTradePointer([], [entry({})]), null,
  "with nothing but a dead hold remembered, the hero shows nothing at all");

console.log("Expired-listing and window-shopping regressions passed.");

// ── Profile name merge: never clobber a profile Chama did not create ────────
const { mergeProfileNameContent } = await import("../ui/nostr-profiles.js");

const rich = JSON.stringify({
  name: "old", display_name: "Old", picture: "https://x/y.png",
  about: "hi", lud16: "me@wallet", nip05: "me@domain",
});
const merged = JSON.parse(mergeProfileNameContent(rich, "Jetty"));
assert.equal(merged.name, "Jetty");
assert.equal(merged.display_name, "Jetty", "both fields set so every client agrees");
assert.equal(merged.picture, "https://x/y.png", "a picture set elsewhere survives the rename");
assert.equal(merged.lud16, "me@wallet", "a lightning address set elsewhere survives");
assert.equal(merged.nip05, "me@domain", "a nip-05 set elsewhere survives");

const fromNothing = JSON.parse(mergeProfileNameContent(null, "Jetty"));
assert.deepEqual(fromNothing, { name: "Jetty", display_name: "Jetty" },
  "a first profile is exactly a name");
const fromGarbage = JSON.parse(mergeProfileNameContent("not json at all", "Jetty"));
assert.deepEqual(fromGarbage, { name: "Jetty", display_name: "Jetty" },
  "unparseable content starts clean rather than propagating garbage");
const fromArray = JSON.parse(mergeProfileNameContent("[1,2,3]", "Jetty"));
assert.deepEqual(fromArray, { name: "Jetty", display_name: "Jetty" },
  "a non-object profile is not spread into the new one");

console.log("Profile-name merge regressions passed.");

// ── A circle seat is its MEMBER's exposure, never the host's ───────────────
const { sumActiveBuyerSellerTradeMsats, countActiveBuyerSellerCommitments } =
  await import("../ui/decisions.js");

const HOST = "amina", M1 = "bruno", M2 = "carla";
const seat = (id: string, member: string) => ({
  id, chamaPolicy: "share-v1", parent: "circle_1",
  status: EscrowStatus.LOCKED, amountMsats: 21_000,
  participants: { [Role.BUYER]: member, [Role.SELLER]: HOST },
  eventChain: [], joinHolds: {}, votes: {}, claim: {}, lock: {},
  communityArbiters: [], expiresAt: NOW + 86_400, createdAt: NOW - 100,
} as unknown as EscrowState);

const circle = [seat("s1", M1), seat("s2", M2), seat("s3", HOST)];
assert.equal(
  sumActiveBuyerSellerTradeMsats({ escrows: circle, userPubkey: HOST, nowSec: NOW }),
  21_000,
  "the host's money at risk is their own seat — not every member's, however many join",
);
assert.equal(
  countActiveBuyerSellerCommitments({ escrows: circle, userPubkey: HOST, nowSec: NOW }),
  1,
  "and it counts as one active trade, not one per member",
);
assert.equal(
  sumActiveBuyerSellerTradeMsats({ escrows: circle, userPubkey: M1, nowSec: NOW }),
  21_000,
  "a member sees exactly their own seat",
);
assert.equal(
  sumActiveBuyerSellerTradeMsats({ escrows: [seat("s1", M1)], userPubkey: HOST, nowSec: NOW }),
  0,
  "hosting someone else's seat puts none of the host's own sats at risk",
);

console.log("Circle-seat exposure regressions passed.");
