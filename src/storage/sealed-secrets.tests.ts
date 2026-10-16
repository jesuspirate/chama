// Audit M9: the saved Nostr key and saved NWC connections are kept
// encrypted in the browser. These tests drive the move from plain storage
// with a fake sealer; sealed-store.ts itself is exercised in a real browser.
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { readBrowserSavedNsec, removeBrowserSavedNsec, saveNsec, SAVED_NSEC_KEY, NSEC_ORIGIN_KEY } =
  await import("./saved-nsec.js");
const { setLocalStorageUserScope, scopedStorageKey } = await import("./user-scope.js");
const nwc = await import("../payments/nwc-connections.js");

function fakeSealer(opts: { failSet?: boolean; failGet?: boolean } = {}) {
  const sealed = new Map<string, string>();
  return {
    sealed,
    opts,
    get: async (name: string) => { if (opts.failGet) throw new Error("unreadable"); return sealed.get(name) ?? null; },
    set: async (name: string, value: string) => { if (opts.failSet) throw new Error("no space"); sealed.set(name, value); },
    delete: async (name: string) => { sealed.delete(name); },
  };
}

// ── saved Nostr key ─────────────────────────────────────────────────────
{
  const s = fakeSealer();
  await saveNsec("nsec1kept", "generated", localStorage, undefined, s);
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1kept", "kept encrypted");
  assert.equal(store.get(SAVED_NSEC_KEY), undefined, "no plain copy left behind");
  assert.equal(store.get(NSEC_ORIGIN_KEY), "generated");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1kept");

  await removeBrowserSavedNsec(localStorage, s);
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false);
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);
}
{
  // An older app's plain key moves in, and its plain copy goes only once sealed.
  const s = fakeSealer();
  store.set(SAVED_NSEC_KEY, "nsec1old");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1old");
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1old");
  assert.equal(store.get(SAVED_NSEC_KEY), undefined);
}
{
  // Sealing fails: the key is still kept, plainly, never dropped.
  const s = fakeSealer({ failSet: true });
  store.set(SAVED_NSEC_KEY, "nsec1plain");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1plain");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1plain", "plain copy kept when sealing fails");
  store.clear();
  await saveNsec("nsec1fallback", "imported", localStorage, undefined, s);
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1fallback", "save falls back to plain storage");
}
{
  // An unreadable sealed copy is never deleted, and a plain copy still works.
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1sealed");
  s.opts.failGet = true;
  store.clear();
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1sealed", "unreadable sealed key left untouched");
}

// ── saved NWC connections ───────────────────────────────────────────────
const walletA = "a".repeat(64);
const walletB = "b".repeat(64);
const conn = (wallet: string, secret: string) =>
  `nostr+walletconnect://${wallet}?relay=wss%3A%2F%2Frelay.example.com&secret=${secret}`;
