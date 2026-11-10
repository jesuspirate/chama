// 6.4.35: the closing federations (first BLF, GBF, Bitcoin Principles,
// Orange Club Africa, LatNet; all 2026-12-15) give way to the new BLF and
// Freedom Money. Pins: the new invites name the IDs we ship; old signed trades
// keep their original federation for every app version; new defaults point at
// the v2 routes; and no new sats go onto a closing federation, refused before
// any spend, never after sats have moved.
import assert from "node:assert/strict";
import { bech32m } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

const data = new Map<string, string>();
Object.assign(globalThis, { localStorage: {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => data.set(k, v),
  removeItem: (k: string) => data.delete(k),
} });

const { setLocalStorageUserScope } = await import("../storage/user-scope.js");
setLocalStorageUserScope("v2-migration-seller");
const invites = await import("./federation-invites.js");
const config = await import("./federation-config.js");
const registry = await import("../communities/registry.js");
const {
  BLF_FEDERATION_ID, BLF_FEDERATION_INVITE, BLF_V2_FEDERATION_ID, BLF_V2_FEDERATION_INVITE,
  FREEDOM_MONEY_FEDERATION_ID, FREEDOM_MONEY_FEDERATION_INVITE, GBF_FEDERATION_ID, GBF_FEDERATION_INVITE,
  BP_FEDERATION_ID, OCA_FEDERATION_INVITE, LATNET_FEDERATION_INVITE, AFRIBIT_KIBERA_FEDERATION_ID,
  closingFederation,
} = invites;
const OCA_ID = invites.PUBLIC_FEDI_APPROVED_FEDERATIONS.find((f) => f.slug === "fedi-orange-club-africa")!.federationId;
const LATNET_ID = invites.PUBLIC_FEDI_APPROVED_FEDERATIONS.find((f) => f.slug === "fedi-latnet")!.federationId;

// ── 1. The invites carry the federation IDs we ship (independent decode) ──
function inviteFederationId(invite: string): string {
  const decoded = bech32m.decode(invite as `${string}1${string}`, 4096);
  const bytes = bech32m.fromWords(decoded.words);
  return Buffer.from(bytes.slice(-32)).toString("hex");
}
assert.equal(inviteFederationId(BLF_V2_FEDERATION_INVITE), BLF_V2_FEDERATION_ID, "new BLF invite names 30a2771d…");
assert.equal(inviteFederationId(FREEDOM_MONEY_FEDERATION_INVITE), FREEDOM_MONEY_FEDERATION_ID, "Freedom Money invite names 63bfb99b…");
assert.equal(inviteFederationId(BLF_FEDERATION_INVITE), BLF_FEDERATION_ID, "decoder sanity: the first BLF");
assert.notEqual(BLF_V2_FEDERATION_ID, BLF_FEDERATION_ID, "the two BLFs are different federations");
assert.equal(config.expectedFederationIdForInvite(BLF_V2_FEDERATION_INVITE), BLF_V2_FEDERATION_ID);
assert.equal(config.expectedFederationIdForInvite(FREEDOM_MONEY_FEDERATION_INVITE), FREEDOM_MONEY_FEDERATION_ID);
assert.equal(config.expectedFederationIdForInvite(BLF_FEDERATION_INVITE), BLF_FEDERATION_ID, "the first BLF still resolves");

// ── 2. Which federations are closing ──
for (const id of [BLF_FEDERATION_ID, GBF_FEDERATION_ID, BP_FEDERATION_ID, OCA_ID, LATNET_ID]) {
  assert.equal(closingFederation(id)?.closesOn, "2026-12-15", `${id.slice(0, 8)} closes 2026-12-15`);
  assert.equal(closingFederation(id.toUpperCase())?.closesOn, "2026-12-15", "case-insensitive");
}
for (const id of [BLF_V2_FEDERATION_ID, FREEDOM_MONEY_FEDERATION_ID, AFRIBIT_KIBERA_FEDERATION_ID, null, "", "zz"]) {
  assert.equal(closingFederation(id), null, `${String(id).slice(0, 8)} is not closing`);
}
assert.match(config.closingDateLabel("2026-12-15", "en"), /December 15, 2026|15 December 2026/);
assert.match(config.closingDateLabel("2026-12-15", "fr"), /15 décembre 2026/);
assert.equal(config.closingDateLabel("not-a-date", "en"), "not-a-date");

// ── 3. Pickers offer only open federations; routing still knows them all ──
assert.ok(config.PICKABLE_PRESETS.every((p) => !closingFederation(p.federationId)), "no closing federation is offered");
assert.ok(config.PICKABLE_PRESETS.some((p) => p.inviteCode === BLF_V2_FEDERATION_INVITE));
assert.ok(config.PICKABLE_PRESETS.some((p) => p.inviteCode === FREEDOM_MONEY_FEDERATION_INVITE));
for (const invite of [BLF_FEDERATION_INVITE, GBF_FEDERATION_INVITE, OCA_FEDERATION_INVITE, LATNET_FEDERATION_INVITE]) {
  assert.ok(config.CURATED_PRESETS.some((p) => p.inviteCode === invite && p.closesOn === "2026-12-15"),
    "a closing federation stays curated (named, listed, routable)");
}
assert.deepEqual(registry.getCommunitiesByCountry("US").map((c) => c.slug), ["us-blf"], "one US choice: the new BLF");
assert.ok(registry.COMMUNITY_REGISTRY.filter((c) => !c.hiddenFromPicker).every((c) =>
  !closingFederation(config.expectedFederationIdForInvite(c.federationInvite))), "no visible community names a closing federation");

