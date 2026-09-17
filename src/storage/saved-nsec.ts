/** Saved identity keys are separate from wallet recovery material. */
export const SAVED_NSEC_KEY = "chama_saved_nsec";
export const NSEC_ORIGIN_KEY = "chama_nsec_origin";
// null = not saved here; pending = notice owed; done = acknowledged.
export const NSEC_KEEP_NOTICE_KEY = "chama_nsec_keep_notice";

type NoticeStorage = Pick<Storage, "getItem" | "setItem">;
type NativePreferences = { set(options: { key: string; value: string }): Promise<void> };

/** Arm the saved-key notice only after the selected storage accepted the key. */
export async function saveNsecWithNotice(
  nsec: string,
  origin: "generated" | "imported",
  storage: NoticeStorage,
  native?: NativePreferences,
): Promise<void> {
  if (native) {
    await native.set({ key: SAVED_NSEC_KEY, value: nsec });
    await native.set({ key: NSEC_ORIGIN_KEY, value: origin });
  } else {
    storage.setItem(SAVED_NSEC_KEY, nsec);
    storage.setItem(NSEC_ORIGIN_KEY, origin);
  }
  try {
    if (storage.getItem(NSEC_KEEP_NOTICE_KEY) === null) {
      storage.setItem(NSEC_KEEP_NOTICE_KEY, "pending");
    }
  } catch { /* A notice-storage failure does not undo a successful native save. */ }
}
