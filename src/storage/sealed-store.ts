// ══════════════════════════════════════════════════════════════════════════
// Chama — sealed browser storage for local secrets (audit M9)
// ══════════════════════════════════════════════════════════════════════════
//
// The saved Nostr key and saved NWC connection strings used to sit in
// localStorage as plain text, where a copied storage file, a backup or
// another program reading the profile gets them as readable strings. Here
// each value is encrypted with AES-GCM under a key the page can use but
// cannot export, and the key and the encrypted values live in ONE IndexedDB
// object store, so a browser can only clear them together: no partial clear
// leaves sealed data without its key.
//
// This does not stop a script running inside Chama (that is the content
// policy, M8), and a determined attacker with the whole browser profile may
// still recover the key. Where IndexedDB or WebCrypto is missing, callers
// keep the old plain localStorage path; nothing is ever dropped to seal it.
//
// First step (6.4.29): callers write an encrypted copy beside the plain one
// and still read the plain one, so an older app sees the same key and
// wallets. Second step (6.4.32): callers stop writing those copies and can
// read a value a later release keeps only here, under a new name; a stored
// copy that isn't known to be redundant is archived (sealedArchive), never
// deleted unread. Removing the plain copies comes one release later.

const DB_NAME = "chama-sealed-v1";
const STORE = "items";
const KEY_ID = "__seal_key__";
const PREFIX = "item:";

interface SealedRecord { iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }

let dbPromise: Promise<IDBDatabase> | null = null;
let keyPromise: Promise<CryptoKey> | null = null;

/** True when this runtime can seal values (IndexedDB + WebCrypto). */
export function sealedStoreAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined"
      && typeof crypto !== "undefined"
      && typeof crypto.subtle?.encrypt === "function";
  } catch {
    return false;
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function get<T>(id: string): Promise<T | undefined> {
  const db = await openDb();
  return request(db.transaction(STORE, "readonly").objectStore(STORE).get(id)) as Promise<T | undefined>;
}

async function put(id: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(value, id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

/** Store `value` only if nothing is stored under `id` yet (IndexedDB `add`
 *  fails on an existing key, atomically across tabs). */
async function addIfAbsent(id: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const req = tx.objectStore(STORE).add(value, id);
  req.onerror = (event) => { event.preventDefault(); };
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function del(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB delete aborted"));
  });
}

function sealKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await get<CryptoKey>(KEY_ID);
      if (existing) return existing;
      const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      // Never replace a key: another tab may have stored one first, and
      // values sealed under it would become unreadable. Use whichever won.
      await addIfAbsent(KEY_ID, fresh);
      const stored = await get<CryptoKey>(KEY_ID);
      if (!stored) throw new Error("Seal key was not saved");
      return stored;
    })().catch((e) => { keyPromise = null; throw e; });
  }
  return keyPromise;
}

/** The decrypted value, or null when nothing is stored under `name`.
 *  Throws when a stored value can't be read (never treat that as absent). */
export async function sealedGet(name: string): Promise<string | null> {
  const record = await get<SealedRecord>(PREFIX + name);
  if (!record) return null;
  const key = await sealKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, key, record.ct);
  return new TextDecoder().decode(plain);
}

/** Encrypt and store `value`, then read it back; throws unless the stored
 *  copy decrypts to exactly `value`. */
export async function sealedSet(name: string, value: string): Promise<void> {
  askToPersist();
  const key = await sealKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  await put(PREFIX + name, { iv, ct } satisfies SealedRecord);
  if (await sealedGet(name) !== value) throw new Error("Sealed value did not read back");
}

let persistAsked = false;
/** Ask the browser not to evict this origin's storage under pressure, so the
 *  sealed store isn't dropped while plain storage stays. Best effort. */
function askToPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  try { void navigator.storage?.persist?.().catch(() => {}); } catch {}
}

export async function sealedDelete(name: string): Promise<void> {
  await del(PREFIX + name);
}

/** Copy the record stored under `name`, exactly as stored, to an archive
 *  name, and return that name (null when nothing is stored). The record is
 *  never decrypted, so one that can't be read right now is kept whole and a
 *  later read may still open it. Throws unless the copy is in place: callers
 *  replace or delete the original only after this returns. */
export async function sealedArchive(name: string): Promise<string | null> {
  const record = await get<SealedRecord>(PREFIX + name);
  if (!record) return null;
  // Named by the record's own random IV, so archiving the same record again
  // (an unreadable copy met on every start) rewrites one archive, never piles up.
  const archived = `${name}#archived:${Array.from(new Uint8Array(record.iv), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  await put(PREFIX + archived, record);
  const copy = await get<SealedRecord>(PREFIX + archived);
  if (!copy || copy.ct.byteLength !== record.ct.byteLength) throw new Error("Archive copy was not saved");
  return archived;
}

/** Names of the archives sealedArchive made from `name`. */
export async function sealedArchiveNames(name: string): Promise<string[]> {
  const db = await openDb();
  const keys = await request(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
  const prefix = `${PREFIX}${name}#archived:`;
  return keys.map(String).filter((key) => key.startsWith(prefix)).map((key) => key.slice(PREFIX.length));
}

/** Test hook: forget cached handles so a fresh IndexedDB can be used. */
export function resetSealedStoreForTests(): void {
  dbPromise = null;
  keyPromise = null;
}
