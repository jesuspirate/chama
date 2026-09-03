// ══════════════════════════════════════════════════════════════════════════
// A6 web push client — opt-in, closed-app wake-ups for the PWA / getchama.app
// ══════════════════════════════════════════════════════════════════════════
//
// The browser/PWA half of the "VPS privacy-preserving watcher" (brief:
// design/mockups/chama-a6-vps-webpush-brief.md). This module ONLY establishes
// the push channel and registers OPAQUE watch-tags with the watcher. It does
// not decide *when* to notify — that stays in notify-service.ts — and it never
// hands the VPS anything linkable (no pubkey, escrow id, amount, or content).
//
// Scope of this P1 slice: subscribe + register + tag derivation + the iOS gate,
// all self-contained. Wiring watch-tags into the trade lifecycle (derive on
// JOIN/LOCK, attach `#w` on publish, rotate/unwatch on COMPLETE) is P3 and lives
// with the escrow flow, not here. Every network call is best-effort: the watcher
// may not be up yet, and a push failure must NEVER break a trade — same doctrine
// as notify-service's fire-and-forget delivery.

// ── Config (public by design) ──────────────────────────────────────────────
// VAPID public key ships in the bundle; the private key never leaves the VPS.
// TODO(P2): replace with the real key printed by `web-push generate-vapid-keys`
// on the watcher host. An empty value disables subscription cleanly (no throw).
export const WEB_PUSH_VAPID_PUBLIC = "BHl6Xx8C6UvN0CGmn9Q-zvwfuttqjUEdePvOL4-Rq2TrHNJ_cZ6d3SHgsdfIR-grZi-f6h9f1Rj7uiW790OGCTE";

// The watcher's registration API. Same host family as the relay; a dedicated
// subdomain keeps it independent of the app origin. TODO(P2): confirm host.
export const WEB_PUSH_REGISTER_URL = "https://push.chama.community/register";
export const WEB_PUSH_UNREGISTER_URL = "https://push.chama.community/unregister";

// ── Capability + permission ────────────────────────────────────────────────

/** True only where the browser can actually deliver a background push. */
export function isWebPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * iOS/iPadOS give web push ONLY to a home-screen-installed PWA, never a Safari
 * tab. Detect the tab case so the UI can show an "Add to Home Screen" step
 * instead of a permission prompt that can never succeed. Returns true when the
 * user is on iOS, in a browser tab, and therefore cannot receive push yet.
 */
export function iosNeedsInstallForPush(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Mac; disambiguate by touch.
    (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
  if (!isIos) return false;
  const standalone =
    (typeof navigator !== "undefined" && (navigator as { standalone?: boolean }).standalone === true) ||
    (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches === true);
  return !standalone;
}

export function webPushPermission(): NotificationPermission | "unsupported" {
  if (!isWebPushSupported()) return "unsupported";
  return Notification.permission;
}

// ── Blinded watch-tags ─────────────────────────────────────────────────────
//
// A watch-tag is what the VPS matches on. It is opaque to the relay and the
// watcher — derived from a per-trade symmetric key both participants can
// compute — so the VPS sees a random-looking string, never a trade or a pubkey.
//
// `epoch` is the ratchet: bumping it per state-transition means the VPS sees a
// stream of unlinkable tags rather than a stable pairing it could use to draw a
// social graph (brief §6.1). Callers pass the same epoch both sides agree on.

function toBytes(input: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const src = typeof input === "string" ? new TextEncoder().encode(input) : input;
  // Copy into a fresh ArrayBuffer-backed view: a caller's Uint8Array may be
  // backed by an ArrayBufferLike (incl. SharedArrayBuffer), which WebCrypto's
  // BufferSource does not accept under TS's typed-array types.
  const copy = new Uint8Array(src.length);
  copy.set(src);
  return copy;
}

function base64url(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * watchTag = base64url( HMAC-SHA256(tradeWatchKey, escrowId || ":" || epoch) )[:16]
 *
 * Deterministic and dependency-free (WebCrypto). 16 chars ≈ 96 bits of tag
 * space — ample to avoid collisions while carrying zero recoverable meaning.
 */
export async function deriveWatchTag(
  tradeWatchKey: Uint8Array | string,
  escrowId: string,
  epoch = 0,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(tradeWatchKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, toBytes(`${escrowId}:${epoch}`));
  return base64url(mac).slice(0, 16);
}

// ── Subscription lifecycle ─────────────────────────────────────────────────

/** Opaque community wake-tag. Any client can derive it from the PUBLIC community
 *  slug, so the VPS watcher can wake a device when a new listing appears in that
 *  community without ever learning what the device is waiting for (S4.2). */
export async function deriveCommunityWakeTag(slug: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(`chama:community-wake:v1:${slug.trim().toLowerCase()}`));
  return base64url(digest).slice(0, 16);
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Ensure a live push subscription. Requests notification permission (contextual,
 * like the rest of notify-service), then subscribes against the VAPID key.
 * Returns null when unsupported, denied, on an iOS tab, or when no VAPID key is
 * configured yet — never throws, so a caller can treat null as "not available".
 */
export async function ensureWebPushSubscription(): Promise<PushSubscription | null> {
  try {
    if (!isWebPushSupported() || iosNeedsInstallForPush()) return null;
    if (!WEB_PUSH_VAPID_PUBLIC) return null; // P2 not deployed yet — no-op cleanly

    if (Notification.permission === "denied") return null;
    if (Notification.permission !== "granted") {
      const asked = await Notification.requestPermission();
      if (asked !== "granted") return null;
    }

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;

    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(WEB_PUSH_VAPID_PUBLIC),
    });
  } catch (e) {
    console.warn("[chama/notify] web-push subscribe failed", e);
    return null;
  }
}

/**
 * Register interest for a set of opaque watch-tags. Sends ONLY the push
 * subscription and the tags — no identity. Best-effort: a down watcher or a
 * network error resolves false, never throws.
 */
export async function registerWatchTags(tags: readonly string[]): Promise<boolean> {
  if (tags.length === 0) return true;
  const subscription = await ensureWebPushSubscription();
  if (!subscription) return false;
  try {
    const res = await fetch(WEB_PUSH_REGISTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.toJSON(), tags }),
      keepalive: true,
    });
    return res.ok;
  } catch (e) {
    console.warn("[chama/notify] watch-tag register failed", e);
    return false;
  }
}

/** Drop watch-tags (e.g. on trade COMPLETE / forget). Best-effort. */
export async function unregisterWatchTags(tags: readonly string[]): Promise<boolean> {
  if (tags.length === 0) return true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true; // nothing registered ⇒ nothing to drop
    const res = await fetch(WEB_PUSH_UNREGISTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.toJSON(), tags }),
      keepalive: true,
    });
    return res.ok;
  } catch (e) {
    console.warn("[chama/notify] watch-tag unregister failed", e);
    return false;
  }
}

/** Tear down the subscription entirely (user turns background wake-ups off). */
export async function disableWebPush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (e) {
    console.warn("[chama/notify] web-push disable failed", e);
  }
}
