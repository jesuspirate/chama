import assert from "node:assert/strict";
import React from "react";
import { hexToBytes } from "@noble/hashes/utils.js";
import { renderToStaticMarkup } from "react-dom/server";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { LangProvider, translate, LANGS } from "../i18n/index.js";
import { buildBondAnnouncementEvent, parseBondAnnouncementEvent, selectLatestAnnouncements, type VerifiedBond } from "../bond-multisig/bond-announcement.js";
import { buildCommitmentBond } from "../bond-multisig/commitment-bond.js";
import { MAINNET } from "../bond-multisig/multisig.js";
import { writeCachedCommunityBonds, readCachedCommunityBonds } from "../arbiters/bonded-pool-cache.js";
import { bondedArbitersForCommunity } from "../arbiters/live-chama.js";
import { sellerIsBonded, MERCHANT_BOND_FLOOR_SATS } from "../escrow-engine/listing-renewal.js";
import { RetiredMerchantBondNudge } from "./components/RetiredMerchantBondNudge.js";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
} });
const secret = new Uint8Array(32).fill(65), owner = getPublicKey(secret);
const bond = buildCommitmentBond(hexToBytes(owner), 970000, MAINNET);
const params = { pubkey: owner, community: "us-blf", ownerXonly: owner, lockUntil: bond.lockUntil,
  amountSats: MERCHANT_BOND_FLOOR_SATS, network: MAINNET, address: bond.address };
const legacy = finalizeEvent(buildBondAnnouncementEvent({ ...params, roles: ["merchant"], createdAt: 100 }), secret);
const parsed = parseBondAnnouncementEvent(legacy)!;
assert.deepEqual(parsed.roles, ["merchant"], "retired declarations still parse as a signed opt-out");
const verified: VerifiedBond = { npub: owner, community: params.community, address: bond.address, lockUntil: bond.lockUntil,
  claimedSats: params.amountSats, actualSats: params.amountSats, funded: true, active: true,
  roles: parsed.roles, announcedAt: parsed.createdAt };
writeCachedCommunityBonds(params.community, [verified]);
const cached = readCachedCommunityBonds(params.community)!;
assert.deepEqual(cached[0].roles, ["merchant"], "cache retains the opt-out");
assert.deepEqual(bondedArbitersForCommunity(cached), [], "old merchant owners stay out of the arbiter pool");
assert.equal(sellerIsBonded(cached, owner), true, "old listing floor remains valid");
assert.equal(sellerIsBonded([{ ...verified, actualSats: MERCHANT_BOND_FLOOR_SATS - 1n }], owner), false);
const replacement = finalizeEvent(buildBondAnnouncementEvent({ ...params, createdAt: 200 }), secret);
assert.equal("roles" in JSON.parse(replacement.content), false);
assert.deepEqual(selectLatestAnnouncements([legacy, replacement])[0].roles, ["arbiter"]);
const html = (bonds: VerifiedBond[], viewer = owner) => renderToStaticMarkup(<LangProvider><RetiredMerchantBondNudge bonds={bonds} owner={viewer} /></LangProvider>);
assert.match(html(cached), /Storefront-only bonds are retired/);
assert.equal(html(cached, "another owner"), "");
assert.equal(html([{ ...verified, roles: ["arbiter"] }]), "");
assert.equal(html([{ ...verified, roles: ["arbiter", "merchant"] }]), "");
assert.equal(html([{ ...verified, roles: undefined }]), "");
assert.equal(html([verified, { ...verified, roles: ["arbiter"], announcedAt: 200 }]), "", "a superseded opt-out never prompts");
assert.equal((html([verified, verified]).match(/Storefront-only bonds/g) ?? []).length, 1, "one line per bond card, not one per announcement");
for (const lang of LANGS) {
  data.set("chama_lang", lang);
  const line = translate(lang, "bond.merchantRetired");
  assert.notEqual(line, "bond.merchantRetired");
  assert.ok(line.length > 20);
}
console.log("Bond retirement: signed opt-outs, cached pool exclusion, listing floor and owner-only nudge passed");
