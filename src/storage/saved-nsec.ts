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
}
type NativePreferences = { set(options: { key: string; value: string }): Promise<void> };

/** Set (plain, not secret) once the kept key lives only in the encrypted
 *  store. Versions before 6.4.32 never write it, so without it an encrypted
 *  copy with no plain copy is left over from a sign-out, never a kept key. */
export const SEALED_ONLY_MARKER_KEY = "chama_saved_nsec_sealed_only";

/** M9 step 2's switch: remove the plain copy once the encrypted one reads
 *  back. Off in 6.4.32, which only adds the reader, so a browser that later
 *  runs 6.4.29-6.4.31 again (an old tab, a rollback) still finds the key.
 *  Turned on one release later. */
export let DROP_PLAIN_SAVED_NSEC = false;
/** Test hook for the switch. */
export function setDropPlainSavedNsecForTests(on: boolean): void { DROP_PLAIN_SAVED_NSEC = on; }

/** The kept key is stored but can't be opened right now. Never "no key":
 *  the caller offers Retry, and any new key archives this one first. */
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
  sealer?: NsecSealer,
): Promise<void> {
  if (native) {
    await native.set({ key: SAVED_NSEC_KEY, value: nsec });
    await native.set({ key: NSEC_ORIGIN_KEY, value: origin });
    return;
  }
  // The plain copy is written first, so the key is kept even if the
  // encrypted store fails or never answers.
  storage.setItem(SAVED_NSEC_KEY, nsec);
  storage.setItem(NSEC_ORIGIN_KEY, origin);
  if (!sealer) return;
  if (!DROP_PLAIN_SAVED_NSEC) {
    // Not awaited: a slow or stuck encrypted store must never hold up sign-in.
    void sealNsec(nsec, sealer);
    return;
  }
  if (await sealNsec(nsec, sealer)) dropPlainCopy(nsec, storage as BrowserKeyStorage);
}

// M9 (sealed-store.ts). 6.4.29 wrote an encrypted copy beside the plain one
// and read only the plain one. 6.4.32 adds the reader:
//  - a plain copy, when there is one, is the kept key, whatever the
//    encrypted copy says, because every version up to 6.4.32 writes it on
//    sign-in and removes it on sign-out;
//  - with no plain copy, the encrypted copy is the kept key only when the
//    sealed-only marker says a release that removes plain copies put it there;
//    otherwise it is left over from a sign-out and is moved to an archive;
//  - a stored key that can't be opened is SavedKeyUnreadableError, never null;
//  - a stored key is never replaced or removed without first being archived,
//    except by a sign-out that read it and found the key being signed out.
//
// Encrypted writes and deletes run one at a time, in order, so a sign-out
// right after a save can't be overtaken by that save's encrypted write.
let sealedNsecOps: Promise<unknown> = Promise.resolve();

// A store that never answers gives up its turn after this long, so it can't
// hold up a later sign-out's delete forever.
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

/** Run `op` after every earlier encrypted operation; its result or error is
 *  the caller's, and a stuck or failed one never blocks the next. */
function queueSealedNsec<T>(op: () => Promise<T>): Promise<T> {
  const run = sealedNsecOps.then(() => bounded(op), () => bounded(op));
  sealedNsecOps = run.catch(() => {});
  return run;
}

/** Make the encrypted copy hold `nsec`. A different or unreadable copy is
 *  archived first; when that archive can't be made, nothing is replaced.
 *  True once the copy reads back as `nsec`. */
function sealNsec(nsec: string, sealer: NsecSealer): Promise<boolean> {
  return queueSealedNsec(async () => {
    let current: string | null = null;
    let unreadable = false;
    try { current = await sealer.get(SAVED_NSEC_KEY); } catch { unreadable = true; }
    if (!unreadable && current === nsec) return true;
    if (unreadable || current !== null) await sealer.archive(SAVED_NSEC_KEY);
    await sealer.set(SAVED_NSEC_KEY, nsec);
    return true;
  }).catch((e) => {
    console.warn("[chama] encrypted copy of the kept key not written; plain copy kept", e);
    return false;
  });
}

