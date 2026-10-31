// Audit M9. Step 1 (6.4.29) wrote encrypted copies of the kept Nostr key and
// saved NWC wallets beside the plain ones. Step 2 (6.4.32) was the reader.
// The last step (6.4.33, these tests) keeps them sealed only: a plain copy is
// moved into the sealed name and dropped only once that reads back; the
// key's plain witness (its origin) stays; a kept key that can't be opened is
// never "no key" and is never written over; changes to saved wallets are
// applied to the list as stored, so another tab's change is never lost; and
// nothing is deleted unread unless it equals what is kept.
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
const { setSealedNsecSettleDelayForTests, setSealedNsecWaitForTests, resetSealedNsecForTests } = await import("./saved-nsec.js");
// The later checks (a drop that waits, the watch after a drop) run quickly here.
setSealedNsecSettleDelayForTests(5);
nwc.setSealedSettleDelayForTests(5);

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
/** A fake op that waits until released. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  assert.ok(check(), what);
}
const quiet = console.warn;
console.warn = () => {};

// ── kept Nostr key ──────────────────────────────────────────────────────
{
  // Saving keeps the key sealed only: written plainly first (sign-in doesn't
  // wait), then moved; the origin stays plain as the witness.
  store.clear();
  const s = fakeSealer();
  await saveNsec("nsec1kept", "generated", localStorage, undefined, s);
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1kept", "plain until the sealed copy reads back");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1kept");
  assert.equal(store.has(SAVED_NSEC_KEY), false, "no plain copy once sealed");
  assert.equal(store.get(NSEC_ORIGIN_KEY), "generated", "the plain witness stays");
  assert.equal(olderApp.readKey(), null, "6.4.31 and older find no key here (it is not lost)");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1kept");
  await flushSealedNsecWrites();
  assert.equal(store.has(SAVED_NSEC_KEY), false, "never written back plainly");

  // With no sealed store the key stays plain, as before.
  store.clear();
  await saveNsec("nsec1nostore", "imported", localStorage);
  assert.equal(olderApp.readKey(), "nsec1nostore");

  // A plain copy left by an older version is moved too; with no origin
  // beside it, one is written first so the sealed key stays witnessed.
  store.clear();
  const old = fakeSealer();
  store.set(SAVED_NSEC_KEY, "nsec1fromold");
  assert.equal(await readBrowserSavedNsec(localStorage, old), "nsec1fromold");
  await flushSealedNsecWrites();
  assert.equal(old.sealed.get(SEALED_NSEC_KEY), "nsec1fromold");
  assert.equal(store.has(SAVED_NSEC_KEY), false);
  assert.equal(store.get(NSEC_ORIGIN_KEY), "imported");
  assert.equal(await readBrowserSavedNsec(localStorage, old), "nsec1fromold", "still the kept key after a restart");
}
{
  // Item 7: with the store stuck, sign-in never waits and the plain copy stays.
  store.clear();
  const stuck = fakeSealer({ hang: true });
  const t0 = Date.now();
  await saveNsec("nsec1fast", "generated", localStorage, undefined, stuck);
  assert.ok(Date.now() - t0 < 200, "saving never waits on the store");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1fast");
}
{
  // A write that doesn't read back, or a sealed write that fails, keeps the
  // plain copy.
  store.clear();
  const lossy = fakeSealer();
  lossy.set = async () => {};
  await saveNsec("nsec1lossy", "generated", localStorage, undefined, lossy);
  await flushSealedNsecWrites();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1lossy", "plain copy kept when the sealed one isn't there");

  store.clear();
  const failing = fakeSealer();
  failing.set = async () => { throw new Error("quota"); };
  await saveNsec("nsec1quota", "generated", localStorage, undefined, failing);
  await flushSealedNsecWrites();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1quota");
}
{
  // Another key already sealed there is archived before it is replaced; if
  // the archive fails nothing is replaced and the plain copy stays.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SEALED_NSEC_KEY, "nsec1before");
  store.set(NSEC_ORIGIN_KEY, "generated");
  await saveNsec("nsec1after", "imported", localStorage, undefined, s);
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1after");
  assert.deepEqual(archived(s, SEALED_NSEC_KEY), ["nsec1before"]);

  store.clear();
  const noArchive = fakeSealer({ failArchive: true });
  noArchive.sealed.set(SEALED_NSEC_KEY, "nsec1before");
  await saveNsec("nsec1after", "imported", localStorage, undefined, noArchive);
  await flushSealedNsecWrites();
  assert.equal(noArchive.sealed.get(SEALED_NSEC_KEY), "nsec1before", "no archive, no replace");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1after", "the new key stays plain");
}
{
  // A sign-out while the move runs wins: the key is not left kept.
  store.clear();
  const s = fakeSealer();
  let release!: () => void;
  const set = s.set;
  s.set = async (name: string, value: string) => { await new Promise<void>((r) => { release = r; }); return set(name, value); };
  await saveNsec("nsec1leaving", "generated", localStorage, undefined, s);
  await new Promise((r) => setTimeout(r, 0));
  const out = removeBrowserSavedNsec(localStorage, s, { forget: "nsec1leaving", wait: true });
  release();
  await out;
  await flushSealedNsecWrites();
  assert.equal(s.sealed.has(SEALED_NSEC_KEY), false, "the sealed copy written meanwhile is removed too");
  assert.equal(await readBrowserSavedNsec(localStorage, s), null, "signed out means signed out");

  // Another key saved while the move runs wins, and is moved itself.
  store.clear();
  const t = fakeSealer();
  let go!: () => void;
  const tset = t.set;
  t.set = async (name: string, value: string) => { t.set = tset; await new Promise<void>((r) => { go = r; }); return tset(name, value); };
  await saveNsec("nsec1first", "generated", localStorage, undefined, t);
  await new Promise((r) => setTimeout(r, 0));
  await saveNsec("nsec1second", "imported", localStorage, undefined, t);
  go();
  await flushSealedNsecWrites();
  assert.equal(t.sealed.get(SEALED_NSEC_KEY), "nsec1second");
  assert.deepEqual(archived(t, SEALED_NSEC_KEY), ["nsec1first"]);
  assert.equal(await readBrowserSavedNsec(localStorage, t), "nsec1second");
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
  // A key kept sealed, beside its plain witness, is the kept key and stays
  // sealed only.
  store.clear();
  const s = fakeSealer();
  s.sealed.set(SEALED_NSEC_KEY, "nsec1sealed");
  store.set(NSEC_ORIGIN_KEY, "generated");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1sealed");
  await flushSealedNsecWrites();
  assert.equal(store.has(SAVED_NSEC_KEY), false, "not written back plainly");
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1sealed");
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
  await saveNsec("nsec1pasted", "imported", localStorage, undefined, s);
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1pasted");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1locked", "the saved copy stays on this device");
  assert.equal(archived(s, SEALED_NSEC_KEY).length, 0, "not even archived: it is never written over");
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1pasted", "the new key stays plain beside it");

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
  // Second review B1: a 6.4.32 tab wrote the sealed key back plainly and is
  // about to delete the sealed copy. This version, meeting the plain copy
  // with the same key already sealed, doesn't drop the plain copy at once:
  // it checks again later, finds the sealed copy gone, and keeps it.
  store.clear();
  setSealedNsecSettleDelayForTests(100);
  const s = fakeSealer();
  s.sealed.set(SEALED_NSEC_KEY, "nsec1K");
  store.set(NSEC_ORIGIN_KEY, "generated");
  store.set(SAVED_NSEC_KEY, "nsec1K"); // 6.4.32's write-back
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1K");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1K", "not dropped before it checks again");
  s.sealed.delete(SEALED_NSEC_KEY); // 6.4.32's delete lands
  await flushSealedNsecWrites();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1K", "the plain copy stays when the sealed one went");
  setSealedNsecSettleDelayForTests(5);
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1K");
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1K", "moved again on the next start");
  assert.equal(store.has(SAVED_NSEC_KEY), false);

  // With no older tab, the delayed drop goes ahead.
  store.set(SAVED_NSEC_KEY, "nsec1K");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1K");
  await flushSealedNsecWrites();
  assert.equal(store.has(SAVED_NSEC_KEY), false);
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1K");

  // And after any drop, if the sealed copy is gone a moment later while the
  // key is still kept, it is written back plainly: never left nowhere.
  store.clear();
  const w = fakeSealer();
  await saveNsec("nsec1W", "generated", localStorage, undefined, w);
  await until(() => !store.has(SAVED_NSEC_KEY), "moved");
  w.sealed.delete(SEALED_NSEC_KEY); // another version deletes it
  await flushSealedNsecWrites();
  assert.equal(store.get(SAVED_NSEC_KEY), "nsec1W", "written back plainly");
  // ...but never after a sign-out.
  store.clear();
  const x = fakeSealer();
  await saveNsec("nsec1X", "generated", localStorage, undefined, x);
  await until(() => !store.has(SAVED_NSEC_KEY), "moved");
  store.delete(NSEC_ORIGIN_KEY); // signed out (in any version)
  x.sealed.delete(SEALED_NSEC_KEY);
  await flushSealedNsecWrites();
  assert.equal(store.has(SAVED_NSEC_KEY), false, "a signed-out key is not written back");
}
{
  // Second review B2: a sealed write that outlasts its caller's wait still
  // finishes before the next sealed operation starts, so it can't land late
  // over a newer key, and a key signed out meanwhile stays signed out.
  setSealedNsecWaitForTests(30);
  store.clear();
  const s = fakeSealer();
  const g = gate();
  const set = s.set;
  s.set = async (name: string, value: string) => { s.set = set; await g.opened; return set(name, value); };
  await saveNsec("nsec1K", "generated", localStorage, undefined, s);
  await new Promise((r) => setTimeout(r, 60)); // longer than the caller's wait
  await removeBrowserSavedNsec(localStorage, s, { forget: "nsec1K", wait: true }); // gives up waiting
  await saveNsec("nsec1K2", "generated", localStorage, undefined, s);
  g.open(); // K's write lands only now
  await flushSealedNsecWrites();
  assert.equal(s.sealed.get(SEALED_NSEC_KEY), "nsec1K2", "the newer key is what is kept");
  assert.equal(await readBrowserSavedNsec(localStorage, s), "nsec1K2", "the signed-out key never signs in");
  assert.ok(!archived(s, SEALED_NSEC_KEY).includes("nsec1K2"));
  setSealedNsecWaitForTests(10_000);
}
{
  // Last for the key (a stuck op holds the queue: only callers stop waiting):
  // a stuck store never holds up sign-in, and a sign-in that clears a stale
  // key doesn't wait for it.
  setSealedNsecWaitForTests(50);
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
const wallets = () => nwc.listSavedNwcConnections().map((c) => c.walletPubkey).sort();
const sealedWallets = (s: Fake) => (JSON.parse(s.sealed.get(sealedKey) ?? "[]") as { walletPubkey: string }[]).map((c) => c.walletPubkey).sort();
const walletC = "e".repeat(64);
{
  // Before the sealed list is read (or with no sealed store) the plain list
  // is the list, as before.
  fresh();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "1".repeat(64)));
  assert.ok(store.get(primaryKey)?.includes(walletA));
  assert.deepEqual(wallets(), [walletA]);
}
{
  // At sign-in the plain list moves into the sealed list and the plain one
  // goes; the step-1 copy equal to it is deleted. From then on changes are
  // sealed only.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "1".repeat(64)));
  s.sealed.set(primaryKey, store.get(primaryKey)!);
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(sealedWallets(s), [walletA]);
  assert.equal(store.has(primaryKey), false, "no plain list once sealed");
  assert.equal(store.has(backupKey), false);
  assert.equal(s.sealed.has(primaryKey), false, "the step-1 duplicate goes");
  assert.equal(archived(s, primaryKey).length, 0);
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "2".repeat(64)));
  assert.deepEqual(wallets(), [walletA, walletB], "shows at once");
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletA, walletB]);
  assert.equal(store.has(primaryKey), false, "changes stay sealed only");
  const b = nwc.listSavedNwcConnections().find((c) => c.walletPubkey === walletB)!;
  nwc.renameSavedNwcConnection(b.id, "Bee");
  nwc.deleteSavedNwcConnection(nwc.listSavedNwcConnections().find((c) => c.walletPubkey === walletA)!.id);
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletB]);
  assert.ok(s.sealed.get(sealedKey)!.includes("Bee"));
  assert.equal(store.has(primaryKey), false);
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
  assert.deepEqual(wallets(), [walletA], "the wallets still show");
}
{
  // A plain list and a sealed list (an older version saved a wallet here)
  // are merged; nothing is lost.
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "6".repeat(64))]));
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "7".repeat(64)));
  assert.deepEqual(wallets(), [walletB], "only the plain list before it is read");
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), [walletA, walletB]);
  assert.deepEqual(sealedWallets(s), [walletA, walletB]);
  assert.equal(store.has(primaryKey), false);
}
{
  // R3: a wallet added while the sealed list is read is kept beside it.
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "b".repeat(64))]));
  const get = s.get;
  let release!: () => void;
  s.get = async (name: string) => { s.get = get; await new Promise<void>((r) => { release = r; }); return get(name); };
  const pending = nwc.hydrateSavedNwcConnections(s);
  await new Promise((r) => setTimeout(r, 0));
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "c".repeat(64)));
  release();
  await pending;
  assert.deepEqual(wallets(), [walletA, walletB], "both wallets kept");
  assert.deepEqual(sealedWallets(s), [walletA, walletB]);
}
{
  // Item 6: another tab's change is never written over. Tab B added C to the
  // sealed list after this tab read it; this tab's rename is applied to the
  // list as stored, so C stays.
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "d".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "d".repeat(64)), entry(walletC, "f".repeat(64))]));
  nwc.renameSavedNwcConnection(entry(walletA, "").id, "Renamed");
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletA, walletC], "the other tab's wallet stays");
  assert.ok(s.sealed.get(sealedKey)!.includes("Renamed"));
  assert.deepEqual(wallets(), [walletA, walletC], "and now shows here");

  // A deletion in another tab stays deleted when this tab adds a wallet.
  s.sealed.set(sealedKey, JSON.stringify([entry(walletC, "f".repeat(64))]));
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "1".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletB, walletC].sort());
}
{
  // While the sealed list can't be opened, or doesn't parse, it is never
  // written over: changes stay plain beside it, and are merged once it opens.
  fresh();
  const s = fakeSealer({ failGet: true });
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "7".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), []);
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "8".repeat(64)));
  assert.ok(store.get(primaryKey)?.includes(walletB));
  assert.ok(s.sealed.get(sealedKey)?.includes(walletA), "the unreadable list is never replaced");
  s.opts.failGet = false;
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), [walletA, walletB], "merged once it opens");
  assert.deepEqual(sealedWallets(s), [walletA, walletB]);

  fresh();
  const bad = fakeSealer();
  bad.sealed.set(sealedKey, "{not json");
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "9".repeat(64)));
  await nwc.hydrateSavedNwcConnections(bad);
  assert.equal(bad.sealed.get(sealedKey), "{not json", "a list that doesn't parse stays");
  assert.ok(store.get(primaryKey)?.includes(walletB), "and the plain list stays");
}
{
  // A sealed write that fails (or doesn't read back) keeps the change plainly,
  // never lost; the plain list is dropped only once the sealed one reads back.
  fresh();
  const s = fakeSealer();
  await nwc.hydrateSavedNwcConnections(s);
  const set = s.set;
  s.set = async () => { throw new Error("quota"); };
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "2".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.ok(store.get(primaryKey)?.includes(walletA), "kept plainly");
  assert.deepEqual(wallets(), [walletA]);
  s.set = set;
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "3".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletA, walletB], "merged into the sealed list next write");
  assert.equal(store.has(primaryKey), false);

  fresh();
  const lossy = fakeSealer();
  lossy.set = async () => {};
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "4".repeat(64)));
  await nwc.hydrateSavedNwcConnections(lossy);
  assert.ok(store.get(primaryKey)?.includes(walletA), "plain list kept when the sealed one isn't there");
  assert.deepEqual(wallets(), [walletA]);
}
{
  // A plain list changed while the sealed write runs (an older version's tab
  // saved a wallet) is not dropped: it stays, and is merged later.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "5".repeat(64)));
  const set = s.set;
  let release!: () => void;
  s.set = async (name: string, value: string) => { s.set = set; await new Promise<void>((r) => { release = r; }); return set(name, value); };
  const pending = nwc.hydrateSavedNwcConnections(s);
  await new Promise((r) => setTimeout(r, 0));
  const both = JSON.stringify([entry(walletA, "5".repeat(64)), entry(walletB, "6".repeat(64))]);
  store.set(primaryKey, both);
  store.set(backupKey, both);
  release();
  await pending;
  assert.equal(store.get(primaryKey), both, "the changed plain list stays");
  assert.deepEqual(wallets(), [walletA, walletB]);
  nwc.addOrTouchSavedNwcConnection(conn(walletC, "7".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletA, walletB, walletC]);
  assert.equal(store.has(primaryKey), false, "merged, then dropped");
}
{
  // Second review B1 (wallets): a 6.4.32 tab wrote the sealed list back
  // plainly and is about to delete the sealed one; the plain list is kept.
  fresh();
  const s = fakeSealer();
  const list = JSON.stringify([entry(walletA, "1".repeat(64))]);
  s.sealed.set(sealedKey, list);
  store.set(primaryKey, list);
  store.set(backupKey, list);
  await nwc.hydrateSavedNwcConnections(s);
  s.sealed.delete(sealedKey); // 6.4.32's delete lands
  await nwc.flushSealedNwcWrites();
  assert.ok(store.get(primaryKey)?.includes(walletA), "the plain list stays when the sealed one went");
  assert.deepEqual(wallets(), [walletA]);

  // After a drop, a sealed list that vanishes is written back plainly.
  fresh();
  const w = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "2".repeat(64)));
  await nwc.hydrateSavedNwcConnections(w);
  await until(() => !store.has(primaryKey), "dropped");
  w.sealed.delete(sealedKey);
  await nwc.flushSealedNwcWrites();
  assert.ok(store.get(primaryKey)?.includes(walletA), "written back plainly");
}
{
  // Second review B2 (wallets): a write that outlasts its caller's wait is
  // kept plainly, and the next change waits for it, so it can't land late
  // over a newer list.
  nwc.setSealedWaitForTests(30);
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "3".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  const g = gate();
  const set = s.set;
  s.set = async (name: string, value: string) => { s.set = set; await g.opened; return set(name, value); };
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "4".repeat(64)));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(store.get(primaryKey)?.includes(walletB), "kept plainly once the wait ran out");
  nwc.addOrTouchSavedNwcConnection(conn(walletC, "5".repeat(64)));
  g.open();
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(sealedWallets(s), [walletA, walletB, walletC], "nothing written over");
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), [walletA, walletB, walletC]);
  nwc.setSealedWaitForTests(10_000);
}
{
  // Second review B3: another tab's change read in just before this tab's
  // sealed write fails: this tab's own change is still kept (plainly).
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "6".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "6".repeat(64)), entry(walletC, "7".repeat(64))]));
  nwc.refreshSavedNwcForTests(user); // tab B announced C
  const set = s.set;
  s.set = async () => { s.set = set; throw new Error("quota"); };
  nwc.addOrTouchSavedNwcConnection(conn(walletB, "8".repeat(64)));
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(wallets(), [walletA, walletB, walletC], "this tab's wallet is still there");
  assert.ok(store.get(primaryKey)?.includes(walletB), "kept plainly");
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), [walletA, walletB, walletC], "and after a restart");
}
{
  // Second review S1: a wallet removed while the sealed write fails doesn't
  // come back on the next start.
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "9".repeat(64)), entry(walletB, "a".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  const set = s.set;
  s.set = async () => { s.set = set; throw new Error("quota"); };
  nwc.deleteSavedNwcConnection(entry(walletA, "").id);
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(wallets(), [walletB]);
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), [walletB], "the removed wallet stays removed");
  assert.deepEqual(sealedWallets(s), [walletB], "and is gone from the sealed list");
  assert.equal(store.has(scopedStorageKey(nwc.NWC_REMOVED_STORAGE_KEY, user)), false, "nothing left to remember");
}
{
  // Re-review RR1: the same wallet saved again after a removal that never
  // reached the sealed list stays saved.
  fresh();
  const s = fakeSealer();
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "e".repeat(64))]));
  await nwc.hydrateSavedNwcConnections(s);
  const set = s.set;
  s.set = async () => { s.set = set; throw new Error("quota"); };
  nwc.deleteSavedNwcConnection(entry(walletA, "").id);
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(wallets(), []);
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "e".repeat(64)));
  assert.deepEqual(wallets(), [walletA], "shows again");
  await nwc.flushSealedNwcWrites();
  assert.deepEqual(wallets(), [walletA], "and stays");
  nwc.resetSealedNwcForTests();
  await nwc.hydrateSavedNwcConnections(s);
  assert.deepEqual(wallets(), [walletA], "after a restart too");
  assert.deepEqual(sealedWallets(s), [walletA]);
}
{
  // Second review N2: a rewrite that would drop an entry this version can't
  // read archives the stored list first.
  fresh();
  const s = fakeSealer();
  const odd = { ...entry(walletB, "b".repeat(64)), relayCount: undefined };
  s.sealed.set(sealedKey, JSON.stringify([entry(walletA, "c".repeat(64)), odd]));
  nwc.addOrTouchSavedNwcConnection(conn(walletC, "d".repeat(64)));
  await nwc.hydrateSavedNwcConnections(s);
  assert.equal(archived(s, sealedKey).length, 1, "archived before the rewrite");
  assert.ok(archived(s, sealedKey)[0].includes(walletB));
  assert.deepEqual(sealedWallets(s), [walletA, walletC]);
}
{
  // Each identity has its own list.
  fresh();
  const s = fakeSealer();
  nwc.addOrTouchSavedNwcConnection(conn(walletA, "a".repeat(64)));
  await nwc.hydrateSavedNwcConnections(s);
  setLocalStorageUserScope("d".repeat(64));
  assert.equal(nwc.listSavedNwcConnections().length, 0, "another identity doesn't see this list");
  setLocalStorageUserScope(user);
  assert.deepEqual(wallets(), [walletA]);
}

console.warn = quiet;
console.log("PASS M9 last step: kept key and saved wallets are sealed only; unreadable copies are never written over; other tabs' changes are kept; nothing is deleted unread");
