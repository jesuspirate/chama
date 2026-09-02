// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Relay Manager
// ══════════════════════════════════════════════════════════════════════════
//
// Manages WebSocket connections to multiple Nostr relays.
// Publishes events with redundancy, subscribes to escrow event chains,
// and provides real-time state updates.
//
// Design principles:
//   1. Multi-relay redundancy — publish to all, consider success if ≥1 accepts
//   2. Automatic reconnection with exponential backoff
//   3. Subscription deduplication — same event from 3 relays = 1 callback
//   4. Clean shutdown — close all connections gracefully

import { type NostrEvent, EscrowEventKind, TAGS } from "./types.js";
import { type FetchProbe } from "./discovery-diagnostics.js";

// SECURITY: per-event content size cap. NIP-01 does not enforce a cap, so
// a malicious relay can craft an EVENT message whose `content` is many
// MB, and force the client into a slow JSON.parse or decrypt. 128 KiB is
// generous for legitimate escrow events (LOCK with SSS shares is well
// under 10 KiB; CHAT image attachments are inlined base64 but capped
// elsewhere).
const MAX_EVENT_CONTENT_BYTES = 128 * 1024;

// SECURITY / AVAILABILITY: cap the raw WebSocket frame BEFORE JSON.parse.
// The event-content check below is intentionally retained as a second layer,
// but it cannot protect the parser itself: a hostile or broken relay can send
// one enormous JSON frame and pin WebKit's main thread in JSON.parse while the
// compositor keeps scrolling. 256 KiB leaves generous envelope/tag overhead
// above MAX_EVENT_CONTENT_BYTES without permitting multi-megabyte frames.
const MAX_RELAY_FRAME_UNITS = 256 * 1024;

// ── Relay connection states ───────────────────────────────────────────────

export enum RelayStatus {
  CONNECTING = "connecting",
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  ERROR = "error",
}

// ── Subscription filter (subset of NIP-01 filter) ─────────────────────────

export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  "#d"?: string[];
  "#p"?: string[];
  /** #7 multi-unit storefront: child purchase CREATEs carry their parent
   *  listing's id as a `parent` tag, so a `#parent` filter fans out one REQ
   *  to fetch all of a listing's children for derived stock counting. */
  "#parent"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/** Per-read startup policy. Full escrow/history reads retain the default
 * quorum wait; small public hints may first ask whichever relay is already
 * open, then deliberately fall back to the normal quorum path themselves. */
export interface OnceFetchOptions {
  quorumBudgetMs?: number;
}

// ── Relay events ──────────────────────────────────────────────────────────

export interface RelayCallbacks {
  onEvent?: (event: NostrEvent, relayUrl: string) => void;
  onEose?: (subscriptionId: string, relayUrl: string) => void;
  onOk?: (eventId: string, accepted: boolean, message: string, relayUrl: string) => void;
  onError?: (error: Error, relayUrl: string) => void;
  onStatusChange?: (relayUrl: string, status: RelayStatus) => void;
  /**
   * v0.4.2 sim mode (hotfix round 2): chokepoint drop predicate. If
   * returns true, the relay-manager skips ALL downstream dispatch
   * for this event — onEvent callback, pending-fetch routing,
   * fetchOnce capture, dedup. The escrow client sets this to
   * shouldDropForSimPolicy so a sim-tagged event never enters the
   * prod browser's state via any path (handleIncomingEvent,
   * loadEscrow→fetchEscrowEvents, fetchOnce). Without this, the
   * handleIncomingEvent filter alone misses the fetch-based paths.
   */
  shouldDropEvent?: (event: NostrEvent) => boolean;
  /**
   * SECURITY: signature verification predicate. When provided, every
   * EVENT message received from a relay is passed through this function
   * before it reaches any dispatch path (live onEvent, pending fetches,
   * fetchOnce capture). If it returns false, the event is dropped.
   *
   * Relays are UNTRUSTED — they can forge any pubkey, kind, and content
   * if the client does not check the schnorr signature locally. The
   * escrow client wires this to nostr-tools' `verifyEvent`. Tests that
   * use synthetic events with fake signatures simply omit this callback
   * and continue to receive every event.
   */
  verifyEvent?: (event: NostrEvent) => boolean;
}

// ── Single relay connection ───────────────────────────────────────────────

interface RelayConnection {
  url: string;
  ws: WebSocket | null;
  status: RelayStatus;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  subscriptions: Map<string, NostrFilter>;
  /** Session-local circuit breaker for a relay that violates the raw-frame
   *  limit. Reconnect explicitly clears it; automatic backoff does not. */
  quarantined: boolean;
}

