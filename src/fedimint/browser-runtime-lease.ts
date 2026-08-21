// Chama — browser Fedimint runtime lease
//
// A Start9 service can expose the same UI on multiple localhost-style ports.
// Ports are separate web origins, so OPFS, BroadcastChannel, localStorage and
// Web Locks cannot coordinate them. Cookies, however, are host-scoped and are
// shared across ports. Keep at most one heavyweight Fedimint WASM/OPFS runtime
// alive per wallet while leaving every tab's Nostr client and trade state
// fully operational.
//
// ⚠ THE LEASE IS KEYED BY WALLET SCOPE, NOT BY HOST. The hazard being guarded
// is one SEED driving two WASM runtimes — divergent ecash state across two
// stores that both believe they own the same notes. Keying by host instead
// swept in every unrelated Chama tab on the same hostname, because a cookie
// ignores the port: two dev servers (:3000 and :3001) and two identities in
// one browser profile all collided, and the refusal surfaced to the user as
// "Couldn't reach <community>". The scope is the same value that selects the
// OPFS wallet file (see sdk-adapter's storageScope), so two runtimes collide
// here exactly when they would collide on disk.
//
// A dead owner still holds its cookie until the TTL expires — `pagehide` is
// best-effort and never fires for a crash, a force-quit, or a tab the browser
// discards under memory pressure. That is what `armBrowserRuntimeTakeover`
// exists for: the blocked tab can claim the runtime on the user's say-so
// instead of waiting out a timer it cannot see.

const COOKIE_BASE = "chama_fedimint_runtime";
const HEARTBEAT_MS = 15_000;
// Chrome may throttle a long-backgrounded page's timers to roughly one
// callback per minute. Three minutes keeps a healthy hidden wallet from being
// mistaken for a dead owner while still recovering automatically after a
// renderer crash.
export const BROWSER_RUNTIME_LEASE_TTL_MS = 180_000;
// A taken-over owner must stop touching the wallet quickly, so the cookie is
// READ far more often than it is written. Reads are free; the write cadence
// stays at HEARTBEAT_MS.
const WATCHDOG_MS = 2_000;
const CLAIM_SETTLE_MS = 80;

type LeaseRecord = { token: string; touchedAt: number };

let ownedToken: string | null = null;
let ownedCookieName: string | null = null;
let onLeaseLost: (() => void) | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastWriteAt = 0;
let pageHideInstalled = false;
let takeoverArmed = false;

/**
 * Cookie name for one wallet scope.
 *
 * `scope` is the caller's storage scope (normally the user's Nostr pubkey).
 * A missing scope falls back to the unscoped name, which keeps the guard in
 * place for callers that have no identity to key on.
 */
export function browserRuntimeLeaseCookieName(scope?: string | null): string {
  const clean = (scope ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean ? `${COOKIE_BASE}_${clean.slice(0, 16)}` : COOKIE_BASE;
}

function readCookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=") || null;
  }
  return null;
}

export function parseBrowserRuntimeLease(
  cookie: string,
  scope?: string | null,
): LeaseRecord | null {
  const raw = readCookieValue(cookie, browserRuntimeLeaseCookieName(scope));
  if (!raw) return null;
  try {
    const [token, touched] = decodeURIComponent(raw).split(".");
    const touchedAt = Number(touched);
    return token && Number.isFinite(touchedAt) && touchedAt > 0
      ? { token, touchedAt }
      : null;
  } catch {
    return null;
  }
}

export function browserRuntimeLeaseIsActive(
  record: LeaseRecord | null,
  now = Date.now(),
): boolean {
  return !!record && now - record.touchedAt < BROWSER_RUNTIME_LEASE_TTL_MS;
}

/**
 * Let the NEXT acquire claim the runtime even if another lease looks alive.
 *
 * One-shot and consumed by the following `acquireBrowserRuntimeLease`, so a
 * takeover cannot leak into a later, unrelated wallet init. Arming it is a
 * user decision ("use the wallet in this tab"), not something the data layer
 * should ever do on its own — a live owner is stood down by the watchdog
 * below, but only after it notices, so the honest default remains "refuse".
 */
export function armBrowserRuntimeTakeover(): void {
  takeoverArmed = true;
}

/** Test/diagnostic read of the one-shot flag. Does not consume it. */
export function browserRuntimeTakeoverArmed(): boolean {
  return takeoverArmed;
}

function writeLease(name: string, token: string, touchedAt = Date.now()): void {
  document.cookie =
    `${name}=${encodeURIComponent(`${token}.${touchedAt}`)}; Path=/; SameSite=Strict`;
  lastWriteAt = touchedAt;
}

