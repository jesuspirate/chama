// Audit M9, first step: the saved Nostr key and saved NWC connections are
// also written encrypted in the browser, while the plain copies stay the
// ones that are read, so an older app sees exactly what this one sees. These
// tests drive that with a fake sealer; sealed-store.ts itself is exercised
// in a real browser.
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { readBrowserSavedNsec, removeBrowserSavedNsec, saveNsec, flushSealedNsecWrites, SAVED_NSEC_KEY, NSEC_ORIGIN_KEY } =
  await import("./saved-nsec.js");
const { setLocalStorageUserScope, scopedStorageKey } = await import("./user-scope.js");
const nwc = await import("../payments/nwc-connections.js");

function fakeSealer(opts: { failSet?: boolean; failGet?: boolean; failDelete?: boolean; hang?: boolean } = {}) {
  const sealed = new Map<string, string>();
  const hang = () => new Promise<never>(() => {});
  return {
    sealed,
    opts,
    get: async (name: string) => {
      if (opts.hang) return hang();
      if (opts.failGet) throw new Error("unreadable");
      return sealed.get(name) ?? null;
    },
    set: async (name: string, value: string) => { if (opts.failSet) throw new Error("no space"); sealed.set(name, value); },
    delete: async (name: string) => { if (opts.failDelete) throw new Error("blocked"); sealed.delete(name); },
  };
}

// An older app (6.4.28 and before) reads and writes only the plain copies.
const olderApp = {
  readKey: () => store.get(SAVED_NSEC_KEY) ?? null,
  signOut: () => { store.delete(SAVED_NSEC_KEY); store.delete(NSEC_ORIGIN_KEY); },
};

// ── saved Nostr key ─────────────────────────────────────────────────────
{
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1kept", "generated", localStorage, undefined, s);
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1kept", "an encrypted copy is written");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1kept", "the plain copy stays for older apps");
  assert.equal(store.get(NSEC_ORIGIN_KEY), "generated");
  assert.equal(olderApp.readKey(), "nsec1kept", "an older app still finds the key");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1kept");

  await removeBrowserSavedNsec(localStorage, s);
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false, "sign-out removes the encrypted copy");
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);
}
{
  // Review blocker 1: an encrypted copy that can't be opened must never read
  // as "no key" and let Create replace the real one. The plain copy is what
  // is read, so the real key still signs in, and nothing is overwritten.
  store.clear();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(SAVED_NSEC_KEY, "nsec1other");
  store.set(SAVED_NSEC_KEY, "nsec1real");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1real", "the real key still signs in");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1other", "an unreadable encrypted copy is left as it is");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1real");
}
{
  // Review blocker 2: an older app (stale tab, rollback) still sees the key,
  // and its sign-out signs this app out too.
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1both", "imported", localStorage, undefined, s);
  await flushSealedNsecWrites();
  assert.equal(olderApp.readKey(), "nsec1both");
  olderApp.signOut();
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "signed out in an older app means signed out here");
  // An older app's new login replaces the encrypted copy on the next read.
  store.set(SAVED_NSEC_KEY, "nsec1fromolder");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1fromolder");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1fromolder", "the encrypted copy follows the plain one");
}
{
  // The encrypted copy failing or hanging never stops the key being kept or read.
  store.clear();
  const failing = fakeSealer({ failSet: true });
  await saveNsec("nsec1plain", "imported", localStorage, undefined, failing);
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1plain");
  assert.equal(await readBrowserSavedNsec(localStorage, failing), "nsec1plain");
  await flushSealedNsecWrites();
}
{
  // Sign-out sticks even when the encrypted copy can't be deleted: the plain
  // copy is gone and that is what is read.
  store.clear();
  const s = fakeSealer({ failDelete: true });
  s.sealed.set(SAVED_NSEC_KEY, "nsec1stuck");
  store.set(SAVED_NSEC_KEY, "nsec1stuck");
  await removeBrowserSavedNsec(localStorage, s);
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "no sign-in after sign-out");
}
{
  // A sign-out straight after a save is never overtaken by the save's encrypted write.
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1quick", "generated", localStorage, undefined, s);
  await removeBrowserSavedNsec(localStorage, s);
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false, "no encrypted key left after signing out");
}