interface PendingOnceFetch {
  events: NostrEvent[];
  seenIds: Set<string>;
  eoseCount: number;
  connectedCount: number;
  resolve: (events: NostrEvent[]) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** EOSE-quorum grace timer (round 3b step 2): set once a quorum of relays
   *  have EOSE'd but not all; resolves the fetch after EOSE_GRACE_MS so one
   *  hung relay can't pin it to the full timeout. */
  graceTimer?: ReturnType<typeof setTimeout> | null;
  /** Optional observational diagnostics. Set only by discovery + the `#d`
   *  transport control; absent for seed-recovery / Browse fetches. Purely
   *  read — never gates or alters the fetch. */
  probe?: FetchProbe;
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_RETRY_COUNT = 8;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 8_000;
const PUBLISH_CONNECT_WAIT_MS = 8_000;
const PUBLISH_CONNECT_POLL_MS = 250;
const PREFERRED_RELAY_URL = "wss://relay.chama.community";
const PREFERRED_RELAY_ACK_GRACE_MS = 1_500;
// Webview-safe fetch quorum. A one-shot REQ must not resolve against a single
// fast relay while the rest are still handshaking — iOS in-app browser / Fedi
// webview bring sockets up slowly and staggered, so a fetch that fired with
// 1 relay connected EOSEs partial and misses the resolve/complete tail (the
// "stuck ESCROW" + oscillating My-Trades symptom). Wait for a QUORUM of relays
// — or a bounded budget — before issuing REQs. On desktop the quorum is already
// met when a fetch runs, so waitForRelayQuorum returns immediately (no penalty).
const FETCH_QUORUM = 3;
const FETCH_QUORUM_BUDGET_MS = 5_000;
const FETCH_QUORUM_POLL_MS = 200;
// EOSE resolution quorum (Fedi round 3b, step 2). A fetch normally resolves
// only when EVERY connected relay sends EOSE. But a relay that completes the
// WS handshake then never answers (field: relay.primal.net — conn:Y req:Y
// eose:n) would otherwise pin the fetch to its FULL timeout (8s discovery /
// 15s chain), stalling every read and the parallel My-Trades heal. So once a
// QUORUM of connected relays have EOSE'd, start a short grace for any near-
// simultaneous straggler, then resolve with what's in. This NEVER fires when
// all relays answer (the all-EOSE fast path resolves first, cancelling grace),
// so a healthy fetch pays zero penalty. And a quorum-EOSE resolution is
// strictly MORE complete than the timeout fallback it replaces (≥quorum relays
// confirmed exhausted + every event received so far), so it cannot reintroduce
// the round-2 partial-fetch bug — it only stops waiting on a dead socket. The
// connection quorum above (wait before REQ) is unchanged.
//
// The quorum itself is now adaptive (see effectiveQuorum()): min(FETCH_QUORUM,
// relayCount-1), so a small/degraded pool still resolves instead of stalling.
const EOSE_GRACE_MS = 1_000;
const HEAVY_CURSOR_EVENT_BYTES = 8 * 1024;

// Preferred-relay durability queue. `publish` resolves on the FIRST accept
// from ANY relay — good for latency, but it means an event published while
// Chama's own relay was mid-reconnect (or briefly rejecting) lands ONLY on a
// public relay, with nothing ever re-offering it. Public relays prune; the
// Chama relay doesn't. That is the shape of the observed damage: chains on
// relay.chama.community missing exactly one kind (both VOTEs, or the CREATE,
// or the LOCK) while the rest of the chain is intact — the pieces published
// during a gap. So: anything the preferred relay did not accept is queued and
// re-offered the moment it reconnects.
const PREFERRED_REPUBLISH_MAX = 200;
const PREFERRED_REPUBLISH_TTL_MS = 24 * 60 * 60 * 1000;
const PREFERRED_REPUBLISH_FAILURE_STREAK = 3;

// ══════════════════════════════════════════════════════════════════════════
// RELAY MANAGER
// ══════════════════════════════════════════════════════════════════════════

export class RelayManager {
  private relays: Map<string, RelayConnection> = new Map();
  private callbacks: RelayCallbacks;
  private seenEventIds: Set<string> = new Set();
  private subscriptionCounter = 0;
  private WebSocketImpl: typeof WebSocket;
  private stopped = false;

  constructor(
    relayUrls: string[],
    callbacks: RelayCallbacks = {},
    wsImpl?: typeof WebSocket
  ) {
    this.callbacks = callbacks;
    // Allow injecting WebSocket for Node.js (ws package) or testing
    this.WebSocketImpl = wsImpl || (typeof WebSocket !== "undefined" ? WebSocket : undefined as any);

    for (const url of relayUrls) {
      this.relays.set(url, {
        url,
        ws: null,
        status: RelayStatus.DISCONNECTED,
        retryCount: 0,
        retryTimer: null,
        subscriptions: new Map(),
        quarantined: false,
      });
    }
  }

  // ── Connect to all relays ───────────────────────────────────────────────

  connect(): void {
    this.stopped = false;
    for (const [url] of this.relays) {
      this.connectRelay(url);
    }
  }

