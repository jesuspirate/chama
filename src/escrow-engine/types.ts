// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Types & Constants
// ══════════════════════════════════════════════════════════════════════════
//
// Pure type definitions. No runtime dependencies. No server. No database.
// This file is the single source of truth for the escrow protocol.
//
// Design principles:
//   1. Non-custodial by design — 2-of-3 SSS, no server can move funds
//   2. Relay-native — state lives as Nostr events, reconstructable by any client
//   3. NIP-44 encrypted content — only the 3 participants can read trade details
//   4. Immutable audit log — non-replaceable events, chained via e-tags

// ── Escrow States ─────────────────────────────────────────────────────────
// Matches the existing Chama state machine from ARCHITECTURE.md
// but adapted for relay-native operation (no FUNDED state — funding IS locking)

export enum EscrowStatus {
  /** Trade terms published, waiting for counterparty + arbiter to join */
  CREATED = "CREATED",
  /** All 3 participants joined; ecash can be locked */
  FUNDED = "FUNDED",
  /** Ecash locked in 2-of-3 SSS escrow */
  LOCKED = "LOCKED",
  /** 2-of-3 votes agree on outcome */
  APPROVED = "APPROVED",
  /** Winner has claimed the ecash */
  CLAIMED = "CLAIMED",
  /** Payout confirmed — terminal */
  COMPLETED = "COMPLETED",
  /** Timeout reached — terminal */
  EXPIRED = "EXPIRED",
  /** Cancelled before lock — terminal */
  CANCELLED = "CANCELLED",
}

// ── Terminal states (no further transitions allowed) ──────────────────────

export const TERMINAL_STATES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.COMPLETED,
  EscrowStatus.EXPIRED,
  EscrowStatus.CANCELLED,
]);

// TRULY_TERMINAL_STATES — v0.1.66.26 (expiry heal / Mechanism A)
// ────────────────────────────────────────────────────────────────
// EXPIRED is NOT truly terminal in our model. It's a transient state
// that represents "the escrow timed out while participants were
// offline, but can heal via 2-of-3 REFUND votes once anyone comes
// back online." The state machine (applyEvent) uses this stricter
// set so that post-expiry VOTE events reach their handler instead of
// being rejected with TERMINAL_STATE.
//
// TERMINAL_STATES is kept unchanged for UI purposes where EXPIRED
// should still read as "this trade is done" in listings, filters,
// and chat blocking — healing is a background process the user
// doesn't need to see mid-flight.
//
// Only COMPLETED (money moved successfully) and CANCELLED (trade
// aborted pre-lock) are genuinely unrecoverable.
export const TRULY_TERMINAL_STATES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.COMPLETED,
  EscrowStatus.CANCELLED,
]);

// ── Participant Roles ─────────────────────────────────────────────────────

export enum Role {
  BUYER = "buyer",
  SELLER = "seller",
  ARBITER = "arbiter",
}

// ── Vote Outcomes ─────────────────────────────────────────────────────────

export enum Outcome {
  RELEASE = "release", // Sats go to buyer (trade completed successfully)
  REFUND = "refund",   // Sats return to seller (trade failed/disputed)
}

// ── Nostr Event Kinds ─────────────────────────────────────────────────────
// Application-specific range (30000+). Non-replaceable for immutable audit.
// Using 38100–38109 block for Chama escrow protocol.

export enum EscrowEventKind {
  /** Initiator publishes trade terms */
  CREATE = 38100,
  /** Counterparty + arbiter accept and join */
  JOIN = 38101,
  /** Ecash locked in 2-of-3 SSS — shares distributed */
  LOCK = 38102,
  /** Participant casts a vote (release or refund) */
  VOTE = 38103,
  /** 2-of-3 threshold met — outcome resolved */
  RESOLVE = 38104,
  /** Winner claims ecash (publishes proof of reconstruction) */
  CLAIM = 38105,
  /** Trade completed — final confirmation */
  COMPLETE = 38106,
  /** Trade cancelled before lock */
  CANCEL = 38107,
  /** Chat message within escrow context (NIP-44 encrypted) */
  CHAT = 38108,
  /** Participant confirms they're online and ready for locking */
  READY = 38109,
  /** Kick an unresponsive participant (pre-lock only) */
  KICK = 38110,
  /** Create a subscription escrow with periodic releases */
  SUBSCRIBE = 38111,
  /** Release one period's sats to the seller */
  PERIOD_RELEASE = 38112,
}

