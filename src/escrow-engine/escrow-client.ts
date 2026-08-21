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
  getEffectiveParticipantAt,
  getEffectiveParticipantsAt,
  joinHoldExpiresAt,
  joinHoldExpiresAtFor,
  type NostrEvent,
  type EscrowState,
  type ParsedEscrowEvent,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type LockShareEntry,
  type SelectedMenuItem,
  type HandleEnvelope,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type PeriodReleasePayload,
  type ChatBody,
  type ChatImageAttachment,
  type ChatPayload,
  type PremiumBody,
  type PremiumPayload,
  type SettlementPayload,
  type EscrowPayload,
  type TrancheChildDescriptor,
  type TrancheBitcoinNetwork,
  type PlanStartPayload,
  type ChildKeyPayload,
} from "./types.js";

import { applyEvent, replayEventChain, canVote, getWinner, payoutRecipientFor, type TransitionResult } from "./state-machine.js";
import {
  beginHydrationDiagnostic,
  type HydrationDiagnosticRun,
} from "./hydration-diagnostics.js";
import { buildChildCreateParams, remainingStock, unsoldStock, isSoldOut, isLastUnitContested } from "./storefront.js";
import { HOLDER_ONLY_SHARE_POLICY, shareIndexForRole } from "./holder-shares.js";
import type { TrancheRef } from "./tranche.js";
import type { EscrowMode } from "./types.js";
import { arbiterVotePriority, arbiterPriorityOrder, isPerformanceContest } from "./arbiter-substitution.js";
import type { VoteShareEnvelope } from "./types.js";
import { EscrowNotifier } from "./notifier.js";
import { ENCRYPTION_CONFIG } from "./encryption-config.js";
import { parseEscrowEvent, sortEventChain } from "./event-parser.js";
import { appendCachedEvents, getCachedEvents, putCachedEvents } from "./escrow-event-cache.js";
import { selectBackfillEvents, shouldBackfillNow } from "./relay-backfill.js";
import { createEnvelope, decryptFromEnvelope } from "./envelope.js";
import { finalArbiterSettlementProof, finalCoopSettlementProof } from "./onchain-settlement-transport.js";
import { RelayManager, RelayStatus, type NostrFilter } from "./relay-manager.js";
import {
  FetchProbe,
  recordDiscoveryRun,
  type FetchLegDiag,
} from "./discovery-diagnostics.js";
import { simTagOrNull, shouldDropForSimPolicy } from "../sim/simMode.js";
import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import { randomId } from "../storage/random-id.js";
import { compactSelectedMenuItems } from "./selected-menu-items.js";
import { pickPreferredArbiter } from "../arbiters/pool.js";
import {
  buildChildDescriptor,
  canFundTranche,
  isPrivatePlanChild,
  splitTranches,
  trancheChildId,
  tranchePlanId,
  trancheTermsDigest,
} from "./tranche-plan.js";
import {
  deriveSlicePlan,
  MAX_SLICE_EXPOSURE_MSATS,
  SETTLEMENT_POLICY_ECASH_SLICES,
} from "./slice-policy.js";
import {
  buildNip99ListingEvent,
  nip99ListingCoordinate,
} from "./nip99-listing.js";

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

  /**
   * NIP-04 encrypt content for a recipient. ONLY for kind:4 DMs — the
   * NIP-04 spec ties kind:4 content to NIP-04 ciphertext, and external
   * clients (Damus, Amethyst, ChapSmart…) decrypt it as such; NIP-44
   * ciphertext in a kind:4 renders as a BLANK message there. Every
   * escrow payload stays on nip44Encrypt. Optional: a signer without
   * NIP-04 support degrades to the nip44 legacy behavior at call sites.
   */
  nip04Encrypt?(plaintext: string, recipientPubkey: string): Promise<string>;

  /** Export a locally-held recovery key on an explicit user request.
   * Remote/extension signers intentionally omit this capability. */
  exportRecoveryKey?(): Promise<string>;
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
  /** Number of public CREATE chains currently being verified before they are
   *  safe to surface in Browse. */
  onPublicListingHydration?: (pending: number) => void;
  /** The initial public-listing subscription reached EOSE quorum. CREATEs
   *  already received may still be undergoing full-chain hydration. */
  onPublicListingsSettled?: () => void;
}

function statusProgressRank(status: EscrowStatus): number {
  switch (status) {
    case EscrowStatus.CREATED: return 0;
    case EscrowStatus.LOCKED: return 1;
    case EscrowStatus.APPROVED: return 2;
    case EscrowStatus.CLAIMED: return 3;
    case EscrowStatus.COMPLETED: return 4;
    default: return 4;
  }
}

function isTerminalStatus(status: EscrowStatus): boolean {
  return status === EscrowStatus.COMPLETED
    || status === EscrowStatus.CANCELLED
    || status === EscrowStatus.EXPIRED;
}

// Completeness-retry bound (round 3b step 3). A loadEscrow whose replay lands
// non-truly-terminal (anything but COMPLETED/CANCELLED) re-fetches up to this
// many times, since a contended/truncated Fedi-webview fetch can drop the
// resolve/complete tail. Bounded so a genuinely-non-terminal trade (a real
// LOCKED/EXPIRED) doesn't loop forever.
const COMPLETENESS_MAX_ATTEMPTS = 2;

// Part 6 relay-recovery backfill timings. Debounce collapses the burst of
// CONNECTED events that fire as a pool comes up (or recovers) into one pass;
// the throttle caps how often the backfill can run so a flapping pool can't
// storm re-fetches.
const RECOVERY_BACKFILL_DEBOUNCE_MS = 2_000;
const RECOVERY_BACKFILL_THROTTLE_MS = 60_000;
/** Small inclusive overlap for delta reads. Nostr `since` is second-granular;
 * backing up two seconds keeps same-timestamp siblings and modest relay clock
 * skew eligible while still avoiding full-history image/chat replay. */
const ESCROW_DELTA_OVERLAP_SECS = 2;
const HEAVY_CURSOR_EVENT_BYTES = 8 * 1024;

// ── Redelivery-storm governors ────────────────────────────────────────────
// A relay reconnect re-REQs every live subscription, so a flapping pool
// redelivers history in bulk. The per-relay cursor and the delta `since` keep
// most of those bytes off the wire, but whatever still arrives must not be
// able to multiply itself into full chain re-fetches. These bound that.

/** Full chain hydrations of never-seen public listings running at once. A
 *  Browse redelivery burst carries one CREATE per listing; without a cap each
 *  one fires its own multi-relay chain fetch in parallel and the main thread
 *  drowns in the responses. */
const LISTING_HYDRATION_CONCURRENCY = 4;
/** A listing whose chain won't replay (invalid/aged-off history) returns null
 *  forever, so re-hydrating it on every redelivery is pure waste. Hold it down
 *  for this long after a failed or empty hydration. */
const LISTING_HYDRATION_RETRY_COOLDOWN_MS = 5 * 60_000;
/** Out-of-order reload backoff. The first stale event that can't apply is
 *  usually genuine ordering, so the first reload is cheap and near-immediate;
 *  repeats on the same trade are a redelivery storm and get pushed out fast. */
const OUT_OF_ORDER_RELOAD_DELAY_MS = 1_500;
const OUT_OF_ORDER_RELOAD_BASE_COOLDOWN_MS = 30_000;
const OUT_OF_ORDER_RELOAD_MAX_COOLDOWN_MS = 5 * 60_000;
/** Trades whose raw chain stays in the hot in-memory map. IndexedDB holds the
 *  durable copy and `state.eventChain` still supplies the delta cursor, so an
 *  eviction costs nothing but a colder next read. */
const HOT_RAW_TRADE_CAP = 120;

/** Backoff for repeated out-of-order reloads of one trade. `attempts` counts
 *  reloads already spent on it this session. */
export function outOfOrderReloadCooldownMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const backed = OUT_OF_ORDER_RELOAD_BASE_COOLDOWN_MS * 2 ** (attempts - 1);
  return Math.min(backed, OUT_OF_ORDER_RELOAD_MAX_COOLDOWN_MS);
}

/** Which trades lose their hot raw chain once the map is over cap. Watched
 *  trades are never evicted (they're the ones taking live events); among the
 *  rest, settled chains go before live ones, then least-recently-touched. */
export function selectHotRawEvictions(
  entries: readonly { id: string; touchedAt: number; terminal: boolean }[],
  watched: ReadonlySet<string>,
  cap: number,
): string[] {
  const evictable = entries
    .filter(entry => !watched.has(entry.id))
    .sort((a, b) => (
      a.terminal === b.terminal
        ? a.touchedAt - b.touchedAt
        : (a.terminal ? -1 : 1)
    ));
  const overflow = entries.length - cap;
  if (overflow <= 0) return [];
  return evictable.slice(0, overflow).map(entry => entry.id);
}

function isPartialReplayDowngrade(current: EscrowState | undefined, incoming: EscrowState): boolean {
  if (!current) return false;
  if (isTerminalStatus(incoming.status)) return false;
  if (statusProgressRank(incoming.status) < statusProgressRank(current.status)) return true;
  if (incoming.status !== current.status) return false;

  const incomingChainIds = new Set(incoming.eventChain.map(event => event.raw.id));
  return current.eventChain.some(event => !incomingChainIds.has(event.raw.id));
}

function mergeRawEventsById(primary: NostrEvent[], secondary: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of primary) byId.set(event.id, event);
  for (const event of secondary) byId.set(event.id, event);
  return [...byId.values()];
}

/** Newest safe relay cursor for a chain already present in memory. */
export function escrowDeltaSince(events: readonly NostrEvent[]): number | undefined {
  let newest = -1;
  for (const event of events) {
    if (Number.isFinite(event?.created_at)) newest = Math.max(newest, event.created_at);
  }
  if (newest < 0) return undefined;
  const newestEvents = events.filter(event => event.created_at === newest);
  const newestIsHeavy = newestEvents.some(event =>
    event.kind === EscrowEventKind.CHAT ||
    event.content.length > HEAVY_CURSOR_EVENT_BYTES
  );
  // Nostr `since` is inclusive. Re-requesting the newest second is useful for
  // small state events (same-second siblings), but disastrous when that second
  // contains an inline photo. The full verified event is already cached and
  // durable, so advance past a heavy/chat tip instead of downloading it again.
  return newestIsHeavy
    ? newest + 1
    : Math.max(0, newest - ESCROW_DELTA_OVERLAP_SECS);
}

/** Rank relay-discovered trade ids by their newest observed event. Discovery
 * hydration is bounded, so this ordering is a custody property: a fresh
 * completed trade must not lose its slot to arbitrary relay frame order. */
export function discoveredEscrowIdsByActivity(events: readonly NostrEvent[]): string[] {
  const newest = new Map<string, number>();
  for (const event of events) {
    const id = event.tags.find(tag => tag[0] === TAGS.ESCROW_ID)?.[1];
    if (!id) continue;
    newest.set(id, Math.max(newest.get(id) ?? 0, event.created_at || 0));
  }
  return [...newest.keys()].sort((a, b) =>
    (newest.get(b)! - newest.get(a)!) || a.localeCompare(b));
}

/** CHAT bodies can contain large inline attachments. The parsed state already
 * owns the visible chat and IndexedDB owns the durable raw copy; retaining the
 * same ciphertext again in rawEvents multiplies memory across every loaded
 * trade. Keep only state-chain raws in the hot cache. */
export function compactHotRawEvents(events: readonly NostrEvent[]): NostrEvent[] {
  return dedupRawEvents(events.filter(event => event.kind !== EscrowEventKind.CHAT));
}

/** The same configured-pool quorum shape used by relay reads. Exported so the
 * reconnect storm guard remains a pinned, testable policy. */
export function recoveryReadQuorum(configuredRelayCount: number): number {
  return Math.max(1, Math.min(3, configuredRelayCount - 1));
}

export function relayPoolNeedsRecoveryBackfill(
  connectedRelayCount: number,
  configuredRelayCount: number,
): boolean {
  return connectedRelayCount < recoveryReadQuorum(configuredRelayCount);
}

function dedupRawEvents(events: readonly NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const compact: NostrEvent[] = [];
  for (const event of events) {
    if (!event?.id || seen.has(event.id)) continue;
    seen.add(event.id);
    compact.push(event);
  }
  return compact;
}

function durableRawSnapshot(events: readonly NostrEvent[]): NostrEvent[] {
  return dedupRawEvents(events).map(event => ({
    ...event,
    tags: event.tags.map(tag => [...tag]),
  }));
}

function stripParsedChatCiphertext(state: EscrowState): void {
  state.chatMessages = state.chatMessages.map(message => (
    message.raw.content
      ? { ...message, raw: { ...message.raw, content: "" } }
      : message
  ));
}

// v3.1.1: mirror of relay-manager's per-event content cap (the size relays
// enforce on receive). Defined locally rather than imported to avoid a
// cross-module re-export that tripped a Vite dev ESM resolution race (the dev
// server served a stale relay-manager without the new export → the whole module
// graph failed to load). Keep in sync with relay-manager.ts's value.
const MAX_CHAT_EVENT_CONTENT_BYTES = 128 * 1024;

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT CONFIG
// ══════════════════════════════════════════════════════════════════════════

// SECURITY: how far into the future an incoming event's `created_at` is
// allowed to be before we drop it. Generous enough for ordinary clock
// skew (NTP drift, mobile sleep, phones in airplane mode for a bit) but
// tight enough that no-one can claim their VOTE is from next week to
// shift expiry windows around. The synthetic-event-based test suite
// drives the same EscrowClient with `created_at = NOW + counter` and
// can run past an hour of synthetic time on a slow CI box, so the
// constant has to stay roomy enough for the test loop too.
const MAX_FUTURE_TIMESTAMP_SLACK_SECS = 24 * 60 * 60; // 24 hours

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
  /**
   * SECURITY: schnorr signature verifier applied to every event the
   * relay-manager receives, before it reaches any dispatch path. The
   * production default is nostr-tools' `verifyEvent`, which rejects any
   * event a relay tried to forge. Tests that build synthetic events
   * with placeholder `sig` strings can opt out by passing
   * `verifyEvent: () => true`. Do not pass a permissive verifier in
   * production code.
   */
  verifyEvent?: (event: NostrEvent) => boolean;
}

// ══════════════════════════════════════════════════════════════════════════
// LOAD FAILURES — why a chain didn't come back
// ══════════════════════════════════════════════════════════════════════════

/**
 * `loadEscrow` returns null for three structurally different reasons, and the
 * difference matters to the user:
 *
 *   no-events        nothing on any relay AND nothing in the durable cache —
 *                    the honest "this history is gone" case.
 *   undecryptable    events exist but none parse for this identity (wrong
 *                    npub / legacy envelope).
 *   chain-incomplete events exist but don't replay: pieces are missing from
 *                    the relays (a COMPLETED trade whose VOTEs are gone dies
 *                    on THRESHOLD_NOT_MET) or one is invalid. NOT "gone" —
 *                    the missing part may come back, and other participants
 *                    may still hold it.
 */
export type LoadFailureReason = "no-events" | "undecryptable" | "chain-incomplete";

export interface LoadFailure {
  reason: LoadFailureReason;
  /** Replay error code for chain-incomplete (THRESHOLD_NOT_MET, MISSING_CREATE…). */
  code?: string;
  message?: string;
  eventId?: string;
}

// ══════════════════════════════════════════════════════════════════════════
// ESCROW CLIENT
// ══════════════════════════════════════════════════════════════════════════

export class EscrowClient {
  private relayManager: RelayManager;
  private signer: Signer;
  private config: EscrowClientConfig;
  private notifier: EscrowNotifier | null = null;
  /** Track which escrows are currently being reloaded to avoid duplicate reloads */
  private _reloading: Set<string> = new Set();
  /** Out-of-order reload accounting per escrow. `_reloading` only dedupes an
   *  in-flight reload; without this a redelivery storm re-arms a fresh full
   *  chain fetch the moment the previous one lands. */
  private _reloadHistory: Map<string, { attempts: number; lastAt: number }> = new Map();
  /** CREATE-only public listings being hydrated before they reach Browse. */
  private _listingHydration: Set<string> = new Set();
  /** Listings waiting on a hydration slot, and the cooldown on listings whose
   *  chain came back unusable. */
  private _listingHydrationQueue: string[] = [];
  private _listingHydrationCooldown: Map<string, number> = new Map();
  /** One fetch/decrypt/replay generation per escrow. All cold-start callers
   *  share it; bounded completeness retries stay inside the owner. */
  private _loadEscrowInFlight: Map<string, {
    promise: Promise<EscrowState | null>;
    diagnostic: HydrationDiagnosticRun;
    /** Whether this generation may fall back to the durable cache on a failed
     *  replay. A background generation can't satisfy a repair-wanting caller. */
    repairFromCache: boolean;
  }> = new Map();
  /** Backfill bookkeeping: which trades already handed their recovered events
   *  back this session, and when the last batch went out. Republishing is
   *  redelivered to every subscribed client, so it stays one-shot and paced. */
  private _backfilledEscrows: Set<string> = new Set();
  private _lastBackfillAt = 0;
  /** Why the last loadEscrow for an id came back null. A null load has three
   *  very different causes and the UI was telling users only one of them
   *  ("not on the relay anymore") regardless — including for chains this
   *  device could see were merely INCOMPLETE. Cleared on a successful load. */
  private _lastLoadFailures: Map<string, LoadFailure> = new Map();
  /** Initial public-listing EOSE accounting. Live subscription remains open
   *  after this reading settles. */
  private publicListingsSubId: string | null = null;
  private publicListingsEoseRelays: Set<string> = new Set();
  private publicListingsSettled = false;
  /** Buffer for events that arrived before their predecessors */
  private retryBuffer: Map<string, { event: NostrEvent; relay: string; attempts: number }[]> = new Map();
  private callbacks: EscrowClientCallbacks;

  /** Cached escrow states — escrowId → state */
  private states: Map<string, EscrowState> = new Map();

  /** Raw events per escrow — escrowId → events[] */
  private rawEvents: Map<string, NostrEvent[]> = new Map();