  private connectRelay(url: string): void {
    if (this.stopped) return;
    const relay = this.relays.get(url);
    if (!relay) return;
    if (relay.quarantined) return;
    if (relay.status === RelayStatus.CONNECTING || relay.status === RelayStatus.CONNECTED) return;

    relay.status = RelayStatus.CONNECTING;
    this.callbacks.onStatusChange?.(url, RelayStatus.CONNECTING);

    try {
      const ws = new this.WebSocketImpl(url);
      relay.ws = ws;

      ws.onopen = () => {
        relay.status = RelayStatus.CONNECTED;
        relay.retryCount = 0;
        this.callbacks.onStatusChange?.(url, RelayStatus.CONNECTED);

        // Resubscribe all active subscriptions
        for (const [subId, filter] of relay.subscriptions) {
          this.sendToRelay(relay, ["REQ", subId, filter]);
        }

        // Chama's relay is back: re-offer anything it missed while it was
        // away (see PREFERRED_REPUBLISH_MAX). Fire-and-forget — a publish
        // path must never gate on it.
        if (url === PREFERRED_RELAY_URL) {
          void this.flushPreferredRepublishQueue().catch(() => {});
        }
      };

      ws.onmessage = (msg: MessageEvent) => {
        try {
          const raw = this.readBoundedRelayFrame(msg.data);
          if (raw === null) {
            this.quarantineRelay(relay);
            return;
          }
          const data = JSON.parse(raw);
          this.handleRelayMessage(url, data);
        } catch (e) {
          // Ignore unparseable messages
        }
      };

      ws.onerror = () => {
        relay.status = RelayStatus.ERROR;
        this.callbacks.onError?.(new Error(`WebSocket error on ${url}`), url);
        this.callbacks.onStatusChange?.(url, RelayStatus.ERROR);
        // A WebSocket `error` does NOT guarantee a following `close` in every
        // runtime, so relying on onclose alone (below) can leave an errored
        // relay stuck in ERROR forever — it never re-enters the backoff loop.
        // Schedule the reconnect here too; scheduleReconnect dedupes against an
        // already-pending retryTimer, so an error+close pair won't double-arm.
        if (!this.stopped) this.scheduleReconnect(url);
      };

      ws.onclose = () => {
        relay.ws = null;
        // quarantineRelay already published the ERROR state and intentionally
        // suppresses automatic backoff. Do not immediately overwrite that
        // useful diagnosis with DISCONNECTED when close(1009) completes.
        if (relay.quarantined) return;
        relay.status = RelayStatus.DISCONNECTED;
        this.callbacks.onStatusChange?.(url, RelayStatus.DISCONNECTED);
        if (this.stopped) return;
        this.scheduleReconnect(url);
      };
    } catch (e) {
      relay.status = RelayStatus.ERROR;
      this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)), url);
      this.scheduleReconnect(url);
    }
  }

  /** Decode a relay frame only when its cheap, allocation-free size check is
   *  inside the parser budget. Nostr relays send text frames in browsers;
   *  ArrayBuffer support keeps injected/test WebSockets compatible. Unknown
   *  binary containers are rejected rather than copied speculatively. */
  private readBoundedRelayFrame(frame: unknown): string | null {
    if (typeof frame === "string") {
      return frame.length <= MAX_RELAY_FRAME_UNITS ? frame : null;
    }
    if (frame instanceof ArrayBuffer) {
      if (frame.byteLength > MAX_RELAY_FRAME_UNITS) return null;
      return new TextDecoder().decode(frame);
    }
    if (ArrayBuffer.isView(frame)) {
      if (frame.byteLength > MAX_RELAY_FRAME_UNITS) return null;
      return new TextDecoder().decode(
        new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
      );
    }
    return null;
  }

  /** Stop an oversized-frame source for the rest of the session. Merely
   *  dropping one frame is insufficient: a flooding relay would continue to
   *  starve the UI, and normal onclose backoff would reconnect into the same
   *  loop. The user's explicit Reconnect action gets one clean retry. */
  private quarantineRelay(relay: RelayConnection): void {
    if (relay.quarantined) return;
    relay.quarantined = true;
    relay.status = RelayStatus.ERROR;
    this.callbacks.onError?.(
      new Error(`Relay ${relay.url} sent an oversized or unsupported frame and was disconnected`),
      relay.url,
    );
    this.callbacks.onStatusChange?.(relay.url, RelayStatus.ERROR);
    console.warn(
      `[relay] ${relay.url} exceeded the ${MAX_RELAY_FRAME_UNITS}-unit raw frame limit; quarantining for this session`,
    );
    const ws = relay.ws;
    relay.ws = null;
    try { ws?.close(1009, "Relay frame too large"); } catch {}
  }

  // ── Reconnection with exponential backoff ───────────────────────────────

  private scheduleReconnect(url: string): void {
    if (this.stopped) return;
    const relay = this.relays.get(url);
    if (!relay || relay.quarantined || relay.retryCount >= MAX_RETRY_COUNT) return;
    // Idempotent: a single failure can fire both onerror and onclose, and both
    // call here. With a retry already pending, a second call would double-
    // increment retryCount (skewing the backoff) and leak a timer. At most one
    // retry is ever in flight, so bail if one is already armed.
    if (relay.retryTimer) return;

    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, relay.retryCount), MAX_RETRY_MS);
    relay.retryCount++;

    relay.retryTimer = setTimeout(() => {
      relay.retryTimer = null;
      this.connectRelay(url);
    }, delay);
  }

  /**
   * Force an immediate re-probe of every non-connected relay, clearing the
   * exponential-backoff give-up state. The per-relay backoff caps out at
   * MAX_RETRY_COUNT and then abandons a relay for the rest of the session
   * (retryCount only resets on a successful onopen) — so a relay that was down
   * through ~MAX_RETRY_COUNT cycles never comes back on its own, even once it
   * recovers. This is the explicit recovery lever behind the in-app
   * "Reconnect" control: reset retryCount + cancel any pending timer and
   * reconnect now. No-op after disconnect() (respects `stopped`). Connected
   * relays are left untouched.
   */
  forceReconnectAll(): void {
    if (this.stopped) return;
    for (const [url, relay] of this.relays) {
      if (relay.status === RelayStatus.CONNECTED) continue;
      if (relay.retryTimer) {
        clearTimeout(relay.retryTimer);
        relay.retryTimer = null;
      }
      relay.retryCount = 0;
      relay.quarantined = false;
      this.connectRelay(url);
    }
  }

  // ── Handle incoming relay messages ──────────────────────────────────────

  private handleRelayMessage(relayUrl: string, data: unknown[]): void {
    if (!Array.isArray(data) || data.length < 2) return;

    const [type] = data;

    switch (type) {
      case "EVENT": {
        // ["EVENT", subscription_id, event]
        if (data.length < 3) return;
        const subId = data[1] as string;
        const event = data[2] as NostrEvent;
        if (!event?.id) return;

        // SECURITY: drop oversized events before any work. A relay sending
        // a multi-MB `content` would otherwise force the client into a
        // slow JSON.parse or NIP-44 decrypt and degrade UI responsiveness.
        if (
          typeof event.content === "string" &&
          event.content.length > MAX_EVENT_CONTENT_BYTES
        ) {
          console.warn(
            `[relay] ${relayUrl} sent oversized event ${event.id?.slice(0, 8)} ` +
              `(${event.content.length} bytes > ${MAX_EVENT_CONTENT_BYTES}); dropping`,
          );
          break;
        }

        // SECURITY: verify the schnorr signature locally before any
        // dispatch. Without this, a malicious relay can inject events
        // claiming any pubkey, forging votes / claims / cancels from
        // people who never signed them. Verification is sync (noble
        // schnorr) so this stays a cheap pre-filter.
        if (this.callbacks.verifyEvent) {
          let valid = false;
          try {
            valid = this.callbacks.verifyEvent(event);
          } catch {
            valid = false;
          }
          if (!valid) {
            console.warn(
              `[relay] ${relayUrl} sent event ${event.id?.slice(0, 8)} ` +
                `with invalid signature; dropping`,
            );
            break;
          }
        }

        // v0.4.2 sim-mode chokepoint drop (hotfix round 2). Applied
        // before ALL dispatch paths (pending fetches, fetchOnce
        // intercept, onEvent callback) so a sim-tagged event in a
        // prod client — or a prod event in a sim client — never
        // enters local state via any path. The handleIncomingEvent
        // filter alone wasn't enough: fetchEscrowEvents / fetchOnce
        // route raw events directly to their callers, bypassing it.
        if (this.callbacks.shouldDropEvent?.(event)) return;

        // Advance only THIS relay's copy of the subscription cursor. Filters
        // are intentionally cloned per relay (see subscribe/fetch below), so a
        // fast relay cannot move a slower relay past history it has not yet
        // delivered. Reconnect then resumes with a tiny inclusive overlap
        // instead of replaying the entire chat-bearing trade history.
        const relayFilter = this.relays.get(relayUrl)?.subscriptions.get(subId);
        if (relayFilter && Number.isFinite(event.created_at)) {
          const nextSince =
            event.kind === EscrowEventKind.CHAT ||
            event.content.length > HEAVY_CURSOR_EVENT_BYTES
              ? event.created_at + 1
              : Math.max(0, event.created_at - 2);
          relayFilter.since = Math.max(relayFilter.since ?? 0, nextSince);
        }

        // Route arbitrary one-shot fetches by their exact temporary
        // subscription ID. This must happen before global live-event dedup,
        // otherwise a live Browse/watch subscription can contaminate seed
        // recovery and other queryOnce callers with unrelated events.
        const onceFetch = this._pendingOnceFetches.get(subId);
        if (onceFetch) {
          // Count the frame per relay BEFORE dedup so a relay that lost the
          // dedup race to another still registers as "delivering frames"
          // (transport works) in the diagnostic.
          onceFetch.probe?.noteEvent(relayUrl);
          if (!onceFetch.seenIds.has(event.id)) {
            onceFetch.seenIds.add(event.id);
            onceFetch.events.push(event);
          }
        }

        // Route to pending fetch subscriptions FIRST (before global dedup)
        // Match by escrow ID from the event's d-tag, NOT by subscription ID.
        // Relays may tag events with the watch subscription ID instead of
        // the fetch subscription ID when both match the same filter.
        if (this._pendingFetches && this._pendingFetches.size > 0) {
          const dTag = event.tags?.find((t: string[]) => t[0] === "d");
          const eventEscrowId = dTag?.[1];
          if (eventEscrowId) {
            for (const [, fetchState] of this._pendingFetches) {
              if (fetchState.escrowId === eventEscrowId && !fetchState.seenIds.has(event.id)) {
                fetchState.seenIds.add(event.id);
                fetchState.events.push(event);
              }
            }
          }
        }

        // Global dedup: only fire live callback once per event ID
        if (this.seenEventIds.has(event.id)) break;
        this.seenEventIds.add(event.id);

        // Trim seen set if it gets too large
        if (this.seenEventIds.size > 10_000) {
          const arr = [...this.seenEventIds];
          this.seenEventIds = new Set(arr.slice(-5_000));
        }

        this.callbacks.onEvent?.(event, relayUrl);
        break;
      }

      case "EOSE": {
        // ["EOSE", subscription_id]
        const subId = data[1] as string;

        if (this._pendingOnceFetches.has(subId)) {
          const fetchState = this._pendingOnceFetches.get(subId)!;
          fetchState.probe?.noteEose(relayUrl);
          fetchState.eoseCount++;
          const quorum = Math.min(fetchState.connectedCount, this.effectiveQuorum());
          if (fetchState.eoseCount >= fetchState.connectedCount) {
            // Every connected relay said EOSE — fast path, resolve now. If
            // events is empty here, the relays AFFIRMATIVELY answered "nothing
            // for this filter" (points at a wrong query key, not blocked
            // transport).
            fetchState.probe?.noteResolved("eose");
            this.finalizeOnceFetch(subId);
          } else if (fetchState.eoseCount >= quorum && !fetchState.graceTimer) {
            // A quorum answered but ≥1 relay is still silent — give a short
            // grace for a near-simultaneous straggler, then resolve so a hung
            // socket can't pin us to the full timeout.
            fetchState.graceTimer = setTimeout(() => {
              fetchState.probe?.noteResolved("eose-quorum");
              this.finalizeOnceFetch(subId);
            }, EOSE_GRACE_MS);
          }
        }

        // Route to pending fetch if this EOSE matches
        if (this._pendingFetches?.has(subId)) {
          const fetchState = this._pendingFetches.get(subId)!;
          fetchState.eoseCount++;
          const quorum = Math.min(fetchState.connectedCount, this.effectiveQuorum());
          if (fetchState.eoseCount >= fetchState.connectedCount) {
            console.debug(`[relay] fetch ${subId}: complete with ${fetchState.events.length} events from ${fetchState.eoseCount} relays`);
            this.finalizeEscrowFetch(subId);
          } else if (fetchState.eoseCount >= quorum && !fetchState.graceTimer) {
            fetchState.graceTimer = setTimeout(() => {
              console.debug(`[relay] fetch ${subId}: EOSE quorum (${fetchState.eoseCount}/${fetchState.connectedCount}) + grace — resolving with ${fetchState.events.length} events`);
              this.finalizeEscrowFetch(subId);
            }, EOSE_GRACE_MS);
          }
        }
        this.callbacks.onEose?.(subId, relayUrl);
        break;
      }

      case "OK": {
        // ["OK", event_id, accepted, message]
        if (data.length < 4) return;
        const [, eventId, accepted, message] = data as [string, string, boolean, string];

        // Check if this is a pending publish
        const key = `${eventId}:${relayUrl}`;
        const pending = this.pendingOk.get(key);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingOk.delete(key);
          pending.resolve({ accepted, message: message || "" });
        }

        this.callbacks.onOk?.(eventId, accepted, message || "", relayUrl);
        break;
      }

      case "NOTICE": {
        // ["NOTICE", message] — relay notice, log but don't crash
        break;
      }
    }
  }

  // ── Send raw message to a relay ─────────────────────────────────────────

  private sendToRelay(relay: RelayConnection, message: unknown[]): boolean {
    if (relay.status !== RelayStatus.CONNECTED || !relay.ws) return false;
    try {
      relay.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════

  // ── Publish an event to all connected relays ────────────────────────────

  /**
   * Publish a signed Nostr event to all connected relays.
   * Returns a promise that resolves with the number of relays that accepted.
   * Rejects if zero relays accept within the timeout.
   */
  async publish(event: NostrEvent): Promise<{ accepted: number; rejected: number; errors: string[] }> {
    let connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);

    if (connected.length === 0) {
      connected = await this.waitForConnectedRelays(PUBLISH_CONNECT_WAIT_MS);
    }

    if (connected.length === 0) {
      throw new Error("Relays are still reconnecting — couldn't publish yet. Wait a few seconds and try again.");
    }

    // Mark as seen BEFORE publishing — prevents the relay echo from
    // being processed as a new event when it comes back to us.
    this.seenEventIds.add(event.id);

    // First-ACK semantics (field report: slow Create→Publish). The EVENT
    // frame goes out to EVERY connected relay immediately — each
    // publishToSingleRelay sends before it waits for its OK — so waiting
    // for stragglers adds zero propagation; it only delays the caller. The
    // old Promise.allSettled meant one zombie "connected" relay held every
    // publish hostage for the full PUBLISH_TIMEOUT_MS (8s) even after
    // healthy relays ACKed in milliseconds. Resolve on the FIRST accept —
    // the durability bar is unchanged (at least one relay has the event,
    // same accepted>=1 rule as before); stragglers settle in the background
    // and are logged for relay health. Zero accepts still rejects with the
    // same error as before.
    const sends = connected.map(relay => ({ relay, promise: this.publishToSingleRelay(relay, event) }));
    const preferredConnected = connected.some((relay) => relay.url === PREFERRED_RELAY_URL);
    // DURABILITY: the preferred relay isn't even connected, so this publish
    // can only reach public relays (which prune). Queue it now; the flush on
    // its next connect is what stops a vote/CREATE published during a
    // reconnect window from being permanently absent there.
    if (!preferredConnected && this.relays.has(PREFERRED_RELAY_URL)) {
      this.queuePreferredRepublish(event);
    }

    return await new Promise((resolve, reject) => {
      let settledCount = 0;
      let accepted = 0;
      let rejected = 0;
      const errors: string[] = [];
      let resolvedEarly = false;
      let fallbackAccept: { accepted: number; rejected: number; errors: string[] } | null = null;
      let preferredSettled = !preferredConnected;
      let preferredGrace: ReturnType<typeof setTimeout> | null = null;

      const resolveAccepted = () => {
        if (resolvedEarly || !fallbackAccept) return;
        resolvedEarly = true;
        if (preferredGrace) clearTimeout(preferredGrace);
        resolve(fallbackAccept);
      };

      for (const { relay, promise: send } of sends) {
        // publishToSingleRelay never rejects (timeouts resolve as
        // {accepted:false, message}), so .then is exhaustive here.
        void send.then(result => {
          settledCount++;
          if (result.accepted) {
            accepted++;
          } else {
            rejected++;
            errors.push(result.message);
          }

          if (relay.url === PREFERRED_RELAY_URL) {
            preferredSettled = true;
            // Rejected or timed out on Chama's own relay: keep it for the
            // next connect rather than letting a public-relay accept stand
            // in for durability.
            if (!result.accepted) this.queuePreferredRepublish(event);
          }

          if (!resolvedEarly && result.accepted) {
            fallbackAccept = { accepted, rejected, errors: [...errors] };
            // When Chama's relay is connected, give its durable ACK a short
            // priority window. Public relays remain the bounded fallback.
            if (relay.url === PREFERRED_RELAY_URL || preferredSettled) {
              resolveAccepted();
            } else if (!preferredGrace) {
              preferredGrace = setTimeout(resolveAccepted, PREFERRED_RELAY_ACK_GRACE_MS);
            }
            return;
          }

          if (!resolvedEarly && relay.url === PREFERRED_RELAY_URL && preferredSettled && fallbackAccept) {
            resolveAccepted();
            return;
          }

          if (settledCount === sends.length) {
            if (!resolvedEarly && accepted === 0) {
              reject(new Error(`All ${rejected} relays rejected the event: ${errors.join("; ")}`));
            } else if (resolvedEarly && rejected > 0) {
              console.debug(
                `[chama] publish ${event.id.slice(0, 8)}…: ${accepted}/${sends.length} relays accepted; stragglers: ${errors.join("; ")}`,
              );
            }
          }
        });
      }
    });
  }

  private async waitForConnectedRelays(timeoutMs: number): Promise<RelayConnection[]> {
    if (this.relays.size === 0) return [];

    // A mobile WebView can briefly report 0 relays while sockets are
    // reconnecting. Kick every non-open relay once, then give the normal
    // onopen handlers a bounded window before failing the publish.
    for (const [url, relay] of this.relays) {
      if (relay.status !== RelayStatus.CONNECTED && relay.status !== RelayStatus.CONNECTING) {
        this.connectRelay(url);
      }
    }

    let waited = 0;
    while (waited < timeoutMs) {
      const connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);
      if (connected.length > 0) return connected;
      await new Promise(resolve => setTimeout(resolve, PUBLISH_CONNECT_POLL_MS));
      waited += PUBLISH_CONNECT_POLL_MS;
    }

    return [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);
  }

  /**
   * Wait until a QUORUM of relays is CONNECTED, or `budgetMs` elapses —
   * whichever comes first — then return the currently-connected set. Unlike
   * waitForConnectedRelays (which returns the instant ≥1 is up), this refuses
   * to proceed on a single fast relay: that single-relay head start is exactly
   * what made one-shot fetches resolve partial on slow webviews (the resolve/
   * complete tail lived on a relay that hadn't connected yet). The quorum is
   * clamped to the relay-set size, so a 2-relay federation waits for 2. Kicks
   * any non-open relay first, so a throttled/backgrounded webview that dropped
   * sockets reconnects them before the fetch (webview connection health).
   */
  /** Synchronous check: is a quorum of relays CONNECTED right now? Lets the
   *  fetch paths skip the (async) quorum wait entirely when relays are already
   *  up — preserving the same-tick REQ dispatch the fast path relies on. */
  private hasRelayQuorum(quorum: number): boolean {
    if (this.relays.size === 0) return false;
    const target = Math.max(1, Math.min(quorum, this.relays.size));
    const connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED).length;
    return connected >= target;
  }

  /**
   * The quorum to actually require for one-shot fetches, adapted to the
   * configured pool size: min(FETCH_QUORUM, relayCount - 1). The fixed
   * FETCH_QUORUM=3 assumed a 5-relay pool; a deliberately small pool (a 2- or
   * 3-relay federation, or a degraded set) could never reach 3 and would burn
   * the full FETCH_QUORUM_BUDGET_MS / fetch timeout on every read. Keying off
   * the CONFIGURED size (not the live-connected count) keeps this safe: it only
   * relaxes when the pool itself is small, never below the healthy count
   * mid-handshake (which is what caused the round-2 partial-fetch bug). For a
   * healthy 5-7 relay pool this returns 3 — identical to the old behavior.
   */
  private effectiveQuorum(): number {
    return Math.max(1, Math.min(FETCH_QUORUM, this.relays.size - 1));
  }

  private async waitForRelayQuorum(quorum: number, budgetMs: number): Promise<RelayConnection[]> {
    if (this.relays.size === 0) return [];
    const target = Math.max(1, Math.min(quorum, this.relays.size));

    for (const [url, relay] of this.relays) {
      if (relay.status !== RelayStatus.CONNECTED && relay.status !== RelayStatus.CONNECTING) {
        this.connectRelay(url);
      }
    }

    let waited = 0;
    while (waited < budgetMs) {
      const connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);
      if (connected.length >= target) return connected;
      await new Promise(resolve => setTimeout(resolve, FETCH_QUORUM_POLL_MS));
      waited += FETCH_QUORUM_POLL_MS;
    }
    return [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);
  }

  /** Pending OK handlers — keyed by "eventId:relayUrl" */
  private pendingOk: Map<string, { resolve: (v: { accepted: boolean; message: string }) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();

  /** Events the PREFERRED relay hasn't accepted yet (it was down, rejected,
   *  or timed out). Re-offered on its next connect. Bounded by count + TTL. */
  private preferredRepublishQueue: Map<string, { event: NostrEvent; queuedAt: number }> = new Map();
  private preferredFlushInFlight = false;

  /** Queue an event for the preferred relay. Idempotent per event id; drops
   *  the oldest entry when full so a long offline stretch can't grow forever. */
  private queuePreferredRepublish(event: NostrEvent): void {
    if (!event?.id || this.preferredRepublishQueue.has(event.id)) return;
    if (this.preferredRepublishQueue.size >= PREFERRED_REPUBLISH_MAX) {
      const oldest = [...this.preferredRepublishQueue.entries()]
        .sort((a, b) => a[1].queuedAt - b[1].queuedAt)[0];
      if (oldest) this.preferredRepublishQueue.delete(oldest[0]);
    }
    this.preferredRepublishQueue.set(event.id, { event, queuedAt: Date.now() });
  }

  /** Re-offer every queued event to the preferred relay. Called on its
   *  connect. Serial (one in-flight OK at a time) so a reconnect storm can't
   *  fan out; an entry only leaves the queue when the relay ACCEPTS it or it
   *  ages out, so a flush that fails is simply retried on the next connect. */
  private async flushPreferredRepublishQueue(): Promise<void> {
    if (this.preferredFlushInFlight || this.preferredRepublishQueue.size === 0) return;
    const relay = this.relays.get(PREFERRED_RELAY_URL);
    if (!relay || relay.status !== RelayStatus.CONNECTED) return;
    this.preferredFlushInFlight = true;
    try {
      const cutoff = Date.now() - PREFERRED_REPUBLISH_TTL_MS;
      let restored = 0;
      let consecutiveFailures = 0;
      for (const [id, entry] of [...this.preferredRepublishQueue]) {
        if (entry.queuedAt < cutoff) {
          this.preferredRepublishQueue.delete(id);
          continue;
        }
        if (relay.status !== RelayStatus.CONNECTED) break;
        const result = await this.publishToSingleRelay(relay, entry.event);
        if (result.accepted) {
          this.preferredRepublishQueue.delete(id);
          restored++;
          consecutiveFailures = 0;
          continue;
        }
        // A relay that's rejecting or timing out won't start accepting three
        // events later — stop the serial walk (each failure costs the full
        // publish timeout) and leave the rest queued for the next connect.
        if (++consecutiveFailures >= PREFERRED_REPUBLISH_FAILURE_STREAK) break;
      }
      if (restored > 0) {
        console.debug(
          `[relay] preferred-relay durability: re-delivered ${restored} event(s) to ${PREFERRED_RELAY_URL}` +
            (this.preferredRepublishQueue.size > 0 ? `; ${this.preferredRepublishQueue.size} still queued` : ""),
        );
      }
    } finally {
      this.preferredFlushInFlight = false;
    }
  }

  /**
   * Hand a set of already-signed events back to the PREFERRED relay — history
   * this client holds that the relay's own answer was missing (see
   * relay-backfill.ts). No-op when that relay isn't connected; the events are
   * queued and re-offered on its next connect. Never throws.
   */
  async republishToPreferredRelay(events: readonly NostrEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    for (const event of events) this.queuePreferredRepublish(event);
    const before = this.preferredRepublishQueue.size;
    await this.flushPreferredRepublishQueue();
    const delivered = before - this.preferredRepublishQueue.size;
    if (delivered > 0) {
      console.debug(`[relay] backfilled ${delivered} recovered event(s) to ${PREFERRED_RELAY_URL}`);
    }
    return delivered;
  }

  private publishToSingleRelay(
    relay: RelayConnection,
    event: NostrEvent
  ): Promise<{ accepted: boolean; message: string }> {
    return new Promise((resolve) => {
      const key = `${event.id}:${relay.url}`;

      const timeout = setTimeout(() => {
        this.pendingOk.delete(key);
        resolve({ accepted: false, message: `Timeout on ${relay.url}` });
      }, PUBLISH_TIMEOUT_MS);

      this.pendingOk.set(key, { resolve, timeout });
      this.sendToRelay(relay, ["EVENT", event]);
    });
  }

  // ── Subscribe to events matching a filter ───────────────────────────────

  /**
   * Subscribe to events matching a filter on all connected relays.
   * Returns a subscription ID that can be used to unsubscribe.
   */
  subscribe(filter: NostrFilter): string {
    const subId = `sm_sub_${++this.subscriptionCounter}`;

    for (const [, relay] of this.relays) {
      relay.subscriptions.set(subId, { ...filter });
      if (relay.status === RelayStatus.CONNECTED) {
        this.sendToRelay(relay, ["REQ", subId, relay.subscriptions.get(subId)!]);
      }
    }

    return subId;
  }

  /**
   * Unsubscribe from a subscription on all relays.
   */
  unsubscribe(subscriptionId: string): void {
    for (const [, relay] of this.relays) {
      relay.subscriptions.delete(subscriptionId);
      if (relay.status === RelayStatus.CONNECTED) {
        this.sendToRelay(relay, ["CLOSE", subscriptionId]);
      }
    }
  }

  /** Current connected-relay count, used by long-lived subscriptions to decide
   *  when their initial EOSE reading has reached the same quorum as one-shot
   *  fetches. This exposes no relay internals and does not alter fetch policy. */
  connectedRelayCount(): number {
    return [...this.relays.values()]
      .filter(relay => relay.status === RelayStatus.CONNECTED)
      .length;
  }

  /** Quorum required for a reading across the currently connected relay set. */
  connectedRelayQuorum(): number {
    const connected = this.connectedRelayCount();
    return connected === 0 ? 0 : Math.min(connected, this.effectiveQuorum());
  }

  // ── Convenience: subscribe to a specific escrow's events ────────────────

  /**
   * Subscribe to all events for a specific escrow ID.
   * Returns the subscription ID.
   */
  subscribeToEscrow(escrowId: string): string {
    return this.subscribe({
      kinds: Object.values(EscrowEventKind).filter(v => typeof v === "number") as number[],
      "#d": [escrowId],
    });
  }

  /**
   * Subscribe to escrows that a pubkey participates in.
   * Useful for building a "my trades" list.
   */
  subscribeToParticipant(pubkey: string, since?: number): string {
    return this.subscribe({
      kinds: [EscrowEventKind.CREATE, EscrowEventKind.JOIN],
      "#p": [pubkey],
      ...(since ? { since } : {}),
    });
  }

  /**
   * Subscribe to all public CREATE events (open listings) across the network.
   * Powers the Browse feed: trades anyone has posted, not just ones we're
   * tagged in. CREATE payloads are plaintext so the UI can read them without
   * being a participant.
   *
   * @param since Unix timestamp — only fetch CREATEs newer than this.
   *              Default: 7 days ago. Prevents pulling the entire history.
   */
  subscribeToPublicListings(since?: number): string {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    return this.subscribe({
      kinds: [EscrowEventKind.CREATE],
      since: since ?? sevenDaysAgo,
    });
  }

  /**
   * #7 multi-unit storefront: subscribe to a listing's CHILD purchase CREATEs
   * (events tagged `parent: <parentId>`). Each child's CREATE announces a
   * buyer's claim; the caller loads each child's full chain by id to derive
   * committed stock. Live updates keep a parent's "N left" current.
   */
  subscribeToChildren(parentId: string): string {
    return this.subscribe({
      kinds: [EscrowEventKind.CREATE],
      "#parent": [parentId],
    });
  }

  /**
   * #7 multi-unit storefront: one-shot fetch of a listing's CHILD purchase
   * CREATEs by `#parent`. Returns the children's CREATE events (each d-tag is
   * a child escrow id); the caller loads each child's full chain to derive
   * committed stock.
   */
  fetchChildCreates(parentId: string, timeoutMs = 5_000): Promise<NostrEvent[]> {
    return this.fetchOnce({
      kinds: [EscrowEventKind.CREATE],
      "#parent": [parentId],
    }, timeoutMs);
  }

  // ── One-shot fetch: get all events for an escrow ────────────────────────

  /**
   * Fetch all events for an escrow and return them once all relays
   * have sent EOSE (end of stored events).
   */
  async fetchEscrowEvents(
    escrowId: string,
    timeoutMs = 15_000,
    since?: number,
  ): Promise<NostrEvent[]> {
    // Quorum-gate before snapshotting the connected set: don't REQ a single
    // fast relay and EOSE partial (missing the resolve/complete tail). The
    // late relays that connect during/after this fetch also receive the REQ
    // (onopen resubscribes), and loadEscrow's completeness retry re-fetches
    // once if it lands non-terminal with more relays now connected. Skip the
    // wait entirely (same-tick dispatch) when quorum is already met.
    if (!this.hasRelayQuorum(this.effectiveQuorum())) {
      await this.waitForRelayQuorum(this.effectiveQuorum(), FETCH_QUORUM_BUDGET_MS);
    }

    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const seenIds = new Set<string>();
      let eoseCount = 0;
      const connectedCount = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED).length;

      if (connectedCount === 0) {
        console.warn(`[relay] fetchEscrowEvents: no relays connected, resolving empty`);
        resolve(events);
        return;
      }

      const subId = `sm_fetch_${++this.subscriptionCounter}`;

      // Register this fetch in a per-subscription map so it doesn't
      // collide with other concurrent fetches
      if (!this._pendingFetches) this._pendingFetches = new Map();
      this._pendingFetches.set(subId, { events, seenIds, eoseCount: 0, connectedCount, resolve, timer: null as any, escrowId });

      const fetchState = this._pendingFetches.get(subId)!;

      fetchState.timer = setTimeout(() => {
        console.debug(`[relay] fetchEscrowEvents ${escrowId}: timeout with ${events.length} events from ${fetchState.eoseCount}/${connectedCount} relays`);
        this.finalizeEscrowFetch(subId);
      }, timeoutMs);

      // Subscribe on all relays
      const filter: NostrFilter = {
        kinds: Object.values(EscrowEventKind).filter(v => typeof v === "number") as number[],
        "#d": [escrowId],
        ...(since !== undefined ? { since } : {}),
      };

      for (const [, relay] of this.relays) {
        relay.subscriptions.set(subId, { ...filter });
        if (relay.status === RelayStatus.CONNECTED) {
          this.sendToRelay(relay, ["REQ", subId, relay.subscriptions.get(subId)!]);
        }
      }
    });
  }

  /** Pending fetch state map — used to avoid callback collisions */
  private _pendingFetches: Map<string, {
    events: NostrEvent[];
    seenIds: Set<string>;
    eoseCount: number;
    connectedCount: number;
    resolve: (events: NostrEvent[]) => void;
    timer: any;
    /** EOSE-quorum grace timer (round 3b step 2) — see PendingOnceFetch. */
    graceTimer?: any;
    escrowId: string;
  }> = new Map();

  /** Pending arbitrary fetchOnce state keyed by subscription ID. */
  private _pendingOnceFetches: Map<string, PendingOnceFetch> = new Map();

  /** Resolve + tear down a pending fetchOnce (all-EOSE, quorum+grace, or
   *  timeout). Clears both timers, unsubscribes, and resolves with whatever
   *  events accumulated. Idempotent — a no-op if already finalized. */
  private finalizeOnceFetch(subId: string): void {
    const fetchState = this._pendingOnceFetches.get(subId);
    if (!fetchState) return;
    if (fetchState.timer) clearTimeout(fetchState.timer);
    if (fetchState.graceTimer) clearTimeout(fetchState.graceTimer);
    this._pendingOnceFetches.delete(subId);
    this.unsubscribe(subId);
    fetchState.resolve(fetchState.events);
  }

  /** Resolve + tear down a pending fetchEscrowEvents. See finalizeOnceFetch. */
  private finalizeEscrowFetch(subId: string): void {
    const fetchState = this._pendingFetches?.get(subId);
    if (!fetchState) return;
    if (fetchState.timer) clearTimeout(fetchState.timer);
    if (fetchState.graceTimer) clearTimeout(fetchState.graceTimer);
    this._pendingFetches.delete(subId);
    this.unsubscribe(subId);
    fetchState.resolve(fetchState.events);
  }

  // ── One-shot fetch with an arbitrary filter ─────────────────────────────

  /**
   * Fetch events matching an arbitrary filter. Resolves when every
   * connected relay has sent EOSE, or after the timeout.
   */
  async fetchOnce(
    filter: NostrFilter,
    timeoutMs = 5_000,
    probe?: FetchProbe,
    options?: OnceFetchOptions,
  ): Promise<NostrEvent[]> {
    // Quorum-gate (see fetchEscrowEvents) — discovery (authors ∪ #p) must not
    // resolve against one relay and return a partial trade list, which is what
    // made My Trades oscillate 2↔3 on slow webviews. The hook also re-fires
    // discovery as the connected set grows, so a list built early heals. Skip
    // the wait entirely (same-tick dispatch) when quorum is already met.
    //
    // `probe` is an optional observer (discovery + the `#d` transport control)
    // that records per-relay REQ/EVENT/EOSE and how the fetch resolved. It
    // never gates or changes the fetch — see discovery-diagnostics.ts.
    if (!this.hasRelayQuorum(this.effectiveQuorum())) {
      await this.waitForRelayQuorum(
        this.effectiveQuorum(),
        options?.quorumBudgetMs ?? FETCH_QUORUM_BUDGET_MS,
      );
    }

    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const seenIds = new Set<string>();
      const connectedCount = [...this.relays.values()].filter(
        r => r.status === RelayStatus.CONNECTED
      ).length;

      if (connectedCount === 0) {
        probe?.noteResolved("no-relays");
        resolve([]);
        return;
      }

      const subId = `sm_fetch_once_${++this.subscriptionCounter}`;
      const fetchState: PendingOnceFetch = {
        events,
        seenIds,
        eoseCount: 0,
        connectedCount,
        resolve,
        timer: null,
        probe,
      };
      this._pendingOnceFetches.set(subId, fetchState);

      fetchState.timer = setTimeout(() => {
        // Resolved on the timer — REQs went out but not even a quorum of
        // connected relays returned EOSE. Empty here points at blocked/
        // throttled frames (transport), NOT a wrong query key.
        probe?.noteResolved("timeout");
        this.finalizeOnceFetch(subId);
      }, timeoutMs);

      for (const [, relay] of this.relays) {
        relay.subscriptions.set(subId, { ...filter });
        const connected = relay.status === RelayStatus.CONNECTED;
        const reqSent = connected && this.sendToRelay(
          relay,
          ["REQ", subId, relay.subscriptions.get(subId)!],
        );
        probe?.noteDispatch(relay.url, connected, reqSent);
      }
    });
  }

  // ── Status queries ──────────────────────────────────────────────────────

  getRelayStatuses(): Map<string, RelayStatus> {
    const statuses = new Map<string, RelayStatus>();
    for (const [url, relay] of this.relays) {
      statuses.set(url, relay.status);
    }
    return statuses;
  }

  getConnectedCount(): number {
    return [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED).length;
  }

  // ── Shutdown ────────────────────────────────────────────────────────────

  disconnect(): void {
    this.stopped = true;
    for (const [, relay] of this.relays) {
      if (relay.retryTimer) {
        clearTimeout(relay.retryTimer);
        relay.retryTimer = null;
      }
      if (relay.ws) {
        try { relay.ws.close(); } catch {}
        relay.ws = null;
      }
      relay.status = RelayStatus.DISCONNECTED;
      relay.quarantined = false;
      relay.subscriptions.clear();
    }
    this.seenEventIds.clear();
  }

  // ── Add / remove relays at runtime ──────────────────────────────────────

  addRelay(url: string): void {
    if (this.relays.has(url)) return;
    this.relays.set(url, {
      url,
      ws: null,
      status: RelayStatus.DISCONNECTED,
      retryCount: 0,
      retryTimer: null,
      subscriptions: new Map(),
      quarantined: false,
    });
    this.connectRelay(url);
  }

  removeRelay(url: string): void {
    const relay = this.relays.get(url);
    if (!relay) return;
    if (relay.retryTimer) clearTimeout(relay.retryTimer);
    if (relay.ws) try { relay.ws.close(); } catch {}
    this.relays.delete(url);
  }
}
