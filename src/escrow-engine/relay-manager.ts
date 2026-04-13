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
  since?: number;
  until?: number;
  limit?: number;
}

// ── Relay events ──────────────────────────────────────────────────────────

export interface RelayCallbacks {
  onEvent?: (event: NostrEvent, relayUrl: string) => void;
  onEose?: (subscriptionId: string, relayUrl: string) => void;
  onOk?: (eventId: string, accepted: boolean, message: string, relayUrl: string) => void;
  onError?: (error: Error, relayUrl: string) => void;
  onStatusChange?: (relayUrl: string, status: RelayStatus) => void;
}

// ── Single relay connection ───────────────────────────────────────────────

interface RelayConnection {
  url: string;
  ws: WebSocket | null;
  status: RelayStatus;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  subscriptions: Map<string, NostrFilter>;
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_RETRY_COUNT = 8;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 8_000;

// ══════════════════════════════════════════════════════════════════════════
// RELAY MANAGER
// ══════════════════════════════════════════════════════════════════════════

export class RelayManager {
  private relays: Map<string, RelayConnection> = new Map();
  private callbacks: RelayCallbacks;
  private seenEventIds: Set<string> = new Set();
  private subscriptionCounter = 0;
  private WebSocketImpl: typeof WebSocket;

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
      });
    }
  }

  // ── Connect to all relays ───────────────────────────────────────────────

  connect(): void {
    for (const [url] of this.relays) {
      this.connectRelay(url);
    }
  }

  private connectRelay(url: string): void {
    const relay = this.relays.get(url);
    if (!relay) return;
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
      };

      ws.onmessage = (msg: MessageEvent) => {
        try {
          const data = JSON.parse(typeof msg.data === "string" ? msg.data : new TextDecoder().decode(msg.data as ArrayBuffer));
          this.handleRelayMessage(url, data);
        } catch (e) {
          // Ignore unparseable messages
        }
      };

      ws.onerror = () => {
        relay.status = RelayStatus.ERROR;
        this.callbacks.onError?.(new Error(`WebSocket error on ${url}`), url);
        this.callbacks.onStatusChange?.(url, RelayStatus.ERROR);
      };

      ws.onclose = () => {
        relay.status = RelayStatus.DISCONNECTED;
        relay.ws = null;
        this.callbacks.onStatusChange?.(url, RelayStatus.DISCONNECTED);
        this.scheduleReconnect(url);
      };
    } catch (e) {
      relay.status = RelayStatus.ERROR;
      this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)), url);
      this.scheduleReconnect(url);
    }
  }

  // ── Reconnection with exponential backoff ───────────────────────────────

  private scheduleReconnect(url: string): void {
    const relay = this.relays.get(url);
    if (!relay || relay.retryCount >= MAX_RETRY_COUNT) return;

    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, relay.retryCount), MAX_RETRY_MS);
    relay.retryCount++;

    relay.retryTimer = setTimeout(() => {
      relay.retryTimer = null;
      this.connectRelay(url);
    }, delay);
  }

  // ── Handle incoming relay messages ──────────────────────────────────────

  private handleRelayMessage(relayUrl: string, data: unknown[]): void {
    if (!Array.isArray(data) || data.length < 2) return;

    const [type] = data;

    switch (type) {
      case "EVENT": {
        // ["EVENT", subscription_id, event]
        if (data.length < 3) return;
        const event = data[2] as NostrEvent;
        if (!event?.id) return;

        // Dedup: only fire callback once per event ID across all relays
        if (this.seenEventIds.has(event.id)) return;
        this.seenEventIds.add(event.id);

        // Trim seen set if it gets too large
        if (this.seenEventIds.size > 10_000) {
          const arr = [...this.seenEventIds];
          this.seenEventIds = new Set(arr.slice(-5_000));
        }

        // Route to pending fetch subscriptions first
        if (this._pendingFetches) {
          for (const [fetchSubId, fetchState] of this._pendingFetches) {
            if (subId === fetchSubId && !fetchState.seenIds.has(event.id)) {
              fetchState.seenIds.add(event.id);
              fetchState.events.push(event);
            }
          }
        }
        this.callbacks.onEvent?.(event, relayUrl);
        break;
      }

      case "EOSE": {
        // ["EOSE", subscription_id]
        const subId = data[1] as string;
        // Route to pending fetch if this EOSE matches
        if (this._pendingFetches?.has(subId)) {
          const fetchState = this._pendingFetches.get(subId)!;
          fetchState.eoseCount++;
          if (fetchState.eoseCount >= fetchState.connectedCount) {
            console.debug(`[relay] fetch ${subId}: complete with ${fetchState.events.length} events from ${fetchState.eoseCount} relays`);
            clearTimeout(fetchState.timer);
            this.unsubscribe(subId);
            const events = fetchState.events;
            const resolveFn = fetchState.resolve;
            this._pendingFetches.delete(subId);
            resolveFn(events);
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
    const connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);

    if (connected.length === 0) {
      throw new Error("No connected relays — cannot publish");
    }

    // Mark as seen BEFORE publishing — prevents the relay echo from
    // being processed as a new event when it comes back to us.
    this.seenEventIds.add(event.id);

    const results = await Promise.allSettled(
      connected.map(relay => this.publishToSingleRelay(relay, event))
    );

    let accepted = 0;
    let rejected = 0;
    const errors: string[] = [];

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.accepted) {
        accepted++;
      } else if (result.status === "fulfilled") {
        rejected++;
        errors.push(result.value.message);
      } else {
        rejected++;
        errors.push(result.reason?.message || "Unknown error");
      }
    }

    if (accepted === 0) {
      throw new Error(`All ${rejected} relays rejected the event: ${errors.join("; ")}`);
    }

    return { accepted, rejected, errors };
  }

  /** Pending OK handlers — keyed by "eventId:relayUrl" */
  private pendingOk: Map<string, { resolve: (v: { accepted: boolean; message: string }) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();

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
      relay.subscriptions.set(subId, filter);
      if (relay.status === RelayStatus.CONNECTED) {
        this.sendToRelay(relay, ["REQ", subId, filter]);
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

  // ── One-shot fetch: get all events for an escrow ────────────────────────

  /**
   * Fetch all events for an escrow and return them once all relays
   * have sent EOSE (end of stored events).
   */
  fetchEscrowEvents(escrowId: string, timeoutMs = 15_000): Promise<NostrEvent[]> {
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
      this._pendingFetches.set(subId, { events, seenIds, eoseCount: 0, connectedCount, resolve, timer: null as any });

      const fetchState = this._pendingFetches.get(subId)!;

      const cleanup = () => {
        clearTimeout(fetchState.timer);
        this.unsubscribe(subId);
        this._pendingFetches.delete(subId);
      };

      fetchState.timer = setTimeout(() => {
        console.debug(`[relay] fetchEscrowEvents ${escrowId}: timeout with ${events.length} events from ${fetchState.eoseCount}/${connectedCount} relays`);
        cleanup();
        resolve(events);
      }, timeoutMs);

      // Subscribe on all relays
      const filter: NostrFilter = {
        kinds: Object.values(EscrowEventKind).filter(v => typeof v === "number") as number[],
        "#d": [escrowId],
      };

      for (const [, relay] of this.relays) {
        relay.subscriptions.set(subId, filter);
        if (relay.status === RelayStatus.CONNECTED) {
          this.sendToRelay(relay, ["REQ", subId, filter]);
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
  }> = new Map();

  // ── One-shot fetch with an arbitrary filter ─────────────────────────────

  /**
   * Fetch events matching an arbitrary filter. Resolves when every
   * connected relay has sent EOSE, or after the timeout.
   */
  fetchOnce(filter: NostrFilter, timeoutMs = 5_000): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const seenIds = new Set<string>();
      let eoseCount = 0;
      const connectedCount = [...this.relays.values()].filter(
        r => r.status === RelayStatus.CONNECTED
      ).length;

      if (connectedCount === 0) {
        resolve([]);
        return;
      }

      const subId = `sm_fetch_once_${++this.subscriptionCounter}`;

      const origOnEvent = this.callbacks.onEvent;
      const origOnEose = this.callbacks.onEose;

      const cleanup = () => {
        clearTimeout(timer);
        this.unsubscribe(subId);
        this.callbacks.onEvent = origOnEvent;
        this.callbacks.onEose = origOnEose;
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(events);
      }, timeoutMs);

      this.callbacks.onEvent = (event, relayUrl) => {
        origOnEvent?.(event, relayUrl);
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          events.push(event);
        }
      };

      this.callbacks.onEose = (sid, relayUrl) => {
        origOnEose?.(sid, relayUrl);
        if (sid === subId) {
          eoseCount++;
          if (eoseCount >= connectedCount) {
            cleanup();
            resolve(events);
          }
        }
      };

      for (const [, relay] of this.relays) {
        relay.subscriptions.set(subId, filter);
        if (relay.status === RelayStatus.CONNECTED) {
          this.sendToRelay(relay, ["REQ", subId, filter]);
        }
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