const user = "c".repeat(64);
const primaryKey = scopedStorageKey(nwc.NWC_CONNECTIONS_STORAGE_KEY, user);
const backupKey = scopedStorageKey(nwc.NWC_CONNECTIONS_BACKUP_STORAGE_KEY, user);
{
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "1".repeat(64)));
  assert.ok(store.get(primaryKey)?.includes(walletA), "before loading, the plain path works as before");

  const s = fakeSealer();
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 1, "the old plain list moved in");
  assert.ok(s.sealed.get(primaryKey)?.includes(walletA), "and is stored encrypted");
  assert.equal(store.get(primaryKey), undefined, "plain copy removed after the encrypted one read back");
  assert.equal(store.get(backupKey), undefined);

  nwc.addOrTouchSavedNwcConnection(conn(walletB, "2".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.equal(nwc.listSavedNwcConnections().length, 2);
  assert.ok(s.sealed.get(primaryKey)?.includes(walletB), "new connections are written encrypted");
  assert.equal(store.get(primaryKey), undefined, "and never in plain text");

  const id = nwc.listSavedNwcConnections()[0].id;
  nwc.renameSavedNwcConnection(id, "Phone wallet");
  nwc.deleteSavedNwcConnection(nwc.listSavedNwcConnections()[1].id);
  await nwc.flushSealedNwcWrites();
  const reloaded = JSON.parse(s.sealed.get(primaryKey)!);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].label, "Phone wallet");

  // A new session reads the encrypted list back.
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections()[0].label, "Phone wallet");
}
{
  // Sealing fails while writing: the list is kept plainly, not lost.
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  const s = fakeSealer();
  await nwc.hydrateSavedNwcConnections(s);
  s.opts.failSet = true;
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "3".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.ok(store.get(primaryKey)?.includes(walletA), "plain fallback when sealing fails");
}
{
  // An unreadable encrypted list leaves everything on the old path, untouched.
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  const s = fakeSealer();
  s.sealed.set(primaryKey, "[]");
  s.opts.failGet = true;
  store.set(primaryKey, JSON.stringify([]));
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "4".repeat(64)));
  await nwc.hydrateSavedNwcConnections(s);
  assert.ok(store.get(primaryKey)?.includes(walletA), "plain list still served and kept");
  assert.equal(s.sealed.get(primaryKey), "[]", "unreadable encrypted copy not overwritten");
}
{
  // Each identity has its own list; signing out falls back to plain storage.
  store.clear();
  nwc.resetSealedNwcForTests();
  const s = fakeSealer();
  setLocalStorageUserScope(user);
  await nwc.hydrateSavedNwcConnections(s);
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "5".repeat(64)));
  await nwc.flushSealedNwcWrites();
  setLocalStorageUserScope("d".repeat(64));
  assert.equal(nwc.listSavedNwcConnections().length, 0, "another identity doesn't see this list");
  setLocalStorageUserScope(null);
  assert.equal(nwc.listSavedNwcConnections().length, 0);
  setLocalStorageUserScope(user);
  assert.equal(nwc.listSavedNwcConnections().length, 1);
}

{
  // Review blocker: another tab's change must survive this tab's next write.
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  const s = fakeSealer();
  await nwc.hydrateSavedNwcConnections(s);
  const x = conn(walletA, "6".repeat(64));
  nwc.addOrTouchSavedNwcConnection(x);
  await nwc.flushSealedNwcWrites();
  // Another tab adds Y straight into sealed storage; this tab's memory has only X.
  const stored = JSON.parse(s.sealed.get(primaryKey)!);
  const y = { ...stored[0], id: "nwc_other_tab", connectionString: conn(walletB, "7".repeat(64)), walletPubkey: walletB };
  s.sealed.set(primaryKey, JSON.stringify([y, ...stored]));
  nwc.addOrTouchSavedNwcConnection(x); // pay with X here
  await nwc.flushSealedNwcWrites();
  const after = JSON.parse(s.sealed.get(primaryKey)!);
  assert.equal(after.length, 2, "the other tab's wallet is kept");
  assert.equal(nwc.listSavedNwcConnections().length, 2, "and this tab now shows it");

  // Another tab deletes Y; touching X here must not bring Y back.
  s.sealed.set(primaryKey, JSON.stringify(after.filter((c: any) => c.walletPubkey !== walletB)));
  nwc.addOrTouchSavedNwcConnection(x);
  await nwc.flushSealedNwcWrites();
  assert.equal(JSON.parse(s.sealed.get(primaryKey)!).length, 1, "a wallet deleted elsewhere stays deleted");

  // Deleting here removes it by wallet secret too, so no copy comes back.
  nwc.deleteSavedNwcConnection(nwc.listSavedNwcConnections()[0].id);
  await nwc.flushSealedNwcWrites();
  assert.equal(JSON.parse(s.sealed.get(primaryKey)!).length, 0);
}
{
  // Review: a newer plain key beats an older sealed one, and is moved in.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1older");
  store.set(SAVED_NSEC_KEY, "nsec1newer");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1newer");
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1newer");
  // A save that falls back to plain also clears the older sealed key.
  s.sealed.set(SAVED_NSEC_KEY, "nsec1older");
  s.opts.failSet = true;
  await saveNsec("nsec1fresh", "imported", localStorage, undefined, s);
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false);
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1fresh");
}
{
  // Review: if the sealed key can't be deleted, signing out still sticks.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1stuck");
  const stuck = { ...s, delete: async () => { throw new Error("blocked"); } };
  await removeBrowserSavedNsec(localStorage, stuck);
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "no auto sign-in after sign-out");
  await saveNsec("nsec1again", "imported", localStorage, undefined, s);
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1again", "saving again clears the mark");
}

console.log("PASS M9: saved key and NWC connections kept encrypted, moved in from plain storage, never dropped");
