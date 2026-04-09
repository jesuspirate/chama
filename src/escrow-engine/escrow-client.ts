// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Escrow Client
// ══════════════════════════════════════════════════════════════════════════
//
// High-level orchestrator that connects:
//   - Relay manager (network)
//   - Event parser (Nostr → typed events)
//   - State machine (typed events → state)
//   - NIP-44 encryption (content privacy)
//   - Event signing (Nostr identity)
//
// This is the API the UI layer calls. One method per user action.
//
// The client is agnostic about WHERE keys/signing come from:
//   - NIP-07 browser extension (window.nostr)
//   - Fedi Mini-App runtime (fediInternal)
//   - Local keypair (for testing)
//   - Amber / remote signer
//
// Signing and encryption are injected via the Signer interface.

import {
  EscrowEventKind,
  EscrowStatus,
  Role,
  Outcome,
  TAGS,
  type NostrEvent,
  type EscrowState,
  type ParsedEscrowEvent,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type ChatPayload,
  type EscrowPayload,
} from "./types.js";

import { applyEvent, replayEventChain, canVote, getWinner, type TransitionResult } from "./state-machine.js";
import { parseEscrowEvent, sortEventChain } from "./event-parser.js";
import { RelayManager, type NostrFilter } from "./relay-manager.js";

// ══════════════════════════════════════════════════════════════════════════
// SIGNER INTERFACE — Injected dependency for key operations
// ══════════════════════════════════════════════════════════════════════════

/**
 * Abstract signing/encryption interface.
 *
 * Implementations:
 *   - NIP07Signer: uses window.nostr (browser extension)
 *   - FediSigner: uses fediInternal APIs (Fedi Mini-App)
 *   - LocalSigner: uses a local keypair (testing / CLI)
 */
export interface Signer {
  /** Get the user's public key (hex) */
  getPublicKey(): Promise<string>;

  /**
   * Sign a Nostr event (set pubkey, id, sig fields).
   * Input is an unsigned event (no id, no sig, no pubkey).
   * Returns a fully signed event.
   */
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;

  /**
   * NIP-44 encrypt content for a recipient.
   * Returns the encrypted string to put in event.content.
   */
  nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string>;

  /**
   * NIP-44 decrypt content from a sender.
   * Returns the plaintext string.
   */
  nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string>;
}

/** Unsigned event template — the client builds these, the signer completes them */
export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT EVENTS — Callbacks for the UI layer
// ══════════════════════════════════════════════════════════════════════════

export interface EscrowClientCallbacks {
  /** Called when any escrow state changes (new event processed) */
  onStateUpdate?: (escrowId: string, state: EscrowState) => void;
  /** Called when a new chat message arrives */
  onChatMessage?: (escrowId: string, message: ParsedEscrowEvent<ChatPayload>) => void;
  /** Called when an event fails validation */
  onValidationError?: (escrowId: string, error: string, eventId?: string) => void;
  /** Called when relay connectivity changes */
  onRelayStatus?: (relayUrl: string, status: string) => void;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT CONFIG
// ══════════════════════════════════════════════════════════════════════════

export interface EscrowClientConfig {
  /** Relay URLs to connect to */
  relays: string[];
  /** Default platform fee in basis points */
  defaultPlatformFeeBps?: number;
  /** Platform fee recipient pubkey */
  platformFeePubkey?: string;
  /** Default expiry in seconds */
  defaultExpirySeconds?: number;
  /** WebSocket implementation (for Node.js) */
  wsImpl?: typeof WebSocket;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT
// ══════════════════════════════════════════════════════════════════════════

export class EscrowClient {
  private relayManager: RelayManager;
  private signer: Signer;
  private config: EscrowClientConfig;
  private callbacks: EscrowClientCallbacks;

  /** Cached escrow states — escrowId → state */
  private states: Map<string, EscrowState> = new Map();

  /** Raw events per escrow — escrowId → events[] */
  private rawEvents: Map<string, NostrEvent[]> = new Map();

  /** Active subscriptions */
  private subscriptions: Map<string, string> = new Map(); // label → subId

  /** Our pubkey (cached after first call) */
  private _pubkey: string | null = null;

