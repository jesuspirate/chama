// Audit M9. Step 1 (6.4.29) wrote encrypted copies of the kept Nostr key and
// saved NWC wallets beside the plain ones. Step 2 (6.4.32, these tests) is
// the reader: with no plain copy, a key or list kept sealed under the new
// name is read and written back plainly; a kept key that can't be opened is
// never "no key"; the old encrypted copies stop being written and are never
// deleted unread unless they equal what is kept; and an older app (6.4.28 to
// 6.4.31, reading only plain copies) still sees exactly what this one sees.
// Driven with a fake sealer; sealed-store.ts itself runs in a real browser.
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const {
  readBrowserSavedNsec, removeBrowserSavedNsec, saveNsec, flushSealedNsecWrites,
  SavedKeyUnreadableError, SAVED_NSEC_KEY, SEALED_NSEC_KEY, NSEC_ORIGIN_KEY,
} = await import("./saved-nsec.js");
const { setLocalStorageUserScope, scopedStorageKey } = await import("./user-scope.js");
const nwc = await import("../payments/nwc-connections.js");

function fakeSealer(opts: { failGet?: boolean; failArchive?: boolean; failDelete?: boolean; hang?: boolean } = {}) {
  const sealed = new Map<string, string>();
  let made = 0;
  const hang = () => new Promise<never>(() => {});
  return {
    sealed,
    opts,
    get: async (name: string) => {
      if (opts.hang) return hang();
      if (opts.failGet) throw new Error("unreadable");
      return sealed.get(name) ?? null;
    },
    set: async (name: string, value: string) => { sealed.set(name, value); },
    delete: async (name: string) => { if (opts.failDelete) throw new Error("blocked"); sealed.delete(name); },
    // Copies the stored record unread, like sealedArchive.
    archive: async (name: string) => {
      if (opts.failArchive) throw new Error("archive failed");
      if (!sealed.has(name)) return null;
      const to = `${name}#archived:${++made}`;
      sealed.set(to, sealed.get(name)!);
      return to;
    },
    archives: async (name: string) => [...sealed.keys()].filter((k) => k.startsWith(`${name}#archived:`)),
  };
}
type Fake = ReturnType<typeof fakeSealer>;
const archived = (s: Fake, name: string) =>
  [...s.sealed.entries()].filter(([k]) => k.startsWith(`${name}#archived:`)).map(([, v]) => v);
const olderApp = {
  readKey: () => store.get(SAVED_NSEC_KEY) ?? null,
  signOut: () => { store.delete(SAVED_NSEC_KEY); store.delete(NSEC_ORIGIN_KEY); },
};
const quiet = console.warn;
console.warn = () => {};