// ── 4. New defaults ──
assert.equal(config.getFederationInvite(), BLF_V2_FEDERATION_INVITE);
assert.equal(config.resolveFederationForCommunity(null), BLF_V2_FEDERATION_INVITE);
assert.equal(config.resolveFederationForCommunity("us-blf"), BLF_V2_FEDERATION_INVITE);
assert.equal(config.resolveFederationForCommunity("us-gbf"), BLF_V2_FEDERATION_INVITE, "GBF's people move to the new BLF");
assert.equal(config.resolveFederationForCommunity("sn-cfa"), BLF_V2_FEDERATION_INVITE, "Africa: Orange Club Africa named no successor");
assert.equal(config.resolveFederationForCommunity("fedi-latnet"), FREEDOM_MONEY_FEDERATION_INVITE, "LatNet → Freedom Money");
assert.equal(registry.defaultFederationForCountry("MX").invite, FREEDOM_MONEY_FEDERATION_INVITE);
assert.equal(registry.defaultFederationForCountry("NG").invite, BLF_V2_FEDERATION_INVITE);
assert.equal(registry.defaultFederationForCountry("AF").invite, BLF_V2_FEDERATION_INVITE);
assert.equal(registry.legacyFederationForCountry("NG").invite, OCA_FEDERATION_INVITE, "6.4.34 regional map is frozen");
assert.equal(registry.legacyFederationForCountry("MX").invite, LATNET_FEDERATION_INVITE);
assert.equal(registry.getCommunityBySlug("ke-kes")?.historicalFederationInvite, undefined, "Kenya's routes never moved");

