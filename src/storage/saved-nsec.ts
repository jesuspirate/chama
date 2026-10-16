/** Saved identity keys are separate from wallet recovery material. */
export const SAVED_NSEC_KEY = "chama_saved_nsec";
export const NSEC_ORIGIN_KEY = "chama_nsec_origin";
/** Set when a sealed key could not be deleted: no key is kept, whatever
 *  sealed storage still holds, until the next save. */
export const NSEC_FORGOTTEN_KEY = "chama_saved_nsec_forgotten";

type KeyStorage = Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>;

/** Encrypted browser storage (sealed-store.ts), injected so tests can fake it. */
export interface NsecSealer {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}
type NativePreferences = { set(options: { key: string; value: string }): Promise<void> };

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
  // M9: in the browser the key is kept encrypted when it can be. The plain
  // copy is removed only after the sealed copy has read back; if sealing
  // fails, the key is kept the old way rather than not at all.
  if (sealer) {
    try {
      await sealer.set(SAVED_NSEC_KEY, nsec);
      storage.setItem(NSEC_ORIGIN_KEY, origin);
      try { storage.removeItem?.(SAVED_NSEC_KEY); } catch {}
      try { storage.removeItem?.(NSEC_FORGOTTEN_KEY); } catch {}
      return;
    } catch {
      // Fall through to plain storage, and don't let an older sealed key
      // stand beside the new plain one.
      try { await sealer.delete(SAVED_NSEC_KEY); } catch {}
    }
  }
  storage.setItem(SAVED_NSEC_KEY, nsec);
  storage.setItem(NSEC_ORIGIN_KEY, origin);
  try { storage.removeItem?.(NSEC_FORGOTTEN_KEY); } catch {}
}

/** The kept browser key: the sealed copy first, else a plain one, which is
 *  then moved into sealed storage (plain copy removed only after it reads
 *  back). An unreadable sealed copy is never deleted here. */
export async function readBrowserSavedNsec(
  storage: Pick<Storage, "getItem"> & Partial<Pick<Storage, "removeItem">>,
  sealer?: NsecSealer,
): Promise<string | null> {
  try { if (storage.getItem(NSEC_FORGOTTEN_KEY)) return null; } catch {}
  // A plain copy is always the newer one: it exists only from an older app
  // or when sealing failed. It wins and is moved into sealed storage.
  let plain: string | null = null;
  try { plain = storage.getItem(SAVED_NSEC_KEY)?.trim() || null; } catch { plain = null; }
  if (!plain && sealer) {
    try {
      const sealed = (await sealer.get(SAVED_NSEC_KEY))?.trim();
      if (sealed) return sealed;
    } catch {
      // Unreadable sealed copy: delete nothing.
    }
    return null;
  }
  if (plain && sealer) {
    try {
      await sealer.set(SAVED_NSEC_KEY, plain);
      try { storage.removeItem?.(SAVED_NSEC_KEY); } catch {}
    } catch {
      // Keep the plain copy; try again next time.
    }
  }
  return plain;
}

/** Forget the kept browser key, sealed and plain. */
export async function removeBrowserSavedNsec(
  storage: Partial<Pick<Storage, "removeItem" | "setItem">>,
  sealer?: NsecSealer,
): Promise<void> {
  if (sealer) {
    let gone = false;
    try {
      await sealer.delete(SAVED_NSEC_KEY);
      gone = (await sealer.get(SAVED_NSEC_KEY)) === null;
    } catch {
      gone = false;
    }
    // Signing out must not sign back in on reload: if the sealed key may
    // still be there, mark it forgotten.
    if (!gone) { try { storage.setItem?.(NSEC_FORGOTTEN_KEY, "1"); } catch {} }
  }
  try { storage.removeItem?.(SAVED_NSEC_KEY); } catch {}
  try { storage.removeItem?.(NSEC_ORIGIN_KEY); } catch {}
}
