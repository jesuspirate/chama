// ══════════════════════════════════════════════════════════════════════════
// Notification deep-links — carry a tapped notification to its trade
// ══════════════════════════════════════════════════════════════════════════
//
// A tapped trade notification should land the user on that trade's TradeDetail,
// not the home list. Every trade notification carries its escrowId — Capacitor
// `extra`, Tauri `extra`, and the web Notification via the delivering closure in
// notify-service. The tap can fire before React is ready (a cold launch from a
// killed app), so we BUFFER the most-recent target here and let App drain it
// once it's connected. Kept tiny and free of app/engine imports so notify-service
// can depend on it without a cycle.

/** Sentinel for "we got a tap but no escrowId" — a desktop fallback when a
 *  platform's notification click delivers no payload. App resolves it to the
 *  user's current active trade. */
export const LATEST_ACTIONABLE = "__latest_actionable__";

/** The on-wire escrow id shape (mirrors App's URL-param guard). */
const ESCROW_ID_RE = /^sm_[a-z0-9_]+$/i;

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Record a tap target. Accepts a valid escrow id or the LATEST_ACTIONABLE
 *  sentinel; anything else is ignored (defends against malformed `extra`). */
export function setPendingTradeDeepLink(target: unknown): void {
  const t =
    target === LATEST_ACTIONABLE ? LATEST_ACTIONABLE
    : typeof target === "string" && ESCROW_ID_RE.test(target) ? target
    : null;
  if (!t) return;
  pending = t;
  for (const l of [...listeners]) {
    try { l(); } catch { /* a listener must never wedge delivery */ }
  }
}

/** Take and clear the buffered tap target, if any. */
export function consumePendingTradeDeepLink(): string | null {
  const t = pending;
  pending = null;
  return t;
}

/** Subscribe to tap arrivals; returns an unsubscribe. */
export function onTradeDeepLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── Native tap-handler registration (idempotent) ─────────────────────────────
// Platform detection inlined (mirrors notify-service) to keep this decoupled.

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
  } catch {
    return false;
  }
}

function isTauriNative(): boolean {
  const g = globalThis as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return Boolean(g.__TAURI__ || g.__TAURI_INTERNALS__);
}

function extractEscrowId(extra: unknown): string | null {
  const id = (extra as { escrowId?: unknown } | null | undefined)?.escrowId;
  return typeof id === "string" && ESCROW_ID_RE.test(id) ? id : null;
}

/** Route a warm web-service-worker notification tap without navigating the
 *  live document (and therefore without destroying its memory-only nsec). */
export function handleWebNotificationClickMessage(data: unknown): void {
  const message = data as { type?: unknown; escrowId?: unknown } | null | undefined;
  if (message?.type !== "chama:notificationclick") return;
  setPendingTradeDeepLink(extractEscrowId(message));
}

let registered = false;

/**
 * Register OS-notification tap handlers for the current native platform, routing
 * each tap into the pending-deeplink buffer. Idempotent and never throws — a
 * missing plugin is a silent no-op. Page-constructed web notifications are
 * wired in notify-service via Notification.onclick; service-worker-delivered
 * web notifications arrive here via postMessage. Returns a best-effort
 * unregister.
 */
export function registerNotificationTapHandlers(): () => void {
  if (registered) return () => {};
  registered = true;
  const disposers: Array<() => void> = [];

  if (isCapacitorNative()) {
    void (async () => {
      try {
        const { LocalNotifications } = await import("@capacitor/local-notifications");
        const handle = await LocalNotifications.addListener(
          "localNotificationActionPerformed",
          (action) => setPendingTradeDeepLink(extractEscrowId(action?.notification?.extra)),
        );
        disposers.push(() => { try { void handle.remove(); } catch { /* ignore */ } });
      } catch { /* plugin unavailable; ignore */ }
    })();
  } else if (isTauriNative()) {
    void (async () => {
      try {
        const mod = await import("@tauri-apps/plugin-notification");
        const handle = await mod.onAction((notification) => {
          // Primary: the escrowId we stamped into `extra`. Fallback (desktop
          // click delivered without a payload): land on the active trade.
          setPendingTradeDeepLink(extractEscrowId(notification?.extra) ?? LATEST_ACTIONABLE);
        });
        disposers.push(() => { try { void handle.unregister(); } catch { /* ignore */ } });
      } catch { /* plugin unavailable; ignore */ }
    })();
  } else if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    const serviceWorker = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      handleWebNotificationClickMessage(event.data);
    };
    serviceWorker.addEventListener("message", onMessage);
    disposers.push(() => serviceWorker.removeEventListener("message", onMessage));
  }

  return () => {
    registered = false;
    for (const d of disposers) d();
  };
}
