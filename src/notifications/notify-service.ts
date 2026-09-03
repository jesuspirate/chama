// ══════════════════════════════════════════════════════════════════════════
// Notify service — side effects around the pure notification core (#88)
// ══════════════════════════════════════════════════════════════════════════
//
// Owns everything trade-notifications.ts deliberately doesn't: the on/off
// preference, the fire-once-ever dedup, the CONTEXTUAL permission ask (the
// first time a notification would actually fire), and the platform-aware
// delivery — Capacitor local-notifications on Android, the Tauri notification
// plugin on desktop, the Web Notification API in a browser. Every path is
// wrapped so a notification failure can NEVER break the trade flow.

import {
  notificationForTransition, chatNotificationFor,
  buyerInterestNotificationFor, newListingNotificationFor,
  tradeDmNotificationFor, dmViewerRole, pendingOnchainArbiterPubkey,
  type TradeNotification, type DmNotifyPref,
} from "./trade-notifications.js";
import { Role, EscrowStatus } from "../escrow-engine/types.js";
import { setPendingTradeDeepLink } from "./deep-link.js";
import { translate, getCurrentLang } from "../i18n/index.js";
import {
  getScopedStorageItem,
  getStrictScopedStorageItem,
  setScopedStorageItem,
  setStrictScopedStorageItem,
} from "../storage/user-scope.js";
import { getUserCommunitySlugRaw } from "../communities/storage.js";
import { getCommunityBySlug } from "../communities/registry.js";
import { listSavedIntents, savedIntentMatchesListing, type SavedIntent } from "../guided/saved-intents.js";
import type { EscrowState, ChatPayload, ParsedEscrowEvent } from "../escrow-engine/types.js";

export type { DmNotifyPref };

const ENABLED_KEY = "chama_notifications_enabled";
const DM_PREF_KEY = "chama_dm_notifications";
const FIRED_KEY = "chama_notifications_fired_v1";
/** Cap the persisted fired-tag set so it can't grow unbounded over a lifetime. */
const MAX_FIRED_TAGS = 500;
/** Session-only reservation while permission + OS scheduling are in flight.
 * Persisting before scheduling used to turn one denied/failed attempt into a
 * permanent false "already fired" result. */
const notificationInFlight = new Set<string>();

// ── Platform detection (inlined; keeps notifications decoupled from fedimint) ─

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

function platformName(): "capacitor" | "tauri" | "web" {
  return isCapacitorNative() ? "capacitor" : isTauriNative() ? "tauri" : "web";
}

// ── Diagnostics (opt-in; the silent-on-Tauri / resume-only debugging seam) ────
//
// Notification delivery is deliberately fire-and-forget and swallows every
// failure so a missed buzz can't break a trade. That makes "why didn't it
// fire?" un-diagnosable in the field — especially on Tauri/macOS, where the
// plugin reports permission `granted` unconditionally and the real notify-rust
// delivery is gated by the app's macOS identity (dev posts as "Terminal";
// an unsigned prod bundle is silently dropped). These logs convert "silent"
// into "diagnosable": permission result, platform, and whether the OS-level
// IPC actually resolved — so you can tell transition-didn't-fire vs.
// permission vs. IPC-error vs. OS-swallowed in one run.
//
// On in dev builds; opt-in on any build via localStorage chama_notify_debug=1
// (so a packaged Tauri/APK can be inspected without a dev rebuild).
const DEBUG_KEY = "chama_notify_debug";
/** Opt-in flag for the one-shot delivery self-test (notifySelfTest). Separate
 *  from DEBUG so dev builds don't buzz a test notification on every launch. */
const SELFTEST_KEY = "chama_notify_selftest";

function notifyDebugEnabled(): boolean {
  try {
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) return true;
  } catch { /* non-Vite host (test runner) — fall through */ }
  try {
    return globalThis.localStorage?.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Log a diagnostic line when notify-debug is on. Takes a thunk so the message
 *  is never built when disabled. Never throws. */
function notifyDebug(msg: () => string): void {
  if (!notifyDebugEnabled()) return;
  try { console.info(`[chama/notify] ${msg()}`); } catch { /* ignore */ }
}

// ── Preference (default ON — the OS permission is the real gate) ─────────────

export function notificationsEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* cosmetic preference; ignore storage failure */
  }
}