/** Remove the plain copy, only if it still holds `nsec` (another tab may
 *  have kept a different key meanwhile). The marker goes first, so there is
 *  never a moment with neither the plain copy nor the marker. */
function dropPlainCopy(nsec: string, storage: BrowserKeyStorage): void {
  try {
    if (storage.getItem(SAVED_NSEC_KEY)?.trim() !== nsec) return;
    storage.setItem?.(SEALED_ONLY_MARKER_KEY, "1");
    storage.removeItem?.(SAVED_NSEC_KEY);
  } catch {}
}

/** Wait for queued encrypted writes and deletes (tests). */
export async function flushSealedNsecWrites(): Promise<void> {
  // Ops queued while waiting are waited for too.
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
    void sealNsec(plain, sealer).then((ok) => { if (ok && DROP_PLAIN_SAVED_NSEC) dropPlainCopy(plain!, storage); });
    return plain;
  }
  let sealedOnly = false;
  try { sealedOnly = storage.getItem(SEALED_ONLY_MARKER_KEY) === "1"; } catch {}
  if (!sealedOnly) {
    // Nothing is kept. An encrypted copy here is left over from a sign-out
    // in a version that didn't wait for its delete: never sign in with it,
    // and move it aside rather than lose it.
    void queueSealedNsec(async () => {
      let leftover: string | null = null;
      try { leftover = await sealer.get(SAVED_NSEC_KEY); } catch { leftover = "unreadable"; }
      if (leftover === null) return;
      if (storage.getItem(SAVED_NSEC_KEY) || storage.getItem(SEALED_ONLY_MARKER_KEY) === "1") return;
      await sealer.archive(SAVED_NSEC_KEY);
      await sealer.delete(SAVED_NSEC_KEY);
    }).catch((e) => console.warn("[chama] leftover encrypted key not moved aside", e));
    return null;
  }
  let sealed: string | null;
  try {
    sealed = await queueSealedNsec(() => sealer.get(SAVED_NSEC_KEY));
  } catch (e) {
    throw new SavedKeyUnreadableError(e);
  }
  sealed = sealed?.trim() || null;
  if (!sealed) {
    try { storage.removeItem?.(SEALED_ONLY_MARKER_KEY); } catch {}
    return null;
  }
  // Running a release that still keeps plain copies: write one back, so any
  // version that reads only plain copies finds the key again.
  if (!DROP_PLAIN_SAVED_NSEC) {
    try {
      storage.setItem?.(SAVED_NSEC_KEY, sealed);
      storage.removeItem?.(SEALED_ONLY_MARKER_KEY);
    } catch {}
  }
  return sealed;
}

/** Forget the kept browser key, plain and encrypted. Waits (bounded) for the
 *  encrypted delete, so a reload right after can't find the key again. A
 *  stored copy that isn't this key, or can't be opened, is archived rather
 *  than deleted unread. */
export async function removeBrowserSavedNsec(
  storage: Partial<Pick<Storage, "removeItem" | "getItem">>,
  sealer?: NsecSealer,
): Promise<void> {
  let plain: string | null = null;
  try { plain = storage.getItem?.(SAVED_NSEC_KEY)?.trim() || null; } catch {}
  try { storage.removeItem?.(SAVED_NSEC_KEY); } catch {}
  try { storage.removeItem?.(NSEC_ORIGIN_KEY); } catch {}
  try { storage.removeItem?.(SEALED_ONLY_MARKER_KEY); } catch {}
  if (!sealer) return;
  await queueSealedNsec(async () => {
    let current: string | null = null;
    let unreadable = false;
    try { current = await sealer.get(SAVED_NSEC_KEY); } catch { unreadable = true; }
    if (!unreadable && current === null) return;
    // The key being signed out is the plain copy, or, with none, the
    // encrypted copy itself (sealed-only). Anything else is kept aside.
    if (unreadable || (plain !== null && current !== plain)) await sealer.archive(SAVED_NSEC_KEY);
    await sealer.delete(SAVED_NSEC_KEY);
  }).catch((e) => console.warn("[chama] encrypted copy of the kept key not removed", e));
}