// ── Valid State Transitions ───────────────────────────────────────────────
// Maps each state to the set of states it can transition to.
// The state machine enforces these — any event that would cause an
// invalid transition is rejected during replay.

export const VALID_TRANSITIONS: ReadonlyMap<EscrowStatus, ReadonlySet<EscrowStatus>> = new Map([
  [EscrowStatus.CREATED,   new Set([EscrowStatus.FUNDED, EscrowStatus.CANCELLED, EscrowStatus.EXPIRED])],
  [EscrowStatus.FUNDED,    new Set([EscrowStatus.LOCKED, EscrowStatus.CANCELLED, EscrowStatus.EXPIRED])],
  [EscrowStatus.LOCKED,    new Set([EscrowStatus.APPROVED, EscrowStatus.EXPIRED])],
  [EscrowStatus.APPROVED,  new Set([EscrowStatus.CLAIMED])],
  [EscrowStatus.CLAIMED,   new Set([EscrowStatus.COMPLETED])],
  // Terminal — no transitions out
  [EscrowStatus.COMPLETED, new Set()],
  [EscrowStatus.EXPIRED,   new Set()],
  [EscrowStatus.CANCELLED, new Set()],
]);

// ── Event Kind → Transition Mapping ───────────────────────────────────────
// Which event kinds can trigger which state transitions

export const EVENT_KIND_TRANSITIONS: ReadonlyMap<EscrowEventKind, { from: EscrowStatus[]; to: EscrowStatus }> = new Map([
  [EscrowEventKind.JOIN,     { from: [EscrowStatus.CREATED],  to: EscrowStatus.FUNDED }],
  [EscrowEventKind.LOCK,     { from: [EscrowStatus.FUNDED],   to: EscrowStatus.LOCKED }],
  // VOTE doesn't directly transition — RESOLVE does when 2-of-3 is met
  [EscrowEventKind.RESOLVE,  { from: [EscrowStatus.LOCKED],   to: EscrowStatus.APPROVED }],
  [EscrowEventKind.CLAIM,    { from: [EscrowStatus.APPROVED], to: EscrowStatus.CLAIMED }],
  [EscrowEventKind.COMPLETE, { from: [EscrowStatus.CLAIMED],  to: EscrowStatus.COMPLETED }],
  [EscrowEventKind.CANCEL,   { from: [EscrowStatus.CREATED, EscrowStatus.FUNDED], to: EscrowStatus.CANCELLED }],
]);

// ── Nostr Event Tag Constants ─────────────────────────────────────────────

export const TAGS = {
  /** Escrow identifier (d-tag for filtering) */
  ESCROW_ID: "d",
  /** Participant pubkey */
  PARTICIPANT: "p",
  /** Reference to previous event in chain */
  PREV_EVENT: "e",
  /** Event type label */
  TYPE: "t",
  /** Fedimint federation invite code or mint URL */
  MINT: "mint",
  /** SSS share index (0, 1, or 2) */
  SHARE_INDEX: "share_idx",
  /** Platform fee pubkey */
  FEE_PUBKEY: "fee_pk",
  /** Trade amount in msats */
  AMOUNT: "amount",
  /** Fiat currency code */
  CURRENCY: "currency",
  /** Category tag for marketplace filtering */
  CATEGORY: "cat",
} as const;

// ── Encrypted Content Payloads ────────────────────────────────────────────
// These are the JSON structures inside NIP-44 encrypted `content` fields.

/** Content of a CREATE event */
export interface CreatePayload {
  type: "escrow:create";
  description: string;
  amountMsats: number;
  /** Fiat amount if applicable */
  fiatAmount?: number;
  fiatCurrency?: string;
  /** Category: p2p-trade, bill-pay, marketplace, lending */
  category: string;
  /** Fedimint federation invite code */
  mintUrl: string;
  /** Platform fee in basis points */
  platformFeeBps: number;
  /** Platform fee recipient pubkey */
  platformFeePubkey: string;
  /** Arbiter fee in msats (if pre-agreed) */
  arbiterFeeMsats?: number;
  /** Payment methods accepted (for P2P) */
  paymentMethods?: string[];
  /** Expiry duration in seconds */
  expirySeconds: number;
  /** Community arbiter pool — all pubkeys that receive the arbiter SSS share */
  communityArbiters?: string[];
  /** Timestamp */
  createdAt: number;
}

