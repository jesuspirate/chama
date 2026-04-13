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
  getFederationInvite,
  setCustomFederationInvite,
  hasCustomFederation,
  DEFAULT_FEDERATION_NAME,
  getOrCreateSeed,
  clearSeedCache,
  isTestnetMode,
  resetLocalFedimintWallet,
} from "../fedimint/index.js";

// ── Hook state ────────────────────────────────────────────────────────────

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
  /** Join an existing escrow */
  joinEscrow: (escrowId: string, role: Role) => Promise<EscrowState>;
  /** Confirm ready for locking (pre-lock safety check) */
  confirmReady: (escrowId: string) => Promise<EscrowState>;
  /** Kick an unresponsive participant (pre-lock only) */
  kickParticipant: (escrowId: string, targetRole: Role, reason: string) => Promise<EscrowState>;
  /**
   * Lock ecash into 2-of-3 SSS escrow.
   * Runs the full real-Fedimint flow:
   *   spendNotes → Shamir split → NIP-44 encrypt shares → publish LOCK
   */
  lockAndPublish: (escrowId: string) => Promise<EscrowState>;
  /** Cast a vote */
  vote: (escrowId: string, outcome: Outcome) => Promise<EscrowState>;
  /**
   * Claim ecash as the winner.
   * Runs the full real-Fedimint flow:
   *   decrypt shares → Shamir combine → verify hash → redeemEcash → publish CLAIM
   */
  claimAndRedeem: (escrowId: string) => Promise<EscrowState>;
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
   * or falls back to the Bitcoin Life Federation default.
   * Idempotent: safe to call multiple times.
   */
  initFedimint: (inviteCode?: string) => Promise<void>;
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
  /** Refresh the current balance from the wallet */
  refreshBalance: () => Promise<void>;
  /**
   * Wipe the local Fedimint wallet's IndexedDB and reset in-memory state.
   * Use this to recover from a "No modification allowed" seed-mismatch error
   * or any other stuck-state issue. Destructive to *local* state only — the
   * Nostr-backed seed survives and will be re-installed on next initFedimint().
   */
  resetLocalWallet: () => Promise<void>;
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

