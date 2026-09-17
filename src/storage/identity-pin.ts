// ══════════════════════════════════════════════════════════════════════════
// Chama — identity pin (browser / Fedi path)
// ══════════════════════════════════════════════════════════════════════════
//
// When the user signs in with an nsec, the shell persists it on every client
// (runway #13: secure Preferences on native, localStorage in browsers) and
// restores it deterministically on launch. The NIP-07 / Fedi path is
// different: there the key never passes through the app at all, so the active
// npub is whatever `window.nostr` hands back this session. If the Fedi runtime restores or
// returns a different active account (or a transient value) between sign-ins,
// the app would silently re-scope every per-npub store to the new key — the
// observed "buyer/seller role pill flips between Fedi sign-ins" symptom, where
// the active identity flips between two perfectly valid npubs.
//
// This module pins the last-seen identity so connect() can DETECT a change and
// handle it as a deliberate, clean re-scope (reset in-memory state, reload
// that npub's trades) rather than a silent blend of two identities' state. It
// does NOT force a key — a FediSigner can only sign with whatever window.nostr
// holds — it just gives the app a stable "who am I now, and did that change?"
// signal. The pin lives in localStorage (the only store the webview offers);
// it is advisory, and relays remain the durable source of truth for trades.

const IDENTITY_PIN_KEY = "chama_identity_pin";

function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** The last-seen identity (64-hex), or null if none/invalid is stored. */
export function getPinnedIdentity(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem(IDENTITY_PIN_KEY)?.trim().toLowerCase() ?? "";
    return isHexPubkey(v) ? v : null;
  } catch {
    return null;
  }
}

export function setPinnedIdentity(pubkey: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const clean = pubkey.trim().toLowerCase();
    if (isHexPubkey(clean)) localStorage.setItem(IDENTITY_PIN_KEY, clean);
  } catch {
    // Advisory cache only; a write failure just means we can't detect the
    // next change — never fatal to sign-in.
  }
}

/**
 * Reconcile a freshly-read signer pubkey against the pinned identity, then
 * update the pin to the current key. Returns whether this is a *changed*
 * identity (a different valid npub than last session) so the caller can
 * re-scope cleanly. `changed` is false on first-ever sign-in (nothing to
 * blend) and on a normal same-identity re-login.
 */
export function reconcileIdentity(pubkey: string): { changed: boolean; previous: string | null } {
  const previous = getPinnedIdentity();
  const clean = pubkey.trim().toLowerCase();
  const changed = previous !== null && isHexPubkey(clean) && previous !== clean;
  setPinnedIdentity(clean);
  return { changed, previous };
}
