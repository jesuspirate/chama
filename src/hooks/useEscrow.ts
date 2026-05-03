// ══════════════════════════════════════════════════════════════════════════
// useEscrow — React hook connecting UI to the Nostr escrow engine
// ══════════════════════════════════════════════════════════════════════════

// ── localStorage helpers for escrow ID persistence ────────────────────────
const STORAGE_KEY = "chama_escrow_ids";

function getSavedEscrowIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveEscrowId(id: string) {
  try {
    const ids = getSavedEscrowIds();
    if (!ids.includes(id)) {
      ids.unshift(id); // newest first
      // Keep max 50 IDs
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, 50)));
    }
  } catch {}
}

function removeEscrowId(id: string) {
  try {
    const ids = getSavedEscrowIds().filter(i => i !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

import { useState, useEffect, useCallback, useRef } from "react";
import {
  EscrowClient,
  type EscrowClientConfig,
  type EscrowClientCallbacks,
  type Signer,
  detectSigner,
  NIP07Signer,
} from "../escrow-engine/index.js";
import {
  type EscrowState,
  type ParsedEscrowEvent,
  type ChatPayload,
  Role,
  Outcome,
} from "../escrow-engine/types.js";
import {
  FedimintClient,
  EscrowFedimintBridge,
  resolveFederationForCommunity,
  setCustomFederationInvite,
  hasCustomFederation,
  DEFAULT_FEDERATION_NAME,
  getOrCreateSeed,
  clearSeedCache,
  isTestnetMode,
  resetLocalFedimintWallet,
  drainPendingRedemptions,
  checkAndMaybeRepublishSeed,
  getActiveInvite,
  setActiveInvite,
  clearActiveInvite,
} from "../fedimint/index.js";
import { getUserCommunitySlug, setUserCommunitySlug } from "../communities/storage.js";
import { getCommunityBySlug, type Community } from "../communities/registry.js";

// ── Hook state ────────────────────────────────────────────────────────────

/**
 * Phases of a claim operation as seen by the UI.
 *
 * `submitted`  — user tapped claim, the bridge call is running.
 * `watching`   — the bridge call rejected with a probably-transient error,
 *                but the federation may still be processing. We're polling
 *                balance for up to 120s to see if sats actually arrive.
 * `success`    — either the bridge resolved cleanly, or the watchdog saw
 *                the balance go up by the expected amount.
 * `timeout`    — 120s elapsed during watching and balance didn't move
 *                enough. The sats may still arrive later; we just stopped
 *                watching. Not a red-toast failure.
 * `failure`    — a genuine hard error (hash mismatch, state precondition
 *                failed, etc.). Safe to show as red.
 */
export type ClaimPhase =
  | { phase: "submitted"; escrowId: string }
  | { phase: "watching"; escrowId: string; reason: string }
  | { phase: "success"; escrowId: string; deltaMsats: number; viaWatchdog: boolean }
  | { phase: "timeout"; escrowId: string }
  | { phase: "failure"; escrowId: string; reason: string };

export interface FedimintState {
  /** Wallet initialized (WASM loaded, transport ready) */
  initialized: boolean;
  /** Joined a federation */
  joined: boolean;
  /** Active federation ID (hex) */
  federationId: string | null;
  /** Human-friendly federation name for display */
  federationName: string;
  /** Whether the user is on a custom (non-default) federation */
  isCustom: boolean;
  /** Balance in msats */
  balanceMsats: number;
  /** True while init/join/fund operations are in flight */
  busy: boolean;
  /** Latest Fedimint error (separate from escrow error) */
  error: string | null;
  /**
   * PR 5: cached federation health probe result.
   * `true`  = last probe succeeded (or last join/switch succeeded — that
   *           also proves reachability).
   * `false` = last probe failed; receive operations should refuse until
   *           a fresh probe succeeds.
   * `null`  = no probe yet (e.g. just after fresh init, before first
   *           receive). Receive ops trigger a fresh probe in this case.
   */
  lastHealthOk: boolean | null;
  /** PR 5: ms-since-epoch of the last probe. Used for the 30s cache TTL. */
  lastHealthAt: number | null;
}

export interface UseEscrowState {
  /** Whether the client is connected to relays */
  connected: boolean;
  /** User's Nostr pubkey (hex) */
  pubkey: string | null;
  /** All loaded escrow states */
  escrows: Map<string, EscrowState>;
  /** Relay connection statuses */
  relayStatuses: Map<string, string>;
  /** Number of connected relays */
  connectedRelays: number;
  /** Latest error */
  error: string | null;
  /** Loading state */
  loading: boolean;
  /** Fedimint wallet state */
  fedimint: FedimintState;
}

export interface UseEscrowActions {
  /** Connect to relays and initialize signer */
  connect: () => Promise<void>;
  /** Disconnect from relays */
  disconnect: () => void;
  /** Create a new escrow trade */
  createEscrow: (params: {
    description: string;
    amountMsats: number;
    fiatAmount?: number;
    fiatCurrency?: string;
    category: string;
    mintUrl: string;
    paymentMethods?: string[];
    arbiterFeeMsats?: number;
    expirySeconds?: number;
  }) => Promise<{ escrowId: string; state: EscrowState }>;
  /** Join an existing escrow as buyer or arbiter (ACK only — does not gate state) */
  joinEscrow: (escrowId: string, role: Role) => Promise<EscrowState>;
  /**
   * Lock ecash into 2-of-3 SSS escrow.
   * Atomic-funding flow: triggered as a side-effect of payment landing.
   *   spendNotes → Shamir split → NIP-44 encrypt shares → publish LOCK
   * The LOCK event self-describes buyer + arbiter; no prior READY ceremony.
   *
   * PR 3: optional savedHandleId names which of the seller's saved
   * payment handles to reveal in the LOCK payload. Bridge resolves
   * to cleartext at lock time. Omit for non-fiat trades.
   */
  lockAndPublish: (escrowId: string, opts?: { savedHandleId?: string }) => Promise<EscrowState>;
  /** Cast a vote */
  vote: (escrowId: string, outcome: Outcome) => Promise<EscrowState>;
  /**
   * Claim ecash as the winner.
   * Runs the full real-Fedimint flow:
   *   decrypt shares → Shamir combine → verify hash → redeemEcash → publish CLAIM
   */
  claimAndRedeem: (escrowId: string) => Promise<EscrowState>;
  /** Release a subscription period */
  releasePeriod: (escrowId: string, periodIndex: number) => Promise<EscrowState>;
  /** Send a chat message */
  sendChat: (escrowId: string, message: string) => Promise<void>;
  /** Cancel a trade (initiator only, pre-lock) */
  cancel: (escrowId: string, reason?: string) => Promise<EscrowState>;
  /** Load an escrow from relays by ID */
  loadEscrow: (escrowId: string) => Promise<EscrowState | null>;
  /** Trigger haptic feedback */
  vibrate: (pattern?: number | number[]) => void;

  // ── Fedimint actions ───────────────────────────────────────────────────
  /**
   * Initialize the Fedimint WASM wallet and join a federation.
   * If no invite code is provided, uses the stored custom invite (if any)
   * or falls back to the community-default (which falls back to BLF).
   * Idempotent: safe to call multiple times.
   *
   * v0.1.82+: throws `RECONCILE_REFUSED_NONZERO_BALANCE` if the OPFS-bound
   * federation differs from the desired one AND the local wallet holds
   * sats (or the balance can't be verified). The UI must surface a
   * destroy-confirm modal before retrying with `{ force: true }`.
   */
  initFedimint: (inviteCode?: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * Persist a custom federation invite code for future sessions.
   * Pass empty string to clear and revert to the default.
   * Does NOT automatically re-join — call initFedimint() after if you
   * want to switch federations immediately.
   */
  setCustomInvite: (inviteCode: string) => void;
  /**
   * Create a Lightning invoice to fund the Fedimint wallet.
   * Returns the BOLT11 string for the user to pay from another wallet.
   */
  createFundingInvoice: (amountMsats: number, description?: string) => Promise<string>;
  payInvoice: (bolt11: string) => Promise<void>;
  spendNotes: (amountMsats: number) => Promise<string>;
  /** Refresh the current balance from the wallet */
  refreshBalance: () => Promise<void>;
  /**
   * Wipe the local Fedimint wallet's IndexedDB and reset in-memory state.
   * Use this to recover from a "No modification allowed" seed-mismatch error
   * or any other stuck-state issue. Destructive to *local* state only — the
   * Nostr-backed seed survives and will be re-installed on next initFedimint().
   */
  resetLocalWallet: () => Promise<void>;
  /**
   * Switch the Fedimint wallet to a different federation. Atomically:
   *   1. Cleans up the in-memory FedimintClient (terminates worker)
   *   2. Wipes the current OPFS file + rotates to a fresh filename
   *   3. Re-initializes with the new invite code
   *
   * Destructive: any ecash held in the previous federation becomes
   * stranded until you switch back. The v0.1.76 balance guard refuses
   * the switch if `getBalance() > 0` unless `{ force: true }` is passed,
   * which the UI must only do after explicit user confirmation. The
   * Nostr-backed seed survives — trade history, escrows, and signer
   * are unaffected.
   */
  switchFederation: (inviteCode: string, options?: { force?: boolean }) => Promise<void>;
  /** (Re-)start the Browse feed subscription for public listings. */
  watchPublicListings: (since?: number) => void;
  /** PR 2: read the user's selected community slug (always returns
   *  a valid slug from the registry — defaults to global-usd). */
  getCommunity: () => string;
  /** PR 2: persist the user's community choice. Pass empty string to
   *  clear and revert to default. Does NOT auto re-init the wallet —
   *  call initFedimint() afterward to switch federations immediately. */
  setCommunity: (slug: string) => void;
}

// ── Default relay list ────────────────────────────────────────────────────

const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
];

// ── Haptic feedback ───────────────────────────────────────────────────────

function vibrate(pattern: number | number[] = 50) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// HOOK
// ══════════════════════════════════════════════════════════════════════════

/**
 * Config accepted by useEscrow. Extends EscrowClientConfig (relays, fees, etc.)
 * with UI-facing callbacks that let the hook communicate multi-phase events
 * back to the UI without the UI having to drive complex promise chains.
 */
export interface UseEscrowConfig extends Partial<EscrowClientConfig> {
  /** Called at each phase of a claim operation — see ClaimPhase. */
  onClaimProgress?: (phase: ClaimPhase) => void;
}

export function useEscrow(config?: UseEscrowConfig): [UseEscrowState, UseEscrowActions] {
  const clientRef = useRef<EscrowClient | null>(null);
  const fedimintRef = useRef<FedimintClient | null>(null);
  const bridgeRef = useRef<EscrowFedimintBridge | null>(null);
  const signerRef = useRef<Signer | null>(null);
  // PR 5: federation health cache. Mirrored into React state for the UI;
  // the ref is the source of truth read inside createFundingInvoice so
  // we don't depend on the latest closure of `state`.
  const healthRef = useRef<{ ok: boolean | null; at: number | null }>({ ok: null, at: null });
  // PR 5: latest state mirror. Lets callbacks read current values
  // (e.g. federationName for error copy) without re-creating the
  // callback on every state change.
  const stateRef = useRef<UseEscrowState | null>(null);

  const [state, setState] = useState<UseEscrowState>({
    connected: false,
    pubkey: null,
    escrows: new Map(),
    relayStatuses: new Map(),
    connectedRelays: 0,
    error: null,
    loading: false,
    fedimint: {
      initialized: false,
      joined: false,
      federationId: null,
      federationName: hasCustomFederation() ? "Custom federation" : DEFAULT_FEDERATION_NAME,
      isCustom: hasCustomFederation(),
      balanceMsats: 0,
      busy: false,
      error: null,
      lastHealthOk: null,
      lastHealthAt: null,
    },
  });

  const updateFedimint = useCallback((partial: Partial<FedimintState>) => {
    setState(prev => ({ ...prev, fedimint: { ...prev.fedimint, ...partial } }));
  }, []);

  // PR 5: keep stateRef in sync with state on every render so callbacks
  // can read the latest values without taking `state` as a dependency.
  stateRef.current = state;

  // ── State updater helpers ───────────────────────────────────────────────

  const updateEscrow = useCallback((escrowId: string, escrowState: EscrowState) => {
    setState(prev => {
      const next = new Map(prev.escrows);
      next.set(escrowId, escrowState);
      return { ...prev, escrows: next };
    });
    // Haptic on state changes
    vibrate(30);
  }, []);

  const updateRelayStatus = useCallback((relayUrl: string, status: string) => {
    setState(prev => {
      const next = new Map(prev.relayStatuses);
      next.set(relayUrl, status);
      const connected = [...next.values()].filter(s => s === "connected").length;
      return { ...prev, relayStatuses: next, connectedRelays: connected };
    });
  }, []);

  // ── Connect ─────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      // Detect signer (NIP-07 extension or Fedi runtime)
      let signer: Signer;
      try {
        // Check for pre-connected NIP-46 signer (set by App component)
        if ((window as any).__chama_nip46_signer) {
          signer = (window as any).__chama_nip46_signer;
          delete (window as any).__chama_nip46_signer;
        }
        // Check for nsec login
        else if ((window as any).__chama_connect_nsec) {
          const nsec = (window as any).__chama_connect_nsec;
          delete (window as any).__chama_connect_nsec;
          const { NsecSigner } = await import("../escrow-engine/nsec-signer.js");
          signer = new NsecSigner(nsec);
        }
        // Default: NIP-07 extension
        else {
          signer = detectSigner();
        }
      } catch {
        // Fallback: try NIP-07 with a delay (extensions sometimes load late)
        await new Promise(r => setTimeout(r, 500));
        try {
          signer = detectSigner();
        } catch (e) {
          throw new Error("No Nostr signer found. Use the Signer QR option, paste an nsec, or install a NIP-07 extension.");
        }
      }

      const pubkey = await signer.getPublicKey();
      signerRef.current = signer;

      const callbacks: EscrowClientCallbacks = {
        onStateUpdate: (id, s) => updateEscrow(id, s),
        onChatMessage: (id, msg) => {
          // Chat messages are embedded in escrow state via the engine.
          // Force React re-render with the updated chatMessages.
          updateEscrow(id, client.getState(id)!);
          vibrate([20, 30, 20]);
        },
        onValidationError: (id, error, eventId) => {
          console.warn(`[escrow] Validation error on ${id}: ${error} (event: ${eventId})`);
        },
        onRelayStatus: (url, status) => updateRelayStatus(url, status),
      };

      const client = new EscrowClient(signer, {
        relays: config?.relays || DEFAULT_RELAYS,
        defaultPlatformFeeBps: config?.defaultPlatformFeeBps ?? 50,
        platformFeePubkey: config?.platformFeePubkey,
        defaultExpirySeconds: config?.defaultExpirySeconds ?? 86_400,
        ...config,
      }, callbacks);

      client.connect();
      clientRef.current = client;

      // Start Browse feed — subscribe to public CREATE events from the last 7 days.
      // These flow through the same onStateUpdate callback and land in `escrows`;
      // the UI filters by "am I a participant" to split Browse from My trades.
      client.watchPublicListings();

      setState(prev => ({
        ...prev,
        connected: true,
        pubkey,
        loading: false,
      }));

      vibrate([50, 30, 50]); // Connected haptic

      // Start periodic balance refresh — every 30 seconds
      const balanceInterval = setInterval(() => {
        refreshBalanceRef.current?.().catch(() => {});
      }, 30_000);

      // Start periodic expiry checker — every 60 seconds, check all loaded escrows
      // v0.1.65: periodic heal — also scan EXPIRED so stuck chains get
      // healed by any online participant, not just those who happened
      // to open the specific trade. The client-side guard inside
      // maybeAutoRefundExpired filters by role + vote-state, so this
      // is safe to call broadly.
      const expiryInterval = setInterval(async () => {
        if (!clientRef.current) return;
        const escrowClient = clientRef.current;
        const now = Math.floor(Date.now() / 1000);
        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          const isStuckLocked =
            escrowState.status === "LOCKED" && now > escrowState.expiresAt;
          const isStuckExpired =
            escrowState.status === "EXPIRED" &&
            !escrowState.eventChain?.some?.((e: any) => e.kind === 38104);
          if (isStuckLocked || isStuckExpired) {
            try {
              await (escrowClient as any).maybeAutoRefundExpired?.(escrowId);
            } catch {}
          }
        }
      }, 60_000);
      // Store interval for cleanup
      (clientRef as any)._expiryInterval = expiryInterval;

      // ── v0.1.67: Mechanism B sentinel ─────────────────────────────
      //
      // Background heal for stuck trades the user is a participant in.
      // Three heals: stuck-LOCKED-past-expiry (publish my REFUND vote),
      // CLAIMED-without-COMPLETE (publish COMPLETE), stuck-FUNDED-past-
      // expiry as initiator (publish CANCEL).
      //
      // In-memory dedup prevents retrying the same heal every tick.
      // Accepts duplicates across clients (state machine dedupes at
      // replay via ALREADY_VOTED / TERMINAL_STATE / INVALID_STATE).
      //
      // Scope: escrowClient.states where the user's pubkey appears in
      // state.participants. Ground-truth filter — independent of
      // savedIds localStorage state.
      const sentinelDedup = new Map<string, Set<string>>();
      const markAttempted = (escrowId: string, healKind: string) => {
        const set = sentinelDedup.get(escrowId) ?? new Set<string>();
        set.add(healKind);
        sentinelDedup.set(escrowId, set);
      };
      const alreadyAttempted = (escrowId: string, healKind: string): boolean =>
        sentinelDedup.get(escrowId)?.has(healKind) ?? false;

      const sentinelInterval = setInterval(async () => {
        if (!mountedRef.current) return;
        if (!clientRef.current || !signerRef.current) return;
        const escrowClient = clientRef.current;
        let myPubkey: string;
        try {
          myPubkey = await signerRef.current.getPublicKey();
        } catch {
          // Signer not ready — skip this tick silently.
          return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        let scanned = 0;
        let heals = 0;

        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          scanned++;

          // Determine my role in this trade, if any. If I'm not a
          // participant, skip entirely — this is the scope guard.
          const p = escrowState.participants;
          let myRole: Role | null = null;
          if (p.buyer === myPubkey) myRole = Role.BUYER;
          else if (p.seller === myPubkey) myRole = Role.SELLER;
          else if (p.arbiter === myPubkey) myRole = Role.ARBITER;
          if (!myRole) continue;

          // ── Heal #1: LOCKED past expiry, I haven't voted REFUND ──
          if (
            escrowState.status === "LOCKED" &&
            nowSec > escrowState.expiresAt &&
            escrowState.votes?.[myRole] === undefined &&
            !alreadyAttempted(escrowId, "refund-vote")
          ) {
            markAttempted(escrowId, "refund-vote");
            try {
              await escrowClient.vote(escrowId, Outcome.REFUND);
              heals++;
              console.log(`[chama] sentinel: published REFUND vote on ${escrowId}`);
            } catch (e) {
              console.debug(`[chama] sentinel: REFUND vote on ${escrowId} suppressed:`, (e as Error)?.message);
            }
            continue;
          }

          // ── Heal #2: CLAIMED without COMPLETE on chain ──
          const hasCompleteEvent = escrowState.eventChain?.some?.((e: any) => e.kind === 38106);
          if (
            escrowState.status === "CLAIMED" &&
            !hasCompleteEvent &&
            !alreadyAttempted(escrowId, "complete")
          ) {
            markAttempted(escrowId, "complete");
            try {
              await escrowClient.complete(escrowId);
              heals++;
              console.log(`[chama] sentinel: published COMPLETE on ${escrowId}`);
            } catch (e) {
              console.debug(`[chama] sentinel: COMPLETE on ${escrowId} suppressed:`, (e as Error)?.message);
            }
            continue;
          }

          // ── Heal #3: CREATED past expiry, no LOCK, I'm the initiator ──
          // Atomic-funding model: trades sit in CREATED until LOCK fires.
          // If a buyer never paid by the deadline, the initiator cancels.
          const isInitiator = escrowState.initiator?.pubkey === myPubkey;
          if (
            escrowState.status === "CREATED" &&
            nowSec > escrowState.expiresAt &&
            isInitiator &&
            !alreadyAttempted(escrowId, "cancel")
          ) {
            markAttempted(escrowId, "cancel");
            try {
              await escrowClient.cancel(escrowId, "never_locked_past_expiry");
              heals++;
              console.log(`[chama] sentinel: published CANCEL on ${escrowId} (stuck CREATED past expiry)`);
            } catch (e) {
              console.debug(`[chama] sentinel: CANCEL on ${escrowId} suppressed:`, (e as Error)?.message);
            }
          }
        }

        console.log(`[chama] sentinel: scanned ${scanned} escrows, ${heals} heals`);
      }, 5 * 60_000);
      (clientRef as any)._sentinelInterval = sentinelInterval;

      // Auto-reload saved escrows — wait for relays to connect first
      const savedIds = getSavedEscrowIds();
      if (savedIds.length > 0) {
        // Wait for at least 2 relays to connect (up to 5 seconds)
        let waited = 0;
        while (waited < 5000) {
          const connectedCount = [...(client as any).relayManager.relays.values()]
            .filter((r: any) => r.status === "connected").length;
          if (connectedCount >= 2) break;
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
        const finalConnected = [...(client as any).relayManager.relays.values()]
          .filter((r: any) => r.status === "connected").length;
        console.log(`[chama] Reloading ${savedIds.length} saved escrow(s) with ${finalConnected} relays connected...`);
        // v0.1.66.32: cap raised 10 → 50 to match save cap.
        // Users with >10 saved trades were silently having older
        // escrows skipped on cold start, causing stale-forever state.
        for (const id of savedIds.slice(0, 50)) {
          try {
            await client.loadEscrow(id);
          } catch (e) {
            console.debug(`[chama] Could not reload ${id}:`, e);
          }
        }
      }
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [config, updateEscrow, updateRelayStatus]);

  // ── Disconnect ──────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    fedimintRef.current?.cleanup().catch((e) =>
      console.debug("[chama] fedimint cleanup error:", e)
    );
    fedimintRef.current = null;
    bridgeRef.current = null;
    signerRef.current = null;
    clearSeedCache();
    setState({
      connected: false,
      pubkey: null,
      escrows: new Map(),
      relayStatuses: new Map(),
      connectedRelays: 0,
      error: null,
      loading: false,
      fedimint: {
        initialized: false,
        joined: false,
        federationId: null,
        federationName: hasCustomFederation() ? "Custom federation" : DEFAULT_FEDERATION_NAME,
        isCustom: hasCustomFederation(),
        balanceMsats: 0,
        busy: false,
        error: null,
        lastHealthOk: null,
        lastHealthAt: null,
      },
    });
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  //
  // v0.1.66.34: mountedRef is the kill-switch for long-lived async polls
  // (the claim watchdog in particular). setTimeout-driven polls hold
  // closures over fedimintRef/updateFedimint, and firing those after
  // unmount produces React "state update on unmounted component" warnings
  // — worse, calling updateFedimint() on a stale instance can race a
  // freshly-mounted hook's state and clobber a real balance update with
  // a stale read.

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.disconnect();
      fedimintRef.current?.cleanup().catch(() => {});
    };
  }, []);

  // ── Trade actions ───────────────────────────────────────────────────────

  const requireClient = (): EscrowClient => {
    if (!clientRef.current) throw new Error("Not connected — call connect() first");
    return clientRef.current;
  };

  const createEscrow = useCallback(async (params: Parameters<EscrowClient["createEscrow"]>[0]) => {
    const client = requireClient();

    // v0.1.72 federation gates ─────────────────────────────────────────
    // Probe the locker's federation at create time. The captured prefix
    // gets embedded in the CREATE event; participants can then verify
    // they're on the same federation before joining/locking/claiming.
    //
    // If the probe fails (federation unreachable, wallet not joined,
    // etc.) we proceed WITHOUT the tags. The trade will work, but
    // participants won't have the gate as a safety net. This is the
    // same as pre-.72 behavior, so it's a graceful degradation.
    let probedFedPrefix: string | undefined;
    let probedFed: string | undefined;
    if (fedimintRef.current) {
      try {
        const probe = await fedimintRef.current.probeFederation();
        probedFedPrefix = probe.prefix;
        probedFed = probe.fed ?? undefined;
      } catch (e) {
        console.warn(
          "[chama] CREATE: federation probe failed, trade will be created without fed tags:",
          e instanceof Error ? e.message : e
        );
      }
    }

    const result = await client.createEscrow({
      ...params,
      fedPrefix: probedFedPrefix,
      fed: probedFed,
    });
    saveEscrowId(result.escrowId);
    vibrate([40, 20, 40, 20, 80]); // Celebratory haptic
    return result;
  }, []);

  const joinEscrow = useCallback(async (escrowId: string, role: Role) => {
    const client = requireClient();

    // v0.1.72 federation gates ─────────────────────────────────────────
    // Pre-flight: if the trade's CREATE event carries a fedPrefix tag,
    // probe the joiner's wallet and refuse to publish JOIN if there's
    // a mismatch. This catches bad joins BEFORE any money operation.
    //
    // For pre-.72 trades (no fedPrefix on CREATE), we allow the join
    // unconditionally — the LOCK gate will still catch a wallet
    // mismatch when the locker tries to spend, and the REDEEM gate
    // catches it when the winner tries to claim. Layered defense.
    const state = client.getState(escrowId);
    const createEvent = state?.eventChain?.[0];
    const expectedFedPrefix: string | undefined =
      (createEvent?.payload as any)?.fedPrefix;

    if (expectedFedPrefix && fedimintRef.current) {
      try {
        const probe = await fedimintRef.current.probeFederation();
        if (probe.prefix !== expectedFedPrefix) {
          const err: any = new Error(
            `This trade requires federation ${expectedFedPrefix}. ` +
              `Your wallet is on ${probe.prefix}. ` +
              `Sign out and rejoin with the correct federation, then try again.`
          );
          err.code = "FED_MISMATCH";
          err.expected = expectedFedPrefix;
          err.got = probe.prefix;
          throw err;
        }
      } catch (probeErr: any) {
        // If the error is FED_MISMATCH, re-throw — let the UI surface it.
        if (probeErr?.code === "FED_MISMATCH") throw probeErr;
        // Otherwise the probe itself failed (network, etc.). Allow the
        // join to proceed — the LOCK gate is still in place.
        console.warn(
          "[chama] JOIN: federation probe failed, proceeding without gate:",
          probeErr instanceof Error ? probeErr.message : probeErr
        );
      }
    }

    try {
      const result = await client.joinEscrow(escrowId, role);
      saveEscrowId(escrowId);
      vibrate([30, 20, 30]);
      return result;
    } catch (e: any) {
      // Swallow known duplicate/stale errors — they fire when a user reloads
      // a trade they already joined and the state has advanced past OPEN.
      // Engine strings: "Cannot JOIN in state <x>" and
      // "Pubkey is already a participant".
      const msg = e?.message || "";
      if (msg.includes("Cannot JOIN") || msg.includes("already a participant") ||
          msg.includes("TERMINAL")) {
        console.debug("[chama] Join suppressed:", msg);
        saveEscrowId(escrowId);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  const requireBridge = (): EscrowFedimintBridge => {
    if (!bridgeRef.current) {
      throw new Error(
        "Fedimint wallet not ready — join a federation before locking or claiming"
      );
    }
    return bridgeRef.current;
  };

  const lockAndPublishAction = useCallback(async (escrowId: string, opts: { savedHandleId?: string } = {}) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      const result = await bridge.lockAndPublish(escrowId, opts);
      vibrate([60, 30, 60, 30, 120]);
      // Refresh balance after spending ecash
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("Cannot LOCK") || msg.includes("TERMINAL")) {
        console.debug("[chama] Lock suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  // Hard-failure signatures — errors we treat as red-toast worthy.
  // These mean the claim will NEVER succeed; retrying won't help.
  // Anything NOT on this list is assumed transient (federation may settle later).
  const isHardClaimFailure = (msg: string): boolean => {
    return msg.includes("not the winner") ||
           msg.includes("not APPROVED") ||
           msg.includes("Not enough shares") ||
           msg.includes("No lock data") ||
           msg.includes("hash mismatch") ||
           msg.includes("Notes hash mismatch") ||
           msg.includes("shares may be corrupted") ||
           msg.includes("You are not");
  };

  // Stale-state signatures — these mean the action was a no-op because state
  // already advanced. Suppress silently (same behavior as pre-v0.1.62).
  //
  // v0.1.66.34: tightened from substring matches on "already"/"Cannot"
  // to specific state-machine error signatures. The previous predicate
  // matched JavaScript TypeErrors like "Cannot read properties of
  // undefined" — those are real bugs we want surfaced, not staleness.
  const isStaleClaim = (msg: string): boolean => {
    return msg.includes("already claimed") ||
           msg.includes("Cannot claim in state") ||
           msg.includes("Cannot CLAIM") ||
           msg.includes("TERMINAL_STATE");
  };

  /**
   * Poll the wallet balance, watching for an inbound delta that looks like
   * the claim settling. Runs for ~120 seconds or until we see it.
   *
   * Resolves once with either "success" (if balance grew by expected amount)
   * or "timeout" (if it didn't). Never rejects — this is a best-effort check.
   */
  const startClaimWatchdog = useCallback((
    escrowId: string,
    balanceBefore: number,
    expectedDeltaMsats: number,
  ): Promise<"success" | "timeout"> => {
    return new Promise((resolve) => {
      const fedimint = fedimintRef.current;
      if (!fedimint) { resolve("timeout"); return; }

      // Tolerance: accept any delta >= 90% of expected. Fedimint settles can
      // have tiny variances from fee routing, and we'd rather false-positive
      // a success than false-negative it into timeout territory.
      const threshold = Math.floor(expectedDeltaMsats * 0.9);
      const maxTicks = 24;       // 24 * 5s = 120s
      const tickMs = 5_000;
      let ticks = 0;

      const check = async () => {
        // v0.1.66.34: bail out if the hook unmounted while we were
        // asleep. Resolving as "timeout" keeps the promise chain in
        // the claim action sane without leaking state updates into a
        // stale component.
        if (!mountedRef.current) { resolve("timeout"); return; }
        ticks++;
        try {
          const now = await fedimint.getBalance();
          if (!mountedRef.current) { resolve("timeout"); return; }
          updateFedimint({ balanceMsats: now });
          const delta = now - balanceBefore;
          if (delta >= threshold) {
            resolve("success");
            return;
          }
        } catch (e) {
          console.debug("[chama] watchdog getBalance threw:", e);
        }
        if (ticks >= maxTicks) {
          resolve("timeout");
          return;
        }
        setTimeout(check, tickMs);
      };

      setTimeout(check, tickMs);
    });
  }, [updateFedimint]);

  const claimAndRedeemAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const bridge = requireBridge();
    const fedimint = fedimintRef.current;
    // v0.1.66.31: wrap notify so phase:success triggers COMPLETE publish.
    // Best-effort — errors are swallowed (COMPLETE is advisory; the
    // reconciliation hook in loadEscrow will retry on next app reload).
    const userNotify = config?.onClaimProgress;
    const notify = (progress: ClaimPhase) => {
      userNotify?.(progress);
      if (progress.phase === "success") {
        clientRef.current?.complete(progress.escrowId).catch(e =>
          console.debug("[chama] post-claim COMPLETE publish failed:", (e as Error)?.message || e)
        );
      }
    };

    // Snapshot balance before we touch anything, so the watchdog knows
    // what "before" meant. If we can't read balance, the watchdog just
    // times out and the user sees the neutral info toast. No drama.
    let balanceBefore = 0;
    try {
      if (fedimint) balanceBefore = await fedimint.getBalance();
    } catch {}

    // Expected amount back: state.fees.platformMsats and arbiterMsats are
    // taken off the seller share at LOCK, so the winner actually receives
    // the full trade minus those cuts. The state has this as sellerReceivesMsats
    // via the LOCK event metadata — but for simplicity we estimate from the
    // escrow amount and stored fee breakdown.
    const state = client.getState(escrowId);
    const expectedDeltaMsats = state
      ? Math.max(
          0,
          state.amountMsats - state.fees.platformMsats - state.fees.arbiterMsats,
        )
      : 0;

    notify?.({ phase: "submitted", escrowId });

    try {
      const result = await bridge.claimAndRedeem(escrowId);
      // Happy path: federation responded before any timeout. Victory haptic.
      vibrate([100, 50, 100, 50, 200]);
      // Refresh balance immediately; subscription callback will also fire.
      refreshBalanceRef.current?.().catch(() => {});
      notify?.({
        phase: "success",
        escrowId,
        deltaMsats: expectedDeltaMsats,
        viaWatchdog: false,
      });
      return result;
    } catch (e: any) {
      const msg = e?.message || String(e);

      // v0.1.63: partial-success claim — chain correct, redeem in flight
      // ─────────────────────────────────────────────────────────────────
      // The bridge publishes CLAIM before calling redeemWithRetry. If the
      // redeem throws after CLAIM is on relays, the bridge wraps the error
      // with {claimPublished: true}. Treat this as "watching" — the chain
      // is correct, and the balance watchdog will either see the sats
      // land or time out gracefully. No red toast.
      if (e?.claimPublished) {
        console.warn(
          "[chama] Claim published, redeem failed — starting balance watchdog:",
          msg,
        );
        notify?.({ phase: "watching", escrowId, reason: msg });
        startClaimWatchdog(escrowId, balanceBefore, expectedDeltaMsats).then(
          (outcome) => {
            if (outcome === "success") {
              vibrate([100, 50, 100, 50, 200]);
              notify?.({
                phase: "success",
                escrowId,
                deltaMsats: expectedDeltaMsats,
                viaWatchdog: true,
              });
            } else {
              notify?.({ phase: "timeout", escrowId });
            }
          },
          (err) => {
            console.warn("[chama] watchdog rejected unexpectedly:", err);
            notify?.({ phase: "timeout", escrowId });
          },
        );
        return client.getState(escrowId)!;
      }

      // Stale state (escrow already past APPROVED from a relay echo, etc.)
      // — silently return the current local state. No toast.
      if (isStaleClaim(msg)) {
        console.debug("[chama] Claim suppressed (stale):", msg);
        return client.getState(escrowId)!;
      }

      // Hard failure — notify, then re-throw for the UI to red-toast.
      if (isHardClaimFailure(msg)) {
        notify?.({ phase: "failure", escrowId, reason: msg });
        throw e;
      }

      // Probably transient (worker timeout, RPC hiccup, "fetch failed", etc.)
      // The federation very likely IS processing the redeem. Start watching
      // balance instead of throwing.
      console.warn(
        "[chama] Claim bridge threw — treating as in-flight, watching balance.",
        msg,
      );
      notify?.({ phase: "watching", escrowId, reason: msg });

      // Kick the watchdog off, but return immediately so the UI doesn't hang.
      // When watchdog resolves, we notify success/timeout.
      startClaimWatchdog(escrowId, balanceBefore, expectedDeltaMsats).then(
        (outcome) => {
          if (outcome === "success") {
            vibrate([100, 50, 100, 50, 200]);
            notify?.({
              phase: "success",
              escrowId,
              deltaMsats: expectedDeltaMsats,
              viaWatchdog: true,
            });
          } else {
            notify?.({ phase: "timeout", escrowId });
          }
        },
        (err) => {
          console.warn("[chama] watchdog rejected unexpectedly:", err);
          notify?.({ phase: "timeout", escrowId });
        },
      );

      // Return the local state so the UI doesn't show an error state.
      // The state will update naturally as the CLAIM event echoes back
      // from relays (if the bridge managed to publish it before the
      // timeout) or from the next loadEscrow.
      return client.getState(escrowId)!;
    }
  }, [config?.onClaimProgress, startClaimWatchdog]);

  // Forward-reference refreshBalance from within lock/claim actions
  const refreshBalanceRef = useRef<(() => Promise<void>) | null>(null);

  const voteAction = useCallback(async (escrowId: string, outcome: Outcome) => {
    const client = requireClient();
    try {
      const result = await client.vote(escrowId, outcome);
      vibrate(outcome === Outcome.RELEASE ? [80, 40, 80] : [60, 30, 60, 30, 60]);
      return result;
    } catch (e: any) {
      // Swallow known duplicate/stale errors — they're from relay echoes
      const msg = e?.message || "";
      if (msg.includes("already voted") || msg.includes("Cannot vote") ||
          msg.includes("TERMINAL") || msg.includes("not LOCKED")) {
        console.debug("[chama] Vote suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  const sendChat = useCallback(async (escrowId: string, message: string) => {
    const client = requireClient();
    await client.sendChat(escrowId, message);
    vibrate(15); // Subtle tap
  }, []);

  const cancelAction = useCallback(async (escrowId: string, reason?: string) => {
    const client = requireClient();
    const result = await client.cancel(escrowId, reason);
    vibrate([50, 100]);
    return result;
  }, []);

  const loadEscrow = useCallback(async (escrowId: string) => {
    const client = requireClient();
    setState(prev => ({ ...prev, loading: true }));
    try {
      const result = await client.loadEscrow(escrowId);
      if (result) saveEscrowId(escrowId);
      setState(prev => ({ ...prev, loading: false }));
      return result;
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      return null;
    }
  }, []);

  // ── Fedimint actions ────────────────────────────────────────────────────

  const refreshBalance = useCallback(async () => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) return;
    try {
      const balanceMsats = await fedimint.getBalance();
      updateFedimint({ balanceMsats });
    } catch (e) {
      console.debug("[chama] refreshBalance error:", e);
    }
  }, [updateFedimint]);

  // Keep the ref in sync so lock/claim actions can call it without
  // recreating their callbacks.
  refreshBalanceRef.current = refreshBalance;

  const initFedimint = useCallback(async (
    inviteCode?: string,
    options?: { force?: boolean },
  ) => {
    if (!clientRef.current || !signerRef.current) {
      throw new Error("Connect to relays before initializing Fedimint");
    }

    const force = options?.force === true;

    updateFedimint({ busy: true, error: null });

    try {
      // PR 2: resolve via the community-aware path. Precedence is
      // explicit arg > custom stored invite > community.federationInvite
      // > BLF default.
      const userCommunity = getUserCommunitySlug();
      const desiredInvite = inviteCode?.trim()
        || resolveFederationForCommunity(userCommunity);
      const previousActiveInvite = getActiveInvite();

      // Fetch (or generate + publish) the Fedimint seed from Nostr
      // *before* initializing the wallet. The seed is encrypted to the
      // user's own pubkey and stored as a replaceable kind-30078 event,
      // so the wallet is recoverable on any device with access to the
      // user's signer. In testnet mode the mock wallet ignores the
      // mnemonic, so we skip the Nostr round-trip.
      const mnemonic = isTestnetMode()
        ? undefined
        : await getOrCreateSeed(clientRef.current!, signerRef.current!);

      const buildClient = () => new FedimintClient({
        onBalanceUpdate: (balance) => updateFedimint({ balanceMsats: balance }),
        onFederationJoined: (fedId) =>
          updateFedimint({ joined: true, federationId: fedId }),
        onError: (err, ctx) => {
          console.warn(`[chama] fedimint error (${ctx}):`, err);
          updateFedimint({ error: `${ctx}: ${err.message}` });
        },
      });

      // Reuse the in-memory client if init already ran this session;
      // otherwise create + init a fresh one against whatever the OPFS
      // currently holds.
      let fedimint = fedimintRef.current;
      if (!fedimint) {
        fedimint = buildClient();
        await fedimint.init({ mnemonic });
        fedimintRef.current = fedimint;
        updateFedimint({ initialized: true });
      }

      // PR 5 (v0.1.82+): cold-start reconciliation with balance guard.
      // ───────────────────────────────────────────────────────────────
      // After init, the in-memory client mirrors whatever the OPFS
      // holds. If the user's preferred invite differs from the
      // last-joined invite (drift — typically from a previous-session
      // paste that the old "case (b) silent no-op" stored without
      // actually switching), we may need to wipe + rejoin.
      //
      // CRITICAL: ecash on the OPFS-bound fed is bearer cash. A silent
      // wipe destroys it. So before wiping, peek the balance:
      //   - balance === 0           → safe to wipe + rejoin silently
      //   - balance > 0 && !force   → REFUSE; throw structured error
      //                               that the UI catches and surfaces
      //                               as a destroy-confirm modal.
      //   - balance > 0 && force    → user-confirmed destruction;
      //                               proceed.
      //
      // This is the load-bearing safety. Without it, a refresh + wrong
      // fed pick destroys notes purely and simply (reproduced twice
      // during v0.1.81 testing).
      const driftDetected =
        previousActiveInvite !== null
        && previousActiveInvite !== desiredInvite
        && fedimint.isJoined();

      if (driftDetected) {
        let opfsBalanceMsats = 0;
        try {
          opfsBalanceMsats = await fedimint.getBalance();
        } catch (e) {
          // If we can't read the balance, treat as unknown — refuse
          // without force rather than risk silent destruction.
          console.debug("[chama] reconcile: balance read failed:", e);
          opfsBalanceMsats = -1;
        }

        if (!force && opfsBalanceMsats !== 0) {
          const sats = opfsBalanceMsats > 0
            ? Math.floor(opfsBalanceMsats / 1000)
            : null;
          const refuseErr = new Error(
            sats !== null
              ? `Refusing to switch federations: ${sats} sats are held on ` +
                `your current federation and would be permanently destroyed ` +
                `when the local wallet is wiped. Move funds out (Lightning ` +
                `withdrawal) before switching, or confirm destruction explicitly.`
              : `Refusing to switch federations: couldn't verify the local ` +
                `wallet balance. Try again, or confirm destruction explicitly.`,
          );
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).code = "RECONCILE_REFUSED_NONZERO_BALANCE";
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).balanceMsats = opfsBalanceMsats > 0 ? opfsBalanceMsats : 0;
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).previousActiveInvite = previousActiveInvite!;
          (refuseErr as Error & {
            code?: string;
            balanceMsats?: number;
            previousActiveInvite?: string;
            desiredInvite?: string;
          }).desiredInvite = desiredInvite;
          throw refuseErr;
        }

        // Safe-to-wipe path: balance is 0, OR force === true.
        console.warn(
          "[chama] reconcile: wiping OPFS to switch federations",
          {
            previous: previousActiveInvite!.slice(0, 24) + "…",
            desired: desiredInvite.slice(0, 24) + "…",
            balanceMsats: opfsBalanceMsats,
            forced: force,
          },
        );
        try { await fedimint.cleanup(); } catch {}
        fedimintRef.current = null;
        bridgeRef.current = null;
        healthRef.current = { ok: null, at: null };
        try {
          await resetLocalFedimintWallet();
        } catch (e) {
          console.warn("[chama] reconcile wipe threw (non-fatal):", e);
        }
        clearActiveInvite();

        // Re-create + init against the now-empty OPFS so joinFederation
        // below lands on the desired fed cleanly (no v0.1.69 case-c
        // throw, no case-b silent no-op).
        fedimint = buildClient();
        await fedimint.init({ mnemonic });
        fedimintRef.current = fedimint;
      }

      const effectiveInvite = desiredInvite;
      const usingCustom = hasCustomFederation() || !!inviteCode?.trim();

      // Join federation (idempotent in the SDK when already on the
      // same fed; lands cleanly on the new fed when post-wipe).
      const federationId = await fedimint.joinFederation(effectiveInvite);

      // PR 5: record the actually-joined invite so the next cold start
      // can reconcile if the user later switches preference.
      setActiveInvite(effectiveInvite);

      // Construct the bridge now that we have a working wallet
      bridgeRef.current = new EscrowFedimintBridge(
        clientRef.current,
        fedimint,
        signerRef.current
      );

      // Read initial balance
      let balanceMsats = 0;
      try {
        balanceMsats = await fedimint.getBalance();
      } catch {
        // fresh wallet — balance fetch may fail briefly after join
      }

      // v0.1.68: Drain any pending-redemption stash in the background.
      // ─────────────────────────────────────────────────────────────────
      // If a previous session died between CLAIM publish and redeem
      // complete (the sm_moadjfkb_9ue9pd5p failure mode), oobNotes are
      // sitting in localStorage waiting to be redeemed. Fire the drain
      // fire-and-forget: onBalanceUpdate (wired above) will push the
      // new balance into state as redemptions land, so the user sees
      // balance tick up without a blocking spinner on init.
      //
      // Drain errors are already logged inside drainPendingRedemptions;
      // the outer .catch here is defense-in-depth against an unexpected
      // throw outside the per-entry try blocks.
      drainPendingRedemptions(fedimint).catch((e) =>
        console.warn("[chama] pending-redemption drain error:", e)
      );

      // v0.1.69: Seed health check + staleness republish.
      // ─────────────────────────────────────────────────────────────────
      // Query relays for the current seed event and republish if it's
      // older than SEED_REPUBLISH_INTERVAL_MS (7 days). Also records
      // health info (relay count, timestamps) to localStorage for UI
      // consumption in a future release.
      //
      // Fresh-generation case: if getOrCreateSeed just generated a new
      // seed this session, its created_at ≈ now, so the staleness check
      // returns false and no republish happens — satisfying the "only
      // republish on recovery, not fresh generation" rule naturally.
      //
      // Fire-and-forget, matches the v0.1.68 drain pattern. Non-blocking
      // so UI transitions to the "joined" state without waiting.
      if (!isTestnetMode()) {
        checkAndMaybeRepublishSeed(
          clientRef.current!,
          signerRef.current!
        ).catch((e) =>
          console.warn("[chama] seed health check error:", e)
        );
      }

      // PR 5: a successful join is itself proof of reachability — seed
      // the health cache so the first invoice doesn't have to probe.
      const joinedAt = Date.now();
      healthRef.current = { ok: true, at: joinedAt };
      updateFedimint({
        initialized: true,
        joined: true,
        federationId,
        federationName: usingCustom ? "Custom federation" : DEFAULT_FEDERATION_NAME,
        isCustom: usingCustom,
        balanceMsats,
        busy: false,
        error: null,
        lastHealthOk: true,
        lastHealthAt: joinedAt,
      });

      vibrate([40, 20, 40, 20, 80]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      updateFedimint({ busy: false, error: message });
      throw e;
    }
  }, [updateFedimint]);

  const setCustomInvite = useCallback((inviteCode: string) => {
    setCustomFederationInvite(inviteCode);
    updateFedimint({
      isCustom: !!inviteCode.trim(),
      federationName: inviteCode.trim() ? "Custom federation" : DEFAULT_FEDERATION_NAME,
    });
  }, [updateFedimint]);

  // v0.1.76 fund-loss protection: resetLocalWallet refuses to wipe
  // OPFS if there is a non-zero balance, unless caller passes
  // `force: true`. The UI layer is responsible for surfacing the
  // destruction explicitly to the user before passing force.
  const resetLocalWallet = useCallback(async (
    options: { force?: boolean } = {},
  ) => {
    const { force = false } = options;

    // Read the current balance from the live wallet, if any. If we
    // can't read it, treat as "unknown" and refuse without force —
    // we'd rather false-positive than destroy bearer notes.
    let currentBalanceMsats: number | null = null;
    try {
      if (fedimintRef.current) {
        currentBalanceMsats = await fedimintRef.current.getBalance();
      }
    } catch (e) {
      console.debug("[chama] balance read during reset:", e);
    }

    if (!force && currentBalanceMsats !== null && currentBalanceMsats > 0) {
      const sats = Math.floor(currentBalanceMsats / 1000);
      const err = new Error(
        `Refusing to reset local wallet: ${sats} sats would be ` +
        `permanently destroyed (Fedimint ecash is bearer cash and ` +
        `lives only in the local wallet file). Use force=true to ` +
        `override after explicit user confirmation.`,
      );
      (err as Error & { code?: string; balanceMsats?: number }).code =
        "RESET_REFUSED_NONZERO_BALANCE";
      (err as Error & { code?: string; balanceMsats?: number })
        .balanceMsats = currentBalanceMsats;
      throw err;
    }

    // Tear down the in-memory wallet first so the IndexedDB delete isn't
    // blocked by the WASM worker holding the database open.
    try {
      await fedimintRef.current?.cleanup();
    } catch (e) {
      console.debug("[chama] fedimint cleanup during reset:", e);
    }
    fedimintRef.current = null;
    bridgeRef.current = null;
    clearSeedCache();
    healthRef.current = { ok: null, at: null };
    clearActiveInvite();

    await resetLocalFedimintWallet();

    updateFedimint({
      initialized: false,
      joined: false,
      federationId: null,
      balanceMsats: 0,
      busy: false,
      error: null,
      lastHealthOk: null,
      lastHealthAt: null,
    });
  }, [updateFedimint]);

  // PR 5: switchFederation — production-grade fed switching.
  // ──────────────────────────────────────────────────────────────────────
  // Composed action: reset + reinit-with-new-invite, as one user-facing
  // operation. Promoted from devSwitchFederation in PR 5 — the prior
  // localStorage.chama_dev_fed_switch gate has been dropped.
  //
  // Safety: the v0.1.76 fund-loss guard refuses if `getBalance() > 0`
  // unless `{ force: true }` is passed. Fedimint ecash is bearer cash
  // and lives only in the local OPFS file — wiping it without checking
  // has destroyed real user sats in the past. Callers (UI) must only
  // pass force after explicit user confirmation.
  const switchFederation = useCallback(async (
    inviteCode: string,
    options: { force?: boolean } = {},
  ) => {
    const { force = false } = options;

    const trimmed = inviteCode.trim();
    if (!trimmed.startsWith("fed1")) {
      throw new Error("Invite code must start with 'fed1'");
    }

    // v0.1.76 fund-loss protection: balance-aware refusal.
    let currentBalanceMsats: number | null = null;
    try {
      if (fedimintRef.current) {
        currentBalanceMsats = await fedimintRef.current.getBalance();
      }
    } catch (e) {
      console.debug("[chama] switch-fed: balance read failed:", e);
    }
    if (!force && currentBalanceMsats !== null && currentBalanceMsats > 0) {
      const sats = Math.floor(currentBalanceMsats / 1000);
      const err = new Error(
        `Refusing federation switch: ${sats} sats would be permanently ` +
        `destroyed when the OPFS file is wiped for the new federation. ` +
        `Move funds out (Lightning withdrawal) before switching, or ` +
        `confirm destruction explicitly in the UI.`,
      );
      (err as Error & { code?: string; balanceMsats?: number }).code =
        "SWITCH_REFUSED_NONZERO_BALANCE";
      (err as Error & { code?: string; balanceMsats?: number })
        .balanceMsats = currentBalanceMsats;
      throw err;
    }

    console.info("[chama] switching federation to", trimmed.slice(0, 24) + "...");
    updateFedimint({ busy: true, error: null });

    try {
      // Step 1 — tear down the current wallet (terminates worker, releases OPFS handle)
      try {
        await fedimintRef.current?.cleanup();
      } catch (e) {
        console.debug("[chama] switch-fed: cleanup threw (non-fatal):", e);
      }
      fedimintRef.current = null;
      bridgeRef.current = null;
      clearSeedCache();
      healthRef.current = { ok: null, at: null };
      // Clear the active-invite record now; initFedimint(trimmed) below
      // will write the new one once the join succeeds.
      clearActiveInvite();

      // Step 2 — wipe OPFS file + rotate filename so init() opens a fresh DB
      await resetLocalFedimintWallet();

      // Step 3 — persist the new invite as the custom override so future
      // reloads stay on this fed (matches the one-time onJoinPreset flow
      // for non-default presets in FederationJoinPanel).
      setCustomFederationInvite(trimmed);

      // Step 4 — clear React state so initFedimint can rebuild from scratch.
      // Reset health probe cache too — the new fed needs its own probe.
      updateFedimint({
        initialized: false,
        joined: false,
        federationId: null,
        balanceMsats: 0,
        lastHealthOk: null,
        lastHealthAt: null,
        busy: true,
        error: null,
      });

      // Step 5 — re-init with the new invite. Reuses the existing
      // initFedimint flow which probes the Nostr seed, joins the new
      // fed, and wires up the balance subscriber.
      await initFedimint(trimmed);

      console.info("[chama] federation switch complete");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[chama] federation switch failed:", message);
      updateFedimint({ busy: false, error: message });
      throw e;
    }
  }, [updateFedimint, initFedimint]);

  // PR 5: federation health gate.
  // ──────────────────────────────────────────────────────────────────────
  // Invoice generation is the moment users discover whether the federation
  // can actually transact. A successful join proves reachability at join
  // time, but mid-session the federation may go unreachable (the iroh-
  // canary failure mode) without producing any other surface signal. If
  // we let the user generate an invoice against an unreachable federation,
  // payments to it become orphaned.
  //
  // Cache discipline: 30s TTL. After a successful join/switch we seed
  // ok=true so the first invoice within 30s is fast. Failed probes are
  // also cached — repeat clicks within 30s see the same refusal without
  // hammering the federation.
  const HEALTH_TTL_MS = 30_000;

  const createFundingInvoice = useCallback(async (
    amountMsats: number,
    description: string = "Chama wallet top-up"
  ) => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) {
      throw new Error("Join a federation before creating an invoice");
    }

    // Health gate: refuse if the most recent probe failed and is still
    // fresh; probe now if the cache is stale or empty.
    const cached = healthRef.current;
    const now = Date.now();
    const fresh = cached.at !== null && (now - cached.at) < HEALTH_TTL_MS;

    let healthy: boolean;
    if (fresh && cached.ok !== null) {
      healthy = cached.ok;
    } else {
      try {
        await fedimint.probeFederation();
        healthy = true;
        healthRef.current = { ok: true, at: now };
        updateFedimint({ lastHealthOk: true, lastHealthAt: now });
      } catch (e) {
        healthy = false;
        healthRef.current = { ok: false, at: now };
        updateFedimint({ lastHealthOk: false, lastHealthAt: now });
        console.warn("[chama] federation probe failed:", e);
      }
    }

    if (!healthy) {
      const fedName = stateRef.current?.fedimint.federationName ?? "(unknown)";
      throw new Error(
        `Wallet temporarily can't receive — federation ${fedName} unreachable. ` +
        `Try again in a moment.`,
      );
    }

    return fedimint.createInvoice(amountMsats, description);
  }, [updateFedimint]);

  // ── Return ──────────────────────────────────────────────────────────────

  const actions: UseEscrowActions = {
    connect,
    disconnect,
    createEscrow,
    joinEscrow,
    lockAndPublish: lockAndPublishAction,
    vote: voteAction,
    releasePeriod: async (escrowId: string, periodIndex: number) => {
      if (!clientRef.current) throw new Error("Not connected");
      const newState = await clientRef.current.releasePeriod(escrowId, periodIndex);
      updateEscrow(escrowId, newState);
      return newState;
    },
    claimAndRedeem: claimAndRedeemAction,
    sendChat,
    cancel: cancelAction,
    loadEscrow,
    vibrate,
    initFedimint,
    setCustomInvite,
    createFundingInvoice,
    payInvoice: async (bolt11: string) => {
      const bridge = requireBridge();
      await bridge.payInvoice(bolt11);
      refreshBalanceRef.current?.().catch(() => {});
    },
    spendNotes: async (amountMsats: number) => {
      const bridge = requireBridge();
      const notes = await bridge.spendNotes(amountMsats);
      refreshBalanceRef.current?.().catch(() => {});
      return notes;
    },
    refreshBalance,
    resetLocalWallet,
    switchFederation,
    watchPublicListings: (since?: number) => {
      clientRef.current?.watchPublicListings(since);
    },
    getCommunity: getUserCommunitySlug,
    setCommunity: setUserCommunitySlug,
  };

  return [state, actions];
}
