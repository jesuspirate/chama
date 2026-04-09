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

// ── Hook state ────────────────────────────────────────────────────────────

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
  /** Lock ecash (simulated for testing) */
  simulatedLock: (escrowId: string) => Promise<EscrowState>;
  /** Cast a vote */
  vote: (escrowId: string, outcome: Outcome) => Promise<EscrowState>;
  /** Claim ecash (winner only) */
  claim: (escrowId: string, notesHash: string) => Promise<EscrowState>;
  /** Send a chat message */
  sendChat: (escrowId: string, message: string) => Promise<void>;
  /** Cancel a trade (initiator only, pre-lock) */
  cancel: (escrowId: string, reason?: string) => Promise<EscrowState>;
  /** Load an escrow from relays by ID */
  loadEscrow: (escrowId: string) => Promise<EscrowState | null>;
  /** Trigger haptic feedback */
  vibrate: (pattern?: number | number[]) => void;
}

// ── Default relay list ────────────────────────────────────────────────────

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
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

  const [state, setState] = useState<UseEscrowState>({
    connected: false,
    pubkey: null,
    escrows: new Map(),
    relayStatuses: new Map(),
    connectedRelays: 0,
    error: null,
    loading: false,
  });

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
        signer = detectSigner();
      } catch {
        // Fallback: try NIP-07 with a delay (extensions sometimes load late)
        await new Promise(r => setTimeout(r, 500));
        try {
          signer = detectSigner();
        } catch (e) {
          throw new Error("No Nostr signer found. Install a NIP-07 extension (nos2x, Alby) or open in Fedi.");
        }
      }

      const pubkey = await signer.getPublicKey();

      const callbacks: EscrowClientCallbacks = {
        onStateUpdate: (id, s) => updateEscrow(id, s),
        onChatMessage: (id, msg) => {
          // Chat messages are embedded in escrow state via the engine
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

      // Auto-reload saved escrows from relays
      const savedIds = getSavedEscrowIds();
      if (savedIds.length > 0) {
        console.log(`[chama] Reloading ${savedIds.length} saved escrow(s)...`);
        for (const id of savedIds.slice(0, 10)) { // Max 10 to avoid hammering relays
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
    setState({
      connected: false,
      pubkey: null,
      escrows: new Map(),
      relayStatuses: new Map(),
      connectedRelays: 0,
      error: null,
      loading: false,
    });
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
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
    const result = await client.joinEscrow(escrowId, role);
    saveEscrowId(escrowId);
    vibrate([30, 20, 30]);
    return result;
  }, []);

  const simulatedLockAction = useCallback(async (escrowId: string) => {
    const client = requireClient();
    try {
      const result = await client.simulatedLock(escrowId);
      vibrate([60, 30, 60, 30, 120]);
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

  const claimAction = useCallback(async (escrowId: string, notesHash: string) => {
    const client = requireClient();
    try {
      const result = await client.claim(escrowId, notesHash);
      vibrate([100, 50, 100, 50, 200]);
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

  // ── Return ──────────────────────────────────────────────────────────────

  const actions: UseEscrowActions = {
    connect,
    disconnect,
    createEscrow,
    joinEscrow,
    simulatedLock: simulatedLockAction,
    vote: voteAction,
    claim: claimAction,
    sendChat,
    cancel: cancelAction,
    loadEscrow,
    vibrate,
  };

  return [state, actions];
}