/** Content of a JOIN event */
export interface JoinPayload {
  type: "escrow:join";
  role: Role;
  /** Optional: arbiter's fee terms */
  arbiterFeeMsats?: number;
  joinedAt: number;
}

/** Single share in a LOCK event's shares[] array.
 *  `encryptedFor` is keyed by participant pubkey → NIP-44 ciphertext. */
export interface LockShareEntry {
  shareIndex: number;
  encryptedFor: Record<string, string>;
}

/** Content of a LOCK event */
export interface LockPayload {
  type: "escrow:lock";
  /** Hash of the full ecash notes (for verification) */
  notesHash: string;
  /** SSS shares — each encrypted to ALL participants for dual-encryption.
   *  Every share is NIP-44 encrypted separately to each participant's
   *  pubkey, so any participant can decrypt any share. */
  shares: LockShareEntry[];
  /** Breakdown of amounts */
  sellerReceivesMsats: number;
  arbiterFeeMsats: number;
  platformFeeMsats: number;
  lockedAt: number;
}

/** Content of a VOTE event */
export interface VotePayload {
  type: "escrow:vote";
  outcome: Outcome;
  role: Role;
  /** Optional reason */
  reason?: string;
  /** The voter's SSS share (encrypted to winner once outcome is known) */
  votedAt: number;
}

/** Content of a RESOLVE event */
export interface ResolvePayload {
  type: "escrow:resolve";
  outcome: Outcome;
  /** Which 2 roles formed the majority */
  majority: [Role, Role];
  /** Was arbiter needed? */
  arbiterInvolved: boolean;
  resolvedAt: number;
}

/** Content of a CLAIM event */
export interface ClaimPayload {
  type: "escrow:claim";
  /** Role of the claimant */
  claimerRole: Role;
  /** Proof: hash of reconstructed notes matches original lock */
  notesHashVerification: string;
  claimedAt: number;
}

/** Content of a COMPLETE event */
export interface CompletePayload {
  type: "escrow:complete";
  completedAt: number;
}

/** Content of a CANCEL event */
export interface CancelPayload {
  type: "escrow:cancel";
  cancellerRole: Role;
  reason?: string;
  cancelledAt: number;
}

/** Content of a CHAT event */
export interface ChatPayload {
  type: "escrow:chat";
  message: string;
  senderRole: Role;
  sentAt: number;
}

/** Content of a READY event — participant confirms they're online and prepared */
export interface ReadyPayload {
  type: "escrow:ready";
  role: Role;
  readyAt: number;
}

/** Content of a SUBSCRIBE event — buyer creates subscription terms */
export interface SubscribePayload {
  type: "escrow:subscribe";
  /** Total number of periods (e.g. 3 months) */
  totalPeriods: number;
  /** Amount per period in msats */
  periodAmountMsats: number;
  /** Duration of each period in seconds (e.g. 2592000 = 30 days) */
  periodDurationSeconds: number;
  /** What the subscription is for */
  description: string;
  /** When the subscription starts */
  startsAt: number;
}

/** Content of a PERIOD_RELEASE event — release one period's sats */
export interface PeriodReleasePayload {
  type: "escrow:period_release";
  /** Which period (0-indexed) */
  periodIndex: number;
  /** Amount released in msats */
  amountMsats: number;
  /** Who triggered the release (seller claim, arbiter auto-release, or buyer early release) */
  triggeredBy: Role;
  releasedAt: number;
}

/** Status of a single subscription period */
export type PeriodStatus = "pending" | "active" | "released" | "disputed" | "refunded";

/** Subscription metadata stored in EscrowState */
export interface SubscriptionMeta {
  /** Total periods in the subscription */
  totalPeriods: number;
  /** Amount per period in msats */
  periodAmountMsats: number;
  /** Duration of each period in seconds */
  periodDurationSeconds: number;
  /** When each period starts (computed from startsAt + index * duration) */
  periodStartTimes: number[];
  /** Status of each period */
  periodStatuses: PeriodStatus[];
  /** Number of periods released so far */
  releasedCount: number;
  /** Number of periods disputed */
  disputedCount: number;
  /** Total msats released so far */
  totalReleasedMsats: number;
  /** When the subscription started */
  startsAt: number;
}