  constructor(
    signer: Signer,
    config: EscrowClientConfig,
    callbacks: EscrowClientCallbacks = {}
  ) {
    this.signer = signer;
    this.config = {
      defaultPlatformFeeBps: 50,
      defaultExpirySeconds: 86_400,
      ...config,
    };
    this.callbacks = callbacks;

    this.relayManager = new RelayManager(
      config.relays,
      {
        onEvent: (event, relay) => this.handleIncomingEvent(event, relay),
        onStatusChange: (relay, status) => this.callbacks.onRelayStatus?.(relay, status),
        onError: (err, relay) => console.warn(`[relay] ${relay}: ${err.message}`),
      },
      config.wsImpl
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  connect(): void {
    this.relayManager.connect();
  }

  disconnect(): void {
    this.relayManager.disconnect();
    this.states.clear();
    this.rawEvents.clear();
  }

  async getPubkey(): Promise<string> {
    if (!this._pubkey) {
      this._pubkey = await this.signer.getPublicKey();
    }
    return this._pubkey;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USER ACTIONS — One method per thing the UI can do
  // ══════════════════════════════════════════════════════════════════════════

  // ── Create a new escrow trade ───────────────────────────────────────────

  async createEscrow(params: {
    description: string;
    amountMsats: number;
    fiatAmount?: number;
    fiatCurrency?: string;
    category: string;
    mintUrl: string;
    paymentMethods?: string[];
    arbiterFeeMsats?: number;
    expirySeconds?: number;
  }): Promise<{ escrowId: string; state: EscrowState }> {
    const pubkey = await this.getPubkey();
    const now = Math.floor(Date.now() / 1000);
    const escrowId = this.generateEscrowId();

    const payload: CreatePayload = {
      type: "escrow:create",
      description: params.description,
      amountMsats: params.amountMsats,
      fiatAmount: params.fiatAmount,
      fiatCurrency: params.fiatCurrency,
      category: params.category,
      mintUrl: params.mintUrl,
      platformFeeBps: this.config.defaultPlatformFeeBps!,
      platformFeePubkey: this.config.platformFeePubkey || pubkey,
      arbiterFeeMsats: params.arbiterFeeMsats,
      paymentMethods: params.paymentMethods,
      expirySeconds: params.expirySeconds || this.config.defaultExpirySeconds!,
      createdAt: now,
    };

    // CREATE content is PLAINTEXT — trade terms are public (marketplace discovery).
    // Only LOCK/VOTE/CLAIM/CHAT events get NIP-44 encrypted.
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CREATE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:create"],
        [TAGS.AMOUNT, String(params.amountMsats)],
        [TAGS.MINT, params.mintUrl],
        ...(params.fiatCurrency ? [[TAGS.CURRENCY, params.fiatCurrency]] : []),
        ...(params.category ? [[TAGS.CATEGORY, params.category]] : []),
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    // Apply locally immediately (optimistic)
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local parse failed: ${parsed.error.message}`);

    const result = applyEvent(null, parsed.event);
    if (!result.ok) throw new Error(`Local apply failed: ${result.error.message}`);

    this.states.set(escrowId, result.state);
    this.rawEvents.set(escrowId, [signed]);
    this.callbacks.onStateUpdate?.(escrowId, result.state);

    // Subscribe to this escrow's events
    this.watchEscrow(escrowId);

    return { escrowId, state: result.state };
  }

  // ── Join an existing escrow ─────────────────────────────────────────────

  async joinEscrow(escrowId: string, role: Role): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: JoinPayload = {
      type: "escrow:join",
      role,
      joinedAt: now,
    };

    // JOIN content is PLAINTEXT — who joined is public info.
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.JOIN,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:join"],
        [TAGS.PARTICIPANT, pubkey],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Simulated lock (for testing without Fedimint WASM) ──────────────────

  async simulatedLock(escrowId: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);
    if (state.status !== EscrowStatus.FUNDED) {
      throw new Error(`Cannot lock — status is ${state.status}, expected FUNDED`);
    }

    const buyerPk = state.participants.buyer || "mock_buyer";
    const sellerPk = state.participants.seller || "mock_seller";
    const arbiterPk = state.participants.arbiter || "mock_arbiter";

    const platformFeeMsats = Math.floor((state.amountMsats * state.fees.platformBps) / 10_000);
    const arbiterFeeMsats = state.fees.arbiterMsats;
    const sellerReceivesMsats = state.amountMsats - platformFeeMsats - arbiterFeeMsats;

    // Mock SSS shares (will be replaced with real Shamir when Fedimint WASM is wired)
    const mockHash = "sim_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

    return this.lockEscrow(escrowId, {
      notesHash: mockHash,
      shares: [
        { recipientPubkey: buyerPk, encryptedShare: "sim_share_0_" + mockHash, shareIndex: 0 },
        { recipientPubkey: sellerPk, encryptedShare: "sim_share_1_" + mockHash, shareIndex: 1 },
        { recipientPubkey: arbiterPk, encryptedShare: "sim_share_2_" + mockHash, shareIndex: 2 },
      ],
      sellerReceivesMsats,
      arbiterFeeMsats,
      platformFeeMsats,
    });
  }

  // ── Lock ecash in SSS escrow ────────────────────────────────────────────

  async lockEscrow(escrowId: string, params: {
    notesHash: string;
    shares: { recipientPubkey: string; encryptedShare: string; shareIndex: number }[];
    sellerReceivesMsats: number;
    arbiterFeeMsats: number;
    platformFeeMsats: number;
  }): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: LockPayload = {
      type: "escrow:lock",
      notesHash: params.notesHash,
      shares: params.shares,
      sellerReceivesMsats: params.sellerReceivesMsats,
      arbiterFeeMsats: params.arbiterFeeMsats,
      platformFeeMsats: params.platformFeeMsats,
      lockedAt: now,
    };

    // For testing: plaintext. In production with real ecash, this will be NIP-44 encrypted.
    // TODO: Re-enable NIP-44 encryption when Fedimint WASM is integrated
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.LOCK,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:lock"],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Cast a vote ─────────────────────────────────────────────────────────

  async vote(escrowId: string, outcome: Outcome): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const voteCheck = canVote(state, pubkey);
    if (!voteCheck.canVote) throw new Error(`Cannot vote: ${voteCheck.reason}`);

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: VotePayload = {
      type: "escrow:vote",
      outcome,
      role,
      votedAt: now,
    };

    // Plaintext for testing. TODO: NIP-44 encrypt when Fedimint WASM integrated
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.VOTE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:vote"],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    const newState = this.applyLocally(escrowId, signed, payload);

    // Auto-resolve if 2-of-3 threshold is met
    await this.maybeAutoResolve(escrowId);

    return newState;
  }

  // ── Claim ecash (winner only) ───────────────────────────────────────────

  async claim(escrowId: string, notesHashVerification: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const winner = getWinner(state);
    if (!winner || winner.pubkey !== pubkey) {
      throw new Error("You are not the winner of this escrow");
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: ClaimPayload = {
      type: "escrow:claim",
      claimerRole: winner.role,
      notesHashVerification,
      claimedAt: now,
    };

    // Plaintext for testing. TODO: NIP-44 encrypt for production
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CLAIM,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:claim"],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Send a chat message ─────────────────────────────────────────────────

  async sendChat(escrowId: string, message: string): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const now = Math.floor(Date.now() / 1000);

    const payload: ChatPayload = {
      type: "escrow:chat",
      message,
      senderRole: role,
      sentAt: now,
    };

    // Plaintext for testing. TODO: NIP-44 encrypt for production
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CHAT,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:chat"],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);
  }

  // ── Cancel (initiator only, pre-lock) ───────────────────────────────────

  async cancel(escrowId: string, reason?: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    if (pubkey !== state.initiator.pubkey) {
      throw new Error("Only the initiator can cancel");
    }

    const role = this.getMyRole(state, pubkey);
    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: CancelPayload = {
      type: "escrow:cancel",
      cancellerRole: role!,
      reason,
      cancelledAt: now,
    };

    // Plaintext for testing. TODO: NIP-44 encrypt for production
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CANCEL,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:cancel"],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES — Read-only access for the UI
  // ══════════════════════════════════════════════════════════════════════════

  getState(escrowId: string): EscrowState | null {
    return this.states.get(escrowId) || null;
  }

  getAllStates(): Map<string, EscrowState> {
    return new Map(this.states);
  }

  getMyRole(state: EscrowState, pubkey?: string): Role | null {
    const pk = pubkey || this._pubkey;
    if (!pk) return null;
    if (state.participants[Role.BUYER] === pk) return Role.BUYER;
    if (state.participants[Role.SELLER] === pk) return Role.SELLER;
    if (state.participants[Role.ARBITER] === pk) return Role.ARBITER;
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ESCROW DISCOVERY — Watch for trades and load state
  // ══════════════════════════════════════════════════════════════════════════

  /** Subscribe to live updates for a specific escrow */
  watchEscrow(escrowId: string): void {
    const label = `escrow:${escrowId}`;
    if (this.subscriptions.has(label)) return;
    const subId = this.relayManager.subscribeToEscrow(escrowId);
    this.subscriptions.set(label, subId);
  }

  /** Stop watching a specific escrow */
  unwatchEscrow(escrowId: string): void {
    const label = `escrow:${escrowId}`;
    const subId = this.subscriptions.get(label);
    if (subId) {
      this.relayManager.unsubscribe(subId);
      this.subscriptions.delete(label);
    }
  }

  /** Fetch and reconstruct full escrow state from relays */
  async loadEscrow(escrowId: string): Promise<EscrowState | null> {
    const rawEvents = await this.relayManager.fetchEscrowEvents(escrowId);
    if (rawEvents.length === 0) return null;

    // Parse all events — try plaintext JSON first, then NIP-44 decrypt.
    // CREATE and JOIN are plaintext; LOCK/VOTE/CLAIM/CHAT are encrypted.
    const parsed: ParsedEscrowEvent[] = [];
    for (const raw of rawEvents) {
      let content: string | null = null;

      // Try 1: plaintext JSON (CREATE, JOIN, CANCEL, COMPLETE, RESOLVE)
      try {
        const test = JSON.parse(raw.content);
        if (test && typeof test.type === "string" && test.type.startsWith("escrow:")) {
          content = raw.content;
        }
      } catch {
        // Not valid JSON — likely NIP-44 encrypted
      }

      // Try 2: NIP-44 decrypt (LOCK, VOTE, CLAIM, CHAT)
      if (!content) {
        try {
          content = await this.signer.nip44Decrypt(raw.content, raw.pubkey);
        } catch {
          // Can't decrypt — encrypted to another participant, skip
          console.warn(`[escrow] Skipping undecryptable event ${raw.id.slice(0, 8)}…`);
          continue;
        }
      }

      const result = parseEscrowEvent(raw, content, true);
      if (result.ok) parsed.push(result.event);
    }

    if (parsed.length === 0) return null;

    // Sort by dependency chain and replay
    const sorted = sortEventChain(parsed);
    const result = replayEventChain(sorted);

    if (!result.ok) {
      this.callbacks.onValidationError?.(escrowId, result.error.message, result.error.eventId);
      return null;
    }

    this.states.set(escrowId, result.state);
    this.rawEvents.set(escrowId, rawEvents);

    // Start watching for live updates
    this.watchEscrow(escrowId);

    return result.state;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL — Event processing pipeline
  // ══════════════════════════════════════════════════════════════════════════

  /** Handle an incoming event from any relay */
  private async handleIncomingEvent(event: NostrEvent, relayUrl: string): Promise<void> {
    // Check if this is an escrow event kind
    const validKinds = new Set(Object.values(EscrowEventKind).filter(v => typeof v === "number"));
    if (!validKinds.has(event.kind)) return;

    // Extract escrow ID from d-tag
    const dTag = event.tags.find(t => t[0] === TAGS.ESCROW_ID);
    if (!dTag?.[1]) return;
    const escrowId = dTag[1];

    // Try plaintext JSON first (CREATE, JOIN), then NIP-44 decrypt (LOCK, VOTE, etc.)
    let decrypted: string | null = null;
    try {
      const test = JSON.parse(event.content);
      if (test && typeof test.type === "string" && test.type.startsWith("escrow:")) {
        decrypted = event.content;
      }
    } catch {
      // Not plaintext JSON — try NIP-44
    }
    if (!decrypted) {
      try {
        decrypted = await this.signer.nip44Decrypt(event.content, event.pubkey);
      } catch {
        // Can't decrypt — encrypted to another participant, ignore
        return;
      }
    }

    // Parse
    const parseResult = parseEscrowEvent(event, decrypted, true);
    if (!parseResult.ok) {
      this.callbacks.onValidationError?.(escrowId, parseResult.error.message, event.id);
      return;
    }

    const parsed = parseResult.event;

    // Handle chat separately
    if (parsed.kind === EscrowEventKind.CHAT) {
      const state = this.states.get(escrowId);
      if (state) {
        const result = applyEvent(state, parsed);
        if (result.ok) {
          this.states.set(escrowId, result.state);
          this.callbacks.onChatMessage?.(escrowId, parsed as ParsedEscrowEvent<ChatPayload>);
        }
      }
      return;
    }

    // Apply to state machine
    const currentState = this.states.get(escrowId) || null;
    const result = applyEvent(currentState, parsed);

    if (result.ok) {
      this.states.set(escrowId, result.state);

      // Store raw event
      const existing = this.rawEvents.get(escrowId) || [];
      existing.push(event);
      this.rawEvents.set(escrowId, existing);

      this.callbacks.onStateUpdate?.(escrowId, result.state);
    } else {
      // Only log — don't fire callback for expected rejections
      // (duplicate events, stale state, events we already applied locally)
      console.debug(`[escrow] Rejected event ${event.id.slice(0, 8)}: ${result.error.code}`);
    }
  }

  /** Apply a locally-created event optimistically */
  private applyLocally(escrowId: string, signed: NostrEvent, payload: EscrowPayload): EscrowState {
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local parse failed: ${parsed.error.message}`);

    const currentState = this.states.get(escrowId) || null;
    const result = applyEvent(currentState, parsed.event);
    if (!result.ok) throw new Error(`Local apply failed: ${result.error.message}`);

    this.states.set(escrowId, result.state);

    const existing = this.rawEvents.get(escrowId) || [];
    existing.push(signed);
    this.rawEvents.set(escrowId, existing);

    this.callbacks.onStateUpdate?.(escrowId, result.state);

    return result.state;
  }

  /** After a vote, check if 2-of-3 threshold is met and auto-publish RESOLVE */
  private async maybeAutoResolve(escrowId: string): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state || state.status !== EscrowStatus.LOCKED) return;

    // Count matching votes
    const votes = Object.entries(state.votes) as [Role, Outcome][];
    if (votes.length < 2) return;

    const releasers = votes.filter(([, o]) => o === Outcome.RELEASE).map(([r]) => r);
    const refunders = votes.filter(([, o]) => o === Outcome.REFUND).map(([r]) => r);

    let outcome: Outcome | null = null;
    let majority: [Role, Role] | null = null;
    let arbiterInvolved = false;

    if (releasers.length >= 2) {
      outcome = Outcome.RELEASE;
      majority = [releasers[0], releasers[1]];
      arbiterInvolved = releasers.includes(Role.ARBITER);
    } else if (refunders.length >= 2) {
      outcome = Outcome.REFUND;
      majority = [refunders[0], refunders[1]];
      arbiterInvolved = refunders.includes(Role.ARBITER);
    }

    if (!outcome || !majority) return;

    // Publish RESOLVE event
    const pubkey = await this.getPubkey();
    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: ResolvePayload = {
      type: "escrow:resolve",
      outcome,
      majority,
      arbiterInvolved,
      resolvedAt: now,
    };

    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.RESOLVE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:resolve"],
      ],
      content,
    };

    const signed = await this.signer.signEvent(unsigned);
    await this.relayManager.publish(signed);

    this.applyLocally(escrowId, signed, payload);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private generateEscrowId(): string {
    // Deterministic-ish but unique: timestamp + random bytes
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `sm_${ts}_${rand}`;
  }
}
