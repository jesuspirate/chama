/** Saved identity keys are separate from wallet recovery material. */
export const SAVED_NSEC_KEY = "chama_saved_nsec";
export const NSEC_ORIGIN_KEY = "chama_nsec_origin";

type KeyStorage = Pick<Storage, "setItem">;
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
): Promise<void> {
  if (native) {
    await native.set({ key: SAVED_NSEC_KEY, value: nsec });
    await native.set({ key: NSEC_ORIGIN_KEY, value: origin });
    return;
  }
  storage.setItem(SAVED_NSEC_KEY, nsec);
  storage.setItem(NSEC_ORIGIN_KEY, origin);
}