export function useEscrow(config?: Partial<EscrowClientConfig>): [UseEscrowState, UseEscrowActions] {
  const clientRef = useRef<EscrowClient | null>(null);
  const fedimintRef = useRef<FedimintClient | null>(null);
  const bridgeRef = useRef<EscrowFedimintBridge | null>(null);
  const signerRef = useRef<Signer | null>(null);

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
    },
  });

  const updateFedimint = useCallback((partial: Partial<FedimintState>) => {
    setState(prev => ({ ...prev, fedimint: { ...prev.fedimint, ...partial } }));
  }, []);

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

      setState(prev => ({
        ...prev,
        connected: true,
        pubkey,
        loading: false,
      }));

      vibrate([50, 30, 50]); // Connected haptic

      // Start periodic expiry checker — every 60 seconds, check all loaded escrows
      const expiryInterval = setInterval(async () => {
        if (!clientRef.current) return;
        const escrowClient = clientRef.current;
        const now = Math.floor(Date.now() / 1000);
        for (const [escrowId, escrowState] of (escrowClient as any).states || []) {
          if (escrowState.status === "LOCKED" && now > escrowState.expiresAt) {
            try {
              await (escrowClient as any).maybeAutoRefundExpired?.(escrowId);
            } catch {}
          }
        }
      }, 60_000);
      // Store interval for cleanup
      (clientRef as any)._expiryInterval = expiryInterval;

      // Auto-reload saved escrows — wait for relays to connect first
      const savedIds = getSavedEscrowIds();
      if (savedIds.length > 0) {
        // Wait for at least 2 relays to connect (up to 5 seconds)
        let waited = 0;
        while (waited < 5000) {
          const connectedCount = [...client.relayManager.relays.values()]
            .filter((r: any) => r.status === "connected").length;
          if (connectedCount >= 2) break;
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
        const finalConnected = [...client.relayManager.relays.values()]
          .filter((r: any) => r.status === "connected").length;
        console.log(`[chama] Reloading ${savedIds.length} saved escrow(s) with ${finalConnected} relays connected...`);
        for (const id of savedIds.slice(0, 10)) {
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
      },
    });
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────

  useEffect(() => {
    return () => {
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
    const result = await client.createEscrow(params);
    saveEscrowId(result.escrowId);
    vibrate([40, 20, 40, 20, 80]); // Celebratory haptic
    return result;
  }, []);

  const joinEscrow = useCallback(async (escrowId: string, role: Role) => {
    const client = requireClient();
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

  const kickParticipantAction = useCallback(async (escrowId: string, targetRole: Role, reason: string) => {
    const client = requireClient();
    const result = await client.kickParticipant(escrowId, targetRole, reason);
    vibrate([80, 40, 80]);
    return result;
  }, []);

  const confirmReadyAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    try {
      const result = await client.confirmReady(escrowId);
      vibrate([30, 15, 30]);
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("ALREADY_READY") || msg.includes("already confirmed")) {
        console.debug("[chama] Ready suppressed:", msg);
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

  const lockAndPublishAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      const result = await bridge.lockAndPublish(escrowId);
      vibrate([60, 30, 60, 30, 120]);
      // Refresh balance after spending ecash
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("expected FUNDED") || msg.includes("Cannot LOCK") ||
          msg.includes("TERMINAL")) {
        console.debug("[chama] Lock suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

  const claimAndRedeemAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    const bridge = requireBridge();
    try {
      const result = await bridge.claimAndRedeem(escrowId);
      vibrate([100, 50, 100, 50, 200]);
      // Refresh balance after redeeming ecash
      refreshBalanceRef.current?.().catch(() => {});
      return result;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("already") || msg.includes("Cannot") ||
          msg.includes("TERMINAL") || msg.includes("not APPROVED")) {
        console.debug("[chama] Claim suppressed:", msg);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);

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

  const initFedimint = useCallback(async (inviteCode?: string) => {
    if (!clientRef.current || !signerRef.current) {
      throw new Error("Connect to relays before initializing Fedimint");
    }

    updateFedimint({ busy: true, error: null });

    try {
      // Reuse existing instance if already initialized
      let fedimint = fedimintRef.current;
      if (!fedimint) {
        // Fetch (or generate + publish) the Fedimint seed from Nostr
        // *before* initializing the wallet. The seed is encrypted
        // to the user's own pubkey and stored as a replaceable
        // kind-30078 event, so the wallet is recoverable on any
        // device with access to the user's signer.
        //
        // In testnet mode the mock wallet ignores the mnemonic, so
        // we skip the Nostr round-trip to avoid a gratuitous NIP-44
        // popup on every dev reload.
        const mnemonic = isTestnetMode()
          ? undefined
          : await getOrCreateSeed(
              clientRef.current!,
              signerRef.current!
            );

        fedimint = new FedimintClient({
          onBalanceUpdate: (balance) => updateFedimint({ balanceMsats: balance }),
          onFederationJoined: (fedId) =>
            updateFedimint({ joined: true, federationId: fedId }),
          onError: (err, ctx) => {
            console.warn(`[chama] fedimint error (${ctx}):`, err);
            updateFedimint({ error: `${ctx}: ${err.message}` });
          },
        });
        await fedimint.init({ mnemonic });
        fedimintRef.current = fedimint;
        updateFedimint({ initialized: true });
      }

      // Resolve the invite code: explicit arg > stored custom > BLF default
      const effectiveInvite = inviteCode?.trim() || getFederationInvite();
      const usingCustom = hasCustomFederation() || !!inviteCode?.trim();

      // Join federation (idempotent in the SDK)
      const federationId = await fedimint.joinFederation(effectiveInvite);

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

      updateFedimint({
        initialized: true,
        joined: true,
        federationId,
        federationName: usingCustom ? "Custom federation" : DEFAULT_FEDERATION_NAME,
        isCustom: usingCustom,
        balanceMsats,
        busy: false,
        error: null,
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

  const resetLocalWallet = useCallback(async () => {
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

    await resetLocalFedimintWallet();

    updateFedimint({
      initialized: false,
      joined: false,
      federationId: null,
      balanceMsats: 0,
      busy: false,
      error: null,
    });
  }, [updateFedimint]);

  const createFundingInvoice = useCallback(async (
    amountMsats: number,
    description: string = "Chama wallet top-up"
  ) => {
    const fedimint = fedimintRef.current;
    if (!fedimint || !fedimint.isJoined()) {
      throw new Error("Join a federation before creating an invoice");
    }
    return fedimint.createInvoice(amountMsats, description);
  }, []);

  // ── Return ──────────────────────────────────────────────────────────────

  const actions: UseEscrowActions = {
    connect,
    disconnect,
    createEscrow,
    joinEscrow,
    confirmReady: confirmReadyAction,
    kickParticipant: kickParticipantAction,
    lockAndPublish: lockAndPublishAction,
    vote: voteAction,
    claimAndRedeem: claimAndRedeemAction,
    sendChat,
    cancel: cancelAction,
    loadEscrow,
    vibrate,
    initFedimint,
    setCustomInvite,
    createFundingInvoice,
    refreshBalance,
    resetLocalWallet,
  };

  return [state, actions];
}
