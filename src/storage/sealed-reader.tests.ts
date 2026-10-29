// Audit M9, second step: Chama reads the encrypted copies of the kept Nostr
// key and saved NWC wallets. A stored key that can't be opened is never "no
// key", nothing stored is replaced or removed unread without an archive, and
// the switch that removes plain copies (off in 6.4.32) is exercised here so
// the release that turns it on flips a tested line. Driven with a fake
// sealer; sealed-store.ts itself is exercised in a real browser.
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const keys = await import("./saved-nsec.js");
const {
  readBrowserSavedNsec, removeBrowserSavedNsec, saveNsec, flushSealedNsecWrites, setDropPlainSavedNsecForTests,
  SavedKeyUnreadableError, SAVED_NSEC_KEY, NSEC_ORIGIN_KEY, SEALED_ONLY_MARKER_KEY,
} = keys;
const { setLocalStorageUserScope, scopedStorageKey } = await import("./user-scope.js");
const nwc = await import("../payments/nwc-connections.js");

function fakeSealer(opts: { failSet?: boolean; failGet?: boolean; failArchive?: boolean } = {}) {
  const sealed = new Map<string, string>();
  return {
    sealed,
    opts,
    get: async (name: string) => { if (opts.failGet) throw new Error("unreadable"); return sealed.get(name) ?? null; },
    set: async (name: string, value: string) => { if (opts.failSet) throw new Error("no space"); sealed.set(name, value); },
    delete: async (name: string) => { sealed.delete(name); },
    archive: async (name: string) => {
      if (opts.failArchive) throw new Error("archive failed");
      if (!sealed.has(name)) return null;
      const to = `${name}#archived:${[...sealed.keys()].filter((k) => k.startsWith(`${name}#archived:`)).length + 1}`;
      sealed.set(to, sealed.get(name)!);
      return to;
    },
  };
}
const archivesOf = (s: ReturnType<typeof fakeSealer>, name: string) =>
  [...s.sealed.entries()].filter(([k]) => k.startsWith(`${name}#archived:`)).map(([, v]) => v);
const quiet = console.warn;
console.warn = () => {};