// ── kept Nostr key ──────────────────────────────────────────────────────
{
  // Saving keeps the key plainly, as every version reads it, and writes no
  // new encrypted copy.
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1kept", "generated", localStorage);
  assert.equal(olderApp.readKey(), "nsec1kept", "an older app still finds the key");
  assert.equal(store.get(NSEC_ORIGIN_KEY), "generated");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1kept");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.size, 0, "nothing new is written encrypted");
}
{
  // The step-1 copy equal to the plain key is deleted; a different one (a
  // key signed out in an older version) is archived first, never signed in with.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1same");
  store.set(SAVED_NSEC_KEY, "nsec1same");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1same");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false, "a duplicate copy goes");
  assert.equal(archived(s, SAVED_NSEC_KEY).length, 0);

  s.sealed.set(SAVED_NSEC_KEY, "nsec1other");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1same", "the plain key wins");
  await flushSealedNsecWrites();
  assert.deepEqual(archived(s, SAVED_NSEC_KEY), ["nsec1other"], "a different copy is archived, not lost");
  assert.equal(s.sealed.has(SAVED_NSEC_KEY), false);
}
{
  // An unreadable step-1 copy never stops the plain key and is archived whole.
  store.clear();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(SAVED_NSEC_KEY, "nsec1locked");
  store.set(SAVED_NSEC_KEY, "nsec1real");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1real");
  await flushSealedNsecWrites();
  assert.deepEqual(archived(s, SAVED_NSEC_KEY), ["nsec1locked"]);

  // When the archive can't be made, nothing is deleted.
  store.clear();
  const noArchive = fakeSealer({ failArchive: true });
  noArchive.sealed.set(SAVED_NSEC_KEY, "nsec1other");
  store.set(SAVED_NSEC_KEY, "nsec1real");
  assert.equal(await readBrowserSavedNsec(localStorage, noArchive), "nsec1real");
  await flushSealedNsecWrites();
  assert.equal(noArchive.sealed.get(SAVED_NSEC_KEY), "nsec1other", "no archive, no delete");
}
{
  // A step-1 copy with no plain key is left over from a sign-out: it never
  // signs in, and is archived.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SAVED_NSEC_KEY, "nsec1signedout");
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "a signed-out key never signs in again");
  await flushSealedNsecWrites();
  assert.deepEqual(archived(s, SAVED_NSEC_KEY), ["nsec1signedout"]);
}
{
  // A key kept sealed under the new name (by the release that stops writing
  // plain copies) is the kept key when there is no plain one. This release
  // writes it back plainly, then removes the sealed copy.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SEALED_NSEC_KEY, "nsec1sealed");
  store.set(NSEC_ORIGIN_KEY, "generated"); // the plain witness that release keeps
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1sealed");
  await flushSealedNsecWrites();
  assert.equal(olderApp.readKey(), "nsec1sealed", "an older app finds it again");
  assert.equal(s.sealed.has(SEALED_NSEC_KEY), false);
  assert.equal(archived(s, SEALED_NSEC_KEY).length, 0, "an exact copy needs no archive");
}
{
  // A sealed key that can't be opened: the read throws (never "no key") and
  // nothing is deleted; Retry signs in once it opens.
  store.clear();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(SEALED_NSEC_KEY, "nsec1locked");
  store.set(NSEC_ORIGIN_KEY, "generated");
  await assert.rejects(readBrowserSavedNsec(localStorage, s), SavedKeyUnreadableError);
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1locked", "nothing is deleted");
  await assert.rejects(readBrowserSavedNsec(localStorage, s), SavedKeyUnreadableError, "a failed Retry still says so");
  s.opts.failGet = false;
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1locked", "Retry signs in once the key opens");
}
{
  // "Sign in with my key" while the sealed key won't open: the new key is
  // kept plainly and wins; the sealed copy stays where it is, as the panel says.
  store.clear();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(SEALED_NSEC_KEY, "nsec1locked");
  store.set(NSEC_ORIGIN_KEY, "generated");
  await assert.rejects(readBrowserSavedNsec(localStorage, s), SavedKeyUnreadableError);
  await saveNsec("nsec1pasted", "imported", localStorage);
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1pasted");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1locked", "the saved copy stays on this device");

  // "Keep me signed in" unchecked instead: archived, never deleted unread,
  // and the sign-in doesn't wait for it.
  store.clear();
  s.sealed.clear();
  s.sealed.set(SEALED_NSEC_KEY, "nsec1locked");
  await removeBrowserSavedNsec(localStorage, s, { forget: "nsec1new" });
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SEALED_NSEC_KEY), false);
  assert.deepEqual(archived(s, SEALED_NSEC_KEY), ["nsec1locked"]);
}
{
  // Sign-out forgets the key: plain and sealed copies, and archives that open
  // to it. Other keys found are archived, not deleted.
  store.clear();
  const s = fakeSealer();
  store.set(SAVED_NSEC_KEY, "nsec1me");
  s.sealed.set(SEALED_NSEC_KEY, "nsec1me");
  s.sealed.set(`${SAVED_NSEC_KEY}#archived:90`, "nsec1me");
  s.sealed.set(SAVED_NSEC_KEY, "nsec1someoneelse");
  await removeBrowserSavedNsec(localStorage, s, { forget: "nsec1me", wait: true });
  assert.equal(store.has(SAVED_NSEC_KEY), false);
  assert.equal(store.has(NSEC_ORIGIN_KEY), false);
  assert.equal(s.sealed.has(SEALED_NSEC_KEY), false, "done before sign-out returns");
  assert.deepEqual(archived(s, SAVED_NSEC_KEY), ["nsec1someoneelse"], "only the other key is kept, archived");
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);

  // Signed out in an older app means signed out here.
  store.clear();
  s.sealed.clear();
  await saveNsec("nsec1both", "imported", localStorage);
  olderApp.signOut();
  assert.equal(await readBrowserSavedNsec(localStorage, s), null);
}
{
  // Re-review R1: a sealed-only key signed out in an older version (which
  // removes the origin witness but can't touch the sealed copy) never signs
  // in again, and is archived.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SEALED_NSEC_KEY, "nsec1K");
  store.set(SAVED_NSEC_KEY, "nsec1K");
  store.set(NSEC_ORIGIN_KEY, "imported");
  olderApp.signOut();
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "signed out in an older app means signed out here");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SEALED_NSEC_KEY), false);
  assert.deepEqual(archived(s, SEALED_NSEC_KEY), ["nsec1K"]);

  // R2: with no key and no witness, a broken or stuck store is never asked
  // for the answer, so nobody is told a saved key won't open.
  store.clear();
  assert.equal(await readBrowserSavedNsec(localStorage, fakeSealer({ failGet: true })), null);

  // R3: a key saved while the sealed read runs wins, and the sealed copy stays.
  store.clear();
  let release!: () => void;
  const slow = fakeSealer();
  slow.sealed.set(SEALED_NSEC_KEY, "nsec1old");
  const get = slow.get;
  slow.get = async (name: string) => { await new Promise<void>((r) => { release = r; }); slow.get = get; return get(name); };
  store.set(NSEC_ORIGIN_KEY, "generated");
  const pending = readBrowserSavedNsec(localStorage, slow);
  await new Promise((r) => setTimeout(r, 0));
  await saveNsec("nsec1created", "generated", localStorage);
  release();
  assert.equal(await pending, "nsec1created", "the key saved meanwhile wins");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1created", "and is never overwritten");
  await flushSealedNsecWrites();
  assert.equal(slow.sealed.get(SEALED_NSEC_KEY), "nsec1old", "the sealed copy stays");
}
{
  // A sign-out whose sealed delete fails still sticks: the plain copy is what is read.
  store.clear();
  const s = fakeSealer({ failDelete: true });
  store.set(SAVED_NSEC_KEY, "nsec1stuck");
  s.sealed.set(SAVED_NSEC_KEY, "nsec1stuck");
  await removeBrowserSavedNsec(localStorage, s, { wait: true });
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "no sign-in after sign-out");
}
{
  // Last for the key (a stuck op holds the queue until its time runs out):
  // a stuck store never holds up sign-in, and a sign-in that clears a stale
  // key doesn't wait for it.
  store.clear();
  store.set(SAVED_NSEC_KEY, "nsec1plain");
  const stuck = fakeSealer({ hang: true });
  const race = <T>(p: Promise<T>) => Promise.race([p, new Promise((r) => setTimeout(() => r("timed out"), 200))]);
  assert.equal(await race(readBrowserSavedNsec(localStorage, stuck)), "nsec1plain", "a stuck store never holds up sign-in");
  assert.equal(await race(removeBrowserSavedNsec(localStorage, stuck, { forget: "nsec1new" })), undefined,
    "an unchecked sign-in never waits on the store");
}

