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
// Atomic-funding model: there is no FUNDED state. The instant the BOLT11
// invoice is paid, the locker mints internally and publishes LOCK in one
// atomic side-effect. CREATED → LOCKED is the only pre-vote transition.
// JOIN events still exist as participant ACKs (carry the pubkey of buyer
// or arbiter pre-LOCK if available) but they do not gate the state
// machine. READY and KICK are gone — they were ceremony around the dead
// FUNDED state.

export enum EscrowStatus {
  /** Trade terms published, waiting for payment to land and trigger LOCK */
  CREATED = "CREATED",
  /** Ecash locked in 2-of-3 SSS escrow (atomic side-effect of payment landing) */
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

// R3-2 (3.5.x): "window shopping" pre-lock hold. Shortened 15m → 5m so an
// abandoned seat frees itself fast — this replaces the explicit "Leave"
// button (removed), so a buyer who wanders off never buries the trade or
// wipes the chat; the seat just expires. CONSENSUS PARAMETER: every client
// must run the same value or two buyers briefly disagree on a seat
// (reservation-only, self-heals on lock/expiry, no funds at risk). Ship as a
// coordinated version bump, never a silent change. Single source of truth —
// the seat display, joinHoldExpiresAt, and the locker's lock window all
// derive from it.
export const JOIN_HOLD_SECONDS = 5 * 60;
export const JOIN_HOLD_LOCK_GRACE_SECONDS = 2 * 60;

// ⭐ ON-CHAIN NEEDS A LONGER SEAT — and this is a correctness fix, not comfort.
//
// An on-chain funder leaves the app, sends from another wallet, and waits for
// ONE CONFIRMATION before a LOCK can be published. The reducer refuses a LOCK
// that does not name a buyer, and a lapsed hold un-seats one. With a 5-minute
// hold against a ~10-minute mainnet block, the confirmation the funder is
// waiting for arrives AFTER the seat expires — essentially always. The sats
// then sit at the escrow address until the CLTV refund leaf matures.
//
// 90 minutes is sized against a BAD-LUCK block, not an average one: with
// Poisson arrivals a single block exceeds 30 minutes ~5% of the time and 60
// minutes ~0.25%. Long enough that seat expiry is never the thing that fails;
// short enough that an abandoned on-chain listing frees the same afternoon.
//
// ⚠ Deliberately NOT a consensus change. The hold deadline is carried in the
// JOIN payload (`holdExpiresAt`) and every client — including ones that know
// nothing about on-chain escrow — honours the wire value verbatim. These
// constants only decide what the JOINING client stamps. See
// design/mockups/chama-onchain-join-hold-brief.md.
export const ONCHAIN_JOIN_HOLD_SECONDS = 90 * 60;

/** Hold length for a trade, from its CREATE-stamped escrow mode. Pure: every
 *  client replaying the same chain gets the same answer. */
export function joinHoldSecondsFor(escrowMode?: string): number {
  return escrowMode === "onchain" ? ONCHAIN_JOIN_HOLD_SECONDS : JOIN_HOLD_SECONDS;
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
  /** Participant ACK — records buyer or arbiter pubkey on the chain
   *  before LOCK lands. Pure acknowledgment; does NOT transition state. */
  JOIN = 38101,
  /** Ecash locked in 2-of-3 SSS — shares distributed. Atomic side-effect
   *  of BOLT11 payment landing; transitions CREATED → LOCKED directly. */
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
  // 38109 (READY) and 38110 (KICK) retired — atomic funding eliminated
  // the FUNDED ceremony those events gated. Numbers reserved.
  /** Create a subscription escrow with periodic releases */
  SUBSCRIBE = 38111,
  /** Release one period's sats to the seller */
  PERIOD_RELEASE = 38112,
  /** Arbiter-premium note (task #53 E1): OOB ecash encrypted to the seated
   *  arbiter, riding the trade's own channel. NON-CONSENSUS — handled like
   *  CHAT (own state array, never eventChain) and accepted post-COMPLETED
   *  (premiums are paid at settlement). MUST stay out of
   *  EVENT_KIND_TRANSITIONS. */
  PREMIUM = 38113,
  /** On-chain settlement PSBT transport. NON-CONSENSUS — its own state
   *  array, never eventChain, and accepted at APPROVED and after. */
  SETTLEMENT = 38114,
  /** Freeze a parent trade's tranche plan and exact participant snapshot. */
  PLAN_START = 38115,
  /** Publish a pre-seated participant's per-child on-chain key. */
  CHILD_KEY = 38116,
}

// ── Valid State Transitions ───────────────────────────────────────────────
// Maps each state to the set of states it can transition to.
// The state machine enforces these — any event that would cause an
// invalid transition is rejected during replay.

export const VALID_TRANSITIONS: ReadonlyMap<EscrowStatus, ReadonlySet<EscrowStatus>> = new Map([
  [EscrowStatus.CREATED,   new Set([EscrowStatus.LOCKED, EscrowStatus.CANCELLED, EscrowStatus.EXPIRED])],
  [EscrowStatus.LOCKED,    new Set([EscrowStatus.APPROVED, EscrowStatus.EXPIRED])],
  [EscrowStatus.APPROVED,  new Set([EscrowStatus.CLAIMED, EscrowStatus.COMPLETED])],
  [EscrowStatus.CLAIMED,   new Set([EscrowStatus.COMPLETED])],
  // Terminal — no transitions out
  [EscrowStatus.COMPLETED, new Set()],
  [EscrowStatus.EXPIRED,   new Set()],
  [EscrowStatus.CANCELLED, new Set()],
]);

// ── Event Kind → Transition Mapping ───────────────────────────────────────
// Which event kinds can trigger which state transitions.
// JOIN is intentionally absent — it's an ACK that records a participant
// pubkey but does not move the state machine forward.

export const EVENT_KIND_TRANSITIONS: ReadonlyMap<EscrowEventKind, { from: EscrowStatus[]; to: EscrowStatus }> = new Map([
  [EscrowEventKind.LOCK,     { from: [EscrowStatus.CREATED],  to: EscrowStatus.LOCKED }],
  // VOTE doesn't directly transition — RESOLVE does when 2-of-3 is met
  [EscrowEventKind.RESOLVE,  { from: [EscrowStatus.LOCKED],   to: EscrowStatus.APPROVED }],
  [EscrowEventKind.CLAIM,    { from: [EscrowStatus.APPROVED], to: EscrowStatus.CLAIMED }],
  [EscrowEventKind.COMPLETE, { from: [EscrowStatus.CLAIMED, EscrowStatus.APPROVED], to: EscrowStatus.COMPLETED }],
  [EscrowEventKind.CANCEL,   { from: [EscrowStatus.CREATED],  to: EscrowStatus.CANCELLED }],
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
  /** Community slug — drives Browse filtering and currency context.
   *  Lower-case slug from the static communities registry. */
  COMMUNITY: "community",
  /** Fulfillment type: "physical" | "service" | "digital". Generic to
   *  any listing; users only pick at create time for marketplace —
   *  other categories auto-set in handleCreate. */
  FULFILLMENT: "fulfillment",
  // v0.1.72 federation gates ───────────────────────────────────────────
  /** Federation prefix (first 10 chars of an ecash probe). Fast compare. */
  FED_PREFIX: "fedPrefix",
  /** Full federation ID (hex). Canonical record. */
  FED: "fed",
  /** #7 multi-unit storefront: parent listing escrow id, present on a
   *  child purchase escrow. Lets Browse fan out a `#parent` relay filter
   *  to count a storefront's children for derived remaining stock. */
  PARENT: "parent",
  /** Deterministic tranche-plan identifier. */
  PLAN: "plan",
  /** Zero-based tranche index. */
  TRANCHE: "tranche",
  /** Exact Bitcoin network inherited from the parent plan. */
  BITCOIN_NETWORK: "bitcoin_network",
} as const;

export type TrancheBitcoinNetwork = "mainnet" | "signet";

export interface TrancheDescriptor {
  index: number;
  amountMsats: number;
}

export interface PlanStartPayload {
  type: "escrow:plan_start";
  planId: string;
  total: number;
  totalMsats: number;
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  termsDigest: string;
  coordinatorPubkey: string;
  bitcoinNetwork: TrancheBitcoinNetwork;
  tranches: TrancheDescriptor[];
  startedAt: number;
}

export interface TrancheChildDescriptor {
  privatePlanChild: true;
  parent: string;
  planId: string;
  planStartEventId: string;
  index: number;
  total: number;
  totalMsats: number;
  buyerPubkey: string;
  sellerPubkey: string;
  arbiterPubkey: string;
  termsDigest: string;
  coordinatorPubkey: string;
  bitcoinNetwork: TrancheBitcoinNetwork;
}

export interface ChildKeyPayload {
  type: "escrow:child_key";
  planId: string;
  parent: string;
  index: number;
  role: Role;
  bitcoinNetwork: TrancheBitcoinNetwork;
  xOnlyPubkey: string;
  publishedAt: number;
}

// ── Encrypted Content Payloads ────────────────────────────────────────────
// These are the JSON structures inside NIP-44 encrypted `content` fields.

/**
 * v0.1.72 federation gates: CreatePayload now optionally carries the
 * locker's federation identity, captured via a 1-sat probe at create
 * time. Both fields are optional for backwards compatibility with
 * pre-.72 trades; participants warn-and-allow when they're missing.
 *
 *   fedPrefix — first 10 chars of an OOB ecash probe. Cheap to compare.
 *   fed       — full federation ID (hex). Canonical, used for display
 *               and registry matching.
 */
/** Content of a CREATE event */
/** A4 — the two sides of Work.
 *
 *  `"work"` is a WORKER's offer ("I can fix bicycles"). `"work-request"` is a
 *  CLIENT's want-ad ("I need a bicycle fixed"). Both are marketplace escrows
 *  with identical money semantics — the client funds, the worker receives — so
 *  neither changes a single line of the reducer.
 *
 *  ⚠ The value `"work"` keeps its exact historical meaning. Every Work listing
 *  published before A4 is a worker offer, and stays one, with no migration.
 *  A want is a listing with the roles flipped; that is the whole trick, and it
 *  is why matching both directions costs a scoring change rather than a
 *  protocol change. */
export type WorkListingKind = "work" | "work-request";

import type { TrancheRef } from "./tranche.js";

export interface CreatePayload {
  type: "escrow:create";
  /** Public product treatment layered over the stable marketplace money
   *  semantics. Work offers remain marketplace escrows (client funds, worker
   *  receives) while rendering and syndicating as a labor listing. */
  listingKind?: WorkListingKind;
  description: string;
  /** Product photo for a single marketplace listing. */
  imageDataUrl?: string;
  /** Ordered gallery. imageDataUrl remains the backwards-compatible cover. */
  imageUrls?: string[];
  amountMsats: number;
  /** Fiat amount if applicable */
  fiatAmount?: number;
  fiatCurrency?: string;
  /** Listing premium in basis points. For lending, this is APR bps. */
  premiumBps?: number;
  /** Category: p2p-trade, bill-pay, marketplace, lending */
  category: string;
  /** Fulfillment type: "physical" | "service" | "digital". Generic to
   *  every listing per PR 2 call #3. The user picks only for
   *  marketplace; for p2p-trade / bill-pay / lending, handleCreate
   *  rewrites this to the canonical "service" if supplied (or fills
   *  it in if missing) so the chain is consistent. */
  fulfillment?: "physical" | "service" | "digital";
  /** Community slug from the static registry (PR 2). Optional for
   *  backwards compatibility with pre-registry trades — those flow
   *  through Browse as cross-community listings without a pill. */
  community?: string;
  /** v3.1 (B3): ISO alpha-2 country of the listing's community, stamped so a
   *  custom / not-yet-curated community renders a flag + currency on OTHER
   *  devices (where getCommunityBySlug returns null). Display-only — additive,
   *  never hashed (notesHash is LOCK-only) or replay/consensus-bound. */
  country?: string;
  /** v4.1 (#12): optional Community-Bill-Pay bill-type id (e.g. "electricity-kplc").
   *  Informational metadata only — listing legibility + future Browse filtering,
   *  never escrow logic. Additive + display-only; same posture as `country`. */
  billType?: string;
  /** A4: Work category id (e.g. "repair-trades"), the join key the guided
   *  matcher compares a worker's offer against a client's request. Optional and
   *  informational — it never touches escrow logic — but a listing without one
   *  matches on the weaker signals only. */
  workCategory?: string;
  /** Tranching: which slice of a larger trade this escrow is. Informational —
   *  the reducer stores it and reasons about nothing. Sequencing and the safety
   *  gate live in escrow-engine/tranche.ts, entirely client-side. */
  tranche?: TrancheRef;
  /** Where this trade's escrow will live. Absent ⇒ "ecash" (every historical
   *  trade). Stamped at CREATE so a client can refuse BEFORE funding — see
   *  EscrowMode. */
  escrowMode?: EscrowMode;
  /** v6.0: the settlement-policy vocabulary, signed at CREATE. Must AGREE with
   *  `escrowMode` (sibling gate, SETTLEMENT_POLICY_MODE_MISMATCH). Absent ⇒
   *  the mode's default policy (legacy trades stay readable). */
  settlementPolicy?: string;
  /** v6.0: signed slice count for an ecash mutual-slices trade. Present only
   *  on the ecash rail; on an onchain CREATE it is rejected
   *  (ONCHAIN_SLICING_UNSUPPORTED). `1` is the degenerate single-settlement
   *  case — identical to today's behaviour. */
  sliceCount?: number;
  /** The CREATOR's on-chain escrow key. They never publish a JOIN, so their key
   *  rides here instead. Same derivation and same reasons as JoinPayload's. */
  escrowXonly?: string;
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
  /** Optional menu/listing items. Absent means the legacy single-offer
   *  listing shape; present means LOCK must snapshot the selected basket
   *  into selectedItems so the trade amount is fixed by the order. */
  items?: MenuItem[];
  /** Expiry duration in seconds */
  expirySeconds: number;
  /** Community arbiter pool — all pubkeys that receive the arbiter SSS share */
  communityArbiters?: string[];
  /** 2B prefer-bonded: the FUNDED bonded subset (⊆ communityArbiters), resolved by
   *  the creator at publish time (the reducer is pure and can't fetch bonds).
   *  Stamped into CREATE so every client replays the SAME prefer-bonded seat; the
   *  JOIN gate accepts BOTH this and the legacy pick, so a mixed-version client
   *  never rejects a valid arbiter. Absent on all historical CREATEs ⇒ legacy
   *  pick only (byte-identical to pre-2B). */
  bondedArbiters?: string[];
  // v0.1.72 federation gates — payload fields ───────────────────────────
  /** Federation prefix (first 10 chars of an OOB ecash probe). Locker
   *  captures via FedimintClient.probeFederation() at create time.
   *  Optional for backwards compatibility with pre-.72 trades. */
  fedPrefix?: string;
  /** Full federation ID (hex). Same probe captures both. Used for
   *  display and registry matching. Optional for pre-.72 trades. */
  fed?: string;
  // ── #7 multi-unit storefront (Stage 1, additive; no behavior yet) ──────
  /** Total units offered by a multi-unit PARENT listing. Absent / 1 means a
   *  single-unit listing (legacy). The parent is a perpetual offer; each
   *  buyer's purchase is a child escrow that decrements derived remaining
   *  stock. */
  stock?: number;
  /** Parent listing's escrow id. Present only on a CHILD escrow — a buyer
   *  purchasing `claimedQuantity` units from a multi-unit parent. Absent on
   *  standalone / parent listings. Also emitted as a `parent` tag so
   *  children are relay-filterable. */
  parent?: string;
  /** Units this child escrow claims from the parent listing's stock.
   *  Present only on child escrows. */
  claimedQuantity?: number;
  /** The parent listing's seller pubkey, pre-filled onto a CHILD by the
   *  buyer who creates it. A multi-unit purchase inverts the marketplace
   *  convention: the BUYER publishes the child CREATE (so the seller needn't
   *  be online per purchase — Option A), which would normally make the
   *  signer the seller. Carrying the seller's pubkey lets handleCreate seat
   *  the real seller as the SELLER participant up front, so the buyer can
   *  LOCK immediately and the SSS share routes to the seller. Required when
   *  `parent` is set; absent on parents / standalone listings. */
  sellerPubkey?: string;
  /** Private deterministic child in a signed sequential tranche plan. */
  trancheChild?: TrancheChildDescriptor;
  /** Timestamp */
  createdAt: number;
}

/** Content of a JOIN event — pure ACK, does not transition state.
 *  Records the joining participant's pubkey on the chain so other
 *  clients can discover them before LOCK lands. The locker may also
 *  read participants from JOIN events to populate the LOCK payload's
 *  buyerPubkey / arbiterPubkey, but is not required to — LOCK is
 *  self-describing. */
export interface JoinPayload {
  type: "escrow:join";
  role: Role;
  /** Tier 2.1: this party's on-chain escrow key (32-byte x-only, hex).
   *
   *  ⚠ NOT their Nostr pubkey. Derived from the BIP-39 seed instead, because an
   *  extension or Amber user cannot sign a Bitcoin sighash with their nsec, and
   *  reusing the identity key would weld a public trading history to specific
   *  UTXOs. See bond-multisig/onchain-escrow-funding.ts.
   *
   *  Published in JOIN because an on-chain escrow ADDRESS cannot be computed
   *  until all three keys are known — including the arbiter's, who must
   *  therefore JOIN before funding. Absent on every ecash trade. */
  escrowXonly?: string;
  /** Optional: arbiter's fee terms */
  arbiterFeeMsats?: number;
  joinedAt: number;
  /** Buyer/seller slot hold deadline. New clients set this to
   *  joinedAt + JOIN_HOLD_SECONDS; legacy JOINs omit it and remain
   *  first-writer-wins for backwards compatibility. */
  holdExpiresAt?: number;
  /** Optional menu/order selection. For menu listings the buyer can
   *  publish a follow-up JOIN with selectedItems after joining; the
   *  locker snapshots the same basket into LOCK. */
  selectedItems?: SelectedMenuItem[];
  /** Cached selected total for browse/detail UI. LOCK still recomputes
   *  from selectedItems so this is display metadata, not accounting. */
  amountMsats?: number;
  /** Optional final acknowledgement that freezes the menu/order cart.
   *  Cross-role lockers must wait for this before publishing LOCK. */
  orderFinalizedAt?: number;
}

/** Single share in a LOCK event's shares[] array.
 *  `encryptedFor` is keyed by participant pubkey → NIP-44 ciphertext. */
export interface LockShareEntry {
  shareIndex: number;
  encryptedFor: Record<string, string>;
}

export type MenuItemKind = "exchange-bracket" | "bill" | "loan" | "market-item";

export interface MenuItem {
  id: string;
  label: string;
  amountMsats: number;
  kind?: MenuItemKind;
  minAmountMsats?: number;
  maxAmountMsats?: number;
  description?: string;
  fiatAmount?: number;
  fiatCurrency?: string;
  fulfillment?: "physical" | "service" | "digital";
  imageDataUrl?: string;
  /** Ordered product gallery. imageDataUrl remains the legacy cover. */
  imageUrls?: string[];
  dueAt?: number;
  termDays?: number;
  aprBps?: number;
  trustTier?: number;
  /** Max units of this menu button a single order may take (anti-drain cap,
   *  v1.2.9 / #6). Undefined = unbounded (legacy items behave as before).
   *  In v1.3.0 / #7 this becomes the stock that decrements as buyers take
   *  units; for now the reducer enforces selected.quantity <= maxQuantity at
   *  LOCK so no order can drain a seller by requesting an absurd quantity. */
  maxQuantity?: number;
}

export interface SelectedMenuItem {
  itemId: string;
  label: string;
  amountMsats: number;
  quantity: number;
  kind?: MenuItemKind;
  minAmountMsats?: number;
  maxAmountMsats?: number;
  description?: string;
  fiatAmount?: number;
  fiatCurrency?: string;
  fulfillment?: "physical" | "service" | "digital";
  dueAt?: number;
  termDays?: number;
  aprBps?: number;
  trustTier?: number;
}

/** PR 4: 3-recipient envelope structure for LOCK-time data that needs
 *  to reach all three participants. Mirrors LockShareEntry.encryptedFor.
 *  Each value is a NIP-44 ciphertext encrypted by the locker (sender)
 *  to the corresponding recipient pubkey. Any recipient decrypts their
 *  entry using the locker's pubkey as the sender for ECDH.
 *
 *  General-purpose: today used for handle reveal; v1.5+ may reuse for
 *  CHAT 3-recipient encryption or other pre-share fields. The helper
 *  in src/escrow-engine/envelope.ts owns construction/decryption. */
export interface HandleEnvelope {
  encryptedFor: Record<string, string>;
}

/** Content of a LOCK event.
 *
 *  Current browser/Fedi milestone: the escrow token is one reconstructed
 *  ecash payload, so LOCK math is a 2-way split: winner-share + optional
 *  pre-agreed arbiter share must equal amountMsats. The fee policy in
 *  src/arbiters/fees.ts is intentionally separate until a dedicated
 *  multi-party payout path can enforce ambient/dispute fees without
 *  making Fedi claims show the wrong amount.
 */
/** Where a trade's escrow actually lives.
 *
 *  ⚠ THIS IS A CONSENSUS FIELD. It belongs in CREATE, not LOCK, deliberately:
 *  by the time a LOCK exists the money has already moved, so a client that
 *  learns the substrate only then has learned it too late to refuse. Stamped at
 *  CREATE, every client knows before funding which shape of LOCK to expect —
 *  and can refuse to fund a trade it does not understand.
 *
 *  Absent ⇒ `"ecash"`. Every trade ever published is an ecash trade, so the
 *  default must reproduce that exactly. */
export type EscrowMode = "ecash" | "onchain";

/** The on-chain escrow's terms, carried by an on-chain LOCK.
 *
 *  ⭐ EVERY FIELD IS AN INPUT TO THE ADDRESS. That is the point: a recipient
 *  rebuilds the address locally from these and refuses if it does not match the
 *  claimed one (`onchainEscrowAddressMatches`). So this is not "trust me, the
 *  money is at X" — it is "here is how to derive X yourself", and a tampered
 *  field produces a different address rather than a stolen payment. */
export interface OnchainLockTerms {
  /** The escrow address. ADVISORY — always recomputed, never trusted. */
  address: string;
  /** Funding outpoint, so any client can confirm the deposit itself. */
  fundingTxid: string;
  fundingVout: number;
  /** Confirmed sats at the escrow output. */
  amountSats: string;
  /** 32-byte x-only keys, hex. The three spending identities. */
  buyerXonly: string;
  sellerXonly: string;
  arbiterXonly: string;
  /** Which principal the refund leaf pays. */
  funder: "buyer" | "seller";
  /** Absolute block height the refund leaf matures at. */
  refundLockUntil: number;
  /** Relative blocks the dispute leaf is held back (0 = no appeal window). */
  disputeCsvBlocks: number;
  /** "mainnet" | "signet" — a cross-network address must never validate. */
  network: "mainnet" | "signet";
}

export interface LockPayload {
  type: "escrow:lock";
  /** ⚠ ECASH LOCKS ONLY. Empty string on an on-chain lock — there are no notes.
   *  Read it through the lock's `mode`, never on its own truthiness. */
  notesHash: string;
  /** ⭐ Present ONLY on an on-chain lock. Its presence is what makes this a
   *  Tier-2 lock; absent ⇒ the historical ecash lock, byte-identical. */
  onchain?: OnchainLockTerms;
  /** SSS shares. Encryption depends on `sharePolicy`:
   *   - absent / legacy: DUAL-ENCRYPTED — each share NIP-44-encrypted to ALL
   *     three participants, so any participant can decrypt any share (the
   *     2-of-3 is only app-enforced, not cryptographic).
   *   - "holder-only-v1": each share encrypted to ONLY its assigned holder
   *     (shareIndex 0=buyer, 1=seller, 2=arbiter), so no one holds two. */
  shares: LockShareEntry[];
  /** Holder-only shares (escrow safety). "holder-only-v1" → each share is
   *  encrypted only to its assigned holder; reconstruction then needs a
   *  vote-carried share from an agreeing participant (see VoteShareEnvelope),
   *  making 2-of-3 cryptographic. Absent ⇒ legacy dual-encrypted (old path). */
  sharePolicy?: "holder-only-v1";
  /** Arbiter substitution (additive to holder-only-v1): when true, the
   *  arbiter share (index 2) is encrypted to the escrow's deterministic
   *  arbiter PRIORITY ORDER (assigned + 2 backups — see
   *  arbiter-substitution.ts) instead of the assigned arbiter alone, so a
   *  pool backup can carry the deciding share if the assigned arbiter goes
   *  absent. Buyer/seller shares stay strictly holder-only. Old clients
   *  ignore this field and keep working in every non-substituted flow. */
  arbiterPoolShare?: boolean;
  /** Arbiter substitution grace (v2.3): the locker's committed ceiling, in
   *  seconds, on how long the assigned arbiter keeps EXCLUSIVE rights to the
   *  arbiter vote after a dispute starts before a pool backup may step in.
   *  Consensus-safe exactly like `expirySeconds`: it rides in the signed LOCK
   *  so every client computes the identical eligibility moment. Clamped to
   *  [0, SUBSTITUTION_GRACE_MAX_SECONDS] and still adaptively floored by half
   *  the trade's remaining life (see substitutionEligibleAt). Absent ⇒ the
   *  legacy 4h ceiling, byte-identical to pre-v2.3 behavior. Old clients
   *  ignore the field. */
  substitutionGraceSeconds?: number;
  /** Breakdown of amounts (2-way split since v0.1.71) */
  sellerReceivesMsats: number;
  arbiterFeeMsats: number;
  /** Snapshot of the buyer-selected menu basket. For menu listings,
   *  this is required at LOCK and its sum becomes the escrow amount. */
  selectedItems?: SelectedMenuItem[];
  /** Atomic-funding fields (PR 1): LOCK is self-describing about who
   *  the buyer and arbiter are. The chain no longer relies on prior
   *  JOIN events to populate the participant slots — JOINs are ACKs.
   *
   *  buyerPubkey: the npub whose BOLT11 payment triggered this LOCK.
   *  arbiterPubkey: the locker's pick from the trade's communityArbiters
   *    pool (or any pubkey if the pool is empty / pre-community trades). */
  buyerPubkey: string;
  arbiterPubkey: string;
  /** PR 4 wire format: 3-recipient encrypted handle reveal. The locker
   *  encrypts a JSON {handleId?, handle, rail?} blob to each of buyer /
   *  seller / arbiter via NIP-44, mirroring how SSS shares are
   *  distributed via LockShareEntry.encryptedFor. Each participant
   *  decrypts their own entry; non-participants get a null lookup.
   *
   *  Optional: marketplace digital trades, raw escrows, and trades
   *  where the seller didn't pick a saved handle leave this undefined.
   *  When the envelope IS present, the top-level handle/handleId/rail
   *  fields below should be omitted on the wire — escrow-client's
   *  receive pipeline resolves the envelope and synthesizes those
   *  top-level fields on the parsed event before applyEvent runs. */
  handleEnvelope?: HandleEnvelope;
  /** PR 3 (deprecated wire format) + PR 4 transient apply-time fields.
   *
   *  On the wire: pre-PR-4 LOCKs carry handle/handleId/rail at the top
   *  level (single-recipient via the now-removed outer NIP-44 wrap).
   *  Replay still accepts those for backwards compat; new emitters use
   *  handleEnvelope instead.
   *
   *  At apply time: escrow-client populates these from the envelope
   *  (decrypts the viewer's entry) before passing to handleLock. The
   *  state machine reads them as cleartext regardless of how they
   *  arrived — wire-legacy or envelope-resolved. */
  handleId?: string;
  handle?: string;
  rail?: string;
  /** v0.6.5: optional mobile-money networks the locker accepts on this
   *  handle (e.g. ["m-pesa", "airtel-money"] for a Kenyan phone number).
   *  Carried inside the same NIP-44 envelope as handle/rail, never on
   *  the wire as cleartext. Apply-time field — escrow-client populates
   *  it from the envelope JSON before applyEvent. Only meaningful for
   *  phone-number rails; other rails leave it undefined. */
  handleNetworks?: string[];
  lockedAt: number;
}

/** Holder-only shares: a voter's SSS share, re-encrypted to the outcome's
 *  engine-computed recipient and bound to the funded token. Carried on VOTE so
 *  the recipient can reconstruct from their own LOCK share + one agreeing
 *  voter's share. The binding fields let the parser reject a share replayed
 *  against the wrong outcome / recipient / token / escrow / share slot. */
export interface VoteShareEnvelope {
  /** The voter's holder share index (role-derived: buyer=0, seller=1, arbiter=2). */
  shareIndex: number;
  /** The outcome this share is bound to — the voter's voted outcome. */
  outcome: Outcome;
  /** notesHash of the LOCK this share belongs to (binds to the funded token). */
  notesHash: string;
  /** The recipient for `outcome` per payoutRecipientFor(state, outcome). */
  recipientPubkey: string;
  /** The share re-encrypted to the recipient. Sender = the voting participant
   *  (NOT the locker) — decrypt with the voter's pubkey as sender. */
  encryptedFor: Record<string, string>;
}

/** Content of a VOTE event */
export interface VotePayload {
  type: "escrow:vote";
  outcome: Outcome;
  role: Role;
  /** Optional reason */
  reason?: string;
  /** Holder-only shares: the voter's share re-encrypted to the outcome's
   *  recipient (see VoteShareEnvelope). Optional — absent on legacy votes and
   *  on the expiry-heal auto-refund path (best-effort there; the funder already
   *  holds the minted token, so its vote-carried share is redundant). */
  shareEnvelope?: VoteShareEnvelope;
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
export interface ChatImageAttachment {
  id: string;
  kind: "image";
  mimeType: string;
  dataUrl: string;
  name?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface ChatBody {
  message: string;
  attachments?: ChatImageAttachment[];
}

export interface ChatPayload {
  type: "escrow:chat";
  /** Cleartext message after envelope resolution. On new wire events,
   *  this is intentionally empty and the readable body lives inside
   *  bodyEnvelope. Legacy plaintext chat keeps using this field. */
  message: string;
  /** Cleartext attachments after envelope resolution. New wire events
   *  carry these inside bodyEnvelope so receipts remain participant-only. */
  attachments?: ChatImageAttachment[];
  /** v0.7.x: participant-only encrypted chat body. The sender encrypts
   *  JSON ChatBody to buyer, seller, and arbiter using the same
   *  per-recipient envelope pattern as LOCK handle reveal. */
  bodyEnvelope?: HandleEnvelope;
  senderRole: Role;
  sentAt: number;
}

/** Cleartext body of a PREMIUM note — lives ONLY inside noteEnvelope,
 *  encrypted to the seated arbiter (task #53 E1). Carries the bearer
 *  ecash, so it must never appear in plaintext event content. */
export interface PremiumBody {
  escrowId: string;
  payerRole: Role;
  amountSats: number;
  /** Federation that minted the bearer note. Arbiters must redeem with a
   *  wallet joined to this federation; a mismatch is deferred, not counted
   *  as a dead-note failure. Optional for pre-v5.2.3 notes. */
  federationId?: string;
  /** OOB ecash note string, spendable by whoever redeems it first.
   *  Spent with a long try_cancel horizon so an absent arbiter's note
   *  auto-refunds to the payer. */
  oobNotes: string;
  kind: "ambient" | "dispute";
  createdAt: number;
}

/** Content of a PREMIUM event (kind 38113) — arbiter insurance premium.
 *  Non-consensus: never touches eventChain or status. The note itself is
 *  opaque to everyone but the arbiter. */
export interface PremiumPayload {
  type: "escrow:premium";
  /** NIP-44 envelope encrypted to the seated arbiter only; plaintext is
   *  JSON PremiumBody. */
  noteEnvelope: HandleEnvelope;
  payerRole: Role;
  noteKind: "ambient" | "dispute";
  sentAt: number;
}

/** Content of a SETTLEMENT event (kind 38114). The whole payload is carried
 *  inside the client's per-recipient NIP-44 envelope; the parser only sees it
 *  after local decryption. */
export interface SettlementPayload {
  type: "escrow:settlement";
  /** Base64 PSBT. It is untrusted wire input until locally recomputed and
   *  verified against the trade's own on-chain terms. */
  psbt: string;
  leaf: "coop" | "arbiter";
  role: Role;
  /** True only when the PSBT contains enough signatures to finalize. */
  final?: boolean;
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
  | PremiumPayload
  | SettlementPayload
  | SubscribePayload
  | PeriodReleasePayload
  | PlanStartPayload
  | ChildKeyPayload;

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
  /** Optional public product treatment. Absent keeps every historical listing
   *  byte-for-byte on its existing marketplace presentation. */
  listingKind?: WorkListingKind;
  /** Product photo for a single marketplace listing. */
  imageDataUrl?: string;
  /** Ordered listing/store gallery. imageDataUrl remains the legacy cover. */
  imageUrls?: string[];
  /** Amount in msats */
  amountMsats: number;
  /** Fiat amount and currency (if applicable) */
  fiatAmount?: number;
  fiatCurrency?: string;
  /** Listing premium in basis points. For lending, this is APR bps. */
  premiumBps?: number;
  /** Category */
  category: string;
  /** Public payment rails/methods accepted for this listing, when the
   *  seller chose to advertise them at create time. Handle cleartext
   *  still stays private until LOCK. */
  paymentMethods?: string[];
  /** Optional menu/listing items. Undefined keeps legacy single-offer
   *  listings small on replay. */
  items?: MenuItem[];
  /** Fulfillment type: "physical" | "service" | "digital". Always set
   *  after handleCreate runs — defaults to "service" for non-marketplace
   *  categories, "physical" for marketplace when not specified. */
  fulfillment: "physical" | "service" | "digital";
  /** Community slug. Null for pre-registry trades (no community tag
   *  on CREATE) — Browse renders these without a community pill. */
  community: string | null;
  /** v3.1 (B3): ISO alpha-2 country for the self-describing flag/currency
   *  fallback when the community slug isn't resolvable on this device. Display
   *  only — additive. */
  country?: string | null;
  /** v4.1 (#12): CBP bill-type id, carried for the card/detail display. Optional,
   *  display-only. */
  billType?: string | null;
  /** A4: Work category id, carried for the card/detail display and for matching. */
  workCategory?: string | null;
  /** Tranching: this escrow's slice of a larger trade, when it is one. */
  tranche?: TrancheRef;
  /** Where this trade's escrow lives. Defaulted to "ecash" by the reducer, so
   *  readers never have to handle undefined. */
  escrowMode: EscrowMode;
  /** v6.0: the signed settlement policy. Defaulted from `escrowMode` when the
   *  CREATE omitted it, so readers never handle undefined. */
  settlementPolicy: string;
  /** v6.0: signed slice count. Present only on ecash mutual-slices trades. */
  sliceCount?: number;
  /** Tier 2.1: each party's published on-chain escrow key, by role. All three
   *  are needed before an escrow address exists. */
  escrowKeys?: Partial<Record<Role, string>>;
  /** Fedimint mint URL / invite code */
  mintUrl: string;

  // ── #7 multi-unit storefront (Stage 1, additive; no behavior yet) ──────
  /** Total units offered by a multi-unit PARENT listing. Undefined / 1 =
   *  single-unit (legacy). The parent is a perpetual offer; each buyer's
   *  purchase is a child escrow that decrements derived remaining stock. */
  stock?: number;
  /** Parent listing's escrow id — set only on a CHILD escrow (a buyer's
   *  purchase from a multi-unit parent). Undefined on standalone / parent
   *  listings. */
  parent?: string;
  /** Units this child escrow claims from the parent's stock. Set only on
   *  child escrows. */
  claimedQuantity?: number;
  /** Present on a parent after its participant snapshot is frozen. */
  tranchePlan?: PlanStartPayload & { eventId: string };
  /** Present only on private deterministic tranche children. */
  trancheChild?: TrancheChildDescriptor;
  /** Per-child on-chain x-only keys published by the frozen participants. */
  childKeys?: Partial<Record<Role, string>>;

  /** Participants — pubkeys mapped to roles */
  participants: {
    [Role.BUYER]: string | null;
    [Role.SELLER]: string | null;
    [Role.ARBITER]: string | null;
  };

  /** Timed buyer/seller reservations created by JOIN ACKs. The
   *  initiator role and arbiter auto-assignment do not use timed holds. */
  joinHolds?: Partial<Record<Role, {
    role: Role;
    pubkey: string;
    joinedAt: number;
    expiresAt: number;
    eventId: string;
    selectedItems?: SelectedMenuItem[];
    amountMsats?: number;
    orderFinalizedAt?: number;
  }>>;

  /** Who initiated the trade (and their role) */
  initiator: { pubkey: string; role: Role };

  /** Community arbiter pool — backup arbiters who also receive the SSS share */
  communityArbiters: string[];
  /** 2B prefer-bonded: funded bonded subset stamped at CREATE (⊆ communityArbiters).
   *  Read with `?? []`; absent on pre-2B trades. Drives pickPreferredArbiter. */
  bondedArbiters?: string[];

  /** Subscription metadata (null for non-subscription escrows) */
  subscription: SubscriptionMeta | null;

  /** Votes cast so far. The ARBITER slot is DERIVED on pooled-share locks:
   *  among all arbiter-role votes in the chain, the one from the
   *  lowest-priority-index pool member wins (assigned = 0 always trumps
   *  backups pre-settlement). See arbiter-substitution.ts. */
  votes: {
    [Role.BUYER]?: Outcome;
    [Role.SELLER]?: Outcome;
    [Role.ARBITER]?: Outcome;
  };

  /** Resolved outcome (set when 2-of-3 agree) */
  resolvedOutcome: Outcome | null;
  /** Which two roles formed the majority */
  resolvedMajority: [Role, Role] | null;
  /** Arbiter substitution: the pubkey whose vote currently holds the ARBITER
   *  slot — the assigned arbiter in the normal case, or the
   *  highest-priority pool backup who stepped in. Undefined before any
   *  arbiter vote (and on all pre-substitution trades). */
  actingArbiter?: string;

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
    /** Encrypted SSS shares, keyed by share index (stringified). Under the
     *  legacy policy each entry's encryptedFor holds all three participants;
     *  under holder-only-v1 each entry holds only its assigned holder. */
    shares: Map<string, LockShareEntry>;
    /** Holder-only shares: "holder-only-v1" when each share was encrypted only
     *  to its holder (claim reconstructs from own LOCK share + a vote-carried
     *  share). Absent ⇒ legacy dual-encrypted (claim picks any two). */
    sharePolicy?: "holder-only-v1";
    /** Tier 2.1: the on-chain escrow's terms, when this lock is on-chain.
     *  Absent ⇒ an ecash lock. Read the MODE, not this field's truthiness. */
    onchain?: OnchainLockTerms;
    /** Arbiter substitution: true when the arbiter share was encrypted to the
     *  escrow's deterministic priority order (assigned + 2 backups) so a pool
     *  backup may cast the arbiter vote after the grace window. Absent ⇒
     *  assigned-arbiter-only (every pre-substitution lock). */
    arbiterPoolShare?: boolean;
    /** Arbiter substitution grace ceiling (v2.3), seconds, as committed in the
     *  LOCK. Read by substitutionEligibleAt as the max-exclusivity window for
     *  the assigned arbiter (still floored by half the remaining life). Absent
     *  ⇒ the legacy 4h default. Consensus-safe: every client replays the same
     *  committed value. */
    substitutionGraceSeconds?: number;
    /** PR 3: revealed payment handle for the trade. Populated by
     *  handleLock when the LockPayload carried handle/rail fields.
     *  null when the trade is a non-fiat vertical (marketplace digital,
     *  raw-escrow) or a pre-PR-3 trade. The render layer applies
     *  handleDisplayForViewer() to gate cleartext display on viewer
     *  context — non-participants see masked output even when this
     *  field is populated locally.
     *  v0.6.5: `networks` carries the mobile-money networks the seller
     *  tagged on a phone-number handle ("M-Pesa", "Wave", etc.). Empty
     *  array means the seller didn't tag any; that's distinct from
     *  null (no handle at all). Render layer shows them as chips
     *  alongside the cleartext number during active trade. */
    handle: {
      id: string | null;
      value: string;
      rail: string | null;
      networks: string[];
    } | null;
    /** Menu basket captured by LOCK. Null/undefined means legacy
     *  single-offer escrow. */
    selectedItems?: SelectedMenuItem[];
  };

  /** Claim details */
  claim: {
    claimerRole: Role | null;
    claimedAt: number | null;
  };

  /** Timestamps */
  createdAt: number;
  /** Deadline for the unlocked Browse listing. Once LOCK lands, the
   *  active trade deadline moves to lock.lockedAt + tradeTimeoutSeconds. */
  listingExpiresAt?: number;
  /** Duration applied to the locked trade after LOCK. Defaults to the
   *  CREATE expirySeconds for backwards-compatible replays. */
  tradeTimeoutSeconds?: number;
  /** Active deadline for the current state: listing deadline while
   *  CREATED, locked trade deadline after LOCK. */
  expiresAt: number;
  resolvedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;

  /** Full ordered event chain (for verification / replay) */
  eventChain: ParsedEscrowEvent[];

  /** Chat messages (separate from state transitions) */
  chatMessages: ParsedEscrowEvent<ChatPayload>[];

  /** Arbiter-premium notes (kind 38113, task #53 E1). Non-consensus,
   *  separate from state transitions — like chatMessages. Optional so
   *  pre-premium state literals stay valid; read with `?? []`. */
  premiumNotes?: ParsedEscrowEvent<PremiumPayload>[];

  /** On-chain settlement PSBT messages (kind 38114). Non-consensus and kept
   *  outside eventChain so transport can never change escrow replay. */
  settlements?: ParsedEscrowEvent<SettlementPayload>[];
}

export function roleUsesJoinHold(role: Role, initiatorRole: Role): boolean {
  return (role === Role.BUYER || role === Role.SELLER) && role !== initiatorRole;
}

export function joinHoldExpiresAt(joinedAt: number): number {
  return joinedAt + JOIN_HOLD_SECONDS;
}

/** Mode-aware hold deadline. `escrowMode` absent/ecash ⇒ byte-identical to
 *  `joinHoldExpiresAt`, so every existing trade is unaffected. */
export function joinHoldExpiresAtFor(joinedAt: number, escrowMode?: string): number {
  return joinedAt + joinHoldSecondsFor(escrowMode);
}

export function getEffectiveParticipantAt(
  state: EscrowState,
  role: Role,
  atSec = Math.floor(Date.now() / 1000),
  opts: { includeLockGrace?: boolean } = {},
): string | null {
  const pubkey = state.participants[role];
  if (!pubkey) return null;
  // A signed PLAN_START freezes all three seats for the lifetime of the
  // persistent parent room; the original buyer reservation no longer lapses.
  if (state.tranchePlan) return pubkey;
  if (state.status !== EscrowStatus.CREATED) return pubkey;

  const hold = state.joinHolds?.[role];
  if (!hold || hold.pubkey !== pubkey) return pubkey;

  const graceSeconds = opts.includeLockGrace ? JOIN_HOLD_LOCK_GRACE_SECONDS : 0;
  return hold.expiresAt + graceSeconds > atSec ? pubkey : null;
}

export function getEffectiveParticipantsAt(
  state: EscrowState,
  atSec = Math.floor(Date.now() / 1000),
): EscrowState["participants"] {
  return {
    [Role.BUYER]: getEffectiveParticipantAt(state, Role.BUYER, atSec),
    [Role.SELLER]: getEffectiveParticipantAt(state, Role.SELLER, atSec),
    [Role.ARBITER]: getEffectiveParticipantAt(state, Role.ARBITER, atSec),
  };
}

export function getJoinHoldRemainingSeconds(
  state: EscrowState,
  role: Role,
  atSec = Math.floor(Date.now() / 1000),
): number | null {
  const hold = state.joinHolds?.[role];
  if (!hold || state.participants[role] !== hold.pubkey) return null;
  return Math.max(0, hold.expiresAt - atSec);
}

export function selectedMenuItemsTotalMsats(items: SelectedMenuItem[] | undefined): number {
  if (!items || items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item.amountMsats * item.quantity, 0);
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