{
  // Last for the key (it holds the queue until its time runs out): a stuck
  // encrypted store never holds up sign-in.
  store.clear();
  store.set(SAVED_NSEC_KEY, "nsec1plain");
  const stuck = fakeSealer({ hang: true });
  const read = await Promise.race([
    readBrowserSavedNsec(localStorage, stuck),
    new Promise((r) => setTimeout(() => r("timed out"), 200)),
  ]);
  assert.equal(read, "nsec1plain", "a stuck encrypted store never holds up sign-in");
}

// ── saved NWC connections ───────────────────────────────────────────────
const walletA = "a".repeat(64);
const walletB = "b".repeat(64);
const conn = (wallet: string, secret: string) =>
  `nostr+walletconnect://${wallet}?relay=wss%3A%2F%2Frelay.example.com&secret=${secret}`;
const user = "c".repeat(64);
const primaryKey = scopedStorageKey(nwc.NWC_CONNECTIONS_STORAGE_KEY, user);
const sealedList = (s: ReturnType<typeof fakeSealer>) => JSON.parse(s.sealed.get(primaryKey) ?? "[]");
{
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "1".repeat(64)));
  const s = fakeSealer();
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(sealedList(s).length, 1, "the existing list gets an encrypted copy");
  assert.ok(store.get(primaryKey)?.includes(walletA), "the plain list stays for older apps");

  nwc.addOrTouchSavedNwcConnection(conn(walletB, "2".repeat(64)));
  const id = nwc.listSavedNwcConnections().find(c => c.walletPubkey === walletA)!.id;
  nwc.renameSavedNwcConnection(id, "Phone wallet");
  await nwc.flushSealedNwcWrites();
  assert.equal(sealedList(s).length, 2, "new wallets are copied encrypted");
  assert.equal(sealedList(s).find((c: any) => c.walletPubkey === walletA).label, "Phone wallet");

  // Review should-fix: a deleted wallet must not come back.
  nwc.deleteSavedNwcConnection(id);
  await nwc.flushSealedNwcWrites();
  assert.equal(nwc.listSavedNwcConnections().length, 1);
  assert.equal(sealedList(s).length, 1, "a deletion is deleted from the encrypted copy too");
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 1, "and stays deleted after a reload");
}
{
  // Review should-fix: an unreadable or failing encrypted copy never empties
  // the list the user sees.
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  const s = fakeSealer({ failGet: true, failSet: true });
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "3".repeat(64)));
  await nwc.hydrateSavedNwcConnections(s);
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "4".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.equal(nwc.listSavedNwcConnections().length, 2, "the wallets still show");
  assert.ok(store.get(primaryKey)?.includes(walletB));
}
{
  // An older app's changes to the plain list are what this app shows.
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
  const s = fakeSealer();
  await nwc.hydrateSavedNwcConnections(s);
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "5".repeat(64)));
  await nwc.flushSealedNwcWrites();
  store.set(primaryKey, "[]");
  store.delete(scopedStorageKey(nwc.NWC_CONNECTIONS_BACKUP_STORAGE_KEY, user));
  assert.equal(nwc.listSavedNwcConnections().length, 0, "a wallet deleted in an older app stays deleted");
}
{
  // Each identity has its own list.
  store.clear();
  nwc.resetSealedNwcForTests();
  const s = fakeSealer();
  setLocalStorageUserScope(user);
  await nwc.hydrateSavedNwcConnections(s);
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "6".repeat(64)));
  await nwc.flushSealedNwcWrites();
  setLocalStorageUserScope("d".repeat(64));
  assert.equal(nwc.listSavedNwcConnections().length, 0, "another identity doesn't see this list");
  setLocalStorageUserScope(user);
  assert.equal(nwc.listSavedNwcConnections().length, 1);
}

console.log("PASS M9 step 1: encrypted copies follow the plain ones; older apps, failures and deletions stay safe");