/** Content of a KICK event — remove unresponsive participant (pre-lock only) */
export interface KickPayload {
  type: "escrow:kick";
  /** Role being kicked */
  targetRole: Role;
  /** Who initiated the kick */
  kickerRole: Role;
  /** Reason for the kick */
  reason: string;
  kickedAt: number;
}

// ── Union type for all payloads ───────────────────────────────────────────

export type EscrowPayload =
  | CreatePayload
  | JoinPayload
  | LockPayload
  | VotePayload
  | ResolvePayload
  | ClaimPayload
  | CompletePayload
  | CancelPayload
  | ChatPayload
  | ReadyPayload
  | KickPayload
  | SubscribePayload
  | PeriodReleasePayload;

// ── Raw Nostr Event (minimal, from nostr-tools) ──────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ── Parsed Escrow Event ───────────────────────────────────────────────────
// A NostrEvent that has been validated, decrypted, and typed.

export interface ParsedEscrowEvent<T extends EscrowPayload = EscrowPayload> {
  /** Original Nostr event */
  raw: NostrEvent;
  /** Decrypted and parsed payload */
  payload: T;
  /** Escrow ID extracted from d-tag */
  escrowId: string;
  /** Previous event ID from e-tag (null for CREATE) */
  prevEventId: string | null;
  /** Event kind as our enum */
  kind: EscrowEventKind;
  /** Signer's pubkey */
  pubkey: string;
  /** Event timestamp */
  timestamp: number;
}

// ── Escrow State (reconstructed from event chain) ─────────────────────────
// This is the "database row" but built entirely from replaying Nostr events.

export interface EscrowState {
  /** Unique escrow identifier (d-tag value) */
  id: string;
  /** Current status */
  status: EscrowStatus;
  /** Trade description */
  description: string;
  /** Amount in msats */
  amountMsats: number;
  /** Fiat amount and currency (if applicable) */
  fiatAmount?: number;
  fiatCurrency?: string;
  /** Category */
  category: string;
  /** Fedimint mint URL / invite code */
  mintUrl: string;

  /** Participants — pubkeys mapped to roles */
  participants: {
    [Role.BUYER]: string | null;
    [Role.SELLER]: string | null;
    [Role.ARBITER]: string | null;
  };

  /** Who initiated the trade (and their role) */
  initiator: { pubkey: string; role: Role };

  /** Community arbiter pool — backup arbiters who also receive the SSS share */
  communityArbiters: string[];

  /** Subscription metadata (null for non-subscription escrows) */
  subscription: SubscriptionMeta | null;

  /** Kick votes — tracks who voted to kick whom. When 2 votes target the same role, removal executes */
  kickVotes: Record<string, string[]>;

  /** Readiness confirmations — who has published READY */
  readiness: {
    [Role.BUYER]?: boolean;
    [Role.SELLER]?: boolean;
    [Role.ARBITER]?: boolean;
  };

  /** Votes cast so far */
  votes: {
    [Role.BUYER]?: Outcome;
    [Role.SELLER]?: Outcome;
    [Role.ARBITER]?: Outcome;
  };

  /** Resolved outcome (set when 2-of-3 agree) */
  resolvedOutcome: Outcome | null;
  /** Which two roles formed the majority */
  resolvedMajority: [Role, Role] | null;

  /** Fee structure */
  fees: {
    platformBps: number;
    platformPubkey: string;
    platformMsats: number;
    arbiterMsats: number;
  };

  /** Lock details */
  lock: {
    notesHash: string | null;
    lockedAt: number | null;
    /** Encrypted SSS shares, keyed by share index (stringified).
     *  Each entry contains the encryptedFor map so any participant can
     *  decrypt any share they need for Shamir reconstruction. */
    shares: Map<string, LockShareEntry>;
  };

  /** Claim details */
  claim: {
    claimerRole: Role | null;
    claimedAt: number | null;
  };

  /** Timestamps */
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;

  /** Full ordered event chain (for verification / replay) */
  eventChain: ParsedEscrowEvent[];

  /** Chat messages (separate from state transitions) */
  chatMessages: ParsedEscrowEvent<ChatPayload>[];
}

// ── Validation Error ──────────────────────────────────────────────────────

export interface ValidationError {
  code: string;
  message: string;
  eventId?: string;
  details?: Record<string, unknown>;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: ValidationError };
