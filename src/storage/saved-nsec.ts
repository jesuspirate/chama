/** Saved identity keys are separate from wallet recovery material. */
export const SAVED_NSEC_KEY = "chama_saved_nsec";
export const NSEC_ORIGIN_KEY = "chama_nsec_origin";

type KeyStorage = Pick<Storage, "setItem">;

/** Encrypted browser storage (sealed-store.ts), injected so tests can fake it. */
export interface NsecSealer {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Copy the stored record, unread, to an archive name (sealedArchive). */
  archive(name: string): Promise<string | null>;
  /** Names of the archives made from `name` (sealedArchiveNames). */
  archives(name: string): Promise<string[]>;
}
type NativePreferences = { set(options: { key: string; value: string }): Promise<void> };

/** Where a release that stops keeping the plain copy keeps the key, sealed.
 *  A name 6.4.29-6.4.31 never read, write or delete, so running one of them
 *  again can't overwrite it. It counts only beside NSEC_ORIGIN_KEY, which
 *  that release must keep plainly: every version's sign-out removes it, so a
 *  sign-out in any version also retires the sealed copy. */
export const SEALED_NSEC_KEY = "chama_saved_nsec_sealed_v2";

/** The kept key is stored but can't be opened right now. Never "no key":
 *  the caller offers Retry; signing in another way keeps the stored copy. */
export class SavedKeyUnreadableError extends Error {
  constructor(cause?: unknown) {
    super("The key saved on this device can't be opened right now");
    this.name = "SavedKeyUnreadableError";
    (this as { cause?: unknown }).cause = cause;
  }
}

type BrowserKeyStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem" | "removeItem">>;

// Runway #13 (revised 2026-09-19): the keep decision moved to a checkbox ON
// the login screen, so the post-login notice — and the arming logic that
// lived here — is gone. Saving is now just saving. A write failure still
// propagates, so callers never claim a key was kept when it wasn't.
export async function saveNsec(
  nsec: string,
  origin: "generated" | "imported",
  storage: KeyStorage,
  native?: NativePreferences,
): Promise<void> {
  if (native) {
    await native.set({ key: SAVED_NSEC_KEY, value: nsec });
    await native.set({ key: NSEC_ORIGIN_KEY, value: origin });
    return;
  }
  storage.setItem(SAVED_NSEC_KEY, nsec);
  storage.setItem(NSEC_ORIGIN_KEY, origin);
}

// M9, step 2 (6.4.32): the reader. In the browser the plain copy is still
// the one kept and written, so 6.4.29-6.4.31 still find the key if they run
// again here. What this release adds:
//  - with no plain copy, a key kept sealed under SEALED_NSEC_KEY (by the
//    release that stops writing plain copies) is the kept key while its
//    plain witness (NSEC_ORIGIN_KEY) is there; this release writes it back
//    plainly and then removes the sealed copy;
//  - a sealed key that can't be opened is SavedKeyUnreadableError, never
//    "no key", and stays where it is;
//  - the copy 6.4.29-6.4.31 wrote under SAVED_NSEC_KEY is no longer written.
//    A copy equal to the plain key is deleted; any other (a key signed out in
//    a version that didn't wait for the delete, or one that can't be opened)
//    is archived first. It is never signed in with.
//
// Sealed operations run one at a time, in order, each bounded, so a stuck
// store can't hold up the next one forever.
let sealedNsecOps: Promise<unknown> = Promise.resolve();
const SEALED_OP_TIMEOUT_MS = 10_000;

class SealedTimeoutError extends Error {
  constructor() { super("The encrypted store did not answer"); this.name = "SealedTimeoutError"; }
}

function bounded<T>(op: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SealedTimeoutError()), SEALED_OP_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    op().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function queueSealedNsec<T>(op: () => Promise<T>): Promise<T> {
  const run = sealedNsecOps.then(() => bounded(op), () => bounded(op));
  sealedNsecOps = run.catch(() => {});
  return run;
}

/** Remove the sealed record `name` unless it holds `keep`: a copy of `forget`
 *  (or of `keep`) is deleted, anything else is archived first. */
async function clearSealed(sealer: NsecSealer, name: string, forget: string | null): Promise<void> {
  let current: string | null = null;
  let unreadable = false;
  try { current = await sealer.get(name); } catch { unreadable = true; }
  if (!unreadable && current === null) return;
  if (unreadable || current?.trim() !== forget) await sealer.archive(name);
  await sealer.delete(name);
}

/** Wait for queued sealed operations (tests). */
export async function flushSealedNsecWrites(): Promise<void> {
  let seen: Promise<unknown>;
  do { seen = sealedNsecOps; await seen; } while (seen !== sealedNsecOps);
}

/** The kept browser key, or null when none is kept. Throws
 *  SavedKeyUnreadableError when a kept key is stored but can't be opened. */
