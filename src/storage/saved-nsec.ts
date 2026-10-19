/** Saved identity keys are separate from wallet recovery material. */
export const SAVED_NSEC_KEY = "chama_saved_nsec";
export const NSEC_ORIGIN_KEY = "chama_nsec_origin";

type KeyStorage = Pick<Storage, "setItem">;

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
  storage.setItem(SAVED_NSEC_KEY, nsec);
  storage.setItem(NSEC_ORIGIN_KEY, origin);
  // Not awaited: a slow or stuck encrypted store must never hold up sign-in.
  if (sealer) void mirrorSealedNsec(nsec, sealer);
}

// M9, first step: in the browser the kept key is also written encrypted
// (sealed-store.ts), but the plain copy stays the one that is read, so an
// older app (a stale tab, a rollback) still finds it and a sign-out there
// still signs out here. A later release reads the encrypted copy and removes
// the plain one. The encrypted copy only follows the plain one, and failing
// to write it changes nothing.
//
// Encrypted writes and deletes run one at a time, in order, so a sign-out
// right after a save can't be overtaken by that save's encrypted write.
let sealedNsecOps: Promise<void> = Promise.resolve();

// A store that never answers gives up its turn after this long, so it can't
// hold up a later sign-out's delete forever.
const SEALED_OP_TIMEOUT_MS = 10_000;

function queueSealedNsec(op: () => Promise<void>): Promise<void> {
  const bounded = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SEALED_OP_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    op().catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
  sealedNsecOps = sealedNsecOps.then(bounded, bounded);
  return sealedNsecOps;
}

function mirrorSealedNsec(nsec: string, sealer: NsecSealer): Promise<void> {
  return queueSealedNsec(async () => {
    try {
      if ((await sealer.get(SAVED_NSEC_KEY)) === nsec) return;
      await sealer.set(SAVED_NSEC_KEY, nsec);
    } catch (e) {
      console.warn("[chama] encrypted copy of the kept key not written; plain copy kept", e);
    }
  });
}

/** Wait for queued encrypted writes and deletes (tests). */
export function flushSealedNsecWrites(): Promise<void> {
  return sealedNsecOps;
}

/** The kept browser key (the plain copy), refreshing its encrypted copy. */
export async function readBrowserSavedNsec(
  storage: Pick<Storage, "getItem">,
  sealer?: NsecSealer,
): Promise<string | null> {
  let plain: string | null = null;
  try { plain = storage.getItem(SAVED_NSEC_KEY)?.trim() || null; } catch { plain = null; }
  if (plain && sealer) void mirrorSealedNsec(plain, sealer);
  return plain;
}

/** Forget the kept browser key, plain and encrypted. */
export async function removeBrowserSavedNsec(
  storage: Partial<Pick<Storage, "removeItem">>,
  sealer?: NsecSealer,
): Promise<void> {
  try { storage.removeItem?.(SAVED_NSEC_KEY); } catch {}
  try { storage.removeItem?.(NSEC_ORIGIN_KEY); } catch {}
  if (sealer) void queueSealedNsec(async () => { try { await sealer.delete(SAVED_NSEC_KEY); } catch {} });
}