  /** Last touch per hot raw chain, driving evict-oldest once over cap. */
  private rawEventsTouchedAt: Map<string, number> = new Map();

  /** Active subscriptions */
  private subscriptions: Map<string, string> = new Map(); // label → subId

  /** Our pubkey (cached after first call) */
  private _pubkey: string | null = null;

  // ── Part 6: relay-recovery chat/chain backfill ──────────────────────────
  /** True once any relay has reached CONNECTED, so the first connect wave
   *  doesn't trigger a redundant backfill (the normal load path covers it). */
  private sawFirstRelayConnect = false;
  /** Debounce timer collapsing a burst of CONNECTED transitions into one
   *  backfill pass. */
  private recoveryBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock of the last backfill, so it runs at most once per throttle
   *  window even across separate recovery bursts. */
  private lastRecoveryBackfillAt = 0;
  /** Recovery work is only justified after the connected pool actually fell
   * below read quorum. A single flapping redundant relay must not re-download
   * every watched trade. */
  private recoveryPoolWasDegraded = false;

  /** Buffered events waiting for their predecessors — escrowId → events[] */
  private eventBuffer: Map<string, { event: NostrEvent; relay: string; attempts: number }[]> = new Map();

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
        onStatusChange: (relay, status) => {
          this.callbacks.onRelayStatus?.(relay, status);
          // Part 6 (chat-wipe close): when a relay (re)connects, schedule a
          // debounced backfill of watched trades. The first ever CONNECTED is
          // skipped (the initial connect wave is already covered by the normal
          // load path); every CONNECTED after that — the rest of the opening
          // wave, plus any later recovery of a dropped/abandoned relay —
          // triggers a re-fetch so partial rehydration heals. loadEscrow merges
          // + never shrinks chat, so this is safe to over-fire; it is throttled.
          const recoveryQuorum = recoveryReadQuorum(this.config.relays.length);
          const connectedNow = this.relayManager.connectedRelayCount();
          if (
            this.sawFirstRelayConnect &&
            (status === RelayStatus.DISCONNECTED || status === RelayStatus.ERROR) &&
            relayPoolNeedsRecoveryBackfill(connectedNow, this.config.relays.length)
          ) {
            this.recoveryPoolWasDegraded = true;
          }
          if (status === RelayStatus.CONNECTED) {
            if (
              this.sawFirstRelayConnect &&
              this.recoveryPoolWasDegraded &&
              connectedNow >= recoveryQuorum
            ) {
              this.recoveryPoolWasDegraded = false;
              this.scheduleRecoveryBackfill();
            }
            this.sawFirstRelayConnect = true;
          }
        },
        onError: (err, relay) => console.warn(`[relay] ${relay}: ${err.message}`),
        onEose: (subscriptionId, relayUrl) => {
          if (
            subscriptionId !== this.publicListingsSubId
            || this.publicListingsSettled
          ) return;
          this.publicListingsEoseRelays.add(relayUrl);
          const quorum = this.relayManager.connectedRelayQuorum();
          if (quorum > 0 && this.publicListingsEoseRelays.size >= quorum) {
            this.publicListingsSettled = true;
            this.callbacks.onPublicListingsSettled?.();
          }
        },
        // v0.4.2 sim mode (hotfix round 2): wire the chokepoint drop so
        // sim-tagged events never enter prod state via fetch-based paths
        // (loadEscrow's fetchEscrowEvents, raw fetchOnce). Defense in
        // depth — handleIncomingEvent still has its own check, but this
        // catches paths that bypass it entirely.
        shouldDropEvent: (event) => shouldDropForSimPolicy(event),
        // SECURITY: wire schnorr signature verification at the relay
        // boundary. Without this, any relay can forge events from any
        // pubkey (incl. participants of in-flight trades). Verification
        // is sync via nostr-tools' verifyEvent. Tests can override with
        // config.verifyEvent (e.g., `() => true`) when emitting events
        // with placeholder signatures from a fake WebSocket.
        verifyEvent: config.verifyEvent ?? verifyNostrEventSignature,
      },
      config.wsImpl
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  connect(): void {
    this.relayManager.connect();

    this.notifier = new EscrowNotifier(this.signer, this.relayManager);
  }

  /** #79 — send one trade-critical alert DM over NIP-17 (kind-4 fallback for
   *  legacy recipients). Fail-soft: a DM must never break the trade flow. */
  async sendTradeAlertDM(recipientPubkey: string, message: string): Promise<boolean> {
    try {
      if (!this.notifier) return false;
      return await this.notifier.sendTradeAlertDM(recipientPubkey, message);
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.relayManager.disconnect();
    if (this.recoveryBackfillTimer) {
      clearTimeout(this.recoveryBackfillTimer);
      this.recoveryBackfillTimer = null;
    }
    this.states.clear();
    this.rawEvents.clear();
    this.rawEventsTouchedAt.clear();
    this._reloadHistory.clear();
    this._listingHydrationQueue.length = 0;
    this._listingHydrationCooldown.clear();
  }

  /**
   * Force an immediate re-probe of every non-connected relay (clears the
   * exponential-backoff give-up state). Surfaced for the in-app "Reconnect"
   * control: the per-relay backoff abandons a relay after MAX_RETRY_COUNT and
   * never recovers it on its own, so a degraded pool stays degraded until this
   * is called (or the whole client is rebuilt). No-op after disconnect().
   */
  forceReconnectAll(): void {
    this.relayManager.forceReconnectAll();
  }

  /** #37: connected-relay count, surfaced for the native-lock recovery's
   *  healthy-read gate (a "no LOCK exists" fetch is only trustworthy when
   *  enough of the pool actually answered). */
  getConnectedRelayCount(): number {
    return this.relayManager.getConnectedCount();
  }

  /** Escrows with a live subscription — the ones still taking events. */
  private watchedEscrowIds(): Set<string> {
    const watched = new Set<string>();
    for (const label of this.subscriptions.keys()) {
      if (label.startsWith("escrow:")) watched.add(label.slice("escrow:".length));
    }
    return watched;
  }

  /** Single writer for the hot raw chain map: stores, stamps the touch used by
   *  eviction, and trims the map back to cap. The durable IndexedDB copy and
   *  `state.eventChain` both survive an eviction, so the only cost is that the
   *  next read of an evicted trade starts colder. */
  private setHotRawEvents(escrowId: string, events: NostrEvent[]): void {
    this.rawEvents.set(escrowId, events);
    this.rawEventsTouchedAt.set(escrowId, Date.now());
    if (this.rawEvents.size <= HOT_RAW_TRADE_CAP) return;

    const entries = [...this.rawEvents.keys()].map(id => ({
      id,
      touchedAt: this.rawEventsTouchedAt.get(id) ?? 0,
      terminal: isTerminalStatus(
        this.states.get(id)?.status ?? EscrowStatus.CREATED,
      ),
    }));
    for (const id of selectHotRawEvictions(entries, this.watchedEscrowIds(), HOT_RAW_TRADE_CAP)) {
      this.rawEvents.delete(id);
      this.rawEventsTouchedAt.delete(id);
    }
  }

  /** True when this exact event is already part of what we hold for the trade
   *  (hot raws, replayed chain, or parsed chat). A relay reconnect redelivers
   *  history in bulk; without this check each redelivered frame pays a full
   *  NIP-44 decrypt and a state-machine apply, and any that no longer applies
   *  cleanly arms another full chain reload. */
  private hasEventLocally(escrowId: string, eventId: string): boolean {
    if ((this.rawEvents.get(escrowId) ?? []).some(event => event.id === eventId)) return true;
    const state = this.states.get(escrowId);
    if (!state) return false;
    return state.eventChain.some(event => event.raw.id === eventId)
      || state.chatMessages.some(message => message.raw.id === eventId);
  }

  // ── Part 6: relay-recovery chat/chain backfill ──────────────────────────

  /** Collapse a burst of relay (re)connections into a single debounced
   *  backfill pass. */
  private scheduleRecoveryBackfill(): void {
    if (this.recoveryBackfillTimer) return;
    this.recoveryBackfillTimer = setTimeout(() => {
      this.recoveryBackfillTimer = null;
      void this.backfillWatchedEscrows();
    }, RECOVERY_BACKFILL_DEBOUNCE_MS);
  }

  /**
   * Delta-fetch each actively-watched, non-terminal trade after the relay pool
   * recovers from a real below-quorum outage. A single redundant relay flap
   * does not trigger this pass.
   * loadEscrow merges fetched + cached events (dedup by id) and re-seeds any
   * in-memory chat the fetch missed, so it can only ADD — never shrink — state.
   * Bounded to non-terminal trades and throttled, so it can't storm during a
   * flapping pool. Best-effort: a per-trade failure is swallowed.
   */
  private async backfillWatchedEscrows(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecoveryBackfillAt < RECOVERY_BACKFILL_THROTTLE_MS) return;
    this.lastRecoveryBackfillAt = now;

    const ids: string[] = [];
    for (const label of this.subscriptions.keys()) {
      if (label.startsWith("escrow:")) ids.push(label.slice("escrow:".length));
    }
    for (const id of ids) {
      // Terminal chains (COMPLETED/CANCELLED) won't gain new chat or events —
      // skip them so the backfill stays bounded to live trades.
      const st = this.states.get(id);
      if (st && isTerminalStatus(st.status)) continue;
      try {
        await this.loadEscrow(id);
      } catch (e) {
        console.debug(`[escrow] recovery backfill ${id} failed:`, (e as Error)?.message || e);
      }
    }
  }

  async getPubkey(): Promise<string> {
    if (!this._pubkey) {
      this._pubkey = await this.signer.getPublicKey();
    }
    return this._pubkey;
  }

  /** Access the underlying signer (for auxiliary modules like seed-manager) */
  getSigner(): Signer {
    return this.signer;
  }

  /**
   * v0.4.2 sim mode: sign an event, but first stamp a `chama-sim` tag
   * if sim mode is active. The tag rides on every event the escrow
   * engine publishes so the receive side can isolate sim trades from
   * real ones cleanly (see handleIncomingEvent below for the drop
   * policy). Callers that previously used `this.signer.signEvent` for
   * an escrow-chain event should route through here. Raw-publish
   * paths (e.g. seed-manager) intentionally bypass — they don't
   * touch the trade chain and don't need the tag.
   */
  private async signWithSimTag(unsigned: UnsignedEvent): Promise<NostrEvent> {
    const simTag = simTagOrNull();
    if (simTag) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, simTag] };
    }
    return this.signer.signEvent(unsigned);
  }

  // ── Raw Nostr helpers ───────────────────────────────────────────────────
  // These are used by auxiliary modules (e.g. the Fedimint seed manager)
  // that need to publish or query events outside the escrow event chain.

  /** Publish an already-signed Nostr event to all connected relays. */
  async publishRaw(event: NostrEvent): Promise<void> {
    await this.relayManager.publish(event);
  }

  /** Re-broadcast a trade's full cached event chain to the current relays —
   *  heals a "ghost" trade whose events never reached a counterparty's relays
   *  (e.g. created during an outage / broken-state era, so the other party's
   *  subscription can't discover or replay it). Any participant who can see the
   *  trade holds the chain (cached rawEvents + the replayed state's eventChain),
   *  so calling this re-publishes every event to today's relay set and the
   *  trade self-heals for everyone. Best-effort: each event is published
   *  independently and a per-event relay rejection is tolerated, so one bad
   *  event can't abort the heal. Returns how many of the chain's events were
   *  accepted by at least one relay. */
  async rebroadcastEscrow(escrowId: string): Promise<{ published: number; total: number }> {
    const chain = mergeRawEventsById(
      this.rawEvents.get(escrowId) ?? [],
      this.states.get(escrowId)?.eventChain.map(event => event.raw) ?? [],
    );
    let published = 0;
    for (const event of chain) {
      try {
        await this.relayManager.publish(event);
        published++;
      } catch (error) {
        console.debug(`[escrow] rebroadcastEscrow ${escrowId}: relay rejected ${event.id}`, error);
      }
    }
    console.debug(`[escrow] rebroadcastEscrow ${escrowId}: re-published ${published}/${chain.length} events`);
    return { published, total: chain.length };
  }

  /**
   * One-shot query for events matching a filter. Resolves after EOSE
   * from all connected relays, or after the timeout.
   */
  async queryOnce(
    filter: import("./relay-manager.js").NostrFilter,
    timeoutMs = 5_000
  ): Promise<NostrEvent[]> {
    return this.relayManager.fetchOnce(filter, timeoutMs);
  }

  /**
   * Active relay discovery for "My Trades": find every escrow ID this pubkey
   * took part in, by querying events it AUTHORED (`authors:`) unioned with
   * events that TAG it (`#p:`). `authors` catches trades you created, joined,
   * locked, voted, claimed or chatted in; `#p` catches trades where you're a
   * tagged participant — JOIN always tags the joiner, and (since the additive
   * v3.x change) LOCK tags buyer/seller/arbiter, so even a passively-seated
   * arbiter who never authored an event is reachable.
   *
   * Two-step by design: this only surfaces the IDs. The caller loadEscrow()s
   * each to fetch + merge + replay the authoritative full chain — so a single
   * discovered JOIN/LOCK never renders as partial state. Best-effort: a failed
   * sub resolves empty rather than throwing, so one bad relay can't blank the
   * list. This is what makes My Trades self-heal after a localStorage wipe (or
   * on a fresh install) without depending on the saved-ID cache.
   */
  async discoverMyEscrowIds(pubkey: string, timeoutMs = 8_000): Promise<string[]> {
    const kinds = Object.values(EscrowEventKind).filter(v => typeof v === "number") as number[];
    const kindsLabel = `${Math.min(...kinds)}-${Math.max(...kinds)}`;
    const short = pubkey.slice(0, 8);
    // INSTRUMENT-FIRST (Fedi round 3): attach a read-only probe to each leg so
    // the on-device debug card can show why a leg came back empty — relays
    // answered EOSE-empty (wrong query key) vs timed out with no frames
    // (blocked transport). Observational only; see discovery-diagnostics.ts.
    const authoredProbe = new FetchProbe("authored", `authors:${short}… kinds:${kindsLabel}`);
    const taggedProbe = new FetchProbe("tagged", `#p:${short}… kinds:${kindsLabel}`);
    const [authored, tagged] = await Promise.all([
      this.relayManager.fetchOnce({ kinds, authors: [pubkey] }, timeoutMs, authoredProbe).catch(() => [] as NostrEvent[]),
      this.relayManager.fetchOnce({ kinds, "#p": [pubkey] }, timeoutMs, taggedProbe).catch(() => [] as NostrEvent[]),
    ]);
    // Relay delivery order is explicitly NOT chronological. Discovery later
    // hydrates under a bounded budget, so returning Set insertion order could
    // strand today's trade beyond the cap while loading arbitrary old tests.
    // Rank by the newest event observed for each id; ties stay deterministic.
    const ids = discoveredEscrowIdsByActivity([...authored, ...tagged]);
    recordDiscoveryRun({
      at: Date.now(),
      queriedPubkey: pubkey,
      legs: [authoredProbe.snapshot(authored.length), taggedProbe.snapshot(tagged.length)],
      idsDiscovered: ids.length,
      eventsFetched: authored.length + tagged.length,
    });
    console.debug(
      `[escrow] discoverMyEscrowIds ${short}…: ${ids.length} ids ` +
        `(${authored.length} authored + ${tagged.length} tagged events)`,
    );
    return ids;
  }

  /**
   * INSTRUMENT-FIRST (Fedi round 3): pubkey-INDEPENDENT transport control.
   * Fetch one known escrow's full chain by `#d` — the exact same `fetchOnce`
   * path discovery uses, but filtered by escrow id instead of pubkey — and
   * return the probe anatomy (per-relay REQ/EVENT/EOSE + resolvedBy). This
   * cross-checks the discovery reading WITHOUT touching the signer:
   *   • events come back  → transport works → an empty discovery is a wrong
   *                          query key (candidate 1).
   *   • times out empty   → transport is blocked (candidate 2), confirmed
   *                          with no dependence on which pubkey we hold.
   * The fetched events are discarded; only the probe matters.
   */
  async probeFetchById(escrowId: string, timeoutMs = 8_000): Promise<FetchLegDiag> {
    const kinds = Object.values(EscrowEventKind).filter(v => typeof v === "number") as number[];
    const kindsLabel = `${Math.min(...kinds)}-${Math.max(...kinds)}`;
    const probe = new FetchProbe(`#d ${escrowId}`, `#d:${escrowId} kinds:${kindsLabel}`);
    const events = await this.relayManager
      .fetchOnce({ kinds, "#d": [escrowId] }, timeoutMs, probe)
      .catch(() => [] as NostrEvent[]);
    return probe.snapshot(events.length);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USER ACTIONS — One method per thing the UI can do
  // ══════════════════════════════════════════════════════════════════════════

  // ── Create a new escrow trade ───────────────────────────────────────────

  async createEscrow(params: {
    description: string;
    listingKind?: CreatePayload["listingKind"];
    imageDataUrl?: string;
    imageUrls?: string[];
    amountMsats: number;
    fiatAmount?: number;
    fiatCurrency?: string;
    premiumBps?: number;
    category: string;
    /** PR 2: marketplace user picks; non-marketplace categories get
     *  "service" written by handleCreate regardless of what's passed. */
    fulfillment?: "physical" | "service" | "digital";
    /** PR 2: community slug from the static registry. Optional —
     *  pre-registry trades work but won't show a community pill. */
    community?: string;
    /** v3.1 B3: self-describing listing — ISO alpha-2 country stamped on the
     *  CREATE so a device that can't resolve the community slug still renders a
     *  flag + currency. Display-only; never hashed / replay/consensus-bound. */
    country?: string;
    /** v4.1 (#12): optional CBP bill-type id (informational metadata only). */
    billType?: string;
    /** A4: optional Work category id (informational; the matcher's join key). */
    workCategory?: string;
    /** Tranching: this escrow's slice of a larger trade. Informational. */
    tranche?: TrancheRef;
    /** Relay-discovery recipients for a tranche continuation. Routing only;
     *  does not seat a participant or enter the CREATE payload. */
    continuationPubkeys?: string[];
    /** Tier 2.1: where this trade's escrow will live. Absent ⇒ "ecash".
     *  ⚠ Stamped at CREATE on purpose — a client must be able to refuse a
     *  substrate it does not understand BEFORE it funds anything. */
    escrowMode?: EscrowMode;
    /** v6.0 signed settlement policy. Must agree with escrowMode. */
    settlementPolicy?: string;
    /** v6.0 whole-plan ecash slice count. Parent CREATE only. */
    sliceCount?: number;
    /** ⚠ Tier 2.1: a RESOLVER, not a key.
     *
     *  The creator's escrow key is derived from (seed, escrowId), and the
     *  escrow id does not exist until this method generates it. Passing a
     *  pre-derived key would therefore mean deriving from a placeholder — every
     *  trade a user creates would share ONE escrow key, commingling their UTXOs
     *  across unrelated trades and defeating the per-trade derivation entirely.
     *  So the caller hands us a function and we call it with the real id. */
    escrowKeyFor?: (escrowId: string) => Promise<string | undefined>;
    mintUrl: string;
    paymentMethods?: string[];
    items?: CreatePayload["items"];
    arbiterFeeMsats?: number;
    expirySeconds?: number;
    communityArbiters?: string[];
    /** 2B prefer-bonded: funded bonded subset (⊆ communityArbiters), stamped into
     *  CREATE so every client replays the same preferred seat. */
    bondedArbiters?: string[];
    subscription?: {
      totalPeriods: number;
      periodAmountMsats: number;
      periodDurationSeconds: number;
    };
    // v0.1.72 federation gates ─────────────────────────────────────────
    /** Federation prefix (first 10 chars of a 1-sat probe). Locker captures via probeFederation(). */
    fedPrefix?: string;
    /** Full federation ID (hex). Locker captures via probeFederation(). */
    fed?: string;
    // #7 multi-unit storefront ───────────────────────────────────────────
    /** Parent listing: total units offered. Marks this CREATE as a perpetual
     *  multi-unit storefront (never locked itself; buyers spawn children). */
    stock?: number;
    /** Child purchase: the parent listing's escrow id. Emitted as a `#parent`
     *  tag so the parent's children are relay-filterable for stock counting. */
    parent?: string;
    /** Child purchase: units claimed from the parent's stock. */
    claimedQuantity?: number;
    /** Child purchase: the parent's seller pubkey, seated as SELLER so a
     *  buyer-created child is lock-ready without the seller online (Option A). */
    sellerPubkey?: string;
    /** Internal deterministic id used only for verified tranche children. */
    escrowId?: string;
    /** Frozen private tranche-child descriptor. */
    trancheChild?: TrancheChildDescriptor;
  }): Promise<{ escrowId: string; state: EscrowState }> {
    const pubkey = await this.getPubkey();
    const now = Math.floor(Date.now() / 1000);
    const escrowId = params.escrowId ?? this.generateEscrowId();
    if (params.trancheChild && escrowId !== trancheChildId(params.trancheChild.parent, params.trancheChild.planId, params.trancheChild.index)) {
      throw new Error("Tranche child id is not deterministic for its parent plan and index");
    }

    // PR 2: normalize fulfillment so the wire payload matches what
    // handleCreate will store. Marketplace defaults to "physical" when
    // unspecified (form should still force a pick); other categories
    // get "service" regardless of input.
    const fulfillment: "physical" | "service" | "digital" =
      params.category === "marketplace"
        ? (params.fulfillment ?? "physical")
        : "service";

    // Resolved AFTER the id exists — see escrowKeyFor. Fails soft: no key just
    // means the funding screen names a blocker until it is published.
    let escrowXonly: string | undefined;
    if (params.escrowKeyFor) {
      try { escrowXonly = await params.escrowKeyFor(escrowId); }
      catch (e) { console.warn("[chama] creator escrow key unavailable:", e); }
    }

    const payload: CreatePayload = {
      type: "escrow:create",
      description: params.description,
      listingKind: params.listingKind,
      imageDataUrl: params.imageDataUrl,
      imageUrls: params.imageUrls,
      amountMsats: params.amountMsats,
      fiatAmount: params.fiatAmount,
      fiatCurrency: params.fiatCurrency,
      premiumBps: params.premiumBps,
      category: params.category,
      fulfillment,
      community: params.community,
      // v3.1 B3: carry the ISO country so receivers who don't know this
      // community can still self-describe (flag + currency) from the wire.
      country: params.country,
      // v4.1 (#12): carry the CBP bill type so the card/detail can show it.
      billType: params.billType,
      // A4: carry the Work category so both sides can be matched on it.
      workCategory: params.workCategory,
      // Tranching: carry the slice descriptor so every client can rebuild the plan.
      ...(params.tranche ? { tranche: params.tranche } : {}),
      // Tier 2.1: only emit the field when it says something other than the
      // default, so an ordinary ecash CREATE stays byte-identical on the wire.
      ...(params.escrowMode === "onchain" ? { escrowMode: "onchain" as const } : {}),
      ...(params.settlementPolicy ? { settlementPolicy: params.settlementPolicy } : {}),
      ...(params.sliceCount !== undefined ? { sliceCount: params.sliceCount } : {}),
      ...(escrowXonly ? { escrowXonly } : {}),
      mintUrl: params.mintUrl,
      platformFeeBps: this.config.defaultPlatformFeeBps!,
      platformFeePubkey: this.config.platformFeePubkey || pubkey,
      arbiterFeeMsats: params.arbiterFeeMsats,
      paymentMethods: params.paymentMethods,
      items: params.items,
      expirySeconds: params.expirySeconds || this.config.defaultExpirySeconds!,
      communityArbiters: params.communityArbiters,
      bondedArbiters: params.bondedArbiters,
      // v0.1.72 federation gates: optional locker-fed identity
      fedPrefix: params.fedPrefix,
      fed: params.fed,
      // #7 multi-unit storefront: stock on a parent; parent/claimedQuantity/
      // sellerPubkey on a child purchase. All optional — legacy listings omit.
      stock: params.stock,
      parent: params.parent,
      claimedQuantity: params.claimedQuantity,
      sellerPubkey: params.sellerPubkey,
      trancheChild: params.trancheChild,
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
        // PR 2: community + fulfillment as relay-filterable tags. Browse
        // can fan out a `#community` filter directly to relays without
        // pulling and decoding every CREATE.
        ...(params.community ? [[TAGS.COMMUNITY, params.community]] : []),
        [TAGS.FULFILLMENT, fulfillment],
        // v0.1.72 federation gates: tag the locker's fed for fast filtering
        ...(params.fedPrefix ? [[TAGS.FED_PREFIX, params.fedPrefix]] : []),
        ...(params.fed ? [[TAGS.FED, params.fed]] : []),
        // #7 multi-unit storefront: a child carries its parent's id as a
        // `#parent` tag so Browse can fan out one relay filter to fetch all of
        // a listing's children and derive remaining stock.
        ...(params.parent ? [[TAGS.PARENT, params.parent]] : []),
        ...(params.trancheChild ? [
          [TAGS.PLAN, params.trancheChild.planId],
          [TAGS.TRANCHE, String(params.trancheChild.index)],
          [TAGS.BITCOIN_NETWORK, params.trancheChild.bitcoinNetwork],
        ] : []),
        // Discovery (v3.x): a child purchase seats the parent's seller without
        // the seller authoring this CREATE — tag them `#p` so the trade is
        // relay-discoverable from the seller's side (discoverMyEscrowIds)
        // before they ever act on it. Additive; replay ignores this tag.
        ...(params.sellerPubkey ? [[TAGS.PARTICIPANT, params.sellerPubkey]] : []),
        // Tranche continuity: both existing principals discover the next
        // slice automatically. These are routing hints, never participant
        // claims; reducer seating remains unchanged.
        ...((params.continuationPubkeys ?? [])
          .filter((pk, index, all) => pk !== pubkey && all.indexOf(pk) === index)
          .map((pk) => [TAGS.PARTICIPANT, pk])),
        ...(params.trancheChild ? [
          [TAGS.PARTICIPANT, params.trancheChild.buyerPubkey],
          [TAGS.PARTICIPANT, params.trancheChild.arbiterPubkey],
        ] : []),
        // Store listings have a standard NIP-99 public identity. The Chama
        // CREATE remains the escrow-capable source of truth and points to its
        // interoperable classified-listing mirror by addressable coordinate.
        ...(params.category === "marketplace" && !params.parent
          ? [["a", nip99ListingCoordinate(pubkey, escrowId)]]
          : []),
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // Best-effort dual publication: a relay/signer failure in the NIP-99
    // mirror must not turn the already-published escrow CREATE into a false
    // failure. Only Store parents/standalone listings are mirrored; buyer-
    // authored child orders and Chama's other verticals stay private to the
    // escrow protocol.
    const nip99Unsigned = buildNip99ListingEvent({
      payload,
      pubkey,
      escrowId,
      createdAt: now,
    });
    if (nip99Unsigned) {
      try {
        const nip99Signed = await this.signWithSimTag(nip99Unsigned);
        await this.relayManager.publish(nip99Signed);
      } catch (error) {
        console.warn(`[chama] NIP-99 mirror publish failed for ${escrowId}:`, error);
      }
    }

    // Apply locally immediately (optimistic)
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local parse failed: ${parsed.error.message}`);

    const result = applyEvent(null, parsed.event);
    if (!result.ok) throw new Error(`Local apply failed: ${result.error.message}`);

    this.states.set(escrowId, result.state);
    this.setHotRawEvents(escrowId, [signed]);
    this.callbacks.onStateUpdate?.(escrowId, result.state);

    // Subscribe to this escrow's events
    this.watchEscrow(escrowId);

    // If subscription params provided, auto-publish SUBSCRIBE event
    if (params.subscription) {
      try {
        const subNow = Math.floor(Date.now() / 1000);
        const subPayload = {
          type: "escrow:subscribe" as const,
          totalPeriods: params.subscription.totalPeriods,
          periodAmountMsats: params.subscription.periodAmountMsats,
          periodDurationSeconds: params.subscription.periodDurationSeconds,
          description: params.description,
          startsAt: subNow,
        };
        const subContent = JSON.stringify(subPayload);
        const currentState = this.states.get(escrowId)!;
        const lastEvtId = currentState.eventChain[currentState.eventChain.length - 1]?.raw.id;
        const subUnsigned: UnsignedEvent = {
          kind: EscrowEventKind.SUBSCRIBE,
          created_at: subNow,
          tags: [
            [TAGS.ESCROW_ID, escrowId],
            [TAGS.PREV_EVENT, lastEvtId, "", "reply"],
            [TAGS.TYPE, "escrow:subscribe"],
          ],
          content: subContent,
        };
        const subSigned = await this.signWithSimTag(subUnsigned);
        await this.relayManager.publish(subSigned);
        this.applyLocally(escrowId, subSigned, subPayload);
        console.debug("[chama] SUBSCRIBE event published for", escrowId);
      } catch (e) {
        console.warn("[chama] Failed to publish SUBSCRIBE:", e);
      }
    }

    return { escrowId, state: this.states.get(escrowId)! };
  }

  /** Freeze a parent and idempotently fan out every private child. The parent
   * stays the persistent room; children are tagged to all frozen participants
   * but are excluded from the public listing feed. */
  async startTranchePlan(
    parentId: string,
    maximumChildMsats: number,
    bitcoinNetwork: TrancheBitcoinNetwork,
  ): Promise<{ parent: EscrowState; children: EscrowState[] }> {
    let parent = this.states.get(parentId) ?? await this.loadEscrow(parentId);
    if (!parent) throw new Error(`Parent ${parentId} not found`);
    const coordinator = await this.getPubkey();
    if (parent.initiator.pubkey !== coordinator || parent.initiator.role !== Role.SELLER) throw new Error("Only the parent seller may coordinate its tranche plan");
    const buyerPubkey = parent.participants[Role.BUYER];
    const sellerPubkey = parent.participants[Role.SELLER];
    // Ordinary ecash does not require an arbiter JOIN: the locker freezes the
    // deterministic pool pick inside LOCK. Slicing introduces PLAN_START before
    // the first child can LOCK, so requiring a pre-seated arbiter here creates a
    // deadlock that the legacy ecash flow can never resolve. Freeze the exact
    // same deterministic assignment into the signed plan instead.
    const arbiterPubkey = parent.participants[Role.ARBITER]
      ?? pickPreferredArbiter(
        parent.communityArbiters,
        parent.bondedArbiters,
        parent.id,
        [buyerPubkey, sellerPubkey],
      );
    if (!buyerPubkey || !sellerPubkey) throw new Error("Parent buyer and seller must be seated before plan start");
    if (!arbiterPubkey) throw new Error("No eligible arbiter is available for this slice plan");

    const baseParams = {
      description: parent.description,
      listingKind: parent.listingKind,
      imageDataUrl: parent.imageDataUrl,
      imageUrls: parent.imageUrls,
      fiatAmount: parent.fiatAmount,
      fiatCurrency: parent.fiatCurrency,
      premiumBps: parent.premiumBps,
      category: parent.category,
      fulfillment: parent.fulfillment,
      community: parent.community ?? undefined,
      country: parent.country ?? undefined,
      billType: parent.billType ?? undefined,
      mintUrl: parent.mintUrl,
      paymentMethods: parent.paymentMethods,
      items: parent.items,
      arbiterFeeMsats: parent.fees.arbiterMsats,
      expirySeconds: parent.tradeTimeoutSeconds ?? this.config.defaultExpirySeconds!,
      communityArbiters: parent.communityArbiters,
      bondedArbiters: parent.bondedArbiters,
    };
    const digestPayload: CreatePayload = {
      type: "escrow:create", ...baseParams, amountMsats: parent.amountMsats,
      platformFeeBps: parent.fees.platformBps, platformFeePubkey: parent.fees.platformPubkey,
      createdAt: parent.createdAt,
    };
    const termsDigest = trancheTermsDigest(digestPayload);
    const planId = tranchePlanId(parentId, termsDigest, buyerPubkey);
    const ecashSlicePlan = parent.escrowMode === "ecash"
      && parent.settlementPolicy === SETTLEMENT_POLICY_ECASH_SLICES
      && parent.sliceCount !== undefined
      ? deriveSlicePlan({ totalMsats: parent.amountMsats, userCount: parent.sliceCount })
      : null;
    const tranches = ecashSlicePlan?.tranches
      ?? splitTranches(parent.amountMsats, maximumChildMsats);
    let planStartEventId = parent.tranchePlan?.eventId;
    let plan: PlanStartPayload;
    if (parent.tranchePlan) {
      plan = parent.tranchePlan;
      if (plan.planId !== planId || plan.bitcoinNetwork !== bitcoinNetwork) throw new Error("Parent already has a different frozen tranche plan");
    } else {
      const now = Math.floor(Date.now() / 1000);
      plan = { type: "escrow:plan_start", planId, total: tranches.length, totalMsats: parent.amountMsats,
        buyerPubkey, sellerPubkey, arbiterPubkey, termsDigest, coordinatorPubkey: coordinator,
        bitcoinNetwork,
        ...(ecashSlicePlan ? {
          settlementPolicy: SETTLEMENT_POLICY_ECASH_SLICES,
          sliceCount: ecashSlicePlan.sliceCount,
          sliceCapMsats: MAX_SLICE_EXPOSURE_MSATS,
        } : {}),
        tranches, startedAt: now };
      const previous = parent.eventChain[parent.eventChain.length - 1]?.raw.id;
      const unsigned: UnsignedEvent = { kind: EscrowEventKind.PLAN_START, created_at: now, tags: [
        [TAGS.ESCROW_ID, parentId], [TAGS.PREV_EVENT, previous, "", "reply"],
        [TAGS.TYPE, "escrow:plan_start"], [TAGS.PLAN, planId], [TAGS.BITCOIN_NETWORK, bitcoinNetwork],
        [TAGS.PARTICIPANT, buyerPubkey], [TAGS.PARTICIPANT, sellerPubkey], [TAGS.PARTICIPANT, arbiterPubkey],
      ], content: JSON.stringify(plan) };
      const signed = await this.signWithSimTag(unsigned);
      await this.relayManager.publish(signed);
      parent = this.applyLocally(parentId, signed, plan);
      planStartEventId = signed.id;
    }
    if (!planStartEventId) throw new Error("Plan start event id unavailable");

    const existing = await this.loadChildren(parentId);
    const byId = new Map(existing.map(child => [child.id, child]));
    const children: EscrowState[] = [];
    for (const row of plan.tranches) {
      const id = trancheChildId(parentId, plan.planId, row.index);
      let child = byId.get(id);
      if (!child) {
        const tranche = buildChildDescriptor(parentId, planStartEventId, plan, row.index);
        child = (await this.createEscrow({ ...baseParams, amountMsats: row.amountMsats, parent: parentId,
          ...(ecashSlicePlan ? { settlementPolicy: SETTLEMENT_POLICY_ECASH_SLICES } : {}),
          sellerPubkey, escrowId: id, trancheChild: tranche })).state;
      }
      children.push(child);
    }
    return { parent, children };
  }

  async publishChildKey(escrowId: string, role: Role, xOnlyPubkey: string): Promise<EscrowState> {
    const state = this.states.get(escrowId) ?? await this.loadEscrow(escrowId);
    if (!state?.trancheChild) throw new Error("Escrow is not a tranche child");
    const pubkey = await this.getPubkey();
    if (state.participants[role] !== pubkey) throw new Error("Signer does not hold that frozen child role");
    const now = Math.floor(Date.now() / 1000);
    const payload: ChildKeyPayload = { type: "escrow:child_key", planId: state.trancheChild.planId,
      parent: state.trancheChild.parent, index: state.trancheChild.index, role,
      bitcoinNetwork: state.trancheChild.bitcoinNetwork, xOnlyPubkey, publishedAt: now };
    const previous = state.eventChain[state.eventChain.length - 1]?.raw.id;
    const unsigned: UnsignedEvent = { kind: EscrowEventKind.CHILD_KEY, created_at: now, tags: [
      [TAGS.ESCROW_ID, escrowId], [TAGS.PREV_EVENT, previous, "", "reply"], [TAGS.TYPE, "escrow:child_key"],
      [TAGS.PARENT, state.trancheChild.parent], [TAGS.PLAN, state.trancheChild.planId], [TAGS.TRANCHE, String(state.trancheChild.index)],
      [TAGS.BITCOIN_NETWORK, state.trancheChild.bitcoinNetwork], [TAGS.PARTICIPANT, pubkey],
    ], content: JSON.stringify(payload) };
    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);
    return this.applyLocally(escrowId, signed, payload);
  }

  /** Pre-spend/pre-address-display tranche gate. Callers must run this before
   * creating an invoice, deposit address, or spending wallet notes. */
  async assertTrancheFundingAllowed(state: EscrowState): Promise<void> {
    if (state.tranchePlan) throw new Error("The parent is a tranche manifest and cannot receive funding");
    if (!state.trancheChild) return;
    const parent = this.states.get(state.trancheChild.parent) ?? await this.loadEscrow(state.trancheChild.parent);
    if (!parent?.tranchePlan) throw new Error("Cannot verify the signed parent tranche plan");
    if (parent.tranchePlan.bitcoinNetwork !== state.trancheChild.bitcoinNetwork) throw new Error("Tranche Bitcoin network does not match its parent");
    const children = await this.loadChildren(parent.id);
    if (!canFundTranche(parent, children, state.id)) throw new Error("A prior tranche must complete before this child can fund");
  }

  // ── Join an existing escrow ─────────────────────────────────────────────

  async joinEscrow(
    escrowId: string,
    role: Role,
    opts: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean; escrowXonly?: string } = {},
  ): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const existingRole = this.getMyRole(state, pubkey);
    const isOrderUpdate =
      existingRole === role &&
      (
        (!!opts.selectedItems && opts.selectedItems.length > 0) ||
        opts.orderFinalized === true
      );
    if (existingRole && !isOrderUpdate) {
      const err: any = new Error(
        existingRole === role
          ? `You are already the ${existingRole} on this trade.`
          : `You are already the ${existingRole} on this trade, so you can't join as ${role}.`
      );
      err.code = "ALREADY_PARTICIPANT";
      err.role = existingRole;
      err.requestedRole = role;
      throw err;
    }
    if (state.initiator.pubkey === pubkey && !isOrderUpdate) {
      const err: any = new Error(
        `You created this trade as ${state.initiator.role}, so you can't join it as ${role}.`
      );
      err.code = "ALREADY_PARTICIPANT";
      err.role = state.initiator.role;
      err.requestedRole = role;
      throw err;
    }
    if (role === Role.ARBITER && !state.communityArbiters.includes(pubkey)) {
      const err: any = new Error(
        state.communityArbiters.length === 0
          ? "This trade has no trusted arbiter pool, so you can't join it as arbiter."
          : "Your key is not in this trade's trusted arbiter pool."
      );
      err.code = state.communityArbiters.length === 0
        ? "ARBITER_POOL_EMPTY"
        : "ARBITER_NOT_IN_POOL";
      err.requestedRole = role;
      throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: JoinPayload = {
      type: "escrow:join",
      role,
      joinedAt: now,
      ...(role === Role.BUYER || role === Role.SELLER
        // ⭐ Mode-aware: an on-chain seat must outlast a confirmation, or the
        // funder's LOCK is refused for naming a buyer who has been un-seated
        // while they waited for the block. Stamped on the wire, so clients that
        // predate on-chain escrow honour it without knowing why.
        ? { holdExpiresAt: joinHoldExpiresAtFor(now, state.escrowMode) }
        : {}),
      ...(opts.selectedItems && opts.selectedItems.length > 0
        ? { selectedItems: opts.selectedItems }
        : {}),
      ...(opts.amountMsats !== undefined && opts.amountMsats > 0
        ? { amountMsats: opts.amountMsats }
        : {}),
      ...(opts.orderFinalized
        ? { orderFinalizedAt: now }
        : {}),
      // Tier 2.1: publish this party's on-chain escrow key so the address can
      // be computed. Only present on an on-chain trade — an ecash JOIN stays
      // byte-identical.
      ...(opts.escrowXonly ? { escrowXonly: opts.escrowXonly } : {}),
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
        // Tier 2.1 discovery: once the buyer is known, so is the exact
        // deterministic bonded arbiter whose key the on-chain address needs.
        // Tagging that pubkey makes the pre-lock trade relay-discoverable to
        // them; replay still derives seating from JOIN/LOCK payloads and never
        // treats this routing tag as consensus state.
        ...(role === Role.BUYER && (state.escrowMode ?? "ecash") === "onchain"
          ? (() => {
              const assigned = pickPreferredArbiter(
                state.communityArbiters,
                state.bondedArbiters,
                state.id,
                [pubkey, state.participants[Role.SELLER]],
              );
              return assigned && assigned !== pubkey
                ? [[TAGS.PARTICIPANT, assigned]]
                : [];
            })()
          : []),
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // JOIN is ACK-only in the atomic-funding model: it records the
    // joiner's pubkey on the chain but does not trigger any state
    // transition or notifier hook. LOCK is what moves the trade.
    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Lock ecash in SSS escrow ────────────────────────────────────────────
  // The real lock flow runs through EscrowFedimintBridge.lockAndPublish,
  // which calls FedimintClient.createEscrowLock (real WASM spendNotes +
  // Shamir split) and then this.lockEscrow with the resulting shares.
  // Use that bridge from the UI layer. This class only handles the
  // Nostr event side.

  // PR 1 atomic funding: lockEscrow now requires buyerPubkey + arbiterPubkey
  // because LOCK is self-describing (no prior JOIN required to populate
  // participant slots). The bridge is responsible for picking the arbiter
  // from state.communityArbiters and supplying the buyer pubkey from
  // whichever source the locker has (prior JOIN ACK, or pre-lock invoice
  // metadata that names the buyer).
  // v0.1.71: lockEscrow no longer takes platformFeeMsats — platform fees
  // are collected via Lightning at trade completion.
  async lockEscrow(escrowId: string, params: {
    notesHash: string;
    shares: LockShareEntry[];
    /** Tier 2.1: on-chain escrow terms. Present ⇒ this is an on-chain LOCK and
     *  `notesHash` is "" with no shares — the reducer refuses the hybrid. */
    onchain?: LockPayload["onchain"];
    sellerReceivesMsats: number;
    arbiterFeeMsats: number;
    buyerPubkey: string;
    arbiterPubkey: string;
    /** PR 3 handle reveal — all optional. The bridge resolves these
     *  from the seller's saved handles before calling. None of these
     *  apply to non-fiat trades (marketplace digital, raw escrow). */
    handleId?: string;
    handle?: string;
    rail?: string;
    /** v0.6.5: mobile-money networks the seller accepts on this handle
     *  ("m-pesa", "wave", etc.). Bridge pulls from saved handle. */
    handleNetworks?: string[];
    selectedItems?: LockPayload["selectedItems"];
    /** Holder-only shares: "holder-only-v1" when the bridge built per-holder
     *  shares. Absent ⇒ legacy dual-encrypted (old claim path). */
    sharePolicy?: LockPayload["sharePolicy"];
    /** Arbiter substitution: true when the bridge encrypted the arbiter share
     *  to the deterministic priority order (assigned + backups). */
    arbiterPoolShare?: boolean;
    /** v2.3: committed substitution grace ceiling (seconds). Rides in the
     *  signed LOCK so backup eligibility replays identically everywhere.
     *  Absent ⇒ legacy 4h default. */
    substitutionGraceSeconds?: number;
  }): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);
    await this.assertTrancheFundingAllowed(state);

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    // PR 4: build the 3-recipient handle envelope when the locker
    // supplied handle data. Mirrors LockShareEntry.encryptedFor — each
    // participant gets a NIP-44 ciphertext of the handle JSON,
    // decryptable only by them. Locker is the sender (their pubkey is
    // the ECDH counterparty for all three decryption operations).
    const lockerPubkey = await this.getPubkey();
    let handleEnvelope: HandleEnvelope | undefined;
    if (params.handle) {
      const handleData = JSON.stringify({
        handleId: params.handleId,
        handle: params.handle,
        rail: params.rail,
        // v0.6.5: networks ride inside the same encrypted blob — never
        // on the wire as cleartext. Only set when present; absent in
        // pre-v0.6.5 trades and non-phone rails.
        ...(params.handleNetworks && params.handleNetworks.length > 0
          ? { networks: params.handleNetworks }
          : {}),
      });
      handleEnvelope = await createEnvelope(
        handleData,
        [params.buyerPubkey, lockerPubkey, params.arbiterPubkey],
        (pt, pk) => this.signer.nip44Encrypt(pt, pk),
      );
    }

    // Wire payload — envelope only. Top-level handle/handleId/rail are
    // omitted; receivers resolve from the envelope.
    const wirePayload: LockPayload = {
      type: "escrow:lock",
      notesHash: params.notesHash,
      ...(params.onchain ? { onchain: params.onchain } : {}),
      shares: params.shares,
      sharePolicy: params.sharePolicy,
      arbiterPoolShare: params.arbiterPoolShare,
      ...(typeof params.substitutionGraceSeconds === "number"
        ? { substitutionGraceSeconds: params.substitutionGraceSeconds }
        : {}),
      sellerReceivesMsats: params.sellerReceivesMsats,
      arbiterFeeMsats: params.arbiterFeeMsats,
      // Images live on CREATE. Strip legacy inline media defensively here,
      // at the final wire boundary, so no caller can create an oversized
      // LOCK event (including an old pending-lock retry).
      selectedItems: compactSelectedMenuItems(params.selectedItems),
      buyerPubkey: params.buyerPubkey,
      arbiterPubkey: params.arbiterPubkey,
      handleEnvelope,
      lockedAt: now,
    };

    // PR 4: outer NIP-44 wrap removed for LOCK. The wrap was
    // single-recipient-to-locker — fundamentally incompatible with
    // 3-recipient distribution. Sensitive data is now per-recipient
    // encrypted INSIDE the payload (shares were already; handle joins
    // them via handleEnvelope). Wire content is plaintext JSON, same
    // as DEV mode behavior, now correct in PROD mode too.
    const content = JSON.stringify(wirePayload);

    // Additive (v3.x) discovery tags: list every seated participant as a `#p`
    // so an npub's trades are relay-discoverable (discoverMyEscrowIds) even for
    // a passively-seated party — most importantly the ARBITER, who otherwise
    // never authors an event until a dispute and so would be invisible to an
    // `authors:` query. Consensus-safe: replay reads buyer/seller/arbiter from
    // the LOCK payload, never from these tags, and old clients ignore them.
    const lockParticipantTags = [
      ...new Set(
        [params.buyerPubkey, state.participants.seller, params.arbiterPubkey].filter(
          (pk): pk is string => typeof pk === "string" && /^[0-9a-f]{64}$/.test(pk),
        ),
      ),
    ].map(pk => [TAGS.PARTICIPANT, pk]);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.LOCK,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:lock"],
        ...lockParticipantTags,
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // For local apply, we have the cleartext in scope — synthesize a
    // payload that includes BOTH the envelope (for wire fidelity in
    // eventChain replay) AND the top-level handle fields (so handleLock
    // can populate state.lock.handle without going through a decrypt
    // round-trip on our own envelope entry).
    const localPayload: LockPayload = {
      ...wirePayload,
      handleId: params.handleId,
      handle: params.handle,
      rail: params.rail,
      ...(params.handleNetworks && params.handleNetworks.length > 0
        ? { handleNetworks: params.handleNetworks }
        : {}),
    };
    const lockResult = this.applyLocally(escrowId, signed, localPayload);

    return lockResult;
  }

  // ── Cast a vote ─────────────────────────────────────────────────────────

  /** Holder-only shares: build the VOTE-carried share envelope for `outcome`.
   *  Decrypts the voter's OWN holder-only LOCK share (locker = sender) and
   *  re-encrypts it to the engine-computed recipient (voter = sender), so only
   *  the recipient can read it even though the VOTE is visible to all three
   *  participants. Returns undefined for legacy locks or on any failure —
   *  best-effort, never blocks the vote. */
  private async buildVoteShareEnvelope(
    state: EscrowState,
    voterRole: Role,
    voterPubkey: string,
    outcome: Outcome,
  ): Promise<VoteShareEnvelope | undefined> {
    try {
      if (state.lock.sharePolicy !== HOLDER_ONLY_SHARE_POLICY) return undefined;
      const recipient = payoutRecipientFor(state, outcome);
      if (!recipient) return undefined;
      const shareIndex = shareIndexForRole(voterRole);
      const myCipher = state.lock.shares.get(String(shareIndex))?.encryptedFor?.[voterPubkey];
      if (!myCipher) return undefined;
      // LOCK shares were encrypted by the locker → decrypt with locker = sender.
      const lockerPubkey = state.eventChain.find(e => e.kind === EscrowEventKind.LOCK)?.raw.pubkey;
      if (!lockerPubkey) return undefined;
      const plaintextShare = await this.signer.nip44Decrypt(myCipher, lockerPubkey);
      // Re-encrypt to the recipient — voter is the sender.
      const reEncrypted = await this.signer.nip44Encrypt(plaintextShare, recipient.pubkey);
      return {
        shareIndex,
        outcome,
        notesHash: state.lock.notesHash ?? "",
        recipientPubkey: recipient.pubkey,
        encryptedFor: { [recipient.pubkey]: reEncrypted },
      };
    } catch (e) {
      console.debug("[escrow] vote share-envelope skipped (best-effort):", e);
      return undefined;
    }
  }

  async vote(escrowId: string, outcome: Outcome): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    let role = this.getMyRole(state, pubkey);
    if (!role) {
      // Arbiter substitution: an eligible pool backup votes as ARBITER on a
      // pooled-share lock. canVote (below) enforces the dispute gates + the
      // assigned arbiter's grace window; the reducer re-enforces all of it.
      if (state.lock.arbiterPoolShare && arbiterVotePriority(state, pubkey) !== null) {
        role = Role.ARBITER;
      } else {
        throw new Error("You are not a participant in this escrow");
      }
    }

    const voteCheck = canVote(state, pubkey);
    if (!voteCheck.canVote) throw new Error(`Cannot vote: ${voteCheck.reason}`);

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    // Holder-only shares: re-encrypt this voter's own LOCK share to the
    // outcome's engine-computed recipient and carry it on the VOTE so the
    // recipient can reconstruct from their own share + this one. Best-effort —
    // a failure or a legacy dual-encrypted lock just omits it, never blocking
    // the vote (the expiry-heal refund pays the funder, whose token makes its
    // share redundant — refinement #3).
    const shareEnvelope = await this.buildVoteShareEnvelope(state, role, pubkey, outcome);

    const payload: VotePayload = {
      type: "escrow:vote",
      outcome,
      role,
      ...(shareEnvelope ? { shareEnvelope } : {}),
      votedAt: now,
    };

    // SECURITY: VOTE outcome is private to the three participants.
    // When encryptVote is on, wrap the payload in a per-recipient
    // envelope so buyer/seller/arbiter can each decrypt their slot
    // and no relay operator can read the cleartext. When off (DEV),
    // ship the JSON in the clear for easy debugging.
    const content = ENCRYPTION_CONFIG.encryptVote
      ? await this.encryptVoteToParticipants(payload, state)
      : JSON.stringify(payload);

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

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    const newState = this.applyLocally(escrowId, signed, payload);

    // Auto-resolve if 2-of-3 threshold is met.
    // Wrapped in try/catch — resolve failure must not break the vote.
    // If this fails, handleIncomingEvent will retry when the relay
    // delivers the VOTE to other browsers (or back to us).
    try {
      await this.maybeAutoResolve(escrowId);
    } catch (e) {
      console.warn("[escrow] Auto-resolve failed after vote — will retry on relay echo:", e);
      // Retry once after a short delay
      setTimeout(() => {
        this.maybeAutoResolve(escrowId).catch(e2 =>
          console.debug("[escrow] Auto-resolve retry also failed:", e2)
        );
      }, 2000);
    }

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

    // SECURITY: CLAIM carries the notes-hash verification — a
    // commitment that only the winner could produce. Wrap in the
    // per-recipient envelope so the three participants can audit it
    // while no relay operator can read it.
    const content = ENCRYPTION_CONFIG.encryptClaim
      ? await this.encryptToParticipants(payload, state)
      : JSON.stringify(payload);

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

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Complete (winner confirms settlement finalized) ─────────────────────
  //
  // After a successful CLAIM + redeem, the winner publishes COMPLETE to
  // move the escrow into the terminal COMPLETED state. Without this, the
  // trade stays at CLAIMED forever and never reaches the defined terminal
  // state. COMPLETE takes no action beyond publishing the event and
  // transitioning local state — it's a protocol-level statement that
  // settlement is finalized.
  //
  // Only the winner publishes COMPLETE. Non-winners observe it via relay
  // echo. Duplicate COMPLETE events from multiple devices are benign —
  // replayEventChain classifies INVALID_STATE on COMPLETE as a benign-skip.

  async complete(escrowId: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    if (state.status !== EscrowStatus.CLAIMED) {
      throw new Error(`Cannot complete in state ${state.status} (need CLAIMED)`);
    }

    const pubkey = await this.getPubkey();
    const winner = getWinner(state);
    if (!winner || winner.pubkey !== pubkey) {
      throw new Error("Only the winner can publish COMPLETE");
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: CompletePayload = {
      type: "escrow:complete",
      completedAt: now,
    };

    // Plaintext for consistency with CLAIM. COMPLETE reveals nothing
    // beyond "this trade settled" which is already observable via the
    // presence of a kind 38106 event with the escrow's d-tag.
    const content = JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.COMPLETE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:complete"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  /** Publish COMPLETE after a verified cooperative on-chain transaction was
   *  broadcast or adopted from Esplora. Unlike ecash there is no CLAIM hop:
   *  the Bitcoin spend itself is the settlement proof. */
  async completeOnchain(escrowId: string, settlementProofEventId: string): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);
    if (!state.lock.onchain || state.status !== EscrowStatus.APPROVED) {
      throw new Error(`Cannot complete on-chain escrow in state ${state.status}`);
    }
    const pubkey = await this.getPubkey();
    const settlementProof = state.settlements?.find(message => message.raw.id === settlementProofEventId);
    const winner = getWinner(state);
    const winnerRole = winner?.role === Role.BUYER || winner?.role === Role.SELLER ? winner.role : null;
    const requiresArbiter = !!state.resolvedMajority?.includes(Role.ARBITER);
    const cooperative = !!(!requiresArbiter && settlementProof && winnerRole
      && finalCoopSettlementProof(settlementProof, state.lock.onchain, winnerRole));
    const arbitrated = !!(requiresArbiter
      && settlementProof && winnerRole
      && finalArbiterSettlementProof(settlementProof, state.lock.onchain, winnerRole));
    const authorized = cooperative
      ? pubkey === state.participants[Role.BUYER] || pubkey === state.participants[Role.SELLER]
      : arbitrated && (pubkey === state.participants[winnerRole!] || pubkey === state.participants[Role.ARBITER]);
    if (!authorized) {
      throw new Error("The selected settlement proof is not replay-valid for this signer");
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: CompletePayload = { type: "escrow:complete", completedAt: now };
    const signed = await this.signWithSimTag({
      kind: EscrowEventKind.COMPLETE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, state.eventChain[state.eventChain.length - 1]?.raw.id, "", "reply"],
        ["settlement", settlementProofEventId],
        [TAGS.TYPE, "escrow:complete"],
      ],
      content: JSON.stringify(payload),
    });
    await this.relayManager.publish(signed);
    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Send a chat message ─────────────────────────────────────────────────

  async sendChat(
    escrowId: string,
    input: string | { message: string; attachments?: ChatImageAttachment[] },
  ): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const now = Math.floor(Date.now() / 1000);
    const message = (typeof input === "string" ? input : input.message).trim();
    const attachments = typeof input === "string"
      ? undefined
      : input.attachments?.filter(a =>
          a.kind === "image" &&
          typeof a.id === "string" &&
          a.mimeType.startsWith("image/") &&
          a.dataUrl.startsWith("data:image/"),
        );
    if (!message && (!attachments || attachments.length === 0)) {
      throw new Error("Chat message cannot be empty");
    }

    const chatBody: ChatBody = {
      message,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    // Chat audience = the NAMED trade parties plus the author themselves, NOT
    // getEffectiveParticipantsAt(now). The effective-participant helper returns
    // null for a role whose 5-min JOIN_HOLD has lapsed while still CREATED — but
    // the hold only governs who may LOCK, never who may READ the conversation
    // they're part of. Enveloping to the effective set silently EXCLUDED the
    // author once their own hold expired (a buyer who took an order, let the
    // deadline pass, then messaged): the message showed via the local cleartext
    // echo but had no ciphertext entry for the author, so it was dropped on any
    // reload/re-entry re-decrypt. Named-participants ∪ self keeps chat readable
    // to exactly the trade parties regardless of seat-hold timing.
    const recipients = Array.from(
      new Set(
        [
          state.participants[Role.BUYER],
          state.participants[Role.SELLER],
          state.participants[Role.ARBITER],
          pubkey,
        ].filter((pk): pk is string => typeof pk === "string" && pk.length > 0),
      ),
    );
    const bodyEnvelope = await createEnvelope(
      JSON.stringify(chatBody),
      recipients,
      (pt, pk) => this.signer.nip44Encrypt(pt, pk),
    );

    const payload: ChatPayload = {
      type: "escrow:chat",
      message: "",
      bodyEnvelope,
      senderRole: role,
      sentAt: now,
    };

    const content = JSON.stringify(payload);

    // v3.1.1 (chat-safety, FIX 3): fail LOUDLY before publish if the event
    // content exceeds the relay cap. Relays silently DROP oversized events on
    // receive (MAX_EVENT_CONTENT_BYTES) and publish has no guard, so without
    // this an oversized image "sends" (local echo only), never reaches the peer,
    // and vanishes on reload. `content` already includes the per-recipient
    // envelope fan-out, so it is the true on-wire size. Thrown before
    // publish/local-apply → App's onSendChat .catch toasts it → no phantom copy.
    if (content.length > MAX_CHAT_EVENT_CONTENT_BYTES) {
      throw new Error(
        `That image is too large to send (${Math.round(content.length / 1024)} KB; the limit is ${Math.round(MAX_CHAT_EVENT_CONTENT_BYTES / 1024)} KB). Try a smaller image.`,
      );
    }

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.CHAT,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:chat"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // Apply chat locally for instant display (don't wait for relay echo)
    const localPayload: ChatPayload = {
      ...payload,
      message: chatBody.message,
      attachments: chatBody.attachments,
    };
    const chatParsed = parseEscrowEvent(signed, JSON.stringify(localPayload), true);
    if (chatParsed.ok) {
      const currentChatState = this.states.get(escrowId);
      if (currentChatState) {
        const chatResult = applyEvent(currentChatState, chatParsed.event);
        if (chatResult.ok) {
          // Sender echoes take the same durable-first / bounded-hot path as
          // received chat. The relay echo dedups, so persist the exact signed
          // ciphertext here before releasing it from renderer memory.
          // APPEND, and never write back a raw we already blanked. Entries in
          // state.chatMessages from earlier passes had their ciphertext stripped
          // by stripParsedChatCiphertext, and mergeRawEventsById lets the SECOND
          // argument win — so a whole-record put here rewrote every earlier
          // chat's stored body to "". appendCachedEvents keeps the STORED copy
          // on an id collision, and the filter stops a blanked raw from entering
          // a record that doesn't have it yet. Chat carries receipts and
          // proof-of-payment, so this is dispute evidence, not cosmetics.
          const durable = durableRawSnapshot(
            mergeRawEventsById(
              this.rawEvents.get(escrowId) ?? [],
              [
                ...chatResult.state.chatMessages.map(message => message.raw),
                signed,
              ],
            ),
          ).filter(raw => raw.kind !== EscrowEventKind.CHAT || !!raw.content);
          void appendCachedEvents(escrowId, durable, chatResult.state.status);
          stripParsedChatCiphertext(chatResult.state);
          this.states.set(escrowId, chatResult.state);
          this.callbacks.onStateUpdate?.(escrowId, chatResult.state);
        }
      }
    }
  }

  // ── Arbiter premium (kind 38113, task #53 E1) ───────────────────────────

  /**
   * Publish an arbiter-premium note on the trade's own channel: the OOB
   * ecash rides inside a NIP-44 envelope encrypted to the seated arbiter
   * only. Non-consensus (like CHAT) and valid post-COMPLETED — premiums
   * are paid at settlement. Caller is responsible for having already
   * spent the notes (with a long try_cancel horizon so an absent arbiter
   * auto-refunds the payer).
   */
  async sendPremium(
    escrowId: string,
    input: { amountSats: number; oobNotes: string; federationId?: string; noteKind?: "ambient" | "dispute" },
  ): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const pubkey = await this.getPubkey();
    const payerRole =
      pubkey === state.participants[Role.BUYER] ? Role.BUYER
      : pubkey === state.participants[Role.SELLER] ? Role.SELLER
      : null;
    if (!payerRole) throw new Error("Only trade principals can send an arbiter premium");

    const arbiter = state.participants[Role.ARBITER];
    if (!arbiter) throw new Error("No seated arbiter on this trade");

    const now = Math.floor(Date.now() / 1000);
    const noteKind = input.noteKind ?? "ambient";
    const body: PremiumBody = {
      escrowId,
      payerRole,
      amountSats: input.amountSats,
      federationId: input.federationId,
      oobNotes: input.oobNotes,
      kind: noteKind,
      createdAt: now,
    };
    const noteEnvelope = await createEnvelope(
      JSON.stringify(body),
      [arbiter],
      (pt, pk) => this.signer.nip44Encrypt(pt, pk),
    );

    const payload: PremiumPayload = {
      type: "escrow:premium",
      noteEnvelope,
      payerRole,
      noteKind,
      sentAt: now,
    };

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.PREMIUM,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:premium"],
        // #p the arbiter so their #p discovery probe reaches the premium
        // even when the trade itself has aged off their loaded set.
        [TAGS.PARTICIPANT, arbiter],
      ],
      content: JSON.stringify(payload),
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    // Apply locally + durably cache the raw. PREMIUM is not in eventChain,
    // so (like CHAT) this local write is the only cache entry for our own
    // premium until a relay echo arrives.
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (parsed.ok) {
      const current = this.states.get(escrowId);
      if (current) {
        const result = applyEvent(current, parsed.event);
        if (result.ok) {
          this.states.set(escrowId, result.state);
          const cached = this.rawEvents.get(escrowId) || [];
          cached.push(signed);
          this.setHotRawEvents(escrowId, cached);
          this.callbacks.onStateUpdate?.(escrowId, result.state);
        }
      }
    }
  }

  /**
   * Arbiter side: decrypt a PREMIUM event's note body. Returns null when
   * we are not the envelope recipient or the body doesn't parse — never
   * throws (a malformed premium must not break a redeem sweep).
   */
  async decryptPremiumBody(event: ParsedEscrowEvent<PremiumPayload>): Promise<PremiumBody | null> {
    try {
      const pubkey = await this.getPubkey();
      const cleartext = await decryptFromEnvelope(
        event.payload.noteEnvelope,
        pubkey,
        event.raw.pubkey,
        (ct, pk) => this.signer.nip44Decrypt(ct, pk),
      );
      if (!cleartext) return null;
      const body = JSON.parse(cleartext) as PremiumBody;
      if (typeof body?.oobNotes !== "string" || body.oobNotes.length === 0) return null;
      if (typeof body.amountSats !== "number" || !Number.isFinite(body.amountSats) || body.amountSats <= 0) return null;
      if (typeof body.escrowId !== "string") return null;
      return body;
    } catch {
      return null;
    }
  }

  // ── On-chain settlement transport (kind 38114, Tier 2.1 · S7) ─────────

  /** Publish a PSBT revision to every named participant AND the sender.
   *  The self slot is load-bearing: without it, the author cannot decrypt
   *  their own relay event after a reload. */
  async sendSettlement(
    escrowId: string,
    input: Omit<SettlementPayload, "type">,
  ): Promise<ParsedEscrowEvent<SettlementPayload>> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);
    const pubkey = await this.getPubkey();
    const role = Object.values(Role).find(r => state.participants[r] === pubkey);
    if (!role || role !== input.role) {
      throw new Error("Settlement sender role does not match this trade");
    }
    const payload: SettlementPayload = { type: "escrow:settlement", ...input };
    const recipients = Array.from(new Set([
      state.participants[Role.BUYER],
      state.participants[Role.SELLER],
      state.participants[Role.ARBITER],
      pubkey,
    ].filter((pk): pk is string => typeof pk === "string" && pk.length > 0)));
    const envelope = await createEnvelope(
      JSON.stringify(payload), recipients,
      (pt, pk) => this.signer.nip44Encrypt(pt, pk),
    );
    const now = Math.floor(Date.now() / 1000);
    const signed = await this.signWithSimTag({
      kind: EscrowEventKind.SETTLEMENT,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.TYPE, "escrow:settlement"],
        ...recipients.map(pk => [TAGS.PARTICIPANT, pk]),
      ],
      content: JSON.stringify(envelope),
    });
    await this.relayManager.publish(signed);

    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local settlement parse failed: ${parsed.error.message}`);
    const current = this.states.get(escrowId);
    if (!current) throw new Error(`Escrow ${escrowId} disappeared after settlement publish`);
    const result = applyEvent(current, parsed.event);
    if (!result.ok) throw new Error(result.error.message);
    this.states.set(escrowId, result.state);
    this.setHotRawEvents(escrowId, mergeRawEventsById(this.rawEvents.get(escrowId) ?? [], [signed]));
    this.callbacks.onStateUpdate?.(escrowId, result.state);
    return parsed.event as ParsedEscrowEvent<SettlementPayload>;
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

    const signed = await this.signWithSimTag(unsigned);
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

  /** Content-free memory counters for the offline production-topology profiler.
   * No keys, payloads, or ciphertext leave the client. */
  getProfileMemorySnapshot(): {
    loadedEscrows: number;
    hotRawEvents: number;
    hotRawChatEvents: number;
    hotRawContentBytes: number;
    parsedChatMessages: number;
    parsedChatRawContentBytes: number;
  } {
    let hotRawEvents = 0;
    let hotRawChatEvents = 0;
    let hotRawContentBytes = 0;
    for (const events of this.rawEvents.values()) {
      hotRawEvents += events.length;
      for (const event of events) {
        hotRawContentBytes += event.content.length;
        if (event.kind === EscrowEventKind.CHAT) hotRawChatEvents++;
      }
    }
    let parsedChatMessages = 0;
    let parsedChatRawContentBytes = 0;
    for (const state of this.states.values()) {
      parsedChatMessages += state.chatMessages.length;
      for (const message of state.chatMessages) {
        parsedChatRawContentBytes += message.raw.content.length;
      }
    }
    return {
      loadedEscrows: this.states.size,
      hotRawEvents,
      hotRawChatEvents,
      hotRawContentBytes,
      parsedChatMessages,
      parsedChatRawContentBytes,
    };
  }

  getMyRole(state: EscrowState, pubkey?: string): Role | null {
    const pk = pubkey || this._pubkey;
    if (!pk) return null;
    const now = Math.floor(Date.now() / 1000);
    if (getEffectiveParticipantAt(state, Role.BUYER, now) === pk) return Role.BUYER;
    if (getEffectiveParticipantAt(state, Role.SELLER, now) === pk) return Role.SELLER;
    if (getEffectiveParticipantAt(state, Role.ARBITER, now) === pk) return Role.ARBITER;
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

  /**
   * Subscribe to all public trade listings (CREATE events) across relays.
   * Powers the Browse tab. Events flow through the same onStateUpdate
   * callback as individual escrow watches — the UI filters by "user is
   * not a participant" to split Browse from My trades.
   *
   * Idempotent: safe to call multiple times.
   *
   * @param since Unix timestamp. Default: 7 days ago.
   */
  watchPublicListings(since?: number): void {
    const label = "public-listings";
    if (this.subscriptions.has(label)) return;
    const subId = this.relayManager.subscribeToPublicListings(since);
    this.publicListingsSubId = subId;
    this.publicListingsEoseRelays.clear();
    this.publicListingsSettled = false;
    this.subscriptions.set(label, subId);
  }

  /** Stop the Browse feed subscription. */
  unwatchPublicListings(): void {
    const label = "public-listings";
    const subId = this.subscriptions.get(label);
    if (subId) {
      this.relayManager.unsubscribe(subId);
      this.subscriptions.delete(label);
      this.publicListingsSubId = null;
      this.publicListingsEoseRelays.clear();
      this.publicListingsSettled = false;
    }
  }

  // ── #7 multi-unit storefront ───────────────────────────────────────────

  /** Spawn a CHILD purchase escrow for `claimedQuantity` units of a multi-unit
   *  parent listing and publish its CREATE. This client is seated as BUYER and
   *  the parent's seller as SELLER (Option A — seller needn't be online), so
   *  the caller can LOCK it immediately via the normal marketplace path.
   *  Returns the new child escrow. */
  async purchaseFromListing(
    parent: EscrowState,
    claimedQuantity: number,
  ): Promise<{ escrowId: string; state: EscrowState }> {
    return this.createEscrow(buildChildCreateParams(parent, claimedQuantity));
  }

  /** Load the full states of a listing's CHILD purchase escrows. Fetches child
   *  CREATEs by `#parent`, then loads each child's chain by id so its status /
   *  hold / claimedQuantity are known for stock accounting. Best-effort: a
   *  child that fails to load is skipped. Note: a non-participant (browsing
   *  buyer) can't decrypt other buyers' LOCKs, so they may under-count locked
   *  units and briefly see more stock than real — safe under Option A (an
   *  overcommit just refunds). The SELLER is a participant in every child, so
   *  the seller's own view is accurate. */
  async loadChildren(parentId: string): Promise<EscrowState[]> {
    const createEvents = await this.relayManager.fetchChildCreates(parentId);
    const childIds = new Set<string>();
    for (const ev of createEvents) {
      const d = ev.tags.find(t => t[0] === TAGS.ESCROW_ID)?.[1];
      if (d) childIds.add(d);
    }
    const children: EscrowState[] = [];
    for (const id of childIds) {
      try {
        const state = await this.loadEscrow(id);
        if (state && state.parent === parentId) children.push(state);
      } catch (e) {
        console.debug(`[escrow] loadChildren ${parentId}: child ${id} failed to load`, e);
      }
    }
    return children;
  }

  /** Derived remaining-stock snapshot for a multi-unit parent listing: resolves
   *  the parent (cache or relays) + its children, then runs the pure storefront
   *  accountant. `now` defaults to the wall clock. Returns null if the parent
   *  can't be resolved. */
  async derivedStock(parentId: string, now: number = Math.floor(Date.now() / 1000)): Promise<{
    remaining: number;
    unsold: number;
    soldOut: boolean;
    lastUnitContested: boolean;
    childCount: number;
  } | null> {
    const parent = this.states.get(parentId) ?? await this.loadEscrow(parentId);
    if (!parent) return null;
    const children = await this.loadChildren(parentId);
    return {
      remaining: remainingStock(parent, children, now),
      unsold: unsoldStock(parent, children, now),
      soldOut: isSoldOut(parent, children, now),
      lastUnitContested: isLastUnitContested(parent, children, now),
      childCount: children.length,
    };
  }

  /** Live-watch a listing's children (CREATE fan-out by `#parent`). New child
   *  CREATEs flow through the normal onStateUpdate path so the UI can recompute
   *  derived stock. Idempotent per parent. */
  watchChildren(parentId: string): void {
    const label = `children:${parentId}`;
    if (this.subscriptions.has(label)) return;
    const subId = this.relayManager.subscribeToChildren(parentId);
    this.subscriptions.set(label, subId);
  }

  /** Stop watching a listing's children. */
  unwatchChildren(parentId: string): void {
    const label = `children:${parentId}`;
    const subId = this.subscriptions.get(label);
    if (subId) {
      this.relayManager.unsubscribe(subId);
      this.subscriptions.delete(label);
    }
  }

  /** Why the most recent load of `escrowId` returned null, or null if the last
   *  load succeeded / never ran. Lets a caller tell "this history is gone"
   *  apart from "the relays gave us a chain with holes in it". */
  getLastLoadFailure(escrowId: string): LoadFailure | null {
    return this._lastLoadFailures.get(escrowId) ?? null;
  }

  private recordLoadFailure(escrowId: string, failure: LoadFailure): void {
    this._lastLoadFailures.set(escrowId, failure);
  }

  private clearLoadFailure(escrowId: string): void {
    this._lastLoadFailures.delete(escrowId);
  }

  /**
   * Fetch and reconstruct full escrow state from relays. Concurrent callers
   * for the same id share one generation instead of multiplying relay,
   * decrypt, and replay work.
   *
   * ⚠ `repairFromCache` is OPT-IN ON PURPOSE — do not flip it on by default.
   * It lets a failed replay retry against the durable IndexedDB cache, which
   * costs an IndexedDB read plus a second decrypt/replay pass. On a device
   * with a lot of holed history that is dozens of extra reads during the boot
   * discovery flood — and a stalled WKWebView `indexedDB.open` on that path is
   * exactly what froze Tauri on launch once already (bounded to 3s now, but
   * the rule that a relay-answered load never touches IndexedDB is the actual
   * protection, not the timeout). So: pass it for an EXPLICIT open (tapping an
   * archived trade, a deep link, a manual heal), never for background
   * discovery, listing hydration, or sweeps.
   */
  loadEscrow(
    escrowId: string,
    opts: { repairFromCache?: boolean } = {},
  ): Promise<EscrowState | null> {
    const repairFromCache = opts.repairFromCache === true;
    const existing = this._loadEscrowInFlight.get(escrowId);
    if (existing) {
      existing.diagnostic.coalesced();
      // A background generation already running can't satisfy a caller who
      // asked for repair: it will stop at the same holed chain. Join it (no
      // duplicate fetch), then repair only if it actually came back empty.
      if (repairFromCache && !existing.repairFromCache) {
        return existing.promise.then((state) =>
          state ?? this.loadEscrow(escrowId, { repairFromCache: true }),
        );
      }
      return existing.promise;
    }

    const diagnostic = beginHydrationDiagnostic(escrowId);
    const promise = this.loadEscrowAttempt(escrowId, 0, diagnostic, repairFromCache)
      .then((state) => {
        const failure = state ? null : this.getLastLoadFailure(escrowId);
        diagnostic.finish(state
          ? `state:${state.status}`
          : failure
            ? `error:${failure.code ?? failure.reason}:${failure.message ?? failure.reason}`
            : "null");
        return state;
      })
      .catch((error) => {
        diagnostic.finish(`error:${(error as Error)?.message || String(error)}`);
        throw error;
      })
      .finally(() => {
        if (this._loadEscrowInFlight.get(escrowId)?.promise === promise) {
          this._loadEscrowInFlight.delete(escrowId);
        }
      });
    this._loadEscrowInFlight.set(escrowId, { promise, diagnostic, repairFromCache });
    return promise;
  }

  /** One generation's internal attempt. Recursive completeness retries call
   *  this directly so they never deadlock by joining their own public promise. */
  private async loadEscrowAttempt(
    escrowId: string,
    completenessAttempt: number,
    diagnostic: HydrationDiagnosticRun,
    repairFromCache = false,
  ): Promise<EscrowState | null> {
    const current = this.states.get(escrowId);
    const cachedRawEvents = mergeRawEventsById(
      this.rawEvents.get(escrowId) ?? [],
      current?.eventChain.map(event => event.raw) ?? [],
    );
    // Parsed chat releases ciphertext but keeps its signed metadata (kind,
    // id, created_at). Include that metadata in the cursor calculation so a
    // chat tip advances past its heavy second instead of falling back to the
    // older state-chain tip and re-downloading the photo.
    const cursorEvents = mergeRawEventsById(
      cachedRawEvents,
      current?.chatMessages.map(message => message.raw) ?? [],
    );
    const since = escrowDeltaSince(cursorEvents);
    const fetchStarted = globalThis.performance?.now?.() ?? Date.now();
    const fetchedRawEvents = await this.relayManager.fetchEscrowEvents(
      escrowId,
      15_000,
      since,
    );
    diagnostic.step(
      `fetch:${completenessAttempt}`,
      (globalThis.performance?.now?.() ?? Date.now()) - fetchStarted,
    );
    let rawEvents = mergeRawEventsById(cachedRawEvents, fetchedRawEvents);
    // Durable rebuild is a FALLBACK, not a hot-path seed: reach for the
    // persistent event cache only when the relay answer can't stand on its
    // own — nothing came back at all, or (below) what came back doesn't
    // replay. This keeps IndexedDB OFF the normal launch path — the discovery
    // flood loads relay-present trades without ever touching it — so a
    // stalled WKWebView IndexedDB can't freeze launch. Fully time-bounded
    // even here (see escrow-event-cache).
    let durableTried = false;
    if (rawEvents.length === 0 && !this.rawEvents.has(escrowId)) {
      durableTried = true;
      const durable = await getCachedEvents(escrowId);
      if (durable.length > 0) {
        this.setHotRawEvents(escrowId, durable);
        rawEvents = mergeRawEventsById(durable, fetchedRawEvents);
      }
    }
    diagnostic.attempt(fetchedRawEvents, rawEvents.length);
    console.debug(
      `[escrow] loadEscrow ${escrowId}: fetched ${fetchedRawEvents.length} raw events from relays` +
        (cachedRawEvents.length > 0 ? `, replaying ${rawEvents.length} with local cache` : ""),
    );
    if (rawEvents.length === 0) {
      this.recordLoadFailure(escrowId, { reason: "no-events" });
      return null;
    }

    // Parse + preflight + replay, as ONE re-runnable pass over a given raw
    // event set. Re-runnable because a relay chain that doesn't replay is
    // repairable: the durable cache frequently holds the exact events the
    // relays dropped (field: a COMPLETED trade whose two VOTEs were gone from
    // every relay while this device still had them, so RESOLVE died on
    // THRESHOLD_NOT_MET and the trade read as "not on the relay anymore").
    const runReplay = async (
      events: NostrEvent[],
      pass: string,
    ): Promise<
      | { ok: true; state: EscrowState }
      | { ok: false; failure: LoadFailure }
    > => {
      // decryptEventContent handles the three wire shapes (plaintext escrow
      // payload, per-recipient envelope, legacy raw NIP-44) and returns null
      // for "not for me / malformed / not recognised" cases. Skip those
      // silently so a stale or wrong-recipient event in a relay's cache
      // doesn't blow up the load.
      const decryptStarted = globalThis.performance?.now?.() ?? Date.now();
      const parsed: ParsedEscrowEvent[] = [];
      let skippedEvents = 0;
      for (const raw of events) {
        const content = await this.decryptEventContent(raw);
        if (content === null) {
          skippedEvents++;
          continue;
        }
        const result = parseEscrowEvent(raw, content, true);
        if (result.ok) parsed.push(result.event);
      }
      diagnostic.step(
        `decrypt:${pass}`,
        (globalThis.performance?.now?.() ?? Date.now()) - decryptStarted,
      );

      console.debug(`[escrow] loadEscrow ${escrowId}: parsed ${parsed.length}/${events.length} events`,
        parsed.map(e => `kind:${e.kind}`).join(', '),
        skippedEvents > 0 ? `(${skippedEvents} skipped)` : "");
      if (parsed.length === 0) return { ok: false, failure: { reason: "undecryptable" } };

      // Resolve only LOCK handle envelopes first, then preflight the
      // state-changing chain before decrypting CHAT bodies. Old invalid
      // escrow histories can contain image receipts; decrypting those before
      // we know the chain is usable causes signer extensions to dump huge
      // base64 payloads into the console.
      const lockResolvedParsed: ParsedEscrowEvent[] = [];
      for (const event of parsed) {
        lockResolvedParsed.push(await this.resolveLockEnvelope(event));
      }
      const preflightSorted = sortEventChain(
        lockResolvedParsed.filter((event) => event.kind !== EscrowEventKind.CHAT),
      );
      const preflight = replayEventChain(preflightSorted);
      if (!preflight.ok) {
        console.debug(`[escrow] loadEscrow ${escrowId}: replay skipped historical invalid chain — ${preflight.error.code}: ${preflight.error.message}`);
        return {
          ok: false,
          failure: {
            reason: "chain-incomplete",
            code: preflight.error.code,
            message: preflight.error.message,
            eventId: preflight.error.eventId,
          },
        };
      }

      // Resolve CHAT body/receipt attachments only after the chain preflight
      // succeeds. Sequential await keeps a slow signer from fanning out into
      // many concurrent NIP-44 calls.
      const readableParsed: ParsedEscrowEvent[] = [];
      for (const event of lockResolvedParsed) {
        const resolved = await this.resolveChatEnvelope(event);
        if (resolved) readableParsed.push(resolved);
      }

      // Sort by dependency chain and replay
      const sorted = sortEventChain(readableParsed);
      console.debug(`[escrow] loadEscrow ${escrowId}: sorted chain`,
        sorted.map(e => `kind:${e.kind}(${e.raw.id.slice(0,6)})`).join(' → '));
      const replayStarted = globalThis.performance?.now?.() ?? Date.now();
      const replayed = replayEventChain(sorted);
      diagnostic.step(
        `replay:${pass}`,
        (globalThis.performance?.now?.() ?? Date.now()) - replayStarted,
      );
      if (!replayed.ok) {
        console.debug(`[escrow] loadEscrow ${escrowId}: replay FAILED — ${replayed.error.code}: ${replayed.error.message}`);
        return {
          ok: false,
          failure: {
            reason: "chain-incomplete",
            code: replayed.error.code,
            message: replayed.error.message,
            eventId: replayed.error.eventId,
          },
        };
      }
      return { ok: true, state: replayed.state };
    };

    let outcome = await runReplay(rawEvents, `${completenessAttempt}`);

    // REPAIR PASS. The relays answered, but not with a chain that replays.
    // Before giving up, union in the durable cache — this device may still
    // hold the events the network lost.
    //
    // ⚠ EXPLICIT OPENS ONLY (`repairFromCache`). A failed replay is common at
    // boot (on the device this was diagnosed from, 61 of 124 remembered trades
    // don't replay from relays), so doing this unconditionally would put an
    // IndexedDB read AND a second decrypt/replay pass on every one of them
    // during the discovery flood — re-creating the launch-freeze exposure the
    // `rawEvents.length === 0` gate exists to prevent. Boot stays relay-only
    // and fast; the repair happens when the user actually opens the trade.
    let repairedFromCache = false;
    if (!outcome.ok && repairFromCache && !durableTried) {
      durableTried = true;
      const durable = await getCachedEvents(escrowId);
      const merged = mergeRawEventsById(rawEvents, durable);
      if (merged.length > rawEvents.length) {
        console.debug(
          `[escrow] loadEscrow ${escrowId}: relay chain failed to replay ` +
            `(${outcome.failure.code ?? outcome.failure.reason}) — retrying with ` +
            `${merged.length - rawEvents.length} event(s) recovered from the durable cache`,
        );
        const repaired = await runReplay(merged, `${completenessAttempt}-cache`);
        if (repaired.ok) {
          rawEvents = merged;
          repairedFromCache = true;
          outcome = repaired;
        }
      }
    }

    if (!outcome.ok) {
      this.recordLoadFailure(escrowId, outcome.failure);
      if (outcome.failure.reason === "chain-incomplete") {
        this.callbacks.onValidationError?.(escrowId, outcome.failure.message ?? "", outcome.failure.eventId);
      }
      // Money-path safety: a replay failure can be caused by partial relay
      // history, late events, or an invalid remote event. Keep the local
      // pointer so later rehydration or recovery surfaces can still find it.
      console.debug(`[escrow] Kept failed escrow ${escrowId} in saved list for later recovery/rehydration`);
      return null;
    }
    const result = { ok: true as const, state: outcome.state };
    this.clearLoadFailure(escrowId);

    // The relays are missing history this device still holds. Hand it back:
    // escrow events are signed and self-authenticating, so re-publishing them
    // repairs the relay for EVERY participant, not just this client.
    //
    // Deliberately NOT a sweep. A republished event is REDELIVERED by the
    // relay to every client holding a matching live subscription, so this
    // spends other people's bandwidth: it goes to the ONE preferred relay
    // (never fanned across the public pool), one trade per explicit open,
    // once per trade per session, ceilinged and paced (see relay-backfill).
    // Only on a full (cursor-less) fetch, where "the relay didn't return it"
    // actually means "the relay doesn't have it". Fire-and-forget.
    if (
      repairedFromCache &&
      since === undefined &&
      shouldBackfillNow({
        alreadyBackfilled: this._backfilledEscrows.has(escrowId),
        sessionCount: this._backfilledEscrows.size,
        lastBackfillAt: this._lastBackfillAt,
      })
    ) {
      const missing = selectBackfillEvents(rawEvents, fetchedRawEvents);
      if (missing.length > 0) {
        this._backfilledEscrows.add(escrowId);
        this._lastBackfillAt = Date.now();
        void this.relayManager
          .republishToPreferredRelay(missing)
          .catch((e) => console.debug(`[escrow] backfill ${escrowId}:`, e));
      }
    }
    console.debug(`[escrow] loadEscrow ${escrowId}: replay OK — state is ${result.state.status}`);

    // Completeness retry (webview truncation cure). If a replay lands NON-
    // truly-terminal (anything but COMPLETED/CANCELLED), the resolve/complete
    // tail may have been dropped by a truncated/contended fetch — the Fedi
    // webview's WS subscription cap makes concurrent #d fetches come back
    // partial. Re-fetch and replay the union. We fire REGARDLESS of relay-count
    // change: in the webview every relay is already connected, so the old "more
    // relays online now" gate never held and the cure never ran. Bounded to
    // COMPLETENESS_MAX_ATTEMPTS re-fetches so a genuinely non-terminal trade
    // (a real LOCKED/EXPIRED) doesn't loop. Truly-terminal states never retry.
    const isTrulyTerminal =
      result.state.status === EscrowStatus.COMPLETED ||
      result.state.status === EscrowStatus.CANCELLED;
    const shouldCompletenessRetry =
      cachedRawEvents.length === 0 || fetchedRawEvents.length > 0;
    if (
      !isTrulyTerminal &&
      completenessAttempt < COMPLETENESS_MAX_ATTEMPTS &&
      shouldCompletenessRetry
    ) {
      console.debug(
        `[escrow] loadEscrow ${escrowId}: non-terminal (${result.state.status}) — ` +
          `completeness retry ${completenessAttempt + 1}/${COMPLETENESS_MAX_ATTEMPTS}`,
      );
      // Carry forward what we just fetched so the retry replays the union.
      const merged = new Map((this.rawEvents.get(escrowId) ?? []).map(e => [e.id, e]));
      for (const e of rawEvents) merged.set(e.id, e);
      this.setHotRawEvents(escrowId, compactHotRawEvents([...merged.values()]));
      return this.loadEscrowAttempt(escrowId, completenessAttempt + 1, diagnostic, repairFromCache);
    }

    if (isPartialReplayDowngrade(current, result.state)) {
      const known = new Map((this.rawEvents.get(escrowId) ?? []).map(event => [event.id, event]));
      for (const event of rawEvents) known.set(event.id, event);
      this.setHotRawEvents(escrowId, compactHotRawEvents([...known.values()]));
      console.warn(
        `[escrow] loadEscrow ${escrowId}: ignoring partial relay downgrade ${current!.status} → ${result.state.status}`,
      );
      this.watchEscrow(escrowId);
      return current!;
    }

    // v3.1.1 (chat-safety, FIX 2): CHAT is not in the eventChain, so a chat-poor
    // relay fetch can rebuild a SHORTER chatMessages than we already hold in
    // memory. Keep the fresh replayed state but re-seed any in-memory chat
    // messages the replay didn't include (dedup by raw.id, kept chronological) —
    // a reload must never SHRINK the visible chat. FIX 1 fills the cache so this
    // is usually a no-op; it guards the window before the cache fills and any
    // cross-session gap.
    if (current && current.chatMessages.length > 0) {
      const haveIds = new Set(result.state.chatMessages.map(m => m.raw.id));
      const missing = current.chatMessages.filter(m => !haveIds.has(m.raw.id));
      if (missing.length > 0) {
        result.state.chatMessages = [...result.state.chatMessages, ...missing]
          .sort((a, b) => a.raw.created_at - b.raw.created_at);
      }
    }

    // Durable event cache: persist the full chain so it rebuilds offline next
    // session even if the relays have dropped it. Fire-and-forget; the status
    // drives evict-oldest-terminal priority. Snapshot first because the parsed
    // UI state below deliberately releases encrypted CHAT content.
    void putCachedEvents(
      escrowId,
      durableRawSnapshot(rawEvents),
      result.state.status,
    );
    stripParsedChatCiphertext(result.state);
    this.states.set(escrowId, result.state);
    this.setHotRawEvents(escrowId, compactHotRawEvents(rawEvents));

    // Notify UI of the reconstructed state
    this.callbacks.onStateUpdate?.(escrowId, result.state);

    // Start watching for live updates
    this.watchEscrow(escrowId);

    // After replay, check if auto-resolve should trigger
    if (result.state.status === EscrowStatus.LOCKED) {
      this.maybeAutoResolve(escrowId).catch(e =>
        console.debug("[escrow] Post-reload auto-resolve:", e?.message || e)
      );
      // Check if the escrow has expired — auto-vote REFUND if so
      this.maybeAutoRefundExpired(escrowId).catch(e =>
        console.debug("[escrow] Post-reload expiry check:", e?.message || e)
      );
    }

    // v0.1.65: also heal EXPIRED on load — for trades that flipped to
    // EXPIRED while everyone was offline. maybeAutoRefundExpired's own
    // guard now accepts EXPIRED-without-RESOLVE, so this is safe.
    if (result.state.status === EscrowStatus.EXPIRED) {
      // Field gap (v2.1.1): an EXPIRED trade whose healing votes already met
      // 2-of-3 but whose RESOLVE never landed was unresolvable by ANY reload —
      // this branch healed missing VOTES but never checked the threshold.
      // maybeAutoResolve itself accepts EXPIRED (v0.1.66.26); call it here so
      // any participant's reload publishes the missing RESOLVE.
      this.maybeAutoResolve(escrowId).catch(e =>
        console.debug("[escrow] Post-reload expired auto-resolve:", e?.message || e)
      );
      this.maybeAutoRefundExpired(escrowId).catch(e =>
        console.debug("[escrow] Post-reload heal-on-load:", e?.message || e)
      );
    }

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

    // SECURITY: timestamp sanity bound. `created_at` is part of the
    // signed event id (sig verification covers tampering), but a
    // genuinely-signed event from a participant with a wrong clock or
    // a deliberately-future timestamp could shift expiry windows or
    // re-order the chain. Reject events claiming to be more than
    // FUTURE_TIMESTAMP_SLACK_SECS ahead of wall-clock; past timestamps
    // are always allowed because historical replay is required.
    const nowSecs = Math.floor(Date.now() / 1000);
    if (
      typeof event.created_at === "number" &&
      event.created_at > nowSecs + MAX_FUTURE_TIMESTAMP_SLACK_SECS
    ) {
      console.warn(
        `[escrow] Dropping event ${event.id?.slice(0, 8)} from ${relayUrl}: ` +
          `created_at ${event.created_at} is ` +
          `${event.created_at - nowSecs}s in the future (max allowed: ` +
          `${MAX_FUTURE_TIMESTAMP_SLACK_SECS}s)`,
      );
      return;
    }

    // v0.4.2 sim mode: a sim-tagged event is only valid for a sim-mode
    // client, and vice versa. We can't filter at the relay-filter level
    // for the "drop sim in prod" direction (NIP-01 has no NOT-has-tag
    // operator), so the drop happens here on receive. Cheap — tag scan
    // happens before any decrypt or state-machine work.
    if (shouldDropForSimPolicy(event)) return;

    // Extract escrow ID from d-tag
    const dTag = event.tags.find(t => t[0] === TAGS.ESCROW_ID);
    if (!dTag?.[1]) return;
    const escrowId = dTag[1];

    // Redelivery short-circuit. A reconnect re-REQs every live subscription,
    // so relays re-send history we already hold. Recognising it by id here —
    // before any decrypt — keeps a storm from paying NIP-44 decrypt per frame
    // (inline chat photos are megabytes) and, more importantly, stops stale
    // frames from reaching the state machine and arming a chain reload each.
    if (this.hasEventLocally(escrowId, event.id)) return;

    // Decrypt the event content into a cleartext escrow payload
    // string. Handles plaintext / per-recipient envelope / legacy raw
    // NIP-44 ciphertext via decryptEventContent. A null here means
    // "not for me, malformed, or unrecognised shape" — silently skip.
    const decrypted = await this.decryptEventContent(event);
    if (decrypted === null) return;

    // Parse
    const parseResult = parseEscrowEvent(event, decrypted, true);
    if (!parseResult.ok) {
      this.callbacks.onValidationError?.(escrowId, parseResult.error.message, event.id);
      return;
    }

    // PR 4: resolve any LOCK handle envelope before applyEvent. The
    // state machine reads handle/handleId/rail at the top level of the
    // payload (whether they came from a legacy PR 3 wire or were
    // synthesized from a PR 4 envelope decrypt). This is the seam.
    const parsed = await this.resolveParticipantEnvelope(parseResult.event);
    if (!parsed) return;

    // Handle chat separately
    if (parsed.kind === EscrowEventKind.CHAT) {
      const state = this.states.get(escrowId);
      if (state) {
        // Dedup: skip if this chat message was already applied locally (sender echo)
        const alreadyHave = state.chatMessages.some(m => m.raw.id === event.id);
        if (alreadyHave) return;

        const result = applyEvent(state, parsed);
        if (result.ok) {
          // Persist CHAT durably but do not retain its potentially-large
          // ciphertext in the hot rawEvents map. Parsed chat remains in state.
          // APPEND + drop already-blanked raws — see the sender-echo site above
          // for why a whole-record put here erased every earlier chat body.
          const durable = durableRawSnapshot(
            mergeRawEventsById(
              this.rawEvents.get(escrowId) ?? [],
              result.state.chatMessages.map(message => message.raw),
            ),
          ).filter(raw => raw.kind !== EscrowEventKind.CHAT || !!raw.content);
          void appendCachedEvents(escrowId, durable, result.state.status);
          stripParsedChatCiphertext(result.state);
          this.states.set(escrowId, result.state);
          this.callbacks.onChatMessage?.(escrowId, parsed as ParsedEscrowEvent<ChatPayload>);
        }
      }
      return;
    }

    const currentState = this.states.get(escrowId) || null;

    // Public Browse discovery starts from plaintext CREATE events, but a
    // CREATE by itself is not proof the listing is still open. Hydrate the
    // full chain before surfacing a never-seen escrow so completed/cancelled
    // trades do not resurrect as stale OPEN tiles on login.
    if (parsed.kind === EscrowEventKind.CREATE && !currentState) {
      if (isPrivatePlanChild(parsed.payload as CreatePayload)) return;
      this.enqueueListingHydration(escrowId);
      return;
    }

    // Apply to state machine
    const result = applyEvent(currentState, parsed);

    if (result.ok) {
      this.states.set(escrowId, result.state);

      // Store raw event
      const existing = this.rawEvents.get(escrowId) || [];
      const hotChain = compactHotRawEvents([...existing, event]);
      this.setHotRawEvents(escrowId, hotChain);

      // Durable persistence for the LIVE path. Without this, a trade that
      // advances while the app is open leaves NOTHING on disk: `rawEvents` is an
      // in-memory map with an eviction cap, so the next session can only rebuild
      // from relays — and the trade you were PRESENT for is exactly the one whose
      // events you never saved. A LOCKED chain lost this way costs the claim
      // (the shares live in the LOCK event), so this is a money path, not merely
      // history. Mirrors what the two CHAT sites already do.
      //
      // APPEND, never put: `putCachedEvents` replaces the whole record, and the
      // hot map is deliberately CHAT-free (compactHotRawEvents), so a blind put
      // here would delete every cached chat message for this trade. Merging
      // `state.chatMessages` in to compensate does not work either — after the
      // first stripParsedChatCiphertext those raws carry content:"" and would
      // overwrite good ciphertext. `appendCachedEvents` merges inside a single
      // readwrite transaction with stored events winning on an id collision, so
      // neither hazard is reachable from here.
      void appendCachedEvents(escrowId, hotChain, result.state.status).catch((e) =>
        console.debug(`[escrow] live durable persist ${escrowId}:`, e),
      );

      this.callbacks.onStateUpdate?.(escrowId, result.state);

      // Flush retry buffer — previously rejected events may now apply
      this.flushRetryBuffer(escrowId);

      // If we just received a VOTE and the threshold is now met,
      // ANY browser can publish the RESOLVE — not just the voter.
      // This is the key redundancy: if the voter's auto-resolve failed,
      // the next browser to see the vote picks up the slack.
      if (parsed.kind === EscrowEventKind.VOTE) {
        this.maybeAutoResolve(escrowId).catch(e =>
          console.debug("[escrow] Incoming-vote auto-resolve failed:", e)
        );
      }

      // Flush buffered events — predecessors may now be in the chain
      this.flushEventBuffer(escrowId);
    } else if (result.error.code === "NO_STATE") {
      // Event arrived for an escrow we haven't loaded — buffer it
      this.bufferEvent(escrowId, event, relayUrl);
    } else if (["INVALID_STATE", "NOT_PARTICIPANT", "THRESHOLD_NOT_MET"].includes(result.error.code)) {
      // Out-of-order event — reload full state from relays
      // This is more reliable than buffering because it fetches ALL events,
      // sorts by chain order, and replays the complete sequence.
      //
      // NOT_PARTICIPANT stays a trigger on purpose: a stale local chain missing
      // a JOIN reports a genuine participant's event this way, and the reload is
      // exactly what heals it. The storm risk is handled by backoff, not by
      // dropping the healing path.
      this.scheduleOutOfOrderReload(escrowId, event.id, result.error.code);
    } else {
      // Permanent rejection (DUPLICATE_CREATE, ALREADY_VOTED, etc.) — just log
      console.debug(`[escrow] Rejected event ${event.id.slice(0, 8)}: ${result.error.code}`);
    }
  }

  /**
   * Arm a full chain reload for a trade whose incoming event didn't apply.
   *
   * `_reloading` alone only dedupes while a reload is in flight, so a burst of
   * redelivered history re-armed a fresh multi-relay fetch the moment each one
   * landed — the same trade re-fetched several times within seconds, forever.
   * Reloads now back off per trade (see outOfOrderReloadCooldownMs) and the
   * counter resets whenever the trade's chain actually grows, so a genuinely
   * out-of-order trade still heals promptly while a storm goes quiet.
   */
  private scheduleOutOfOrderReload(escrowId: string, eventId: string, code: string): void {
    if (this._reloading.has(escrowId)) return;

    const history = this._reloadHistory.get(escrowId) ?? { attempts: 0, lastAt: 0 };
    const cooldown = outOfOrderReloadCooldownMs(history.attempts);
    const waited = Date.now() - history.lastAt;
    if (history.attempts > 0 && waited < cooldown) {
      console.debug(
        `[escrow] Out-of-order event ${eventId.slice(0, 8)} (${code}) for ${escrowId} — ` +
          `reload ${history.attempts} was ${Math.round(waited / 1000)}s ago, ` +
          `holding for ${Math.round((cooldown - waited) / 1000)}s`,
      );
      return;
    }

    this._reloading.add(escrowId);
    this._reloadHistory.set(escrowId, {
      attempts: history.attempts + 1,
      lastAt: Date.now(),
    });
    console.debug(`[escrow] Out-of-order event ${eventId.slice(0, 8)} (${code}) — reloading ${escrowId} from relays`);
    // Small delay to let more events arrive before reloading
    setTimeout(async () => {
      const before = this.states.get(escrowId)?.eventChain.length ?? 0;
      try {
        await this.loadEscrow(escrowId);
        console.debug(`[escrow] Reloaded ${escrowId} from relays — state is now ${this.states.get(escrowId)?.status}`);
        // A reload that actually brought new chain events in was the right call
        // — this trade was genuinely behind, not storming. Clear its backoff so
        // the next real gap heals at full speed.
        if ((this.states.get(escrowId)?.eventChain.length ?? 0) > before) {
          this._reloadHistory.delete(escrowId);
        }
      } catch (e) {
        console.warn(`[escrow] Reload failed for ${escrowId}:`, e);
      } finally {
        this._reloading.delete(escrowId);
      }
    }, OUT_OF_ORDER_RELOAD_DELAY_MS);
  }

  /**
   * Queue a never-seen public listing for chain hydration.
   *
   * Browse discovery surfaces plaintext CREATEs, and a reconnect redelivers all
   * of them at once. Hydrating each one immediately meant dozens of concurrent
   * multi-relay chain fetches; the responses alone could pin the main thread.
   * Slots are bounded, and a listing whose chain won't replay is held down
   * instead of re-fetched on every redelivery.
   */
  private enqueueListingHydration(escrowId: string): void {
    if (this._listingHydration.has(escrowId)) return;
    if (this._listingHydrationQueue.includes(escrowId)) return;
    const cooldownUntil = this._listingHydrationCooldown.get(escrowId) ?? 0;
    if (Date.now() < cooldownUntil) return;

    this._listingHydrationQueue.push(escrowId);
    this.reportListingHydrationDepth();
    this.pumpListingHydration();
  }

  /** Report outstanding hydration work (running + queued) to the UI. */
  private reportListingHydrationDepth(): void {
    this.callbacks.onPublicListingHydration?.(
      this._listingHydration.size + this._listingHydrationQueue.length,
    );
  }

  /** Start hydrations up to the concurrency cap. */
  private pumpListingHydration(): void {
    while (
      this._listingHydration.size < LISTING_HYDRATION_CONCURRENCY &&
      this._listingHydrationQueue.length > 0
    ) {
      const escrowId = this._listingHydrationQueue.shift()!;
      if (this._listingHydration.has(escrowId)) continue;
      this._listingHydration.add(escrowId);
      this.reportListingHydrationDepth();

      this.loadEscrow(escrowId)
        .then((state) => {
          // A null replay means the chain is unusable (invalid history, or aged
          // off the relays) and will stay that way. Re-hydrating it on every
          // redelivery is pure waste, so hold it down for a while.
          if (!state) {
            this._listingHydrationCooldown.set(
              escrowId,
              Date.now() + LISTING_HYDRATION_RETRY_COOLDOWN_MS,
            );
          }
        })
        .catch(e => {
          this._listingHydrationCooldown.set(
            escrowId,
            Date.now() + LISTING_HYDRATION_RETRY_COOLDOWN_MS,
          );
          console.debug(
            `[escrow] Listing hydration failed for ${escrowId}:`,
            (e as Error)?.message || e,
          );
        })
        .finally(() => {
          this._listingHydration.delete(escrowId);
          this.reportListingHydrationDepth();
          this.pumpListingHydration();
        });
    }
  }

  /** Buffer an event for later retry */
  private bufferEvent(escrowId: string, event: NostrEvent, relay: string): void {
    const buf = this.eventBuffer.get(escrowId) || [];
    // Don't buffer duplicates
    if (buf.some(b => b.event.id === event.id)) return;
    // Max 20 buffered events per escrow
    if (buf.length >= 20) return;
    buf.push({ event, relay, attempts: 0 });
    this.eventBuffer.set(escrowId, buf);
  }

  /** Try to apply buffered events after a state change */
  private async flushEventBuffer(escrowId: string): Promise<void> {
    const buf = this.eventBuffer.get(escrowId);
    if (!buf || buf.length === 0) return;

    const remaining: typeof buf = [];
    for (const entry of buf) {
      entry.attempts++;
      try {
        await this.handleIncomingEvent(entry.event, entry.relay);
      } catch {
        // Still can't apply — keep in buffer if under retry limit
        if (entry.attempts < 5) remaining.push(entry);
      }
    }

    if (remaining.length > 0) {
      this.eventBuffer.set(escrowId, remaining);
    } else {
      this.eventBuffer.delete(escrowId);
    }
  }

  /** Apply a locally-created event optimistically */
  /**
   * Flush the retry buffer for an escrow — re-process buffered events
   * that were rejected due to out-of-order delivery.
   */
  private async flushRetryBuffer(escrowId: string): Promise<void> {
    const buffer = this.retryBuffer.get(escrowId);
    if (!buffer || buffer.length === 0) return;

    // Take all buffered events and clear the buffer
    const toRetry = [...buffer];
    this.retryBuffer.set(escrowId, []);

    let applied = 0;
    for (const entry of toRetry) {
      entry.attempts++;
      if (entry.attempts > 10) {
        // Too many retries — drop it
        console.warn(`[escrow] Dropping event ${entry.event.id.slice(0, 8)} after ${entry.attempts} retries`);
        continue;
      }
      // Re-process through the full handler
      await this.handleIncomingEvent(entry.event, entry.relay);
      applied++;
    }

    if (applied > 0) {
      console.debug(`[escrow] Flushed ${applied} buffered events for ${escrowId}`);
    }
  }

  private async resolveParticipantEnvelope(parsed: ParsedEscrowEvent): Promise<ParsedEscrowEvent | null> {
    const withLockEnvelope = await this.resolveLockEnvelope(parsed);
    return this.resolveChatEnvelope(withLockEnvelope);
  }

  /** PR 4: resolve a LOCK event's handleEnvelope (if present) into
   *  top-level handle/handleId/rail fields on the parsed payload. The
   *  state machine reads from those top-level fields; this seam lets
   *  the wire format use a 3-recipient envelope without leaking that
   *  detail into the pure handler.
   *
   *  Behavior:
   *   - Non-LOCK events: returned unchanged.
   *   - LOCK without handleEnvelope: unchanged (legacy PR 3 wire format
   *     with top-level handle fields still works; LOCKs without handle
   *     data have no fields to populate).
   *   - LOCK with handleEnvelope: decrypts viewer's entry, parses the
   *     JSON {handleId?, handle, rail?}, returns a payload-mutated copy
   *     with those fields synthesized at the top level.
   *   - Decrypt failure (not a recipient, malformed ciphertext, wrong
   *     sender): returns unchanged. handleLock will see no top-level
   *     handle and leave state.lock.handle null. Non-participants
   *     transit this path silently. */
  private async resolveLockEnvelope(parsed: ParsedEscrowEvent): Promise<ParsedEscrowEvent> {
    if (parsed.kind !== EscrowEventKind.LOCK) return parsed;
    const lockPayload = parsed.payload as LockPayload;
    if (!lockPayload.handleEnvelope) return parsed;
    // Already resolved (locker's local apply path populates both)
    if (lockPayload.handle) return parsed;

    let myPubkey: string;
    try {
      myPubkey = await this.getPubkey();
    } catch {
      return parsed;
    }

    const cleartext = await decryptFromEnvelope(
      lockPayload.handleEnvelope,
      myPubkey,
      parsed.pubkey,
      (ct, sender) => this.signer.nip44Decrypt(ct, sender),
    );
    if (cleartext === null) return parsed;

    let handleData: {
      handleId?: string;
      handle?: string;
      rail?: string;
      networks?: string[];
    };
    try {
      handleData = JSON.parse(cleartext);
    } catch {
      return parsed;
    }
    if (typeof handleData.handle !== "string" || handleData.handle.length === 0) {
      return parsed;
    }
    // v0.6.5: networks is optional; tolerate absent/malformed shapes.
    const networks = Array.isArray(handleData.networks)
      ? handleData.networks.filter((n: unknown): n is string => typeof n === "string")
      : undefined;

    return {
      ...parsed,
      payload: {
        ...lockPayload,
        handleId: handleData.handleId,
        handle: handleData.handle,
        rail: handleData.rail,
        ...(networks && networks.length > 0 ? { handleNetworks: networks } : {}),
      },
    };
  }

  /** Resolve encrypted CHAT bodyEnvelope into cleartext message and
   *  attachments for this viewer. Legacy plaintext CHAT events (no
   *  envelope) pass through unchanged. If an enveloped chat cannot be
   *  decrypted by this signer, return null so replay/live handling skips
   *  it rather than displaying a blank receipt shell. */
  private async resolveChatEnvelope(parsed: ParsedEscrowEvent): Promise<ParsedEscrowEvent | null> {
    if (parsed.kind !== EscrowEventKind.CHAT) return parsed;
    const chatPayload = parsed.payload as ChatPayload;
    if (!chatPayload.bodyEnvelope) return parsed;
    if (chatPayload.message || (chatPayload.attachments?.length ?? 0) > 0) return parsed;

    let myPubkey: string;
    try {
      myPubkey = await this.getPubkey();
    } catch {
      return null;
    }

    const cleartext = await decryptFromEnvelope(
      chatPayload.bodyEnvelope,
      myPubkey,
      parsed.pubkey,
      (ct, sender) => this.signer.nip44Decrypt(ct, sender),
    );
    if (cleartext === null) return null;

    let body: ChatBody;
    try {
      body = JSON.parse(cleartext);
    } catch {
      return null;
    }
    if (typeof body.message !== "string") return null;
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((a): a is ChatImageAttachment =>
          a?.kind === "image" &&
          typeof a.id === "string" &&
          typeof a.mimeType === "string" &&
          a.mimeType.startsWith("image/") &&
          typeof a.dataUrl === "string" &&
          a.dataUrl.startsWith("data:image/"),
        )
      : undefined;

    return {
      ...parsed,
      payload: {
        ...chatPayload,
        message: body.message,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
    };
  }

  /**
   * SECURITY: decrypt an event's content into a cleartext payload
   * string. Handles three wire shapes in order:
   *
   *   1. Plaintext escrow payload (`{type: "escrow:..."}`). Used by
   *      CREATE, JOIN, COMPLETE, CANCEL, and any DEV-mode event. The
   *      raw JSON string is returned as-is.
   *   2. Per-recipient envelope (`{encryptedFor: {pk: ct, ...}}`).
   *      Used for VOTE, CLAIM, RESOLVE, PERIOD_RELEASE under PROD
   *      encryption. The slot keyed by the local pubkey is decrypted
   *      with NIP-44, using the event signer as the sender.
   *   3. Raw NIP-44 ciphertext (legacy compat). Anything else that
   *      doesn't look like JSON falls through here so any pre-envelope
   *      events still on relays continue to load.
   *
   * Returns null in the silent-skip cases:
   *   - JSON parses but doesn't match any known shape
   *   - Local user is not a recipient of the envelope (not for me)
   *   - NIP-44 decryption fails (wrong key, malformed, tampered)
   *
   * Never throws. The caller decides whether a null means "skip this
   * event" or "surface an error to the UI"; almost all current
   * callers just `return` and let the next event arrive.
   */
  private async decryptEventContent(event: NostrEvent): Promise<string | null> {
    // Shapes 1 + 2: structured JSON. Try parsing first; if it works,
    // dispatch on which field is present.
    let parsedObj: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(event.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON; will fall through to Shape 3.
    }

    if (parsedObj) {
      // Shape 1: plaintext escrow payload.
      const type = parsedObj.type;
      if (typeof type === "string" && type.startsWith("escrow:")) {
        return event.content;
      }
      // Shape 2: per-recipient envelope.
      const envelopeFor = parsedObj.encryptedFor;
      if (envelopeFor && typeof envelopeFor === "object" && !Array.isArray(envelopeFor)) {
        const myPubkey = await this.getPubkey();
        const ct = (envelopeFor as Record<string, unknown>)[myPubkey];
        if (typeof ct !== "string" || ct.length === 0) {
          // Not a recipient — silently skip.
          return null;
        }
        try {
          return await this.signer.nip44Decrypt(ct, event.pubkey);
        } catch {
          // Malformed envelope, wrong sender pubkey, etc.
          return null;
        }
      }
      // JSON object but neither shape — silently skip.
      return null;
    }

    // Shape 3 (legacy): raw NIP-44 ciphertext. Only attempt if it
    // doesn't look like JSON that simply failed validation above —
    // otherwise we'd waste a decrypt call on every malformed payload.
    const looksEncrypted = event.content.length > 0
      && !event.content.startsWith("{")
      && !event.content.startsWith("[");
    if (!looksEncrypted) return null;
    try {
      return await this.signer.nip44Decrypt(event.content, event.pubkey);
    } catch {
      return null;
    }
  }

  /**
   * SECURITY: encrypt a payload to all three trade participants using
   * the per-recipient envelope helper from envelope.ts. The resulting
   * wire content is a JSON-stringified
   *   {encryptedFor: {pk1: ct1, pk2: ct2, pk3: ct3}}
   * so any participant can decrypt their own slot while no relay
   * operator (and no non-participant client) can read the cleartext.
   *
   * This is the publish-side counterpart to the receive-path envelope
   * detection in handleIncomingEvent / loadEscrow. Used for VOTE,
   * CLAIM, RESOLVE, and PERIOD_RELEASE — events that carry private
   * trade outcomes. LOCK already uses the envelope pattern via its
   * SSS-share handling in createEnvelope; COMPLETE / CANCEL carry no
   * sensitive content and stay plaintext for replay simplicity.
   *
   * Participants are derived from `state.participants`. Duplicate or
   * missing pubkeys are skipped (createEnvelope dedupes by pubkey).
   * Throws if no participant pubkeys are known yet — caller should
   * not be publishing an encrypted event in that case.
   */
  private async encryptToParticipants(
    payload: unknown,
    state: EscrowState,
  ): Promise<string> {
    const recipients = this.envelopeRecipients(state);

    if (recipients.length === 0) {
      throw new Error(
        "encryptToParticipants: no participant pubkeys in state — " +
          "cannot envelope-encrypt before LOCK fills in buyer/seller/arbiter.",
      );
    }

    const envelope = await createEnvelope(
      JSON.stringify(payload),
      recipients,
      (pt, pk) => this.signer.nip44Encrypt(pt, pk),
    );
    return JSON.stringify(envelope);
  }

  /** VOTE payloads can carry a holder-only SSS share that is already NIP-44
   * encrypted for exactly one payout recipient. Encrypting the SAME full vote
   * to all three participants duplicated that large ciphertext three times,
   * producing ~69 KiB events that common relays reject at their 64 KiB limit.
   *
   * Every participant still receives the private vote fields. Only the
   * share's intended recipient receives the optional shareEnvelope in their
   * outer slot. The reducer already treats shareEnvelope as optional, and no
   * other participant can use that ciphertext, so consensus semantics and
   * vote privacy are unchanged while the wire event drops to ~one third. */
  private async encryptVoteToParticipants(
    payload: VotePayload,
    state: EscrowState,
  ): Promise<string> {
    const recipients = this.envelopeRecipients(state);
    if (recipients.length === 0) {
      throw new Error(
        "encryptVoteToParticipants: no participant pubkeys in state — " +
          "cannot envelope-encrypt before LOCK fills in buyer/seller/arbiter.",
      );
    }

    const encryptedFor: Record<string, string> = {};
    const compactPayload: VotePayload = payload.shareEnvelope
      ? {
          type: payload.type,
          outcome: payload.outcome,
          role: payload.role,
          votedAt: payload.votedAt,
        }
      : payload;

    for (const pk of recipients) {
      if (!pk || encryptedFor[pk] !== undefined) continue;
      const slotPayload =
        payload.shareEnvelope?.recipientPubkey === pk ? payload : compactPayload;
      encryptedFor[pk] = await this.signer.nip44Encrypt(
        JSON.stringify(slotPayload),
        pk,
      );
    }
    return JSON.stringify({ encryptedFor });
  }

  private envelopeRecipients(state: EscrowState): string[] {
    const recipients = [
      state.participants[Role.BUYER],
      state.participants[Role.SELLER],
      state.participants[Role.ARBITER],
    ].filter((pk): pk is string => typeof pk === "string" && pk.length > 0);

    // Arbiter substitution (field gap, v2.1.1): on pooled-share locks the
    // BACKUP arbiters were given the share (inside the LOCK) but never the
    // MAIL — chain events were enveloped to the three participants only, so
    // a backup's client silently skipped every VOTE ("envelope-not-for-me")
    // and could never see the dispute that summons them, nor the votes
    // backing it. Extend the recipient set with the capped priority order so
    // the pool can actually do the job the lock gave them. createEnvelope
    // dedupes, so the assigned arbiter appearing in both lists is harmless.
    // CHAT is exempt by design — it does not use this helper's pooled path
    // (see sendChat) and stays private to the three participants.
    if (state.lock?.arbiterPoolShare === true) {
      for (const pk of arbiterPriorityOrder(state)) {
        if (typeof pk === "string" && pk.length > 0) recipients.push(pk);
      }
    }
    return [...new Set(recipients)];
  }

  private applyLocally(escrowId: string, signed: NostrEvent, payload: EscrowPayload): EscrowState {
    const parsed = parseEscrowEvent(signed, JSON.stringify(payload), true);
    if (!parsed.ok) throw new Error(`Local parse failed: ${parsed.error.message}`);

    const currentState = this.states.get(escrowId) || null;
    const result = applyEvent(currentState, parsed.event);
    if (!result.ok) throw new Error(`Local apply failed: ${result.error.message}`);

    this.states.set(escrowId, result.state);

    const existing = this.rawEvents.get(escrowId) || [];
    existing.push(signed);
    this.setHotRawEvents(escrowId, existing);

    this.callbacks.onStateUpdate?.(escrowId, result.state);

    return result.state;
  }

  /**
   * Check if a LOCKED escrow has expired and auto-vote REFUND.
   * This is called periodically and after loadEscrow.
   * Any participant (especially community arbiters) can trigger this.
   * 
   * Expiry policy:
   *   - Pre-lock (CREATED/FUNDED): state machine handles → EXPIRED
   *   - Post-lock (LOCKED): arbiter auto-votes REFUND → buyer gets sats back
   *   - APPROVED/CLAIMED: never expire (let the claim complete)
   */
  private async maybeAutoRefundExpired(escrowId: string): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) return;

    // v0.1.65: heal-on-load — allow EXPIRED without RESOLVE
    // ──────────────────────────────────────────────────────
    // Previously this only fired on LOCKED. But if all participants
    // were offline at expiry, the state machine implicitly advances to
    // EXPIRED via timestamp checks, and this guard would then reject
    // any healing attempt. We now also accept EXPIRED trades that
    // haven't published a RESOLVE yet — the first participant back
    // online after expiry heals the chain by publishing REFUND.
    //
    // CLAIMED/COMPLETED/CANCELLED are still skipped (RESOLVE already
    // happened or the trade never got locked). APPROVED is skipped
    // because the winner's claim is the next legitimate event.
    const isStuckLocked = state.status === EscrowStatus.LOCKED;
    const isStuckExpired =
      state.status === EscrowStatus.EXPIRED &&
      !state.eventChain.some(e => e.kind === EscrowEventKind.RESOLVE);
    if (!isStuckLocked && !isStuckExpired) return;

    const now = Math.floor(Date.now() / 1000);
    if (now <= state.expiresAt) return;

    // v2.9: never auto-refund a ghosting LOCKER against a standing RELEASE from
    // the non-locker — that is the performance-contest theft (DECISIONS
    // 2026-06-07: "Expiry auto-refund is exploitable"). The contest is resolved
    // by an arbiter ruling (assigned or backup), not by a blind auto-refund.
    // Suppression lifts once an arbiter rules REFUND (isPerformanceContest goes
    // false), so a genuine merit-refund still completes the 2-of-3.
    if (isPerformanceContest(state)) {
      console.debug(`[escrow] ${escrowId} expired but contested (standing RELEASE) — suppressing auto-refund`);
      return;
    }

    // Check if we're a participant who can vote
    const myPubkey = await this.signer.getPublicKey();
    const myRole = Object.entries(state.participants).find(([, pk]) => pk === myPubkey)?.[0] as Role | undefined;
    if (!myRole) {
      // HEALING substitution (the disputed-expiry limbo fix): in a 1-1 dispute
      // every participant has already voted EXCEPT the assigned arbiter — so
      // the rescue vote used to depend on the exact absent device that
      // stranded the trade. On pooled-share locks, any pool backup's client
      // heals instead: auto-vote REFUND; the vote carries their share-2
      // envelope to the refund recipient, who can then reconstruct and claim.
      if (state.lock.arbiterPoolShare !== true) return;
      if (arbiterVotePriority(state, myPubkey) === null) return;
      const alreadyVotedByMe = state.eventChain.some(
        (e) => e.kind === EscrowEventKind.VOTE && e.pubkey === myPubkey,
      );
      if (alreadyVotedByMe) return;
      console.debug(`[escrow] Escrow ${escrowId} expired — pool backup auto-voting healing REFUND`);
      try {
        await this.vote(escrowId, Outcome.REFUND);
        console.debug(`[escrow] Backup healing REFUND published for ${escrowId}`);
      } catch (e) {
        console.debug(`[escrow] Backup healing REFUND failed for ${escrowId}:`, e);
      }
      return;
    }

    // Check if we already voted
    if (state.votes[myRole]) return;

    // Auto-vote REFUND on expired escrow
    console.debug(`[escrow] Escrow ${escrowId} expired — auto-voting REFUND as ${myRole}`);

    try {
      await this.vote(escrowId, Outcome.REFUND);
      console.debug(`[escrow] Auto-REFUND vote published for expired ${escrowId}`);
    } catch (e) {
      console.debug(`[escrow] Auto-REFUND vote failed for ${escrowId}:`, e);
    }
  }

  /** After a vote, check if 2-of-3 threshold is met and auto-publish RESOLVE */
  private async maybeAutoResolve(escrowId: string): Promise<void> {
    const state = this.states.get(escrowId);
    if (!state) return;
    // v0.1.66.26: accept EXPIRED in addition to LOCKED so healing votes
    // that meet 2-of-3 threshold trigger a RESOLVE publish. Without
    // this, healing votes land but never produce a RESOLVE event, and
    // the trade stays stuck in EXPIRED with 2 votes recorded.
    if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) return;
    // Skip if a RESOLVE event already exists in the chain
    if (state.eventChain.some(e => e.kind === EscrowEventKind.RESOLVE)) return;

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

    // SECURITY: RESOLVE reveals the winning outcome and which two
    // participants formed the majority. Wrap in the per-recipient
    // envelope so the relay sees only ciphertext.
    const content = ENCRYPTION_CONFIG.encryptResolve
      ? await this.encryptToParticipants(payload, state)
      : JSON.stringify(payload);

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

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    this.applyLocally(escrowId, signed, payload);
  }

  // ── Release a subscription period ─────────────────────────────────────

  async releasePeriod(escrowId: string, periodIndex: number): Promise<EscrowState> {
    const state = this.states.get(escrowId);
    if (!state) throw new Error("Escrow " + escrowId + " not loaded");
    if (!state.subscription) throw new Error("This escrow is not a subscription");

    const pubkey = await this.getPubkey();
    const role = this.getMyRole(state, pubkey);
    if (!role) throw new Error("You are not a participant in this escrow");

    const sub = state.subscription;
    if (periodIndex < 0 || periodIndex >= sub.totalPeriods) {
      throw new Error("Period " + periodIndex + " out of range");
    }
    if (sub.periodStatuses[periodIndex] === "released") {
      throw new Error("Period " + (periodIndex + 1) + " already released");
    }

    const now = Math.floor(Date.now() / 1000);
    const lastEventId = state.eventChain[state.eventChain.length - 1]?.raw.id;

    const payload: PeriodReleasePayload = {
      type: "escrow:period_release",
      periodIndex,
      amountMsats: sub.periodAmountMsats,
      triggeredBy: role,
      releasedAt: now,
    };

    // SECURITY: PERIOD_RELEASE exposes subscription cadence + amount.
    // Wrap in the per-recipient envelope along with the rest of the
    // sensitive event kinds. encryptResolve is reused as the gate
    // because PERIOD_RELEASE is a subscription-flavoured RESOLVE —
    // adding a dedicated flag would be cosmetic.
    const content = ENCRYPTION_CONFIG.encryptResolve
      ? await this.encryptToParticipants(payload, state)
      : JSON.stringify(payload);

    const unsigned: UnsignedEvent = {
      kind: EscrowEventKind.PERIOD_RELEASE,
      created_at: now,
      tags: [
        [TAGS.ESCROW_ID, escrowId],
        [TAGS.PREV_EVENT, lastEventId, "", "reply"],
        [TAGS.TYPE, "escrow:period_release"],
      ],
      content,
    };

    const signed = await this.signWithSimTag(unsigned);
    await this.relayManager.publish(signed);

    return this.applyLocally(escrowId, signed, payload);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private generateEscrowId(): string {
    // SECURITY: escrow IDs flow into Nostr d-tags and are the primary
    // join key across relays. Crypto randomness prevents an attacker
    // from pre-allocating the same ID and forcing a collision on a
    // shared relay (which would race the legitimate CREATE).
    const ts = Date.now().toString(36);
    const rand = randomId(8);
    return `sm_${ts}_${rand}`;
  }
}