function clearLeaseCookie(name: string): void {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Strict`;
}

function stopWatchdog(): void {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

function releaseOwnedLease(): void {
  if (!ownedToken || !ownedCookieName || typeof document === "undefined") return;
  const current = parseBrowserRuntimeLeaseByName(document.cookie, ownedCookieName);
  if (current?.token === ownedToken) clearLeaseCookie(ownedCookieName);
  ownedToken = null;
  ownedCookieName = null;
  onLeaseLost = null;
  stopWatchdog();
}

/** Name-addressed parse, for the owner's own bookkeeping (it already resolved
 *  its cookie name at acquire time and must not re-derive it from a scope). */
function parseBrowserRuntimeLeaseByName(
  cookie: string,
  name: string,
): LeaseRecord | null {
  const raw = readCookieValue(cookie, name);
  if (!raw) return null;
  try {
    const [token, touched] = decodeURIComponent(raw).split(".");
    const touchedAt = Number(touched);
    return token && Number.isFinite(touchedAt) && touchedAt > 0
      ? { token, touchedAt }
      : null;
  } catch {
    return null;
  }
}

function leaseError(): Error {
  const error = new Error(
    "Chama's wallet is already open in another tab. That tab remains fully active; " +
      "close it before funding, claiming, or reconnecting this wallet. Trade chat and status remain available here.",
  );
  (error as Error & { code?: string }).code = "FEDIMINT_RUNTIME_IN_OTHER_TAB";
  return error;
}

/**
 * Claim the single browser Fedimint runtime slot for this wallet scope.
 *
 * The short settle turn closes the simultaneous-open race: contenders write
 * unique tokens, then only the last visible token proceeds to import WASM.
 * A renderer crash stops heartbeats and the stale lease self-heals at the TTL
 * — or sooner, if the user arms a takeover.
 *
 * @param scope   Wallet storage scope (normally the Nostr pubkey).
 * @param options `onLost` fires when another tab takes the runtime over, so
 *                the caller can tear its WASM worker down rather than keep a
 *                second runtime alive on the same seed.
 */
export async function acquireBrowserRuntimeLease(
  scope?: string | null,
  options?: { onLost?: () => void },
): Promise<() => void> {
  // Consume the one-shot flag on EVERY attempt — before the environment
  // check, so the guarantee holds unconditionally: an armed takeover that
  // turns out to be unnecessary can never sit around and silently override a
  // legitimate refusal later in the session.
  const takeover = takeoverArmed;
  takeoverArmed = false;

  if (typeof document === "undefined" || typeof location === "undefined") {
    return () => {};
  }

  const name = browserRuntimeLeaseCookieName(scope);

  // Already own THIS scope — nothing to do. Owning a different scope means the
  // tab switched identity, so hand the old wallet's slot back first.
  if (ownedToken && ownedCookieName === name) {
    if (options?.onLost) onLeaseLost = options.onLost;
    return releaseOwnedLease;
  }
  if (ownedToken) releaseOwnedLease();

  const now = Date.now();
  const existing = parseBrowserRuntimeLeaseByName(document.cookie, name);
  if (!takeover && browserRuntimeLeaseIsActive(existing, now)) throw leaseError();

  const token = globalThis.crypto?.randomUUID?.()
    ?? `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
  writeLease(name, token, now);
  await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS));

  const settled = parseBrowserRuntimeLeaseByName(document.cookie, name);
  if (settled?.token !== token) throw leaseError();

  ownedToken = token;
  ownedCookieName = name;
  onLeaseLost = options?.onLost ?? null;

  stopWatchdog();
  watchdog = setInterval(() => {
    if (!ownedToken || !ownedCookieName) return;
    const current = parseBrowserRuntimeLeaseByName(document.cookie, ownedCookieName);

    // Someone else's ACTIVE token is in our slot: we have been taken over.
    // Stand down and let the caller kill its worker — two runtimes on one
    // seed is the exact thing this lease exists to prevent.
    if (current && current.token !== ownedToken
      && browserRuntimeLeaseIsActive(current)) {
      const lost = onLeaseLost;
      ownedToken = null;
      ownedCookieName = null;
      onLeaseLost = null;
      stopWatchdog();
      console.warn(
        "[chama] Fedimint runtime lease taken over by another tab — standing down.",
      );
      try { lost?.(); } catch {}
      return;
    }

    // A missing or expired record is NOT a takeover: our cookie was cleared
    // (privacy sweep, TTL raced a throttled timer) while we are still the
    // live runtime. Re-assert it rather than silently holding nothing.
    if (Date.now() - lastWriteAt >= HEARTBEAT_MS || !current) {
      writeLease(ownedCookieName, ownedToken);
    }
  }, WATCHDOG_MS);

  if (!pageHideInstalled) {
    pageHideInstalled = true;
    globalThis.addEventListener?.("pagehide", releaseOwnedLease);
  }
  return releaseOwnedLease;
}
