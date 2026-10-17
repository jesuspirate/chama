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
  federationIdForInvite, federationIdForRememberedInvite, federationIdFromInvite, knownFederationIdForInvite,
  inviteToRemember, parkedInviteFor, planBrowserDrift, planBrowserWalletScope, rememberRouteOrThrow, routeAfterJoin,
  scopeForFederation, scopeHoldsParkedWallet, walletDrifted,
} = await import("./federation-parking.js");
const { acceptUnlistedFederation, createSessionUnlistedConsent, hasAcceptedUnlistedFederation } =
  await import("./unlisted-federation-consent.js");
const invites = await import("./federation-invites.js");
const { bech32m } = await import("@scure/base");
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

// ── Third-review findings: an unverified invite never lands on another
// federation's wallet, every join records its route, consent is per identity
{
  // A real-shaped invite: one API part, then the federation id part.
  const makeInviteAt = (guardian: string, ...ids: string[]) => {
    const url = new TextEncoder().encode(guardian);
    const api = [url.length, ...url, 0];
    const bytes = [1 + ids.length, 0, api.length, ...api];
    for (const id of ids) bytes.push(1, 32, ...(id.match(/../g) ?? []).map((h) => parseInt(h, 16)));
    return bech32m.encode("fed1", bech32m.toWords(Uint8Array.from(bytes)), 10_000);
  };
  const makeInvite = (...ids: string[]) => makeInviteAt("wss://guardian.example/", ...ids);

  // Every listed invite decodes locally to the id Chama ships for it.
  for (const [name, value] of Object.entries(invites)) {
    if (!name.endsWith("_FEDERATION_INVITE") || typeof value !== "string") continue;
    const shipped = (invites as Record<string, unknown>)[name.replace(/_INVITE$/, "_ID")];
    if (typeof shipped === "string") assert.equal(federationIdFromInvite(value), shipped.toLowerCase(), name);
    else assert.match(federationIdFromInvite(value) ?? "", /^[0-9a-f]{64}$/, `${name} decodes`);
  }
  const U = "1".repeat(64);
  const W = "2".repeat(64);
  const UINV = makeInvite(U);
  assert.equal(federationIdFromInvite(UINV), U, "an unlisted invite names its federation without a network read");
  assert.equal(federationIdFromInvite(` ${UINV} `), U);
  assert.equal(federationIdFromInvite(makeInvite(U, W)), null, "two different ids: trust neither");
  assert.equal(federationIdFromInvite(makeInvite()), null, "no id part");
  assert.equal(federationIdFromInvite(UNLISTED), null, "a malformed invite is not guessed at");
  assert.equal(federationIdFromInvite(UINV.slice(0, -1) + (UINV.endsWith("q") ? "p" : "q")), null, "a bad checksum is refused");
  assert.equal(federationIdFromInvite(bech32m.encode("lnurl", bech32m.toWords(new Uint8Array([0])))), null);
  assert.equal(knownFederationIdForInvite(BLF_FEDERATION_INVITE), BLF_FEDERATION_ID.toLowerCase());
  let asked = 0;
  assert.equal(await federationIdForInvite(UINV, { inspectFederation: async () => { asked++; throw new Error("offline"); } }), U);
  assert.equal(asked, 0, "guardians offline do not matter for a decodable invite");

  // Finding 1: DAVE's first file is BLF's wallet. An invite whose federation
  // can't be identified is refused; it never opens BLF's file as its own.
  const DAVE = "7".repeat(64);
  rememberRouteOrThrow(DAVE, { federationId: BLF_FEDERATION_ID, inviteCode: BLF_FEDERATION_INVITE, storageScope: DAVE });
  const blfBefore = JSON.stringify(getArbiterFederationRoute(DAVE, BLF_FEDERATION_ID));
  assert.deepEqual(planBrowserWalletScope(DAVE, null), { kind: "refuse", reason: "target-unverified" });
  assert.deepEqual(planBrowserWalletScope(DAVE, "nonsense"), { kind: "refuse", reason: "target-unverified" });
  assert.deepEqual(planBrowserWalletScope(DAVE, knownFederationIdForInvite(UINV)),
    { kind: "open", scope: `${DAVE}:arbiter-fed:${U}` }, "a decodable unlisted invite opens its own file, not BLF's");
  assert.deepEqual(planBrowserWalletScope(DAVE, BLF_FEDERATION_ID), { kind: "open", scope: DAVE });
  // The next switch away from BLF with the unverified invite still active
  // must not rewrite BLF's route with that invite.
  assert.equal(parkedInviteFor(DAVE, BLF_FEDERATION_ID, UNLISTED), BLF_FEDERATION_INVITE,
    "an invite whose federation can't be checked is never pinned onto the open wallet");
  assert.equal(parkedInviteFor(DAVE, BLF_FEDERATION_ID, UINV), BLF_FEDERATION_INVITE, "nor one that names another federation");
  rememberRouteOrThrow(DAVE, { federationId: BLF_FEDERATION_ID,
    inviteCode: parkedInviteFor(DAVE, BLF_FEDERATION_ID, UNLISTED)!, storageScope: DAVE });
  assert.equal(JSON.stringify({ ...getArbiterFederationRoute(DAVE, BLF_FEDERATION_ID), updatedAt: 0 }),
    JSON.stringify({ ...JSON.parse(blfBefore), updatedAt: 0 }), "BLF's route is unchanged");
  assert.equal(federationIdForRememberedInvite(DAVE, UNLISTED), null, "the unverified invite maps to no federation");
  assert.equal(parkedInviteFor(DAVE, U, UINV), UINV, "an invite that names this federation is used");
  assert.equal(parkedInviteFor(BOB, UNLISTED_ID, UNLISTED), null,
    "an unverifiable invite with no route: the wallet cannot be parked, so it is not replaced silently");

  // Finding 2: a first join on a fresh file records its route.
  const ERIN = "8".repeat(64);
  const fresh = routeAfterJoin({ pubkey: ERIN, joinedFederationId: U.toUpperCase(), joinedInvite: ` ${UINV} `,
    desiredFederationId: null, reopenedWallet: false, openScope: `${ERIN}:arbiter-fed:${U}`, native: false });
  assert.deepEqual(fresh, { federationId: U, inviteCode: UINV, storageScope: `${ERIN}:arbiter-fed:${U}` },
    "a fresh file joined with the invite proves which federation it names");
  rememberArbiterFederationRoute(ERIN, fresh!);
  assert.equal(listArbiterFederationRoutes(ERIN).length, 1, "the joined wallet is now listed in Me → Sats");
  assert.equal(parkedInviteFor(ERIN, U, UINV), UINV);
  assert.deepEqual(routeAfterJoin({ pubkey: ERIN, joinedFederationId: BLF_FEDERATION_ID, joinedInvite: BLF_FEDERATION_INVITE,
    desiredFederationId: BLF_FEDERATION_ID, reopenedWallet: true, openScope: ERIN, native: false }),
  { federationId: BLF_FEDERATION_ID.toLowerCase(), inviteCode: BLF_FEDERATION_INVITE, storageScope: ERIN },
  "a reopened wallet whose invite was checked is recorded");
  assert.equal(routeAfterJoin({ pubkey: DAVE, joinedFederationId: BLF_FEDERATION_ID, joinedInvite: UNLISTED,
    desiredFederationId: null, reopenedWallet: true, openScope: DAVE, native: false }), null,
  "BLF's reopened wallet is never recorded under an invite nobody checked (the old poisoning)");

  // Second review: an invite that only CLAIMS a federation's id (it points at
  // other guardians) never replaces the invite that reopens that wallet.
  const FORGED = makeInviteAt("wss://someone-else.example/", U);
  assert.notEqual(FORGED, UINV);
  assert.equal(knownFederationIdForInvite(FORGED), U, "it decodes to the federation it claims");
  assert.equal(inviteToRemember(UINV, FORGED), UINV, "the route keeps the invite it has");
  assert.equal(inviteToRemember(null, FORGED), FORGED, "a route with no invite yet takes it");
  assert.equal(inviteToRemember(GBF_FEDERATION_INVITE, BLF_FEDERATION_INVITE), BLF_FEDERATION_INVITE, "a listed invite is taken");
  assert.equal(parkedInviteFor(ERIN, U, FORGED), UINV, "parking with the forged invite active keeps the real one");
  const erinBefore = getArbiterFederationRoute(ERIN, U)?.inviteCode;
  assert.deepEqual(routeAfterJoin({ pubkey: ERIN, joinedFederationId: U, joinedInvite: FORGED,
    desiredFederationId: U, reopenedWallet: true, openScope: `${ERIN}:arbiter-fed:${U}`, native: false }),
  { federationId: U, inviteCode: UINV, storageScope: `${ERIN}:arbiter-fed:${U}` },
  "a reopened wallet's join proves nothing about the invite, so the route keeps its own");
  assert.equal(erinBefore, UINV);
  assert.equal(routeAfterJoin({ pubkey: "9".repeat(64), joinedFederationId: U, joinedInvite: FORGED,
    desiredFederationId: U, reopenedWallet: false, openScope: `${"9".repeat(64)}:arbiter-fed:${U}`, native: false })?.inviteCode,
  FORGED, "a fresh join reached the guardians with it, which proves it");
  assert.equal(routeAfterJoin({ pubkey: DAVE, joinedFederationId: BLF_FEDERATION_ID, joinedInvite: UINV,
    desiredFederationId: U, reopenedWallet: true, openScope: DAVE, native: false }), null, "a mismatched join records nothing");
  assert.equal(routeAfterJoin({ pubkey: DAVE, joinedFederationId: W, joinedInvite: makeInvite(W),
    desiredFederationId: W, reopenedWallet: false, openScope: DAVE, native: false }), null,
  "a file another federation's route claims is never given a second owner");
  assert.equal(getArbiterFederationRoute(DAVE, BLF_FEDERATION_ID)?.inviteCode, BLF_FEDERATION_INVITE);
  assert.equal(routeAfterJoin({ pubkey: ERIN, joinedFederationId: U, joinedInvite: UINV,
    desiredFederationId: U, reopenedWallet: true, openScope: null, native: false }), null, "no browser file, no route");
  assert.deepEqual(routeAfterJoin({ pubkey: ERIN, joinedFederationId: U, joinedInvite: UINV,
    desiredFederationId: U, reopenedWallet: true, openScope: null, native: true }),
  { federationId: U, inviteCode: UINV, storageScope: `${ERIN}:arbiter-fed:${U}` }, "native keeps the route's scope");

  // Finding 3: a session yes belongs to one identity.
  const session = createSessionUnlistedConsent();
  session.accept(ALICE, ` ${UINV} `);
  assert.equal(session.has(ALICE, UINV), true);
  assert.equal(session.has(ALICE.toUpperCase(), UINV), true);
  assert.equal(session.has(BOB, UINV), false, "a second identity on the same tab is still asked");
  assert.equal(session.has(null, UINV), false);
  session.accept(null, UINV);
  session.accept(BOB, "not-an-invite");
  assert.equal(session.has(BOB, "not-an-invite"), false);
}

console.log("PASS H4: wallets are kept per federation, and unlisted federations ask first");