// ── 5. Signed trades keep their original federation (every version agrees) ──
const eff = config.effectiveCreateFederationId;
assert.equal(eff({ community: "us-blf" }), BLF_FEDERATION_ID, "an unstamped us-blf listing still means the first BLF");
assert.equal(eff({ community: "us-blf", mintUrl: BLF_FEDERATION_INVITE }), BLF_FEDERATION_ID);
assert.equal(eff({ community: "us-gbf" }), GBF_FEDERATION_ID);
assert.equal(eff({ community: "sn-cfa" }), OCA_ID, "an unstamped Senegal listing still means Orange Club Africa");
assert.equal(eff({ community: "fedi-latnet" }), LATNET_ID);
assert.equal(eff({ community: "ng-ngn" }), OCA_ID, "pre-seeded country shell keeps its 6.4.34 federation on the wire");
// Route-drift rescue (stamped fed overridden when mintUrl and community agree) is unchanged.
assert.equal(eff({ fed: GBF_FEDERATION_ID, mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" }), BLF_FEDERATION_ID);
// New listings stamp the new federation and it wins.
assert.equal(eff({ fed: BLF_V2_FEDERATION_ID, mintUrl: BLF_V2_FEDERATION_INVITE, community: "us-blf" }), BLF_V2_FEDERATION_ID);
assert.equal(eff({ fed: BLF_V2_FEDERATION_ID, mintUrl: BLF_V2_FEDERATION_INVITE, community: "sn-cfa" }), BLF_V2_FEDERATION_ID);
assert.equal(eff({ fed: FREEDOM_MONEY_FEDERATION_ID, mintUrl: FREEDOM_MONEY_FEDERATION_INVITE, community: "mx-mxn" }), FREEDOM_MONEY_FEDERATION_ID);

// ── 6. Country shells saved on this device by the picker move; hand-added ones don't ──
registry.addCustomCommunity({ slug: "af-afn", displayName: "Afghanistan · AFN", currency: "AFN", country: "AF",
  flagEmoji: "🇦🇫", federationInvite: BLF_FEDERATION_INVITE });
registry.addCustomCommunity({ slug: "mx-mxn", displayName: "Mexico · MXN", currency: "MXN", country: "MX",
  flagEmoji: "🇲🇽", federationInvite: LATNET_FEDERATION_INVITE });
registry.addCustomCommunity({ slug: "my-oca-circle", displayName: "My circle", currency: "XOF", country: "SN",
  flagEmoji: "🇸🇳", federationInvite: OCA_FEDERATION_INVITE });
assert.equal(registry.getCommunityBySlug("af-afn")?.federationInvite, BLF_V2_FEDERATION_INVITE);
assert.equal(registry.communityWireInvite("af-afn"), BLF_FEDERATION_INVITE);
assert.equal(registry.getCommunityBySlug("mx-mxn")?.federationInvite, FREEDOM_MONEY_FEDERATION_INVITE);
assert.equal(registry.getCommunityBySlug("my-oca-circle")?.federationInvite, OCA_FEDERATION_INVITE, "a hand-added community is never repointed");
// Re-saving every shell (another addCustomCommunity write) must not lose the original.
registry.addCustomCommunity({ slug: "zz-test", displayName: "x", currency: "USD", country: null, flagEmoji: "🌐", federationInvite: BLF_V2_FEDERATION_INVITE });
assert.equal(registry.communityWireInvite("af-afn"), BLF_FEDERATION_INVITE, "wire invite survives a rewrite");
assert.equal(registry.getCommunityBySlug("af-afn")?.federationInvite, BLF_V2_FEDERATION_INVITE);
registry.claimGeneratedShellCreator("ab".repeat(32));
assert.equal(registry.communityWireInvite("af-afn"), BLF_FEDERATION_INVITE, "wire invite survives the creator stamp");
assert.equal(registry.getCommunityBySlug("af-afn")?.federationInvite, BLF_V2_FEDERATION_INVITE);
// A wallet still on the first BLF belongs to us-blf (so first-run repair moves it with its community).
assert.equal(registry.communityForInvite(BLF_FEDERATION_INVITE)?.slug, "us-blf");

// ── 7. No new sats onto a closing federation: refused before any spend ──
const { safetyFixture } = await import("../../scripts/lib/escrow-safety-fixture.js");
const { EscrowFedimintBridge } = await import("./escrow-bridge.js");
const { Role } = await import("../escrow-engine/types.js");
const { addSavedHandle } = await import("../payments/saved-handles.js");
const cashTo = addSavedHandle("m-pesa", "+255 700 555 777");
const f = safetyFixture({ buyer: schnorr.getPublicKey(new Uint8Array(32).fill(1)), seller: schnorr.getPublicKey(new Uint8Array(32).fill(2)),
  arbiter: schnorr.getPublicKey(new Uint8Array(32).fill(3)) }, 2_000_000, "v2-migration");
const now = Date.now();
function tradeOn(fed: string | undefined) {
  const base = f.state;
  const create = base.eventChain[0];
  return { ...base, escrowMode: "ecash" as const,
    eventChain: [{ ...create, payload: { ...create.payload, escrowMode: "ecash", ...(fed ? { fed } : {}) } }, ...base.eventChain.slice(1)],
    joinHolds: { buyer: { role: Role.BUYER, eventId: "hold-v2", pubkey: f.pks.buyer, joinedAt: now / 1000 - 60,
      expiresAt: now / 1000 + 240, orderFinalizedAt: now / 1000 - 30 } } };
}
let spends = 0;
function walletOn(fed: string) {
  return { probeReachable: async () => ({ fed }), getFederationId: () => fed,
    spendNotesForLock: async () => { spends++; throw new Error("must not spend"); } };
}
async function preflight(tradeFed: string | undefined, walletFed: string, opts: Record<string, unknown> = {}) {
  const state = tradeOn(tradeFed);
  const client = { getState: () => state, getPubkey: async () => f.pks.seller };
  const bridge = new EscrowFedimintBridge(client as any, walletOn(walletFed) as any, {} as any);
  return bridge.preflightLock(state.id, { savedHandleId: cashTo.id, ...opts });
}
for (const closingId of [BLF_FEDERATION_ID, GBF_FEDERATION_ID, OCA_ID, LATNET_ID, BP_FEDERATION_ID]) {
  await assert.rejects(preflight(closingId, closingId), (e: any) =>
    e.code === "FEDERATION_CLOSING" && e.closesOn === "2026-12-15" && /No sats were spent/.test(e.message),
  `new funding on ${closingId.slice(0, 8)} is refused`);
}
await assert.rejects(preflight(undefined, BLF_FEDERATION_ID), (e: any) => e.code === "FEDERATION_CLOSING",
  "a legacy trade with no stamped federation is judged by the wallet the sats would come from");
// After sats moved (a paid invoice, a resumed lock) the lock goes ahead: the
// sats reach escrow and settle instead of sitting on the closing federation.
await preflight(BLF_FEDERATION_ID, BLF_FEDERATION_ID, { afterSatsMoved: true });
await preflight(undefined, OCA_ID, { afterSatsMoved: true });
// The v2 routes fund normally.
await preflight(BLF_V2_FEDERATION_ID, BLF_V2_FEDERATION_ID);
await preflight(FREEDOM_MONEY_FEDERATION_ID, FREEDOM_MONEY_FEDERATION_ID);
// A wrong-wallet trade still fails on the existing federation check, not ours.
await assert.rejects(preflight(BLF_V2_FEDERATION_ID, BLF_FEDERATION_ID), (e: any) => e.code === "FED_MISMATCH");
assert.equal(spends, 0, "no attempt spent a note");

console.log("federation v2 migration: invites, closing set, defaults, wire meaning, shells and funding gate pinned");