// ── saved NWC wallets ───────────────────────────────────────────────────
const walletA = "a".repeat(64);
const walletB = "b".repeat(64);
const conn = (wallet: string, secret: string) =>
  `nostr+walletconnect://${wallet}?relay=wss%3A%2F%2Frelay.example.com&secret=${secret}`;
const user = "c".repeat(64);
const primaryKey = scopedStorageKey(nwc.NWC_CONNECTIONS_STORAGE_KEY, user);
const backupKey = scopedStorageKey(nwc.NWC_CONNECTIONS_BACKUP_STORAGE_KEY, user);
const sealedKey = scopedStorageKey(nwc.NWC_SEALED_STORAGE_KEY, user);
const entry = (wallet: string, secret: string) => ({
  id: `nwc_${wallet.slice(0, 4)}`, connectionString: conn(wallet, secret), label: "W",
  walletPubkey: wallet, relayCount: 1, createdAt: 1,
});
function fresh() {
  store.clear();
  nwc.resetSealedNwcForTests();
  setLocalStorageUserScope(user);
}
{
  // The plain list is the list; the step-1 copy of it is deleted, and no new
  // encrypted copy is written as wallets change.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "1".repeat(64)));
  s.sealed.set(primaryKey, store.get(primaryKey)!);
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(s.sealed.size, 0, "the duplicate goes, with no archive");
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "2".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.equal(s.sealed.size, 0, "changes stay plain");
  assert.equal(nwc.listSavedNwcConnections().length, 2);
}
{
  // A different or unreadable step-1 copy is archived before it goes; with no
  // archive, it stays.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "3".repeat(64)));
  s.sealed.set(primaryKey, JSON.stringify([entry(walletB, "4".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(archived(s, primaryKey).length, 1);
  assert.ok(archived(s, primaryKey)[0].includes(walletB));
  assert.equal(s.sealed.has(primaryKey), false);

  fresh();
  const noArchive = fakeSealer({ failArchive: true });
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "5".repeat(64)));
  noArchive.sealed.set(primaryKey, "[]");
  await nwc.hydrateSavedNwcConnections(noArchive);
  assert.equal(noArchive.sealed.get(primaryKey), "[]", "no archive, no delete");
  assert.equal(nwc.listSavedNwcConnections().length, 1, "the wallets still show");
}
{
  // A list kept sealed under the new name, with no plain list, is the list:
  // written back plainly, then the sealed copy goes.
  fresh();
  const s = fakeSealer();
  const kept = JSON.stringify([entry(walletA, "6".repeat(64))]);
  s.sealed.set(sealedKey, kept);
  assert.equal(nwc.listSavedNwcConnections().length, 0, "nothing shows before it is read");
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 1, "the sealed list is the list");
  assert.ok(store.get(primaryKey)?.includes(walletA), "written back plainly for older versions");
  assert.ok(store.get(backupKey)?.includes(walletA));
  assert.equal(s.sealed.has(sealedKey), false);
}
{
  // R3: a wallet added while the sealed list is read is kept beside it.
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "b".repeat(64))]));
  const get = s.get;
  let release!: () => void;
  s.get = async (name: string) => { await new Promise<void>((r) => { release = r; }); s.get = get; return get(name); };
  const pending = nwc.hydrateSavedNwcConnections(s);
  await new Promise((r) => setTimeout(r, 0));
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "c".repeat(64)));
  release();
  await pending;
  assert.deepEqual(nwc.listSavedNwcConnections().map((c) => c.walletPubkey).sort(), [walletA, walletB], "both wallets kept");
}
{
  // One that can't be opened, or doesn't parse, stays where it is; a wallet
  // added meanwhile is kept plainly beside it.
  fresh();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "7".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(nwc.listSavedNwcConnections().length, 0);
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "8".repeat(64)));
  assert.ok(store.get(primaryKey)?.includes(walletB));
  assert.ok(s.sealed.get(sealedKey)?.includes(walletA), "the unreadable list is never replaced");

  fresh();
  const bad = fakeSealer();
  bad.sealed.set(sealedKey, "{not json");
  await nwc.hydrateSavedNwcConnections(bad);
  assert.equal(bad.sealed.get(sealedKey), "{not json", "a list that doesn't parse stays");
}
{
  // An older app's deletion stays deleted, and each identity has its own list.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "9".repeat(64)));
  await nwc.hydrateSavedNwcConnections(s);
  store.set(primaryKey, "[]");
  store.delete(backupKey);
  assert.equal(nwc.listSavedNwcConnections().length, 0, "a wallet deleted in an older app stays deleted");
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "a".repeat(64)));
  setLocalStorageUserScope("d".repeat(64));
  assert.equal(nwc.listSavedNwcConnections().length, 0, "another identity doesn't see this list");
  setLocalStorageUserScope(user);
  assert.equal(nwc.listSavedNwcConnections().length, 1);
}

console.warn = quiet;
console.log("PASS M9 step 2: sealed copies are read; unreadable keys retry; nothing is deleted unread; older apps stay in step");
