// H4 (money-path review, Oct 2026): moving to another federation parks the
// open wallet instead of deleting it, and nobody is moved onto a federation
// Chama doesn't list without saying they know who runs it.
import assert from "node:assert/strict";

const store = new Map<string, string>();
let storageBroken = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => { if (storageBroken) throw new Error("storage off"); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (storageBroken) throw new Error("storage off"); store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { BLF_FEDERATION_INVITE, BLF_FEDERATION_ID, GBF_FEDERATION_INVITE, GBF_FEDERATION_ID } = await import("./federation-invites.js");
const { arbiterFederationStorageScope, getArbiterFederationRoute, listArbiterFederationRoutes, rememberArbiterFederationRoute } =
  await import("./arbiter-federation-store.js");
const {
  federationIdForInvite, federationIdForRememberedInvite, parkedInviteFor, planBrowserDrift, rememberRouteOrThrow,
  scopeForFederation, scopeHoldsParkedWallet, walletDrifted,
} = await import("./federation-parking.js");
const { acceptUnlistedFederation, hasAcceptedUnlistedFederation } = await import("./unlisted-federation-consent.js");
const { decideDestroyConfirmRoute, decideListingTapEffect, isListedFederationInvite } = await import("../ui/decisions.js");

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const UNLISTED = "fed1qqqqunlistedfederationinvitefortestsonly";
const UNLISTED_ID = "c".repeat(64);

// ── Which federations are "listed" ──────────────────────────────────────────
assert.equal(isListedFederationInvite(BLF_FEDERATION_INVITE), true);
assert.equal(isListedFederationInvite(GBF_FEDERATION_INVITE), true);
assert.equal(isListedFederationInvite(UNLISTED), false, "a pasted invite is not listed");
assert.equal(isListedFederationInvite(""), false);
assert.equal(isListedFederationInvite(null), false);

// ── Listing tap: unlisted federations ask first, listed ones do not ─────────
const tap = (mintUrl: string, extra: Partial<Parameters<typeof decideListingTapEffect>[0]> = {}) =>
  decideListingTapEffect({ listing: { mintUrl, community: null }, currentInvite: BLF_FEDERATION_INVITE, balanceMsats: 0, ...extra });

assert.deepEqual(tap(UNLISTED), { kind: "unlisted-confirm", targetInvite: UNLISTED },
  "moving onto an unlisted federation asks before anything switches");
assert.equal(tap(UNLISTED, { balanceMsats: 50_000_000 }).kind, "unlisted-confirm",
  "the question comes before any balance handling");
assert.equal(tap(UNLISTED, { acceptsUnlistedFederation: (i) => i === UNLISTED }).kind, "switch-silent",
  "after a yes, the switch goes ahead");
assert.equal(tap(UNLISTED, { acceptsUnlistedFederation: () => false }).kind, "unlisted-confirm");
assert.equal(tap(UNLISTED, { currentInvite: UNLISTED }).kind, "matching",
  "already on that federation: nothing to ask");
assert.equal(tap(GBF_FEDERATION_INVITE).kind, "switch-silent", "listed federations still switch quietly");
assert.equal(tap(UNLISTED, { activeCommitmentCount: 1 }).kind, "blocked-active-commitment",
  "a live trade here still blocks moving away, before the question");

// With every wallet kept per federation, a material balance no longer needs
// the "destroy" sheet; an unread balance still refuses.
assert.equal(decideDestroyConfirmRoute(50_000_000, true), "switch");
assert.equal(decideDestroyConfirmRoute(50_000_000, false), "confirm");
assert.equal(decideDestroyConfirmRoute(null, true), "unknown");

// ── The person's yes is per identity and per invite ─────────────────────────
assert.equal(hasAcceptedUnlistedFederation(ALICE, UNLISTED), false);
assert.equal(acceptUnlistedFederation(ALICE, UNLISTED), true);
assert.equal(hasAcceptedUnlistedFederation(ALICE, UNLISTED), true);
assert.equal(hasAcceptedUnlistedFederation(ALICE, ` ${UNLISTED} `), true);
assert.equal(hasAcceptedUnlistedFederation(BOB, UNLISTED), false, "another identity on this device has not agreed");
assert.equal(hasAcceptedUnlistedFederation(ALICE, UNLISTED + "x"), false);
assert.equal(hasAcceptedUnlistedFederation(null, UNLISTED), false);
assert.equal(acceptUnlistedFederation(ALICE, "not-an-invite"), false);
storageBroken = true;
assert.equal(hasAcceptedUnlistedFederation(ALICE, UNLISTED), false, "unreadable storage means: ask again");
assert.equal(acceptUnlistedFederation(BOB, UNLISTED), false, "an unsaved yes is reported");
storageBroken = false;
store.set(`chama_unlisted_federation_ok_v1:${ALICE}`, "{not json");
assert.equal(hasAcceptedUnlistedFederation(ALICE, UNLISTED), false, "a damaged record means: ask again");

// ── Parked wallets keep their route and the balance seen when they left ─────
rememberArbiterFederationRoute(ALICE, { federationId: BLF_FEDERATION_ID, inviteCode: BLF_FEDERATION_INVITE,
  storageScope: ALICE, lastBalanceMsats: 1_500_000 });
rememberArbiterFederationRoute(ALICE, { federationId: UNLISTED_ID, inviteCode: UNLISTED,
  storageScope: arbiterFederationStorageScope(ALICE, UNLISTED_ID) });
assert.equal(getArbiterFederationRoute(ALICE, BLF_FEDERATION_ID)?.lastBalanceMsats, 1_500_000,
  "dust is remembered, not deleted (1,500 sats is under the old 2,000-sat switch line)");
assert.equal(getArbiterFederationRoute(ALICE, UNLISTED_ID)?.lastBalanceMsats, undefined);
assert.equal(getArbiterFederationRoute(ALICE, UNLISTED_ID)?.storageScope, `${ALICE}:arbiter-fed:${UNLISTED_ID}`,
  "each federation gets its own storage scope");
assert.equal(listArbiterFederationRoutes(ALICE).length, 2);
rememberArbiterFederationRoute(ALICE, { federationId: GBF_FEDERATION_ID, inviteCode: GBF_FEDERATION_INVITE,
  storageScope: arbiterFederationStorageScope(ALICE, GBF_FEDERATION_ID), lastBalanceMsats: Number.NaN });
assert.equal(getArbiterFederationRoute(ALICE, GBF_FEDERATION_ID)?.lastBalanceMsats, undefined, "a nonsense balance is not stored");
{
  const key = `chama_arbiter_federations_v1:${ALICE}`;
  const raw = JSON.parse(store.get(key)!);
  raw.routes[BLF_FEDERATION_ID].lastBalanceMsats = -5;
  store.set(key, JSON.stringify(raw));
  assert.equal(getArbiterFederationRoute(ALICE, BLF_FEDERATION_ID)?.lastBalanceMsats, undefined, "a damaged balance is dropped");
  assert.equal(getArbiterFederationRoute(ALICE, BLF_FEDERATION_ID)?.inviteCode, BLF_FEDERATION_INVITE, "but the route survives");
}

// ── Which invite reopens a parked wallet ────────────────────────────────────
assert.equal(parkedInviteFor(ALICE, BLF_FEDERATION_ID, BLF_FEDERATION_INVITE), BLF_FEDERATION_INVITE);
assert.equal(parkedInviteFor(ALICE, BLF_FEDERATION_ID, GBF_FEDERATION_INVITE), BLF_FEDERATION_INVITE,
  "an active invite for a different listed federation is never used for this one");
assert.equal(parkedInviteFor(ALICE, UNLISTED_ID, UNLISTED), UNLISTED, "the unlisted invite it joined with");
assert.equal(parkedInviteFor(ALICE, UNLISTED_ID, null), UNLISTED, "or the one its route remembers");
assert.equal(parkedInviteFor(BOB, UNLISTED_ID, null), null, "unknown: the wallet cannot be parked, so it is not replaced silently");
assert.equal(parkedInviteFor(null, GBF_FEDERATION_ID.toUpperCase(), null), GBF_FEDERATION_INVITE, "curated fallback");

assert.equal(federationIdForRememberedInvite(ALICE, UNLISTED), UNLISTED_ID);
assert.equal(federationIdForRememberedInvite(BOB, UNLISTED), null);

// ── Which federation an invite belongs to ───────────────────────────────────
let inspected = 0;
const inspector = (answer: unknown) => ({ inspectFederation: async () => { inspected++; return answer as never; } });
assert.equal(await federationIdForInvite(BLF_FEDERATION_INVITE, inspector({})), BLF_FEDERATION_ID.toLowerCase());
assert.equal(inspected, 0, "listed invites are known without a network read");
assert.equal(await federationIdForInvite(UNLISTED, inspector({ federationId: UNLISTED_ID.toUpperCase() })), UNLISTED_ID);
assert.equal(await federationIdForInvite(UNLISTED, inspector({ federationId: "short" })), null, "a malformed id is not trusted");
assert.equal(await federationIdForInvite(UNLISTED, { inspectFederation: async () => { throw new Error("offline"); } }), null,
  "unreachable: no id, so the switch refuses instead of replacing a wallet");
assert.equal(await federationIdForInvite(UNLISTED, null, async () => ({ federationId: UNLISTED_ID }) as never), UNLISTED_ID,
  "without a wallet open, the public preview answers");

// ── Second-review findings (B1, B2, H3, M4, M5) ─────────────────────────────
{
  const CAROL = "d".repeat(64);
  const U = "e".repeat(64);
  const UINV = "fed1qqqqanotherunlistedinviteforcarol";
  // First wallet ever: the identity's legacy file, whatever federation.
  assert.equal(scopeForFederation(CAROL, BLF_FEDERATION_ID), CAROL, "a fresh identity opens its first file");
  rememberRouteOrThrow(CAROL, { federationId: BLF_FEDERATION_ID, inviteCode: BLF_FEDERATION_INVITE, storageScope: CAROL });
  assert.equal(scopeForFederation(CAROL, BLF_FEDERATION_ID), CAROL);
  assert.equal(scopeForFederation(CAROL, U), `${CAROL}:arbiter-fed:${U}`,
    "once the first file belongs to a federation, another federation never opens it");
  assert.equal(scopeForFederation(CAROL, null), CAROL, "unknown id: the first file, where drift handling can see it");
  rememberRouteOrThrow(CAROL, { federationId: U, inviteCode: UINV, storageScope: `${CAROL}:arbiter-fed:${U}` });
  assert.equal(scopeForFederation(CAROL, U), `${CAROL}:arbiter-fed:${U}`, "a parked unlisted wallet reopens its own file");

  // B1: reopening a parked unlisted wallet after the active invite was
  // cleared is not drift, so it is neither re-parked nor replaced.
  assert.equal(walletDrifted({ walletIsJoined: true, walletFederationId: U, desiredFederationId: U,
    previousActiveInvite: null, desiredInvite: UINV }), false);
  assert.equal(walletDrifted({ walletIsJoined: true, walletFederationId: BLF_FEDERATION_ID, desiredFederationId: U,
    previousActiveInvite: UINV, desiredInvite: UINV }), true,
  "H3: same invite string but the open wallet is another federation (native boot on the first database)");
  assert.equal(walletDrifted({ walletIsJoined: false, walletFederationId: null, desiredFederationId: U,
    previousActiveInvite: null, desiredInvite: UINV }), false, "nothing joined: nothing to move");
  assert.equal(walletDrifted({ walletIsJoined: true, walletFederationId: BLF_FEDERATION_ID, desiredFederationId: null,
    previousActiveInvite: UINV, desiredInvite: UINV }), false, "unknown id falls back to the invite comparison");

  // Drift plans for a browser wallet.
  assert.deepEqual(planBrowserDrift({ pubkey: CAROL, walletFederationId: BLF_FEDERATION_ID, openScope: CAROL,
    desiredFederationId: U, previousActiveInvite: BLF_FEDERATION_INVITE }), {
    kind: "park",
    park: { federationId: BLF_FEDERATION_ID.toLowerCase(), inviteCode: BLF_FEDERATION_INVITE, storageScope: CAROL },
    targetScope: `${CAROL}:arbiter-fed:${U}`,
  }, "the open file is parked under its own federation and scope");
  assert.deepEqual(planBrowserDrift({ pubkey: CAROL, walletFederationId: BLF_FEDERATION_ID, openScope: CAROL,
    desiredFederationId: null, previousActiveInvite: BLF_FEDERATION_INVITE }), { kind: "refuse", reason: "target-unreadable" });
  assert.deepEqual(planBrowserDrift({ pubkey: CAROL, walletFederationId: BLF_FEDERATION_ID, openScope: `${CAROL}:arbiter-fed:${U}`,
    desiredFederationId: U, previousActiveInvite: null }), { kind: "refuse", reason: "scope-collision" },
  "a file under the target's own scope holding another federation is never replaced");
  assert.deepEqual(planBrowserDrift({ pubkey: "f".repeat(64), walletFederationId: "9".repeat(64), openScope: "f".repeat(64),
    desiredFederationId: U, previousActiveInvite: null }), { kind: "replace-if-empty" },
  "no known invite for the open wallet: only the balance-guarded path remains");

  // M4: a scope a route points at is a parked wallet.
  assert.equal(scopeHoldsParkedWallet(CAROL, CAROL, U), true);
  assert.equal(scopeHoldsParkedWallet(CAROL, CAROL, BLF_FEDERATION_ID), false, "the open wallet's own route does not count");
  assert.equal(scopeHoldsParkedWallet(CAROL, `${CAROL}:nothing`, null), false);

  // M5: the way back must be on disk before a wallet is closed.
  rememberRouteOrThrow(CAROL, { federationId: U, inviteCode: UINV, storageScope: `${CAROL}:arbiter-fed:${U}`, lastBalanceMsats: 7_000_000 });
  rememberRouteOrThrow(CAROL, { federationId: U, inviteCode: UINV, storageScope: `${CAROL}:arbiter-fed:${U}` });
  assert.equal(getArbiterFederationRoute(CAROL, U)?.lastBalanceMsats, 7_000_000, "a failed balance read keeps the last sighting");
  storageBroken = true;
  assert.throws(() => rememberRouteOrThrow(CAROL, { federationId: GBF_FEDERATION_ID, inviteCode: GBF_FEDERATION_INVITE,
    storageScope: `${CAROL}:arbiter-fed:${GBF_FEDERATION_ID}` }), (e: any) => e.code === "FEDERATION_ROUTE_NOT_SAVED");
  storageBroken = false;
  assert.equal(getArbiterFederationRoute(CAROL, GBF_FEDERATION_ID), null);
}

console.log("PASS H4: wallets are kept per federation, and unlisted federations ask first");