// ── kept Nostr key, 6.4.32 (plain copies kept) ──────────────────────────
setDropPlainSavedNsecForTests(false);
{
  // A plain key with no encrypted copy gets one; the plain copy stays.
  store.clear();
  const s = fakeSealer();
  store.set(SAVED_NSEC_KEY, "nsec1a");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1a");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1a");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1a", "6.4.32 keeps the plain copy for older versions");
  assert.equal(archivesOf(s, SAVED_NSEC_KEY).length, 0, "an empty store needs no archive");
}
{
  // The plain copy is the kept key; a different encrypted copy is archived
  // before it is replaced.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1old");
  store.set(SAVED_NSEC_KEY, "nsec1new");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1new");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1new");
  assert.deepEqual(archivesOf(s, SAVED_NSEC_KEY), ["nsec1old"], "the replaced key is archived");
}
{
  // When the archive can't be made, nothing is replaced.
  store.clear();
  const s = fakeSealer({ failArchive: true });
  s.sealed.set(SAVED_NSEC_KEY, "nsec1old");
  store.set(SAVED_NSEC_KEY, "nsec1new");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1new");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1old", "no archive, no replacement");
}
{
  // An encrypted copy with no plain copy and no marker is left over from a
  // sign-out in an older version: never signed in with, moved aside.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1signedout");
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "a signed-out key never signs in again");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false);
  assert.deepEqual(archivesOf(s, SAVED_NSEC_KEY), ["nsec1signedout"], "and is archived, not lost");
}
{
  // With the marker (written by a release that removes plain copies), the
  // encrypted copy is the kept key. 6.4.32 writes the plain copy back, so a
  // version that reads only plain copies finds it again.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1sealed");
  store.set(SEALED_ONLY_MARKER_KEY, "1");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1sealed");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1sealed", "the plain copy is restored");
  assert.equal(store.has(SEALED_ONLY_MARKER_KEY), false);
}
{
  // A kept key that can't be opened is never "no key": the read throws, and
  // nothing is deleted. Retry reads it once it opens.
  store.clear();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(SAVED_NSEC_KEY, "nsec1locked");
  store.set(SEALED_ONLY_MARKER_KEY, "1");
  await assert.rejects(readBrowserSavedNsec(localStorage, s), SavedKeyUnreadableError);
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1locked", "nothing is deleted");
  assert.equal(store.get(SEALED_ONLY_MARKER_KEY), "1", "the marker stays, so Retry still knows a key is kept");
  s.opts.failGet = false;
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1locked", "Retry signs in once the key opens");

  // "Sign in with my key" instead: the unreadable key is archived first.
  store.clear();
  s.opts.failGet = true;
  s.sealed.clear();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1locked");
  store.set(SEALED_ONLY_MARKER_KEY, "1");
  await assert.rejects(readBrowserSavedNsec(localStorage, s), SavedKeyUnreadableError);
  await saveNsec("nsec1pasted", "imported", localStorage, undefined, s);
  await flushSealedNsecWrites();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1pasted");
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1pasted");
  assert.deepEqual(archivesOf(s, SAVED_NSEC_KEY), ["nsec1locked"], "the key that wouldn't open is kept aside");

  // "Keep me signed in" unchecked while the key won't open: archived, not deleted.
  store.clear();
  s.sealed.clear();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1locked2");
  store.set(SEALED_ONLY_MARKER_KEY, "1");
  await removeBrowserSavedNsec(localStorage, s);
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false);
  assert.deepEqual(archivesOf(s, SAVED_NSEC_KEY), ["nsec1locked2"]);
}
{
  // Sign-out waits for the encrypted delete, so a reload right after can't
  // find the key, and deletes the key being signed out without an archive.
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1me", "generated", localStorage, undefined, s);
  await removeBrowserSavedNsec(localStorage, s);
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false, "deleted before sign-out returns");
  assert.equal(archivesOf(s, SAVED_NSEC_KEY).length, 0, "the signed-out key is forgotten, as the screen says");
  assert.equal(store.has(SAVED_NSEC_KEY), false);
  assert.equal(store.has(NSEC_ORIGIN_KEY), false);
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);

  // An encrypted copy holding some other key is archived, not deleted unread.
  s.sealed.set(SAVED_NSEC_KEY, "nsec1someoneelse");
  store.set(SAVED_NSEC_KEY, "nsec1me");
  await removeBrowserSavedNsec(localStorage, s);
  assert.deepEqual(archivesOf(s, SAVED_NSEC_KEY), ["nsec1someoneelse"]);
}

// ── kept Nostr key, the switch that removes plain copies ────────────────
setDropPlainSavedNsecForTests(true);
{
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1only", "generated", localStorage, undefined, s);
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1only");
  assert.equal(store.has(SAVED_NSEC_KEY), false, "the plain copy is removed once the encrypted one reads back");
  assert.equal(store.get(SEALED_ONLY_MARKER_KEY), "1");
  assert.equal(store.get(NSEC_ORIGIN_KEY), "generated", "the origin (not secret) stays plain");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1only");
  assert.equal(store.has(SAVED_NSEC_KEY), false, "reading doesn't write the plain copy back");

  await removeBrowserSavedNsec(localStorage, s);
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false);
  assert.equal(store.has(SEALED_ONLY_MARKER_KEY), false);
  assert.equal(archivesOf(s, SAVED_NSEC_KEY).length, 0);
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);
}
{
  // The encrypted store failing keeps the key plainly, with no marker.
  store.clear();
  const s = fakeSealer({ failSet: true });
  await saveNsec("nsec1plainonly", "imported", localStorage, undefined, s);
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1plainonly");
  assert.equal(store.has(SEALED_ONLY_MARKER_KEY), false);
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1plainonly");
}
{
  // A plain key from an older version is moved in on read, and a key
  // another tab saved meanwhile is never removed.
  store.clear();
  const s = fakeSealer();
  store.set(SAVED_NSEC_KEY, "nsec1older");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1older");
  await flushSealedNsecWrites();
  assert.equal(store.has(SAVED_NSEC_KEY), false);
  assert.equal(s.sealed.get(SAVED_NSEC_KEY), "nsec1older");

  store.clear();
  s.sealed.clear();
  store.set(SAVED_NSEC_KEY, "nsec1first");
  const read = readBrowserSavedNsec(localStorage, s);
  store.set(SAVED_NSEC_KEY, "nsec1othertab");
  assert.equal(await read, "nsec1first");
  await flushSealedNsecWrites();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1othertab", "another tab's key is never removed");
}
setDropPlainSavedNsecForTests(false);

