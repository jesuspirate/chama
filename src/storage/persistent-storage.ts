// ══════════════════════════════════════════════════════════════════════════
// Chama — ask the browser not to evict our storage
// ══════════════════════════════════════════════════════════════════════════
//
// WHY: everything a browser client owns lives in script-writable storage — the
// Fedimint wallet in OPFS, the durable escrow-event cache in IndexedDB, the
// trade index / identity pin / saved handles in localStorage. Both WebKit and
// Chromium evict that storage on a least-recently-used basis for origins in
// "best-effort" mode when a site has not been interacted with for a while. For
// an installed Chama that is not a lost preference — it is a lost WALLET, and
// a history that then cannot be rebuilt.
//
// `StorageManager.persist()` moves the origin to persistent mode, which is
// excluded from eviction. WebKit grants it on heuristics that explicitly
// include "is this running as a Home Screen Web App"; Chromium uses install +
// engagement signals. Asking costs one call and is idempotent.
//
// ⚠ It is NOT called unconditionally, because Firefox shows a permission
// prompt for persistent storage. A first-time visitor reading listings should
// never be met with a storage dialog. So we ask only when there is something
// worth protecting: the app is installed, or this origin already holds Chama
// state from a previous session.
//
// This does NOT keep anyone signed in. In a browser or PWA the nsec is never
// written to disk at all — `shouldPersistNsecInShell()` is Capacitor-native or
// Tauri only — so a fresh launch asks for the key by design, not by eviction.
// Persisting storage protects the wallet and the history, not the login.

const CHAMA_KEY_PREFIX = "chama_";

/** Running as an installed app (Home Screen / standalone window) rather than a
 *  browser tab. Both signals are needed: iOS Safari shipped `navigator.standalone`
 *  long before it supported the `display-mode` media query for home-screen apps. */
export function isInstalledApp(): boolean {
  try {
    if (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) {
      return true;
    }
    return (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** Does this origin already hold Chama state? A returning user has something to
 *  lose; a cold visitor does not, and must not be prompted. */
export function holdsChamaState(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CHAMA_KEY_PREFIX)) return true;
    }
  } catch {
    // Storage disabled entirely — there is nothing to protect.
  }
  return false;
}

/** Pure policy, so the "never prompt a cold visitor" rule is testable without
 *  a browser. Ask when the app is installed OR when state already exists. */
export function shouldRequestPersistentStorage(
  installed: boolean,
  hasState: boolean,
): boolean {
  return installed || hasState;
}

export type PersistOutcome =
  | "unsupported"   // no StorageManager.persist in this runtime
  | "skipped"       // cold visitor — deliberately did not ask
  | "already"       // origin was already in persistent mode
  | "granted"
  | "denied";       // asked, browser said no (heuristics unmet / user declined)

/**
 * Request persistent-mode storage when it is worth asking for. Safe to call at
 * boot: fully guarded, never throws, and never blocks rendering. Idempotent —
 * `persisted()` short-circuits a repeat request on every later launch.
 */
export async function requestPersistentStorageIfWorthwhile(): Promise<PersistOutcome> {
  try {
    const manager = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!manager || typeof manager.persist !== "function" || typeof manager.persisted !== "function") {
      return "unsupported";
    }
    if (await manager.persisted()) return "already";
    if (!shouldRequestPersistentStorage(isInstalledApp(), holdsChamaState())) {
      return "skipped";
    }
    return (await manager.persist()) ? "granted" : "denied";
  } catch {
    // A storage-policy request must never be able to break a boot.
    return "unsupported";
  }
}