// ── DM / trade-chat preference (tri-state, default "auto" = role-on-trade) ────

export function dmNotifyPref(): DmNotifyPref {
  try {
    const v = globalThis.localStorage?.getItem(DM_PREF_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setDmNotifyPref(pref: DmNotifyPref): void {
  try {
    globalThis.localStorage?.setItem(DM_PREF_KEY, pref);
  } catch {
    /* cosmetic preference; ignore storage failure */
  }
}

// ── Counterparty DM alerts (#79, always-on by default; per-user mute) ────────
//
// When a party takes a trade-critical action, the acting client DMs the
// counterparty over Nostr so their external client (Damus/Amethyst — which have
// push) surfaces it, standing in for the web-push Chama can't do serverlessly.
// Default ENABLED; this is the mute switch. Plain boolean localStorage key.
const TRADE_DM_PREF_KEY = "chama_trade_dm_pref_v1";

/** True when counterparty trade DMs are enabled (default on). */
export function tradeDmPref(): boolean {
  try {
    return globalThis.localStorage?.getItem(TRADE_DM_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setTradeDmPref(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(TRADE_DM_PREF_KEY, on ? "1" : "0");
  } catch {
    /* cosmetic preference; ignore storage failure */
  }
}

// Persisted fire-once-per-(trade, transition) dedup so a reload / re-observe of
// the same transition never re-sends a DM. Separate from the OS-notification
// FIRED set — these are outbound network sends, not local buzzes.
const TRADE_DM_SENT_KEY = "chama_trade_dm_sent_v1";
const MAX_TRADE_DM_SENT = 500;
/** Session-only reservation. Persist only after relay publish succeeds, while
 * preventing rapid duplicate observations from publishing in parallel. */
const tradeDmInFlight = new Set<string>();

function readTradeDmSent(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(TRADE_DM_SENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : []);
  } catch {
    return new Set();
  }
}

function recordTradeDmSent(token: string): void {
  try {
    const tokens = readTradeDmSent();
    tokens.add(token);
    const trimmed = [...tokens].slice(-MAX_TRADE_DM_SENT);
    globalThis.localStorage?.setItem(TRADE_DM_SENT_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

// ── New-listing opt-in (user-scoped, default OFF, whole-community for now) ────
//
// Part ② of the liquidity pass: opt-in "buzz me when a fresh listing appears in
// my home chama." DECIDED whole-community (a single switch) for now, but the
// pref is modeled as a STRUCTURE so a future per-vertical version (CBP / Work /
// Chip In / Stack toggles) is a clean extension, NOT a schema break:
//   • `enabled` is the master on/off for this feature.
//   • `verticals` is "all" today; later it can hold a set of vertical ids and
//     `newListingEnabledForCategory` narrows to that set. Storing the discriminated
//     union now means flipping to per-vertical is a value change, not a migration.
// User-scoped (follows the npub), stored as JSON. Default OFF = explicit opt-in.
const NEW_LISTING_PREF_KEY = "chama_new_listing_notify";

export interface NewListingPref {
  enabled: boolean;
  /** "all" = every vertical (today's whole-community behavior). A string[] is
   *  the forward-compatible per-vertical selection (category ids). */
  verticals: "all" | string[];
}

const DEFAULT_NEW_LISTING_PREF: NewListingPref = { enabled: false, verticals: "all" };

export function newListingPref(): NewListingPref {
  try {
    const raw = getScopedStorageItem(NEW_LISTING_PREF_KEY);
    if (!raw) return DEFAULT_NEW_LISTING_PREF;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return DEFAULT_NEW_LISTING_PREF;
    const obj = parsed as Partial<NewListingPref>;
    const verticals = obj.verticals === "all" || Array.isArray(obj.verticals)
      ? obj.verticals
      : "all";
    return { enabled: obj.enabled === true, verticals };
  } catch {
    return DEFAULT_NEW_LISTING_PREF;
  }
}

export function setNewListingPref(pref: NewListingPref): void {
  try {
    setScopedStorageItem(NEW_LISTING_PREF_KEY, JSON.stringify(pref));
  } catch {
    /* cosmetic preference; ignore storage failure */
  }
}

/** True when new-listing notifications are on AND this listing's category is in
 *  scope. Today "all" ⇒ always in scope; the per-vertical set narrows later. */
export function newListingEnabledForCategory(category: string | null | undefined): boolean {
  const pref = newListingPref();
  if (!pref.enabled) return false;
  if (pref.verticals === "all") return true;
  return typeof category === "string" && pref.verticals.includes(category);
}

// ── Fire-once dedup (persisted, so a moment never re-buzzes across restarts) ──

function readFiredTags(): Set<string> {
  try {
    const raw = getStrictScopedStorageItem(FIRED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : []);
  } catch {
    return new Set();
  }
}

function recordFiredTag(tag: string): void {
  try {
    const tags = readFiredTags();
    tags.add(tag);
    // Keep only the most recent MAX_FIRED_TAGS (insertion order ≈ recency).
    const trimmed = [...tags].slice(-MAX_FIRED_TAGS);
    setStrictScopedStorageItem(FIRED_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

// ── Last-seen status (persisted, for cold-start catch-up) ────────────────────
//
// The transition core only buzzes on an OBSERVED prev→next change, and `prev`
// is the IN-MEMORY prior state. That's right for a live session and for a
// backgrounded-but-alive app (resume reconnects, prev is retained → the missed
// moment fires). But a KILLED app (GrapheneOS kills aggressively) cold-starts
// with an empty escrow map: the first observation has prev=undefined, so a
// transition that advanced while the app was dead is silently suppressed.
//
// Only trade *ids* are persisted (not state), so we keep a tiny per-trade
// last-seen status here. It lets us reconstruct the prior status when useful,
// but the orchestrator still requires a genuinely fresh committed event before
// producing an OS alert. A fresh install / wiped store has no record.
const SEEN_KEY = "chama_notif_seen_status_v1";
/** Cap the seen-status map so it can't grow unbounded over a lifetime. */
const MAX_SEEN_TRADES = 500;

function readSeenStatuses(): Record<string, string> {
  try {
    const raw = getStrictScopedStorageItem(SEEN_KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** The status this trade was last observed at in any prior session, or null. */
export function readSeenStatus(escrowId: string): string | null {
  const v = readSeenStatuses()[escrowId];
  return typeof v === "string" ? v : null;
}

/** Record the latest observed status for a trade. No-op when unchanged (avoids
 *  storage churn); trims to the most-recent MAX_SEEN_TRADES. Never throws. */
export function recordSeenStatus(escrowId: string, status: string): void {
  try {
    const all = readSeenStatuses();
    if (all[escrowId] === status) return;
    delete all[escrowId];       // re-insert at the end so key order ≈ recency
    all[escrowId] = status;
    const keys = Object.keys(all);
    let next = all;
    if (keys.length > MAX_SEEN_TRADES) {
      next = {};
      for (const k of keys.slice(-MAX_SEEN_TRADES)) next[k] = all[k];
    }
    setStrictScopedStorageItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* diagnostic baseline only; ignore storage failure */
  }
}

/**
 * Pick the `prev` to compare a transition against — pure, so the cold-start
 * catch-up rule is exhaustively testable. A live in-memory `prev` always wins.
 * Otherwise, if a prior session recorded an EARLIER status for this trade,
 * synthesize a prev pinned at that status so the status delta is detectable.
 * Notification delivery independently applies its live-session freshness gate;
 * this reconstruction alone is never permission to buzz. No prior record
 * (fresh install / never seen) returns undefined.
 *
 * Note: vote-based transitions (a dispute opening) can't be reconstructed from
 * a status alone, so a dispute that opened while the app was dead won't buzz on
 * cold start — the arbiter still sees it in-app.
 */
export function catchUpPrev(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  seenStatus: string | null | undefined,
): EscrowState | null | undefined {
  if (prev) return prev;
  if (seenStatus && seenStatus !== next.status) {
    return { ...next, status: seenStatus as EscrowState["status"] };
  }
  return undefined;
}

/** Latest committed moment represented by this replayed state. Initial relay
 * hydration can replace a plaintext CREATE shell with a much newer terminal
 * state during the same render session; its historical timestamps distinguish
 * that reconstruction from activity that actually happened after login. */
export function latestNotificationActivityAt(state: EscrowState): number {
  const moments = [
    state.createdAt,
    state.lock?.lockedAt ?? 0,
    state.resolvedAt ?? 0,
    state.completedAt ?? 0,
    state.cancelledAt ?? 0,
    ...(state.eventChain ?? []).map(event => event.timestamp),
    ...Object.values(state.joinHolds ?? {}).map(hold => hold?.joinedAt ?? 0),
  ];
  if (state.status === EscrowStatus.EXPIRED) moments.push(state.expiresAt);
  return Math.max(0, ...moments.filter(value => Number.isFinite(value)));
}

export function isFreshNotificationActivity(state: EscrowState, liveSinceSec: number): boolean {
  return latestNotificationActivityAt(state) >= liveSinceSec;
}

// ── Permission ───────────────────────────────────────────────────────────────

/** Request/confirm OS notification permission for the current platform.
 *  Returns true only when delivery is actually allowed. Never throws. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (isCapacitorNative()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const status = await LocalNotifications.checkPermissions();
      if (status.display === "granted") return true;
      const req = await LocalNotifications.requestPermissions();
      return req.display === "granted";
    }
    if (isTauriNative()) {
      const mod = await import("@tauri-apps/plugin-notification");
      if (await mod.isPermissionGranted()) return true;
      return (await mod.requestPermission()) === "granted";
    }
    // Web
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") return true;
      if (Notification.permission === "denied") return false;
      return (await Notification.requestPermission()) === "granted";
    }
  } catch {
    return false;
  }
  return false;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliver(n: TradeNotification): Promise<boolean> {
  notifyDebug(() => `deliver tag=${n.tag} platform=${platformName()}`);
  try {
    if (isCapacitorNative()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      // Android freezes a channel's importance after first creation. The old
      // implicit `default` channel was DEFAULT importance: it made a sound and
      // entered the shade, but did not reliably show a heads-up card. Use a
      // versioned HIGH channel so trade moments are visible as well as audible.
      // createChannel is Android-only; Capacitor treats it as a harmless no-op
      // on native platforms that do not expose notification channels.
      const tradeChannelId = "trade-updates-v1";
      let tradeChannelReady = false;
      try {
        await LocalNotifications.createChannel({
          id: tradeChannelId,
          name: "Trade updates",
          description: "Buyer interest, locked trades, claims, and completion",
          importance: 4,
        });
        tradeChannelReady = true;
      } catch {
        // Scheduling without the explicit channel is still better than losing
        // the notification on an unusual/older native implementation.
      }
      await LocalNotifications.schedule({
        notifications: [{
          // A stable small int id from the tag so re-fires would coalesce.
          id: (hashTag(n.tag) % 2_000_000_000) + 1,
          title: n.title,
          body: n.body,
          ...(tradeChannelReady ? { channelId: tradeChannelId } : {}),
          extra: { escrowId: n.escrowId },
        }],
      });
      notifyDebug(() => `capacitor scheduled tag=${n.tag}`);
      return true;
    }
    if (isTauriNative()) {
      // `extra` rides the notification so onAction (deep-link.ts) can route the
      // tap to this trade on desktop. NOTE: `extra` IS a valid field in
      // plugin-notification 2.x (NotificationData.extra) — it is accepted, not
      // the cause of any silence.
      //
      // We post via the plugin's own IPC command rather than its void
      // `sendNotification` so we can AWAIT the result and surface a
      // capability/registration/serialize failure (otherwise swallowed). A
      // resolved IPC with no visible buzz on macOS means the gate is the OS
      // layer (dev → "Terminal"; unsigned prod → dropped), NOT the app.
      const opts = { title: n.title, body: n.body, extra: { escrowId: n.escrowId } };
      const internals = (globalThis as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      try {
        if (internals?.invoke) {
          await internals.invoke("plugin:notification|notify", { options: opts });
        } else {
          // Older/global-less context: fall back to the public (void) API.
          const mod = await import("@tauri-apps/plugin-notification");
          mod.sendNotification(opts);
        }
        notifyDebug(() => `tauri notify IPC ok tag=${n.tag} — if no buzz appears, it's the macOS app identity/signing layer (dev posts as "Terminal"), not the app`);
      } catch (e) {
        console.warn("[chama/notify] tauri notify IPC failed", e);
      }
      return true;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      // Android Chrome/PWA requires service-worker delivery. Prefer it on every
      // browser so foreground and background delivery share one tap route.
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(n.title, {
          body: n.body,
          tag: n.tag,
          icon: "/icons/android-chrome-192x192.png",
          badge: "/icons/favicon-96x96.png",
          data: { escrowId: n.escrowId },
        });
        return true;
      }
      // Desktop browsers without service workers retain the page constructor.
      const notif = new Notification(n.title, { body: n.body, tag: n.tag });
      // Tap → focus the tab and open this trade. escrowId rides the closure (the
      // web Notification API carries no custom payload).
      notif.onclick = () => {
        try { globalThis.focus?.(); } catch { /* ignore */ }
        setPendingTradeDeepLink(n.escrowId);
        try { notif.close(); } catch { /* ignore */ }
      };
      return true;
    }
  } catch {
    /* a failed buzz must never surface to the user mid-trade */
  }
  return false;
}

/** Deliver a fire-once notification, but only persist the dedupe token after
 * the platform has actually accepted it. Permission denial and OS/plugin
 * scheduling failures stay retryable on a later observation. */
function deliverOnce(n: TradeNotification, context: string): void {
  if (readFiredTags().has(n.tag) || notificationInFlight.has(n.tag)) return;
  notificationInFlight.add(n.tag);
  void (async () => {
    try {
      const allowed = await ensureNotificationPermission();
      notifyDebug(() => `fire ${context} tag=${n.tag} platform=${platformName()} permission=${allowed}`);
      if (allowed && await deliver(n)) recordFiredTag(n.tag);
    } finally {
      notificationInFlight.delete(n.tag);
    }
  })();
}

function hashTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Orchestrator — call from updateEscrow on every observed transition ───────

/**
 * Fire a notification if this prev→next transition warrants one, the user has
 * notifications enabled, it hasn't fired before, and OS permission is granted.
 * Contextual permission: the FIRST time a notification would fire, we ask — and
 * deliver it if granted. Fully fire-and-forget; never throws.
 */
export function maybeNotifyTransition(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  liveSinceSec = Number.POSITIVE_INFINITY,
): void {
  // Record the observed status FIRST — independent of the enable toggle and of
  // whether anything buzzes — so subsequent observations have a scoped status
  // baseline. Capture the prior record BEFORE overwriting it.
  const seenBefore = readSeenStatus(next.id);
  recordSeenStatus(next.id, next.status);

  if (!notificationsEnabled()) return;

  // Never turn login hydration into a burst of historical alerts. The relay
  // may first expose CREATE and then replay an old LOCK/RESOLVE/COMPLETE into
  // the same in-memory slot; only a committed moment from this live session is
  // notification-worthy. Closed-app wake-ups are owned by the VPS path.
  if (Number.isFinite(liveSinceSec) && !isFreshNotificationActivity(next, liveSinceSec)) return;

  // Reconstruct the prior status when the in-memory state is absent. This may
  // describe a transition, but only the freshness gate above authorizes a buzz.
  const effectivePrev = catchUpPrev(prev, next, seenBefore);
  const coldCatchup = !prev && effectivePrev !== undefined;

  const n = notificationForTransition(effectivePrev, next, userPubkey, liveSinceSec);
  if (!n) return;
  if (readFiredTags().has(n.tag)) {
    notifyDebug(() => `skip (already fired) tag=${n.tag}`);
    return;
  }
  deliverOnce(n, `transition coldCatchup=${coldCatchup}`);
}

/**
 * Fire an OS notification for an inbound trade-chat `message`, honoring the
 * master toggle and the tri-state DM preference. The pure decision (own-echo,
 * role default, backlog guard, copy) lives in chatNotificationFor; this owns
 * only the side effects — master gate, contextual permission, delivery.
 * Deliberately NOT wired to the fire-once-ever dedup: chat recurs, so each fresh
 * message may buzz. `liveSinceSec` is when this session went live (backlog
 * guard). Fully fire-and-forget; never throws.
 */
export function maybeNotifyChatMessage(
  state: EscrowState,
  message: ParsedEscrowEvent<ChatPayload>,
  userPubkey: string | null | undefined,
  liveSinceSec: number,
): void {
  if (!notificationsEnabled()) return; // the master mute silences DMs too
  const n = chatNotificationFor(state, message, userPubkey, dmNotifyPref(), liveSinceSec);
  if (!n) return;
  void (async () => {
    const allowed = await ensureNotificationPermission();
    notifyDebug(() => `fire chat tag=${n.tag} platform=${platformName()} permission=${allowed}`);
    if (allowed) await deliver(n);
  })();
}

/**
 * Buzz the SELLER the moment a buyer shows interest in one of their listings
 * (a fresh child order pre-lock, or a JOIN hold on their own listing) so they're
 * pulled back before the buyer gives up. Honors the master toggle; deduped
 * fire-once-per-(listing,buyer) via the shared fired-tag set (mirrors the
 * transition core). `liveSinceSec` is when this session went live (backlog
 * guard). Fully fire-and-forget; never throws.
 */
export function maybeNotifyBuyerInterest(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  liveSinceSec: number,
): void {
  if (!notificationsEnabled()) return;
  const n = buyerInterestNotificationFor(prev, next, userPubkey, liveSinceSec);
  if (!n) return;
  deliverOnce(n, "buyer-interest");
}

/**
 * Buzz an OPTED-IN user when a fresh listing appears in their HOME chama (that
 * isn't theirs). Gated by the master toggle + the new-listing opt-in (default
 * OFF) + the listing's category being in scope. Home community + friendly label
 * are resolved here so the pure decider stays registry-free. Deduped
 * fire-once-per-listing. `liveSinceSec` is the backlog guard. Fire-and-forget.
 */
export function maybeNotifyNewListing(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  liveSinceSec: number,
): void {
  if (!notificationsEnabled()) return;
  if (!newListingEnabledForCategory(next.category)) return;
  const home = getUserCommunitySlugRaw(); // null ⇒ no explicit home ⇒ decider bails
  const label = (home && getCommunityBySlug(home)?.displayName) || home || "";
  const n = newListingNotificationFor(prev, next, userPubkey, home, label, liveSinceSec);
  if (!n) return;
  deliverOnce(n, "new-listing");
}

// ── S4.2 — saved-intent match alerts ─────────────────────────────────────────
// When a NEWLY published listing matches what a canvas user asked to be notified
// about ("notify me when one appears"), fire a targeted alert. Mirrors the
// new-listing guards (brand-new sighting, open, backlog-guarded) and reuses the
// guided matchers so "compatible" means exactly what it means in the canvas.
// The VPS community wake (watcher) is what brings a CLOSED device online to run
// this; warm/foreground it fires straight off the live subscription.

function savedIntentBody(intent: SavedIntent): string {
  if (intent.bring === "sats" && intent.want === "goods") {
    return intent.query
      ? translate(getCurrentLang(), "notify.savedIntentGoodsBody", { query: intent.query })
      : translate(getCurrentLang(), "notify.savedIntentGoodsBodyGeneric");
  }
  return translate(getCurrentLang(), "notify.savedIntentSatsBody");
}

export function maybeNotifySavedIntentMatch(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  liveSinceSec: number,
): void {
  if (!notificationsEnabled()) return;
  if (!userPubkey) return;
  if (prev) return;                              // only a brand-new sighting
  if (next.status !== EscrowStatus.CREATED) return;
  if (next.parent !== undefined) return;         // child orders aren't listings
  if (next.createdAt < liveSinceSec) return;     // backlog guard (no cold-start spam)
  let intents: SavedIntent[];
  try { intents = listSavedIntents(userPubkey); } catch { return; }
  if (intents.length === 0) return;
  for (const intent of intents) {
    if (intent.community && next.community && intent.community !== next.community) continue;
    if (next.createdAt < intent.createdAt) continue; // only offers that appeared AFTER you asked
    if (!savedIntentMatchesListing(intent, next, userPubkey)) continue;
    deliverOnce({
      escrowId: next.id,
      title: translate(getCurrentLang(), "notify.savedIntentTitle"),
      body: savedIntentBody(intent),
      tag: `saved-intent:${intent.id}:${next.id}`,
    }, "saved-intent");
    return;                                        // one alert per new listing
  }
}

/**
 * #79 — send trade-critical DMs to the counterparty over Nostr, so their
 * external client alerts them like an email. Called from updateEscrow on every
 * observed transition. Gated by the `tradeDmPref` mute, deduped per
 * (trade, transition), and — per the decider's single-`sender` rule — sent ONLY
 * by the party that caused the transition, so exactly one DM goes out network-
 * wide. The caller supplies `send` (bound to the escrow client's DM path) and is
 * responsible for the sim/testnet no-op gate. Fully fire-and-forget; never throws.
 */
export async function maybeSendTradeDms(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
  send: (recipientPubkey: string, message: string) => Promise<boolean>,
): Promise<void> {
  if (!tradeDmPref()) return;
  if (!userPubkey) return;
  try {
    const myRole = dmViewerRole(next, userPubkey);
    if (!myRole) return; // not a party to this trade
    const dm = tradeDmNotificationFor(prev, next, myRole);
    if (!dm) return;
    if (myRole !== dm.sender) return; // only the acting party sends (single-sender rule)
    if (readTradeDmSent().has(dm.transition)) return;
    if (tradeDmInFlight.has(dm.transition)) return;
    tradeDmInFlight.add(dm.transition);

    const pubkeyForRole = (role: Role): string | null => {
      if (role === Role.ARBITER) {
        return next.participants[Role.ARBITER]
          ?? next.actingArbiter
          ?? pendingOnchainArbiterPubkey(next);
      }
      return next.participants[role] ?? null;
    };
    let attempted = 0;
    let allSent = true;
    try {
      for (const role of dm.recipients) {
        const pk = pubkeyForRole(role);
        // Never DM yourself; skip unresolved roles.
        if (!pk || pk.toLowerCase() === userPubkey.toLowerCase()) continue;
        attempted += 1;
        if (!(await send(pk, dm.message))) allSent = false;
      }
      // A failed/unsupported publish stays retryable on the next observation.
      if (attempted > 0 && allSent) recordTradeDmSent(dm.transition);
    } finally {
      tradeDmInFlight.delete(dm.transition);
    }
  } catch {
    /* a DM must never break the trade flow */
  }
}

// ── Delivery self-test (opt-in; the on-device "is the OS layer alive?" probe) ─

/**
 * Fire ONE known-good notification through the real platform delivery path and
 * log each step. No-op unless localStorage chama_notify_selftest=1 — gated
 * separately from notify-debug so dev builds don't buzz on every launch. Call
 * once at startup: on Tauri/APK the visible buzz (or its absence + the logs)
 * tells you whether the OS layer delivers at all on this build, independent of
 * any trade transition firing. Fully fire-and-forget; never throws.
 */
export async function notifySelfTest(): Promise<void> {
  try {
    if (globalThis.localStorage?.getItem(SELFTEST_KEY) !== "1") return;
  } catch {
    return;
  }
  await sendNotificationSelfTest();
}

/** User-triggered end-to-end permission + delivery test. */
export async function sendNotificationSelfTest(): Promise<boolean> {
  const n: TradeNotification = {
    escrowId: "sm_selftest",
    title: translate(getCurrentLang(), "notify.selfTestTitle"),
    body: translate(getCurrentLang(), "notify.selfTestBody"),
    tag: "selftest",
  };
  notifyDebug(() => `self-test start platform=${platformName()}`);
  const allowed = await ensureNotificationPermission();
  notifyDebug(() => `self-test permission=${allowed} platform=${platformName()}`);
  const delivered = allowed ? await deliver(n) : false;
  notifyDebug(() => `self-test done allowed=${allowed} — no buzz on Tauri/macOS ⇒ dev posts as "Terminal" / unsigned prod is dropped (not an app bug)`);
  return delivered;
}