export async function readBrowserSavedNsec(
  storage: BrowserKeyStorage,
  sealer?: NsecSealer,
): Promise<string | null> {
  let plain: string | null = null;
  try { plain = storage.getItem(SAVED_NSEC_KEY)?.trim() || null; } catch { plain = null; }
  if (!sealer) return plain;
  if (plain) {
    // Never waited for: the plain copy signs in now, whatever the store does.
    void queueSealedNsec(() => clearSealed(sealer, SAVED_NSEC_KEY, plain))
      .catch((e) => console.warn("[chama] old encrypted copy of the kept key not cleared", e));
    return plain;
  }
  // A sealed-only key counts only beside its plain witness: the key's origin,
  // which a release that stops writing plain keys keeps, and which every
  // version removes synchronously on sign-out (and on a sign-in that doesn't
  // keep the key). Without it nothing is kept: the store isn't read for the
  // answer, and any sealed copy is left over from a sign-out (in 6.4.29-
  // 6.4.31, or in an older version run after a sealed-only release).
  let witnessed = false;
  try { witnessed = storage.getItem(NSEC_ORIGIN_KEY) !== null; } catch {}
  if (!witnessed) {
    void queueSealedNsec(async () => {
      await clearSealed(sealer, SEALED_NSEC_KEY, null);
      await clearSealed(sealer, SAVED_NSEC_KEY, null);
    }).catch((e) => console.warn("[chama] left-over encrypted key not cleared", e));
    return null;
  }
  let sealed: string | null;
  try {
    sealed = (await queueSealedNsec(() => sealer.get(SEALED_NSEC_KEY)))?.trim() || null;
  } catch (e) {
    // A key was kept and can't be opened, unless one was saved meanwhile.
    try { const now = storage.getItem(SAVED_NSEC_KEY)?.trim(); if (now) return now; } catch {}
    throw new SavedKeyUnreadableError(e);
  }
  // A key saved (or a sign-out) while that read ran wins over what was read.
  let now: string | null = null;
  try { now = storage.getItem(SAVED_NSEC_KEY)?.trim() || null; } catch {}
  if (now) return now;
  try { if (storage.getItem(NSEC_ORIGIN_KEY) === null) return null; } catch {}
  // Not waited for: a leftover from a sign-out in 6.4.29-6.4.31, never used.
  void queueSealedNsec(() => clearSealed(sealer, SAVED_NSEC_KEY, sealed))
    .catch((e) => console.warn("[chama] old encrypted copy of the kept key not cleared", e));
  if (!sealed) return null;
  // Keep it the way this release keeps keys: plainly. The sealed copy goes
  // only once the plain one reads back, and only if it still holds this key.
  try {
    storage.setItem?.(SAVED_NSEC_KEY, sealed);
    if (storage.getItem(SAVED_NSEC_KEY)?.trim() === sealed) {
      void queueSealedNsec(async () => {
        if ((await sealer.get(SEALED_NSEC_KEY))?.trim() === sealed) await sealer.delete(SEALED_NSEC_KEY);
      }).catch(() => {});
    }
  } catch {}
  return sealed;
}

/** Forget the kept browser key, plain and sealed. `forget` is the key being
 *  signed out (when known): sealed copies of it, and archives that open to
 *  it, are deleted; any other stored key is archived, never deleted unread.
 *  With `wait`, returns once the sealed side is done (bounded), so a reload
 *  right after can't find the key; otherwise it finishes in the background. */
export async function removeBrowserSavedNsec(
  storage: Partial<Pick<Storage, "removeItem" | "getItem">>,
  sealer?: NsecSealer,
  opts: { forget?: string | null; wait?: boolean } = {},
): Promise<void> {
  let plain: string | null = null;
  try { plain = storage.getItem?.(SAVED_NSEC_KEY)?.trim() || null; } catch {}
  const forget = opts.forget?.trim() || plain;
  try { storage.removeItem?.(SAVED_NSEC_KEY); } catch {}
  try { storage.removeItem?.(NSEC_ORIGIN_KEY); } catch {}
  if (!sealer) return;
  const done = queueSealedNsec(async () => {
    await clearSealed(sealer, SEALED_NSEC_KEY, forget);
    await clearSealed(sealer, SAVED_NSEC_KEY, forget);
    // "This phone will forget your key": archives of this key go too.
    if (!forget) return;
    for (const name of [...await sealer.archives(SEALED_NSEC_KEY), ...await sealer.archives(SAVED_NSEC_KEY)]) {
      let value: string | null = null;
      try { value = await sealer.get(name); } catch { continue; }
      if (value?.trim() === forget) await sealer.delete(name);
    }
  }).catch((e) => console.warn("[chama] encrypted copy of the kept key not removed", e));
  if (opts.wait) await done;
}