// ── saved NWC wallets ───────────────────────────────────────────────────
const walletA = "a".repeat(64);
const walletB = "b".repeat(64);
const conn = (wallet: string, secret: string) =>
  `nostr+walletconnect://${wallet}?relay=wss%3A%2F%2Frelay.example.com&secret=${secret}`;
const user = "c".repeat(64);
const primaryKey = scopedStorageKey(nwc.NWC_CONNECTIONS_STORAGE_KEY, user);
const backupKey = scopedStorageKey(nwc.NWC_CONNECTIONS_BACKUP_STORAGE_KEY, user);
const markerKey = scopedStorageKey(nwc.NWC_SEALED_ONLY_MARKER_KEY, user);
const entry = (wallet: string, secret: string) => ({
  id: `nwc_${wallet.slice(0, 4)}`, connectionString: conn(wallet, secret), label: "W",
  walletPubkey: wallet, relayCount: 1, createdAt: 1,
});
function fresh() {
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
}

nwc.setDropPlainNwcForTests(false);
{
  // A sealed-only list (marker) is read, and 6.4.32 writes it back plainly.
  fresh();
  const s = fakeSealer();
  s.sealed.set(primaryKey, JSON.stringify([entry(walletA, "1".repeat(64))]));
  store.set(markerKey, "1");
  assert.equal(nwc.listSavedNwcConnections().length, 0, "nothing shows before the encrypted list is read");
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 1, "the encrypted list is the list");
  assert.ok(store.get(primaryKey)?.includes(walletA), "written back plainly for older versions");
  assert.equal(store.has(markerKey), false);
}
{
  // A sealed-only list that can't be opened is never replaced unread: it is
  // archived, and a wallet added meanwhile is kept plainly.
  fresh();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(primaryKey, JSON.stringify([entry(walletA, "2".repeat(64))]));
  store.set(markerKey, "1");
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 0);
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "3".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.ok(store.get(primaryKey)?.includes(walletB), "the new wallet is kept");
  assert.equal(archivesOf(s, primaryKey).length, 1, "the unreadable list is archived first");
  assert.ok(archivesOf(s, primaryKey)[0].includes(walletA));
}
{
  // An encrypted list with wallets and no plain list or marker is archived
  // before the copy of the (empty) plain list replaces it.
  fresh();
  const s = fakeSealer();
  s.sealed.set(primaryKey, JSON.stringify([entry(walletA, "4".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 0, "a list no plain copy stands behind is not shown");
  assert.equal(s.sealed.get(primaryKey), "[]");
  assert.equal(archivesOf(s, primaryKey).length, 1);
}

nwc.setDropPlainNwcForTests(true);
{
  // The switch: after the encrypted list reads back, the plain copies go and
  // changes keep going to the encrypted list.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "5".repeat(64)));
  await nwc.hydrateSavedNwcConnections(s);
  await nwc.flushSealedNwcWrites();
  assert.equal(store.has(primaryKey), false, "plain list removed");
  assert.equal(store.has(backupKey), false, "plain backup removed");
  assert.equal(store.get(markerKey), "1");
  assert.equal(nwc.listSavedNwcConnections().length, 1);

  nwc.addOrTouchSavedNwcConnection(conn(walletB, "6".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.equal(JSON.parse(s.sealed.get(primaryKey)!).length, 2, "a new wallet goes to the encrypted list");
  assert.equal(store.has(primaryKey), false);

  const id = nwc.listSavedNwcConnections().find((c) => c.walletPubkey === walletA)!.id;
  nwc.deleteSavedNwcConnection(id);
  await nwc.flushSealedNwcWrites();
  assert.equal(JSON.parse(s.sealed.get(primaryKey)!).length, 1, "a deletion is deleted there too");

  // After a reload the encrypted list is read again.
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 1);

  // A failing encrypted write never leaves a change only in memory.
  s.opts.failSet = true;
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "7".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.equal(JSON.parse(store.get(primaryKey)!).length, 2, "kept plainly instead");
  assert.equal(store.has(markerKey), false);
  assert.equal(nwc.listSavedNwcConnections().length, 2);
}
nwc.setDropPlainNwcForTests(false);

console.warn = quiet;
console.log("PASS M9 step 2: encrypted copies are read; unreadable keys retry, nothing is replaced unread, the plain-copy switch is tested");
