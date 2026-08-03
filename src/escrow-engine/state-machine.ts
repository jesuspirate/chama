// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — State Machine
// ══════════════════════════════════════════════════════════════════════════
//
// Pure function: (state, event) → state | error
//
// No side effects. No network. No database. No server.
// Given an escrow state and a new validated event, returns the next state.
// Any client can replay the full event chain to reconstruct current state.
//
// Design:
//   - Each handler validates preconditions, then returns a new state object
//   - State is immutable — handlers return new objects, never mutate
//   - Invalid transitions return ValidationError, never throw
//   - The CREATE handler bootstraps initial state from scratch

import {
  EscrowStatus,
  EscrowEventKind,
  Role,
  Outcome,
  TERMINAL_STATES,
  TRULY_TERMINAL_STATES,
  getEffectiveParticipantAt,
  JOIN_HOLD_LOCK_GRACE_SECONDS,
  joinHoldExpiresAt,
  roleUsesJoinHold,
  type EscrowState,
  type ParsedEscrowEvent,
  type CreatePayload,
  type MenuItem,
  type SelectedMenuItem,
  type JoinPayload,
  type LockPayload,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type ChatPayload,
  type PremiumPayload,
  type SubscribePayload,
  type PeriodReleasePayload,
  type PlanStartPayload,
  type ChildKeyPayload,
  type ValidationError,
} from "./types.js";
import { payoutRecipientFor } from "./recipients.js";
import { validateVoteShareEnvelope } from "./holder-shares.js";
import { arbiterVotePriority, substitutionEligibleAt, clampSubstitutionGraceSeconds, oneSidedEscalationAt, isPerformanceContest } from "./arbiter-substitution.js";
import { pickArbiterFromPool, pickPreferredArbiter } from "../arbiters/pool.js";
import { validatePlanStart } from "./tranche-plan.js";

// Re-export so existing callers (escrow-client, escrow-bridge, tests) keep
// importing payoutRecipientFor from the state machine.
export { payoutRecipientFor } from "./recipients.js";

// ── Result type for state transitions ─────────────────────────────────────

export type TransitionResult =
  | { ok: true; state: EscrowState }
  | { ok: false; error: ValidationError };

// ── Helper: create an error result ────────────────────────────────────────

function err(code: string, message: string, eventId?: string, details?: Record<string, unknown>): TransitionResult {
  return { ok: false, error: { code, message, eventId, details } };
}

// INVARIANT(arbiter-fee-bounds) — v3.3 (C2): the arbiter fee is locker-chosen
// and the parser only rejects NaN/Infinity, so it can still arrive negative,
// fractional, or above the trade amount. Sanitize — never reject — at every
// write into state.fees.arbiterMsats: an integer clamped to [0, amount].
// Rejecting at LOCK would strand the locker (the ecash is spent before the
// reducer runs); rejecting at parse would make an odd-but-accepted historical
// chain unloadable. Coercion keeps the payout balanced (seller = amount − fee
// stays in range), applies identically on every client (replay-deterministic),
// and is a no-op for honest floor()'d bps fees. A canonical fee assertion
// belongs to the economic layer (C8) once a payout path actually fans out.
function sanitizeArbiterFeeMsats(value: unknown, amountMsats: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const cap = Number.isFinite(amountMsats) && amountMsats > 0 ? Math.floor(amountMsats) : 0;
  return Math.max(0, Math.min(cap, Math.floor(value)));
}

// ── Helper: clone state immutably ─────────────────────────────────────────

function cloneState(state: EscrowState): EscrowState {
  return {
    ...state,
    paymentMethods: state.paymentMethods ? [...state.paymentMethods] : undefined,
    items: state.items ? state.items.map(item => ({ ...item })) : undefined,
    participants: { ...state.participants },
    joinHolds: state.joinHolds
      ? Object.fromEntries(
          Object.entries(state.joinHolds).map(([role, hold]) => [
            role,
            hold
              ? {
                  ...hold,
                  selectedItems: hold.selectedItems
                    ? hold.selectedItems.map(item => ({ ...item }))
                    : undefined,
                }
              : hold,
          ]),
        ) as EscrowState["joinHolds"]
      : undefined,
    communityArbiters: [...state.communityArbiters],
    bondedArbiters: state.bondedArbiters ? [...state.bondedArbiters] : undefined,
    subscription: state.subscription ? {
      ...state.subscription,
      periodStartTimes: [...state.subscription.periodStartTimes],
      periodStatuses: [...state.subscription.periodStatuses],
    } : null,
    votes: { ...state.votes },
    fees: { ...state.fees },
    lock: {
      ...state.lock,
      shares: new Map(state.lock.shares),
      handle: state.lock.handle ? { ...state.lock.handle } : null,
      selectedItems: state.lock.selectedItems
        ? state.lock.selectedItems.map(item => ({ ...item }))
        : undefined,
    },
    claim: { ...state.claim },
    eventChain: [...state.eventChain],
    chatMessages: [...state.chatMessages],
    premiumNotes: state.premiumNotes ? [...state.premiumNotes] : undefined,
    tranchePlan: state.tranchePlan
      ? { ...state.tranchePlan, tranches: state.tranchePlan.tranches.map(row => ({ ...row })) }
      : undefined,
    tranche: state.tranche ? { ...state.tranche } : undefined,
    childKeys: state.childKeys ? { ...state.childKeys } : undefined,
  };
}

function normalizePaymentMethods(methods: string[] | undefined): string[] | undefined {
  if (!methods) return undefined;
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const method of methods) {
    const value = method.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

function cloneMenuItem(item: MenuItem): MenuItem {
  return {
    id: item.id,
    label: item.label.trim(),
    amountMsats: item.amountMsats,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.minAmountMsats !== undefined ? { minAmountMsats: item.minAmountMsats } : {}),
    ...(item.maxAmountMsats !== undefined ? { maxAmountMsats: item.maxAmountMsats } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.fiatAmount !== undefined ? { fiatAmount: item.fiatAmount } : {}),
    ...(item.fiatCurrency ? { fiatCurrency: item.fiatCurrency } : {}),
    ...(item.fulfillment ? { fulfillment: item.fulfillment } : {}),
    ...(item.imageDataUrl ? { imageDataUrl: item.imageDataUrl } : {}),
    ...(item.imageUrls?.length ? { imageUrls: [...item.imageUrls] } : {}),
    ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}),
    ...(item.termDays !== undefined ? { termDays: item.termDays } : {}),
    ...(item.aprBps !== undefined ? { aprBps: item.aprBps } : {}),
    ...(item.trustTier !== undefined ? { trustTier: item.trustTier } : {}),
    ...(item.maxQuantity !== undefined ? { maxQuantity: item.maxQuantity } : {}),
  };
}

function cloneSelectedMenuItem(item: SelectedMenuItem): SelectedMenuItem {
  return {
    itemId: item.itemId,
    label: item.label.trim(),
    amountMsats: item.amountMsats,
    quantity: item.quantity,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.minAmountMsats !== undefined ? { minAmountMsats: item.minAmountMsats } : {}),
    ...(item.maxAmountMsats !== undefined ? { maxAmountMsats: item.maxAmountMsats } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.fiatAmount !== undefined ? { fiatAmount: item.fiatAmount } : {}),
    ...(item.fiatCurrency ? { fiatCurrency: item.fiatCurrency } : {}),
    ...(item.fulfillment ? { fulfillment: item.fulfillment } : {}),
    ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}),
    ...(item.termDays !== undefined ? { termDays: item.termDays } : {}),
    ...(item.aprBps !== undefined ? { aprBps: item.aprBps } : {}),
    ...(item.trustTier !== undefined ? { trustTier: item.trustTier } : {}),
  };
}

function selectedItemsTotalMsats(items: SelectedMenuItem[]): number {
  return items.reduce((sum, item) => sum + item.amountMsats * item.quantity, 0);
}

function selectedItemsKey(items: SelectedMenuItem[] | undefined): string {
  return (items ?? [])
    .map(item => [
      item.itemId,
      item.label,
      item.amountMsats,
      item.quantity,
      item.kind ?? "",
      item.fiatCurrency ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

function isAmountBracket(item: MenuItem): boolean {
  return item.kind === "exchange-bracket"
    || item.minAmountMsats !== undefined
    || item.maxAmountMsats !== undefined;
}

function menuSelectorRoleFor(category: string): Role {
  return category === "lending" ? Role.SELLER : Role.BUYER;
}

// ── Helper: check if pubkey is a known participant ────────────────────────

function getRole(state: EscrowState, pubkey: string): Role | null {
  if (state.participants[Role.BUYER] === pubkey) return Role.BUYER;
  if (state.participants[Role.SELLER] === pubkey) return Role.SELLER;
  if (state.participants[Role.ARBITER] === pubkey) return Role.ARBITER;
  return null;
}

// ── Helper: check vote threshold ──────────────────────────────────────────

function checkVoteThreshold(votes: EscrowState["votes"]): {
  resolved: boolean;
  outcome?: Outcome;
  majority?: [Role, Role];
  arbiterInvolved?: boolean;
} {
  const entries = Object.entries(votes) as [Role, Outcome][];
  if (entries.length < 2) return { resolved: false };

  // Count outcomes
  const releasers = entries.filter(([, o]) => o === Outcome.RELEASE).map(([r]) => r);
  const refunders = entries.filter(([, o]) => o === Outcome.REFUND).map(([r]) => r);

  if (releasers.length >= 2) {
    return {
      resolved: true,
      outcome: Outcome.RELEASE,
      majority: [releasers[0], releasers[1]],
      arbiterInvolved: releasers.includes(Role.ARBITER),
    };
  }

  if (refunders.length >= 2) {
    return {
      resolved: true,
      outcome: Outcome.REFUND,
      majority: [refunders[0], refunders[1]],
      arbiterInvolved: refunders.includes(Role.ARBITER),
    };
  }

  return { resolved: false };
}

// ══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════

// ── CREATE ────────────────────────────────────────────────────────────────
// Bootstrap a new escrow from a CREATE event. Returns initial state.

function handleCreate(event: ParsedEscrowEvent<CreatePayload>): TransitionResult {
  const p = event.payload;

  // Validate required fields
  if (!p.description || p.amountMsats <= 0) {
    return err("INVALID_CREATE", "CREATE requires description and positive amount", event.raw.id);
  }
  if (!p.mintUrl) {
    return err("INVALID_CREATE", "CREATE requires a mint URL / federation invite", event.raw.id);
  }
  if (p.expirySeconds <= 0) {
    return err("INVALID_CREATE", "CREATE requires positive expiry duration", event.raw.id);
  }

  // Determine initiator role from category convention:
  //   bill-pay → seller creates (bitcoiner offering sats for bill payment)
  //   p2p-trade → seller creates (offering to sell sats for fiat)
  //   marketplace → seller creates (listing an item for sale)
  //   lending → buyer creates (borrower requesting a loan)
  //
  // #7 multi-unit storefront — a CHILD purchase inverts the marketplace
  // convention. The child carries `parent` (the listing's id) and the
  // parent's `sellerPubkey`; the BUYER publishes the child CREATE so the
  // seller needn't be online for each sale (Option A). The signer is the
  // buyer; the real seller is seated up front from the carried pubkey, so the
  // buyer can LOCK immediately and the SSS seller-share routes to the seller
  // (who discovers the child later via the `#parent` filter). A wrong/forged
  // sellerPubkey only locks the buyer's own funds to a counterparty that
  // won't fulfil → recovered via the existing refund/expiry path; no loss.
  const isTrancheChild = p.tranche?.privatePlanChild === true;
  const isChildPurchase = p.parent !== undefined && p.sellerPubkey !== undefined;

  const initiatorRole = isTrancheChild
    ? Role.SELLER
    : (p.category === "lending" || isChildPurchase)
    ? Role.BUYER
    : Role.SELLER;

  const participants = {
    [Role.BUYER]: isTrancheChild ? p.tranche!.buyerPubkey : (initiatorRole === Role.BUYER ? event.pubkey : null),
    [Role.SELLER]: isTrancheChild ? p.tranche!.sellerPubkey : isChildPurchase
      ? p.sellerPubkey!
      : (initiatorRole === Role.SELLER ? event.pubkey : null),
    [Role.ARBITER]: isTrancheChild ? p.tranche!.arbiterPubkey : null as string | null,
  };
  if (isTrancheChild && event.pubkey !== p.tranche!.coordinatorPubkey) {
    return err("INVALID_TRANCHE_COORDINATOR", "Only the frozen plan coordinator may create tranche children", event.raw.id);
  }

  // PR 2: fulfillment is generic to every listing, but only marketplace
  // gives the user a real choice. For other categories we rewrite to
  // the canonical "service" so the chain is consistent — even if a
  // misbehaving client published a CREATE with fulfillment="physical"
  // for a p2p-trade, replay normalizes it.
  const fulfillment: "physical" | "service" | "digital" =
    p.category === "marketplace"
      ? (p.fulfillment ?? "physical")
      : "service";

  const listingExpiresAt = event.timestamp + p.expirySeconds;
  const items = p.items?.map(cloneMenuItem);

  const state: EscrowState = {
    id: event.escrowId,
    status: EscrowStatus.CREATED,
    description: p.description,
    ...(p.listingKind ? { listingKind: p.listingKind } : {}),
    ...(p.category === "marketplace" && p.imageDataUrl ? { imageDataUrl: p.imageDataUrl } : {}),
    ...(p.category === "marketplace" && p.imageUrls?.length ? { imageUrls: [...p.imageUrls] } : {}),
    amountMsats: p.amountMsats,
    fiatAmount: p.fiatAmount,
    fiatCurrency: p.fiatCurrency,
    premiumBps: p.premiumBps,
    category: p.category,
    paymentMethods: normalizePaymentMethods(p.paymentMethods),
    items,
    fulfillment,
    community: p.community ?? null,
    country: p.country ?? null,
    billType: p.billType ?? null,
    mintUrl: p.mintUrl,
    // #7 multi-unit storefront (Stage 1): carried through, no behavior yet.
    ...(p.stock !== undefined ? { stock: p.stock } : {}),
    ...(p.parent !== undefined ? { parent: p.parent } : {}),
    ...(p.claimedQuantity !== undefined ? { claimedQuantity: p.claimedQuantity } : {}),
    ...(p.tranche ? { tranche: { ...p.tranche }, childKeys: {} } : {}),
    participants,
    joinHolds: {},
    initiator: { pubkey: event.pubkey, role: initiatorRole },
    communityArbiters: p.communityArbiters || [],
    bondedArbiters: p.bondedArbiters || [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: {
      platformBps: p.platformFeeBps,
      platformPubkey: p.platformFeePubkey,
      platformMsats: Math.floor((p.amountMsats * p.platformFeeBps) / 10_000),
      // INVARIANT(arbiter-fee-bounds) — v3.3 (C2): sanitize the locker-chosen
      // fee at the canonical source (CREATE) into [0, amount] (integer). This
      // is where the LOCK builder later reads the fee from, so coercing here
      // keeps every downstream LOCK in range without a fund-stranding reject.
      arbiterMsats: sanitizeArbiterFeeMsats(p.arbiterFeeMsats, p.amountMsats),
    },
    lock: {
      notesHash: null,
      lockedAt: null,
      shares: new Map(),
      handle: null,
      selectedItems: undefined,
    },
    claim: {
      claimerRole: null,
      claimedAt: null,
    },
    createdAt: event.timestamp,
    listingExpiresAt,
    tradeTimeoutSeconds: p.expirySeconds,
    expiresAt: listingExpiresAt,
    resolvedAt: null,
    completedAt: null,
    cancelledAt: null,
    eventChain: [event],
    chatMessages: [],
  };

  return { ok: true, state };
}

function handlePlanStart(state: EscrowState, event: ParsedEscrowEvent<PlanStartPayload>): TransitionResult {
  const p = event.payload;
  if (state.tranche || state.parent) return err("PLAN_ON_CHILD", "A tranche child cannot start a plan", event.raw.id);
  if (state.tranchePlan) {
    return state.tranchePlan.eventId === event.raw.id
      ? { ok: true, state }
      : err("PLAN_ALREADY_STARTED", "Parent already has a frozen tranche plan", event.raw.id);
  }
  const invalid = validatePlanStart(p);
  if (invalid) return err("INVALID_PLAN_START", invalid, event.raw.id);
  if (event.pubkey !== state.initiator.pubkey || event.pubkey !== p.coordinatorPubkey) {
    return err("INVALID_PLAN_COORDINATOR", "Plan start must be signed by the parent initiator", event.raw.id);
  }
  if (state.participants[Role.BUYER] !== p.buyerPubkey
    || state.participants[Role.SELLER] !== p.sellerPubkey
    || state.participants[Role.ARBITER] !== p.arbiterPubkey) {
    return err("PLAN_PARTICIPANT_MISMATCH", "Plan participants must match the seated parent participants", event.raw.id);
  }
  if (p.totalMsats !== state.amountMsats) return err("PLAN_AMOUNT_MISMATCH", "Plan total must equal parent amount", event.raw.id);
  const next = cloneState(state);
  next.tranchePlan = { ...p, tranches: p.tranches.map(row => ({ ...row })), eventId: event.raw.id };
  // The parent is now a persistent manifest/room, not a fundable listing.
  next.expiresAt = Number.MAX_SAFE_INTEGER;
  next.eventChain.push(event);
  return { ok: true, state: next };
}

function handleChildKey(state: EscrowState, event: ParsedEscrowEvent<ChildKeyPayload>): TransitionResult {
  const p = event.payload;
  const tranche = state.tranche;
  if (!tranche) return err("KEY_ON_NON_CHILD", "Child keys are accepted only on tranche children", event.raw.id);
  if (p.parent !== tranche.parent || p.planId !== tranche.planId || p.index !== tranche.index) {
    return err("CHILD_KEY_PLAN_MISMATCH", "Child key does not match this tranche", event.raw.id);
  }
  if (p.bitcoinNetwork !== tranche.bitcoinNetwork) return err("CHILD_KEY_NETWORK_MISMATCH", "Child key uses the wrong Bitcoin network", event.raw.id);
  if (state.participants[p.role] !== event.pubkey) return err("UNAUTHORIZED_CHILD_KEY", "Key signer does not hold the declared frozen role", event.raw.id);
  const existing = state.childKeys?.[p.role];
  if (existing && existing !== p.xOnlyPubkey) return err("CHILD_KEY_ALREADY_SET", "A frozen role cannot replace its child key", event.raw.id);
  const next = cloneState(state);
  next.childKeys = { ...(next.childKeys ?? {}), [p.role]: p.xOnlyPubkey };
  next.eventChain.push(event);
  return { ok: true, state: next };
}

// ── JOIN ──────────────────────────────────────────────────────────────────
// Atomic-funding model: JOIN is a pure ACK. It records the joining
// participant's pubkey on the chain so other clients (and the eventual
// LOCK publisher) can discover them, but it does NOT transition the
// state machine. The trade stays in CREATED until LOCK lands.
//
// Constraints:
//   - Can only JOIN before LOCK (status must still be CREATED).
//   - Buyer JOIN: fills the buyer slot if empty; idempotent if already
//     filled by the same pubkey (e.g. relay echo).
//   - Arbiter JOIN: must be a member of the trade's communityArbiters
//     pool when the pool is non-empty. Empty pool = free-choice arbiter
//     (legacy / pre-community trades).
//   - Cannot JOIN as the initiator's role.

function getActiveRole(state: EscrowState, pubkey: string, atSec: number): Role | null {
  if (getEffectiveParticipantAt(state, Role.BUYER, atSec) === pubkey) return Role.BUYER;
  if (getEffectiveParticipantAt(state, Role.SELLER, atSec) === pubkey) return Role.SELLER;
  if (getEffectiveParticipantAt(state, Role.ARBITER, atSec) === pubkey) return Role.ARBITER;
  return null;
}

function tradeTimeoutSecondsFor(state: EscrowState): number {
  return state.tradeTimeoutSeconds ?? Math.max(1, state.expiresAt - state.createdAt);
}

function hasJoinOrderPayload(payload: JoinPayload): boolean {
  return !!(
    (payload.selectedItems && payload.selectedItems.length > 0)
    || (payload.amountMsats !== undefined && payload.amountMsats > 0)
    || payload.orderFinalizedAt !== undefined
  );
}

function inferLegacyInitialOrderFinalizedAt(payload: JoinPayload, existingHold: unknown): number | undefined {
  if (payload.orderFinalizedAt !== undefined) return payload.orderFinalizedAt;
  if (existingHold) return undefined;

  const selectedItems = payload.selectedItems;
  if (!selectedItems || selectedItems.length === 0) return undefined;

  const selectedTotal = selectedItemsTotalMsats(selectedItems);
  if (selectedTotal <= 0 || payload.amountMsats !== selectedTotal) return undefined;

  // Historical menu/order trades briefly wrote the selected cart on the
  // first JOIN before the explicit orderFinalizedAt field existed. Newer
  // draft carts are follow-up JOINs on an existing hold, so they do not
  // hit this path.
  return payload.joinedAt;
}

function handleJoin(state: EscrowState, event: ParsedEscrowEvent<JoinPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.CREATED) {
    return err("INVALID_STATE", `Cannot JOIN in state ${state.status}`, event.raw.id);
  }

  // Can't join as the initiator's role (that slot is already filled by CREATE)
  if (p.role === state.initiator.role) {
    return err("ROLE_CONFLICT", `Cannot join as ${p.role} — that's the initiator's role`, event.raw.id);
  }

  const activeRolePubkey = getEffectiveParticipantAt(state, p.role, event.timestamp);

  // Idempotent while the hold is live: same pubkey re-joining the same
  // role is a benign relay echo. Once the timed hold expires, a new JOIN
  // from the same pubkey refreshes the reservation.
  if (activeRolePubkey === event.pubkey) {
    if (roleUsesJoinHold(p.role, state.initiator.role) && hasJoinOrderPayload(p)) {
      const next = cloneState(state);
      next.joinHolds = { ...(next.joinHolds ?? {}) };
      const existingHold = next.joinHolds[p.role];
      if (existingHold?.orderFinalizedAt) {
        return err(
          "ORDER_ALREADY_FINALIZED",
          "This order has already been finalized and can no longer be changed",
          event.raw.id,
        );
      }
      const orderFinalizedAt = inferLegacyInitialOrderFinalizedAt(p, existingHold);
      next.joinHolds[p.role] = {
        role: p.role,
        pubkey: event.pubkey,
        joinedAt: existingHold?.joinedAt ?? p.joinedAt,
        expiresAt: existingHold?.expiresAt ?? p.holdExpiresAt ?? joinHoldExpiresAt(p.joinedAt),
        eventId: event.raw.id,
        ...(p.selectedItems && p.selectedItems.length > 0
          ? { selectedItems: p.selectedItems.map(cloneSelectedMenuItem) }
          : {}),
        ...(p.amountMsats !== undefined && p.amountMsats > 0
          ? { amountMsats: p.amountMsats }
          : {}),
        ...(orderFinalizedAt !== undefined
          ? { orderFinalizedAt }
          : {}),
      };
      next.eventChain.push(event);
      return { ok: true, state: next };
    }
    return err("ALREADY_JOINED", "Pubkey is already a participant in this role", event.raw.id);
  }

  // Slot already filled by a different active pubkey — reject. If the
  // only occupant is an expired buyer/seller hold, the new JOIN replaces it.
  if (activeRolePubkey !== null) {
    return err("ROLE_TAKEN", `Role ${p.role} is already filled`, event.raw.id);
  }

  // Same npub cannot sit on both sides of a trade. This is distinct from
  // ROLE_TAKEN: the requested slot may be empty, but the signer already
  // owns another role in the same escrow.
  const existingRole = getActiveRole(state, event.pubkey, event.timestamp);
  if (existingRole !== null) {
    return err("ALREADY_JOINED",
      `Pubkey is already the ${existingRole}; cannot join as ${p.role}`,
      event.raw.id
    );
  }

  // Arbiter must be in the community pool. Legacy no-community chains
  // may still use volunteer arbiters, but a named community with an empty
  // pool means "no trusted arbiter configured," not "anyone may join."
  if (p.role === Role.ARBITER) {
    if (state.community && state.communityArbiters.length === 0) {
      return err("ARBITER_POOL_EMPTY",
        "This community trade has no trusted arbiter pool",
        event.raw.id
      );
    }
    if (state.communityArbiters.length > 0
        && !state.communityArbiters.includes(event.pubkey)) {
      return err("ARBITER_NOT_IN_POOL",
        "Arbiter pubkey is not in this trade's communityArbiters pool",
        event.raw.id
      );
    }
    // v2.3.1 — deterministic-assignment integrity. Membership (above) is not
    // enough: a LEGIT pool member who is NOT the arbiter this escrow id
    // deterministically selects could front-run a JOIN and seat themselves on
    // a trade they want to sway. Only the priority-0 pick may JOIN-seat the slot
    // pre-lock. Backups never JOIN; they step in by VOTING after the grace window
    // (substitution) or on an expired trade (healing), so this can't strand
    // either path. Empty pool ⇒ no pick ⇒ no gate (legacy volunteer-arbiter).
    //
    // 2B prefer-bonded: accept EITHER the bonded-preferred seat OR the legacy
    // pick — the seating client prefers the bonded arbiter, and EVERY client
    // (old or new) accepts BOTH bases, so a mixed-version replay can never
    // diverge on ARBITER_NOT_ASSIGNED (the accept-any-of-N doctrine C1 uses).
    // bondedArbiters is STAMPED into CREATE, so this stays pure + replay-
    // identical. Empty/absent bonded ⇒ the two picks coincide ⇒ byte-identical
    // to the pre-2B single-pick gate. Front-run is still blocked: only the two
    // *computed* picks pass — not any bonded pool member.
    const legacyAssigned = pickArbiterFromPool(
      state.communityArbiters,
      state.id,
      [state.participants[Role.BUYER], state.participants[Role.SELLER]],
    );
    const preferredAssigned = pickPreferredArbiter(
      state.communityArbiters,
      state.bondedArbiters,
      state.id,
      [state.participants[Role.BUYER], state.participants[Role.SELLER]],
    );
    const acceptedArbiters = [preferredAssigned, legacyAssigned].filter(
      (pk): pk is string => !!pk,
    );
    if (acceptedArbiters.length > 0 && !acceptedArbiters.includes(event.pubkey)) {
      return err("ARBITER_NOT_ASSIGNED",
        "Only the deterministically-assigned arbiter (bonded-preferred or legacy pick) may join this trade; backups step in by voting after the grace window",
        event.raw.id
      );
    }
  }

  const next = cloneState(state);
  next.participants[p.role] = event.pubkey;
  next.joinHolds = { ...(next.joinHolds ?? {}) };

  if (roleUsesJoinHold(p.role, state.initiator.role)) {
    const orderFinalizedAt = inferLegacyInitialOrderFinalizedAt(p, undefined);
    next.joinHolds[p.role] = {
      role: p.role,
      pubkey: event.pubkey,
      joinedAt: p.joinedAt,
      expiresAt: p.holdExpiresAt ?? joinHoldExpiresAt(p.joinedAt),
      eventId: event.raw.id,
      ...(p.selectedItems && p.selectedItems.length > 0
        ? { selectedItems: p.selectedItems.map(cloneSelectedMenuItem) }
        : {}),
      ...(p.amountMsats !== undefined && p.amountMsats > 0
        ? { amountMsats: p.amountMsats }
        : {}),
      ...(orderFinalizedAt !== undefined
        ? { orderFinalizedAt }
        : {}),
    };
  } else {
    delete next.joinHolds[p.role];
  }

  // If arbiter is joining with fee terms, record them — sanitized into
  // [0, amount] (C2), same as CREATE/LOCK, so a crafted arbiter JOIN can't
  // seed a junk fee before the LOCK overwrites it.
  if (p.role === Role.ARBITER && p.arbiterFeeMsats !== undefined) {
    next.fees.arbiterMsats = sanitizeArbiterFeeMsats(p.arbiterFeeMsats, state.amountMsats);
  }

  next.eventChain.push(event);
  // No state transition — JOIN is ACK only. LOCK is what moves the trade
  // forward, and it can fire whether or not buyer/arbiter have JOINed
  // (because LOCK carries their pubkeys directly).
  return { ok: true, state: next };
}

// ── LOCK ──────────────────────────────────────────────────────────────────
// Ecash is locked in 2-of-3 SSS. Shares distributed to participants.
//
// Atomic-funding model: LOCK fires directly from CREATED. There is no
// FUNDED state and no READY ceremony. The locker (the side holding
// sats per their category) publishes LOCK as an automatic side-effect
// of detecting their fee-invoice paid.
//
// LOCK is self-describing: it carries buyerPubkey and arbiterPubkey
// (chosen from communityArbiters pool by the locker). The state
// machine populates participants from the payload at lock time.
// If a buyer or arbiter JOIN event landed earlier as an ACK, LOCK's
// pubkey for that role must match the JOINed pubkey.

function handleLock(state: EscrowState, event: ParsedEscrowEvent<LockPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.CREATED) {
    return err("INVALID_STATE", `Cannot LOCK in state ${state.status}`, event.raw.id);
  }

  // The locker must be the seller's pubkey (or buyer for marketplace) —
  // they're a participant from the moment CREATE published, so getRole
  // works without any prior JOIN.
  const lockerRole = getActiveRole(state, event.pubkey, event.timestamp);
  if (!lockerRole) {
    return err("NOT_PARTICIPANT", "Locker is not a participant", event.raw.id);
  }

  // Determine the expected locker role:
  //   marketplace → buyer locks (paying for item)
  //   lending → seller locks (lender funds the loan)
  //   p2p-trade, bill-pay → seller locks (seller has the sats)
  //   raw-escrow / unknown → any participant can lock
  const expectedLocker = state.category === "marketplace" ? Role.BUYER
    : state.category === "lending" ? Role.SELLER
    : (state.category === "p2p-trade" || state.category === "bill-pay") ? Role.SELLER
    : null; // raw escrow: anyone

  if (expectedLocker && lockerRole !== expectedLocker) {
    return err("WRONG_LOCKER",
      "In " + state.category + ", only the " + expectedLocker + " can lock the escrow",
      event.raw.id
    );
  }

  // Atomic-funding: LOCK must name the buyer and arbiter. Validate both.
  if (!p.buyerPubkey || typeof p.buyerPubkey !== "string") {
    return err("MISSING_BUYER_PUBKEY",
      "LOCK payload must carry buyerPubkey (the npub whose payment triggered the lock)",
      event.raw.id
    );
  }
  if (!p.arbiterPubkey || typeof p.arbiterPubkey !== "string") {
    return err("MISSING_ARBITER_PUBKEY",
      "LOCK payload must carry arbiterPubkey (chosen from the communityArbiters pool)",
      event.raw.id
    );
  }

  // If buyer JOINed earlier as ACK, LOCK's buyerPubkey must agree.
  const joinedBuyer = getEffectiveParticipantAt(state, Role.BUYER, event.timestamp, { includeLockGrace: true });
  if (joinedBuyer && joinedBuyer !== p.buyerPubkey) {
    return err("BUYER_PUBKEY_MISMATCH",
      `LOCK buyerPubkey ${p.buyerPubkey.slice(0, 8)}… disagrees with prior JOIN ${joinedBuyer.slice(0, 8)}…`,
      event.raw.id
    );
  }

  // Same for arbiter.
  const joinedArbiter = getEffectiveParticipantAt(state, Role.ARBITER, event.timestamp, { includeLockGrace: true });
  if (joinedArbiter && joinedArbiter !== p.arbiterPubkey) {
    return err("ARBITER_PUBKEY_MISMATCH",
      `LOCK arbiterPubkey ${p.arbiterPubkey.slice(0, 8)}… disagrees with prior JOIN ${joinedArbiter.slice(0, 8)}…`,
      event.raw.id
    );
  }

  // Arbiter must be from the community pool (when one exists).
  if (state.communityArbiters.length > 0
      && !state.communityArbiters.includes(p.arbiterPubkey)) {
    return err("ARBITER_NOT_IN_POOL",
      "LOCK arbiterPubkey is not in this trade's communityArbiters pool",
      event.raw.id
    );
  }

  // NOTE: C1 (deterministic-assignment gate on LOCK) is intentionally NOT
  // enforced here in v3.3 — see INVARIANTS.md. A naive recompute would reject
  // genuine pre-v0.7.2 (no-exclusion builder) chains as ARBITER_NOT_ASSIGNED
  // on replay (not a benign code → whole chain unloadable, funds stranded).
  // It moves to the pool-integrity cluster (C1+C6+C7) with a backward-
  // compatible accept-either-basis fix. The JOIN-side gate (handleJoin ~506)
  // and the matches-prior-JOIN check (ARBITER_PUBKEY_MISMATCH above) stand.

  // The buyer and arbiter must be distinct from the seller (and each other).
  const sellerPk = state.participants[Role.SELLER];
  if ((sellerPk && (p.buyerPubkey === sellerPk || p.arbiterPubkey === sellerPk))
      || p.buyerPubkey === p.arbiterPubkey) {
    return err("DUPLICATE_PARTICIPANT",
      "LOCK assigns the same pubkey to multiple roles",
      event.raw.id
    );
  }

  // Validate shares — must have exactly 3, one per participant
  if (!p.shares || p.shares.length !== 3) {
    return err("INVALID_SHARES", "LOCK must include exactly 3 SSS shares", event.raw.id);
  }

  const selectedItems = p.selectedItems?.map(cloneSelectedMenuItem);
  let expectedLockAmountMsats = state.amountMsats;

  if (state.items && state.items.length > 0) {
    if (!selectedItems || selectedItems.length === 0) {
      return err(
        "MISSING_SELECTED_ITEMS",
        "LOCK on a menu listing must include selectedItems",
        event.raw.id,
      );
    }

    const menuById = new Map(state.items.map(item => [item.id, item]));
    const seen = new Set<string>();
    for (const selected of selectedItems) {
      const menuItem = menuById.get(selected.itemId);
      if (!menuItem) {
        return err(
          "UNKNOWN_MENU_ITEM",
          `LOCK selected menu item ${selected.itemId} is not on this listing`,
          event.raw.id,
        );
      }
      if (seen.has(selected.itemId)) {
        return err("DUPLICATE_MENU_ITEM", "LOCK selectedItems must merge quantities per item", event.raw.id);
      }
      seen.add(selected.itemId);
      if (menuItem.label !== selected.label) {
        return err(
          "MENU_ITEM_MISMATCH",
          "LOCK selectedItems must snapshot the listing menu item label",
          event.raw.id,
        );
      }
      // Anti-drain (#6): a selected quantity must be a whole number >= 1, and
      // may not exceed the seller's per-button cap. Without this a malicious
      // LOCK could carry quantity 0 / negative / absurdly large and drain the
      // seller's locked liquidity. Undefined maxQuantity stays unbounded.
      if (!Number.isInteger(selected.quantity) || selected.quantity < 1) {
        return err(
          "QUANTITY_INVALID",
          `LOCK quantity for ${menuItem.label} must be a whole number of at least 1`,
          event.raw.id,
        );
      }
      if (menuItem.maxQuantity !== undefined && selected.quantity > menuItem.maxQuantity) {
        return err(
          "QUANTITY_EXCEEDED",
          `LOCK quantity ${selected.quantity} exceeds the ${menuItem.maxQuantity}-unit limit on ${menuItem.label}`,
          event.raw.id,
        );
      }
      if (isAmountBracket(menuItem)) {
        const minAmount = menuItem.minAmountMsats ?? menuItem.amountMsats;
        const maxAmount = menuItem.maxAmountMsats ?? menuItem.amountMsats;
        if (selected.quantity !== 1) {
          return err(
            "MENU_ITEM_MISMATCH",
            "LOCK selected bracket items must use quantity 1",
            event.raw.id,
          );
        }
        if (selected.amountMsats < minAmount || selected.amountMsats > maxAmount) {
          return err(
            "MENU_ITEM_MISMATCH",
            "LOCK selected bracket amount must be within the listing min/max",
            event.raw.id,
          );
        }
        if (selected.kind !== undefined && selected.kind !== menuItem.kind) {
          return err(
            "MENU_ITEM_MISMATCH",
            "LOCK selectedItems must snapshot the listing menu item kind",
            event.raw.id,
          );
        }
        if (selected.fiatCurrency !== undefined && selected.fiatCurrency !== menuItem.fiatCurrency) {
          return err(
            "MENU_ITEM_MISMATCH",
            "LOCK selectedItems must keep the listing fiat currency",
            event.raw.id,
          );
        }
      } else if (menuItem.amountMsats !== selected.amountMsats) {
        return err(
          "MENU_ITEM_MISMATCH",
          "LOCK selectedItems must snapshot the listing menu item amount",
          event.raw.id,
        );
      }
    }

    const selectorRole = menuSelectorRoleFor(state.category);
    if (expectedLocker && expectedLocker !== selectorRole) {
      const finalizedHold = state.joinHolds?.[selectorRole];
      if (
        !finalizedHold ||
        finalizedHold.expiresAt + JOIN_HOLD_LOCK_GRACE_SECONDS <= event.timestamp ||
        !finalizedHold.orderFinalizedAt
      ) {
        return err(
          "ORDER_NOT_FINALIZED",
          `LOCK must wait for the ${selectorRole} to finalize the order`,
          event.raw.id,
        );
      }
      if (selectedItemsKey(finalizedHold.selectedItems) !== selectedItemsKey(selectedItems)) {
        return err(
          "ORDER_MISMATCH",
          "LOCK selectedItems must match the finalized order",
          event.raw.id,
        );
      }
    }

    expectedLockAmountMsats = selectedItemsTotalMsats(selectedItems);
    if (expectedLockAmountMsats <= 0) {
      return err("INVALID_MENU_TOTAL", "LOCK selectedItems must total a positive amount", event.raw.id);
    }
  } else if (selectedItems && selectedItems.length > 0) {
    return err(
      "UNEXPECTED_SELECTED_ITEMS",
      "LOCK selectedItems can only be used on menu listings",
      event.raw.id,
    );
  }

  // Current browser/Fedi milestone: 2-way amount sum.
  // Platform/ambient fee policy is no longer part of LOCK math. The
  // reconstructed ecash token settles as one payload until a dedicated
  // multi-party payout path exists.
  // We accept old LOCKs (pre-.71) that may still carry platformFeeMsats
  // in their payload by checking for either sum shape.
  // INVARIANT(arbiter-fee-bounds) — v3.3 (C2): the fee is bounded by SANITIZING
  // at the writes into state.fees.arbiterMsats (see sanitizeArbiterFeeMsats),
  // never by rejecting the LOCK. The reducer runs AFTER the ecash is spent and
  // the LOCK is published, so a reject here would strand the locker; coercion
  // keeps the payout balanced without that hazard. The sum check below is
  // unchanged.
  const seller = p.sellerReceivesMsats;
  const arbiter = p.arbiterFeeMsats;
  const legacyPlatform = (p as unknown as { platformFeeMsats?: number }).platformFeeMsats;
  const newSum = seller + arbiter;
  const legacySum = newSum + (typeof legacyPlatform === "number" ? legacyPlatform : 0);
  const ok = newSum === expectedLockAmountMsats || legacySum === expectedLockAmountMsats;
  if (!ok) {
    return err("AMOUNT_MISMATCH",
      `Fee split (${newSum}) doesn't match escrow amount (${expectedLockAmountMsats})`,
      event.raw.id,
      { total: newSum, expected: expectedLockAmountMsats }
    );
  }

  const next = cloneState(state);
  next.status = EscrowStatus.LOCKED;
  next.amountMsats = expectedLockAmountMsats;
  next.lock.notesHash = p.notesHash;
  next.lock.lockedAt = p.lockedAt;
  next.lock.selectedItems = selectedItems;
  // Holder-only shares: carry the share policy onto state so the claim path can
  // branch (holder-only reconstruct vs legacy dual-encrypted). Absent ⇒ legacy.
  next.lock.sharePolicy = p.sharePolicy;
  // Arbiter substitution: carry the pooled-arbiter-share marker so the vote
  // path knows backups are eligible here. Absent ⇒ assigned-arbiter-only.
  next.lock.arbiterPoolShare = p.arbiterPoolShare;
  // v2.3: carry the locker's committed substitution grace ceiling so
  // substitutionEligibleAt replays it identically everywhere. Only persist a
  // finite value (absent ⇒ legacy 4h default in the eligibility math).
  if (typeof p.substitutionGraceSeconds === "number" && Number.isFinite(p.substitutionGraceSeconds)) {
    next.lock.substitutionGraceSeconds = clampSubstitutionGraceSeconds(p.substitutionGraceSeconds);
  }
  next.listingExpiresAt = state.listingExpiresAt ?? state.expiresAt;
  next.tradeTimeoutSeconds = tradeTimeoutSecondsFor(state);
  next.expiresAt = p.lockedAt + next.tradeTimeoutSeconds;

  // Atomic-funding: LOCK populates buyer + arbiter slots. If they were
  // already set by prior JOIN ACKs, this is a no-op (consistency was
  // checked above). If they were null, this is the first time the chain
  // sees those pubkeys.
  next.participants[Role.BUYER] = p.buyerPubkey;
  next.participants[Role.ARBITER] = p.arbiterPubkey;

  // Store encrypted shares — dual-encryption only (legacy format dropped
  // in v0.1.60). Each share object is stored keyed by shareIndex so any
  // participant can later look up any share and decrypt via encryptedFor.
  for (const share of p.shares) {
    next.lock.shares.set(String(share.shareIndex), share);
  }

  // PR 3: capture the revealed payment handle when present. The whole
  // LockPayload is NIP-44-protected (encryptLock), so this cleartext
  // only flows to the locker in production until the broader 3-recipient
  // LOCK encryption fanout lands; in dev mode it's plaintext on relays
  // by design. The render layer (handleDisplayForViewer) is what gates
  // the cleartext display on viewer context regardless of where it sits
  // in local state.
  if (p.handle) {
    next.lock.handle = {
      id: p.handleId ?? null,
      value: p.handle,
      rail: p.rail ?? null,
      // v0.6.5: networks carried in the encrypted envelope. Empty
      // array means "seller didn't tag any" — render layer hides the
      // chip row; non-empty means show them alongside the cleartext.
      networks: Array.isArray(p.handleNetworks) ? p.handleNetworks : [],
    };
  }

  // v0.1.71: legacy platformFeeMsats writeback.
  // New LOCKs don't carry platformFeeMsats (it's parked from the schema
  // as platform fees move to LN collection). Old LOCKs (pre-.71) still
  // do — read it via the legacy escape hatch so replays of historical
  // chains preserve audit info. Defaults to 0 for new LOCKs.
  next.fees.platformMsats = legacyPlatform ?? 0;
  // INVARIANT(arbiter-fee-bounds) — v3.3 (C2): sanitize the locker-chosen fee
  // into [0, amount] (integer) on the way into state rather than rejecting the
  // LOCK. expectedLockAmountMsats is the just-validated lock amount.
  next.fees.arbiterMsats = sanitizeArbiterFeeMsats(p.arbiterFeeMsats, expectedLockAmountMsats);

  next.eventChain.push(event);
  return { ok: true, state: next };
}

// ── VOTE ──────────────────────────────────────────────────────────────────
// A participant casts their vote. Does NOT transition state directly —
// a separate RESOLVE event is needed when 2-of-3 threshold is met.

function handleVote(state: EscrowState, event: ParsedEscrowEvent<VotePayload>): TransitionResult {
  const p = event.payload;

  // v0.1.66.26: accept EXPIRED in addition to LOCKED so post-expiry
  // healing votes can be recorded. Mechanism A relies on this.
  if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) {
    return err("INVALID_STATE", `Cannot VOTE in state ${state.status}`, event.raw.id);
  }
  const isHealing = state.status === EscrowStatus.EXPIRED;

  let voterRole = getRole(state, event.pubkey);
  if (!voterRole) {
    // Arbiter substitution (DESIGN-arbiter-substitution.md): on a pooled-share
    // lock, a backup from the deterministic priority order may cast the
    // ARBITER vote once the assigned arbiter's grace window has lapsed.
    // Everyone else stays out.
    if (p.role !== Role.ARBITER || !state.lock.arbiterPoolShare) {
      return err("NOT_PARTICIPANT", "Voter is not a participant", event.raw.id);
    }
    if (arbiterVotePriority(state, event.pubkey) === null) {
      return err("NOT_POOL_ARBITER",
        "Voter is not in this escrow's arbiter priority order", event.raw.id);
    }
    if (isHealing) {
      // HEALING substitution (the disputed-expiry limbo fix): an expired,
      // unresolved trade's rescue vote previously depended on the ONE
      // participant who hadn't voted — in a 1-1 dispute that is exactly the
      // absent assigned arbiter, the same single point of failure that
      // stranded the trade. Any pool backup may now cast the healing vote,
      // REFUND ONLY (healing's sole legitimate outcome), no grace floor —
      // the assigned arbiter had the trade's entire life to act.
      //
      // v2.9: that REFUND-only rule is correct for ABANDONMENT, but a
      // performance CONTEST — a standing RELEASE from the non-locker — is not
      // abandonment. There a backup rules on MERIT (RELEASE or REFUND) with no
      // grace floor (still post-expiry, assigned arbiter is gone), and the
      // expiry auto-refund is suppressed (isPerformanceContest), so this ruling
      // is the resolution. Without this carve-out the constraint would force a
      // refund to a ghosting locker.
      if (!isPerformanceContest(state) && p.outcome !== Outcome.REFUND) {
        return err("INVALID_HEAL_OUTCOME",
          "Healing votes on an expired trade must be REFUND", event.raw.id);
      }
    } else {
      const buyerVote = state.votes[Role.BUYER];
      const sellerVote = state.votes[Role.SELLER];
      const bothVoted = buyerVote !== undefined && sellerVote !== undefined;
      // v2.9: a one-sided standing RELEASE (locker silent) is a valid contest a
      // BACKUP may rule on — substitutionEligibleAt is non-null then (via
      // disputeStartAt's second arm). Two-sided disputes are unchanged.
      if (!bothVoted && oneSidedEscalationAt(state) === null) {
        return err("ARBITER_TOO_EARLY",
          "Arbiter can only vote after both buyer and seller have voted", event.raw.id);
      }
      if (bothVoted && buyerVote === sellerVote) {
        return err("ARBITER_NOT_NEEDED",
          "Arbiter vote not needed — buyer and seller agree", event.raw.id);
      }
      const eligibleAt = substitutionEligibleAt(state);
      if (eligibleAt === null || event.raw.created_at < eligibleAt) {
        return err("SUBSTITUTE_TOO_EARLY",
          `Backup arbiter becomes eligible at ${eligibleAt ?? "?"} — the assigned arbiter still has the floor`,
          event.raw.id);
      }
    }
    voterRole = Role.ARBITER;
  }

  // Role in event must match actual role
  if (voterRole !== p.role) {
    return err("ROLE_MISMATCH",
      `Signer has role ${voterRole} but event claims ${p.role}`,
      event.raw.id
    );
  }

  // Can't vote twice — checked per PUBKEY, not per role-slot. With arbiter
  // substitution, several pool arbiters may legitimately have votes in the
  // chain (the slot is derived by priority below), and the ASSIGNED arbiter
  // must remain able to vote even after a backup filled the slot first. For
  // buyer/seller this is equivalent to the old votes[role] check (role ↔
  // pubkey is 1:1 for them).
  const alreadyVoted = state.eventChain.some(
    (ve) => ve.kind === EscrowEventKind.VOTE && ve.pubkey === event.pubkey,
  );
  if (alreadyVoted) {
    return err("ALREADY_VOTED", `${voterRole} has already voted`, event.raw.id);
  }

  // Arbiter can only vote after buyer AND seller have voted AND they disagree.
  // v0.1.66.26: skip this ordering constraint during expiry healing.
  // Healing votes are always REFUND and any participant (including the
  // arbiter) should be able to kick off recovery — waiting for buyer
  // and seller to vote first defeats the purpose when they're the ones
  // who are offline.
  if (voterRole === Role.ARBITER && !isHealing) {
    const buyerVote = state.votes[Role.BUYER];
    const sellerVote = state.votes[Role.SELLER];
    const bothVoted = buyerVote !== undefined && sellerVote !== undefined;

    if (!bothVoted) {
      // v2.9: a silent locker against a standing RELEASE no longer freezes the
      // arbiter. Once the escalation window opens (always before expiry — the
      // half-life floor guarantees it) the assigned arbiter MAY rule, giving a
      // performer a path to win against a ghosting locker. Outside that window
      // the old "wait for both" rule still holds.
      const escalateAt = oneSidedEscalationAt(state);
      if (escalateAt === null || event.raw.created_at < escalateAt) {
        return err("ARBITER_TOO_EARLY",
          "Arbiter can only vote after both buyer and seller have voted",
          event.raw.id
        );
      }
    } else if (buyerVote === sellerVote) {
      return err("ARBITER_NOT_NEEDED",
        "Arbiter vote not needed — buyer and seller agree",
        event.raw.id
      );
    }
  }

  // Holder-only shares: a carried share envelope must bind correctly — its
  // shareIndex must be the voter's holder index, its outcome must match the
  // vote, its notesHash must match the lock, and it must route to the engine
  // recipient for that outcome. A malformed / misrouted share is rejected (a
  // well-behaved client always produces a valid one). Absent envelopes (legacy
  // votes, expiry-heal) skip this entirely.
  if (p.shareEnvelope) {
    const reason = validateVoteShareEnvelope(
      p.shareEnvelope, state, voterRole, p.outcome, state.lock.notesHash,
    );
    if (reason) {
      return err("INVALID_SHARE_ENVELOPE", `Vote share envelope invalid: ${reason}`, event.raw.id);
    }
  }

  const next = cloneState(state);
  next.eventChain.push(event);
  if (voterRole === Role.ARBITER && state.lock.arbiterPoolShare) {
    // Pooled-share lock: derive the ARBITER slot from ALL arbiter votes in the
    // chain — lowest priority index wins (assigned = 0 always trumps backups).
    // Pure over the chain SET, so replay converges regardless of arrival
    // order; a superseded backup vote stays in the chain and its vote-carried
    // share envelope remains usable by the winner at claim. Applies to HEALING
    // votes too, so assigned + backup both healing converge on the same slot.
    let best: { priority: number; outcome: Outcome; pubkey: string } | null = null;
    for (const ve of next.eventChain) {
      if (ve.kind !== EscrowEventKind.VOTE) continue;
      const vp = ve.payload as VotePayload | undefined;
      if (!vp || vp.role !== Role.ARBITER) continue;
      const pr = arbiterVotePriority(next, ve.pubkey);
      if (pr === null) continue;
      if (!best || pr < best.priority) {
        best = { priority: pr, outcome: vp.outcome, pubkey: ve.pubkey };
      }
    }
    if (best) {
      next.votes[Role.ARBITER] = best.outcome;
      next.actingArbiter = best.pubkey;
    }
  } else {
    next.votes[voterRole] = p.outcome;
    if (voterRole === Role.ARBITER) next.actingArbiter = event.pubkey;
  }

  // NOTE: State stays LOCKED. A separate RESOLVE event is needed.
  // This is intentional — the RESOLVE event is the one that triggers
  // the state transition, and it can be published by any participant
  // who observes that 2-of-3 threshold is met.

  return { ok: true, state: next };
}

// ── RESOLVE ───────────────────────────────────────────────────────────────
// Published when 2-of-3 vote threshold is met. Transitions LOCKED → APPROVED.

function handleResolve(state: EscrowState, event: ParsedEscrowEvent<ResolvePayload>): TransitionResult {
  const p = event.payload;

  // v0.1.66.26: accept EXPIRED in addition to LOCKED so healing votes
  // that meet 2-of-3 threshold can produce a RESOLVE event and
  // transition EXPIRED → APPROVED.
  if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) {
    return err("INVALID_STATE", `Cannot RESOLVE in state ${state.status}`, event.raw.id);
  }

  // Verify the claimed outcome matches actual votes
  const threshold = checkVoteThreshold(state.votes);
  if (!threshold.resolved) {
    return err("THRESHOLD_NOT_MET",
      "Cannot resolve — 2-of-3 vote threshold not met",
      event.raw.id,
      { votes: state.votes }
    );
  }

  if (threshold.outcome !== p.outcome) {
    return err("OUTCOME_MISMATCH",
      `Event claims ${p.outcome} but votes resolve to ${threshold.outcome}`,
      event.raw.id
    );
  }

  // Verify majority claims
  const majoritySet = new Set(p.majority);
  const actualSet = new Set(threshold.majority);
  if (majoritySet.size !== actualSet.size || ![...majoritySet].every(r => actualSet.has(r))) {
    return err("MAJORITY_MISMATCH",
      "Claimed majority doesn't match actual vote majority",
      event.raw.id
    );
  }

  const next = cloneState(state);
  next.status = EscrowStatus.APPROVED;
  next.resolvedOutcome = p.outcome;
  next.resolvedMajority = p.majority;
  next.resolvedAt = p.resolvedAt;
  next.eventChain.push(event);

  return { ok: true, state: next };
}

// ── CLAIM ─────────────────────────────────────────────────────────────────
// Winner reconstructs ecash from 2-of-3 shares and publishes proof.

function handleClaim(state: EscrowState, event: ParsedEscrowEvent<ClaimPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.APPROVED) {
    return err("INVALID_STATE", `Cannot CLAIM in state ${state.status}`, event.raw.id);
  }

  if (!state.resolvedOutcome) {
    return err("NO_OUTCOME", "Cannot claim — no resolved outcome", event.raw.id);
  }

  // Verify the claimer is the correct winner (uses category-aware getWinner)
  const winner = getWinner(state);
  const claimerRole = getRole(state, event.pubkey);

  if (!winner) {
    return err("NO_WINNER", "Cannot determine winner", event.raw.id);
  }

  if (claimerRole !== winner.role) {
    return err("WRONG_CLAIMER",
      `Only ${winner.role} can claim on ${state.resolvedOutcome} outcome`,
      event.raw.id,
      { claimerRole, expectedWinner: winner.role, outcome: state.resolvedOutcome }
    );
  }

  // Verify notes hash matches the original lock
  if (state.lock.notesHash && p.notesHashVerification !== state.lock.notesHash) {
    return err("NOTES_HASH_MISMATCH",
      "Reconstructed notes hash doesn't match locked notes hash",
      event.raw.id
    );
  }

  const next = cloneState(state);
  next.status = EscrowStatus.CLAIMED;
  // SECURITY: store the role derived from the signing pubkey, not the
  // self-attested role in the payload. A participant signing a CLAIM
  // cannot lie about being someone else here.
  next.claim.claimerRole = claimerRole;
  next.claim.claimedAt = p.claimedAt;
  next.eventChain.push(event);

  return { ok: true, state: next };
}

// ── COMPLETE ──────────────────────────────────────────────────────────────
// Final confirmation — ecash has been redeemed.

function handleComplete(state: EscrowState, event: ParsedEscrowEvent<CompletePayload>): TransitionResult {
  if (state.status !== EscrowStatus.CLAIMED) {
    return err("INVALID_STATE", `Cannot COMPLETE in state ${state.status}`, event.raw.id);
  }

  const next = cloneState(state);
  next.status = EscrowStatus.COMPLETED;
  next.completedAt = event.payload.completedAt;
  next.eventChain.push(event);

  return { ok: true, state: next };
}

// ── CANCEL ────────────────────────────────────────────────────────────────
// Cancel before lock. Only initiator can cancel, and only before LOCKED.

function handleCancel(state: EscrowState, event: ParsedEscrowEvent<CancelPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.CREATED) {
    return err("INVALID_STATE",
      `Cannot CANCEL in state ${state.status} — sats may be locked`,
      event.raw.id
    );
  }

  // Only the initiator can cancel
  if (event.pubkey !== state.initiator.pubkey) {
    return err("NOT_INITIATOR",
      "Only the trade initiator can cancel",
      event.raw.id
    );
  }

  const next = cloneState(state);
  next.status = EscrowStatus.CANCELLED;
  next.cancelledAt = p.cancelledAt;
  next.eventChain.push(event);

  return { ok: true, state: next };
}

// ── SUBSCRIBE ─────────────────────────────────────────────────────────────
// Buyer adds subscription terms to an existing escrow.
// Published after CREATE, before LOCK. Adds periodic release metadata.

function handleSubscribe(state: EscrowState, event: ParsedEscrowEvent<SubscribePayload>): TransitionResult {
  const p = event.payload;

  // Only before lock
  if (state.status !== EscrowStatus.CREATED) {
    return err("INVALID_STATE", `Cannot SUBSCRIBE in state ${state.status}`, event.raw.id);
  }

  // Only participants can subscribe
  const role = getRole(state, event.pubkey);
  if (!role) {
    return err("NOT_PARTICIPANT", "Only participants can add subscription terms", event.raw.id);
  }

  // Can't subscribe twice
  if (state.subscription) {
    return err("ALREADY_SUBSCRIBED", "Subscription terms already set", event.raw.id);
  }

  // Validate total amount matches
  const totalAmount = p.totalPeriods * p.periodAmountMsats;
  if (totalAmount !== state.amountMsats) {
    return err("AMOUNT_MISMATCH",
      `Subscription total (${p.totalPeriods} × ${p.periodAmountMsats} = ${totalAmount}) doesn't match escrow amount (${state.amountMsats})`,
      event.raw.id
    );
  }

  const next = cloneState(state);

  // Compute period start times
  const periodStartTimes: number[] = [];
  for (let i = 0; i < p.totalPeriods; i++) {
    periodStartTimes.push(p.startsAt + i * p.periodDurationSeconds);
  }

  next.subscription = {
    totalPeriods: p.totalPeriods,
    periodAmountMsats: p.periodAmountMsats,
    periodDurationSeconds: p.periodDurationSeconds,
    periodStartTimes,
    periodStatuses: Array(p.totalPeriods).fill("pending"),
    releasedCount: 0,
    disputedCount: 0,
    totalReleasedMsats: 0,
    startsAt: p.startsAt,
  };

  next.eventChain.push(event);
  return { ok: true, state: next };
}

// ── PERIOD_RELEASE ────────────────────────────────────────────────────────
// Release one period's sats to the seller. Can be triggered by:
//   - Seller claiming after period expires (happy path)
//   - Arbiter auto-releasing (scheduler)
//   - Buyer releasing early (generous)

function handlePeriodRelease(state: EscrowState, event: ParsedEscrowEvent<PeriodReleasePayload>): TransitionResult {
  const p = event.payload;

  // Must be LOCKED
  if (state.status !== EscrowStatus.LOCKED) {
    return err("INVALID_STATE", `Cannot release period in state ${state.status}`, event.raw.id);
  }

  // Must have subscription
  if (!state.subscription) {
    return err("NOT_SUBSCRIPTION", "This escrow is not a subscription", event.raw.id);
  }

  const sub = state.subscription;

  // Validate period index
  if (p.periodIndex < 0 || p.periodIndex >= sub.totalPeriods) {
    return err("INVALID_PERIOD", `Period ${p.periodIndex} out of range (0-${sub.totalPeriods - 1})`, event.raw.id);
  }

  // Period must not already be released
  if (sub.periodStatuses[p.periodIndex] === "released") {
    return err("ALREADY_RELEASED", `Period ${p.periodIndex} already released`, event.raw.id);
  }

  // Period must not be disputed (use normal VOTE flow for disputes)
  if (sub.periodStatuses[p.periodIndex] === "disputed") {
    return err("PERIOD_DISPUTED", `Period ${p.periodIndex} is disputed — resolve via voting`, event.raw.id);
  }

  // Only participants can release
  const role = getRole(state, event.pubkey);
  if (!role) {
    return err("NOT_PARTICIPANT", "Only participants can release periods", event.raw.id);
  }

  // Validate amount matches period amount
  if (p.amountMsats !== sub.periodAmountMsats) {
    return err("AMOUNT_MISMATCH",
      `Release amount ${p.amountMsats} doesn't match period amount ${sub.periodAmountMsats}`,
      event.raw.id
    );
  }

  const next = cloneState(state);
  const nextSub = next.subscription!;

  // Mark period as released
  nextSub.periodStatuses[p.periodIndex] = "released";
  nextSub.releasedCount++;
  nextSub.totalReleasedMsats += p.amountMsats;

  next.eventChain.push(event);

  // Check if all periods are released → COMPLETED
  if (nextSub.releasedCount >= nextSub.totalPeriods) {
    next.status = EscrowStatus.COMPLETED;
    next.completedAt = p.releasedAt;
  }

  return { ok: true, state: next };
}

// ── CHAT ──────────────────────────────────────────────────────────────────
// Chat messages don't change state but are part of the escrow record.

function handleChat(state: EscrowState, event: ParsedEscrowEvent<ChatPayload>): TransitionResult {
  // Only effective participants can chat. In CREATED, buyer/seller JOIN slots
  // expire if they do not lock in time, so a stale raw participant pubkey must
  // not keep reading or sending on a relisted trade.
  if (getActiveRole(state, event.pubkey, event.timestamp) === null) {
    return err("NOT_PARTICIPANT", "Only participants can send chat messages", event.raw.id);
  }

  // Can't chat in terminal states
  if (TERMINAL_STATES.has(state.status)) {
    return err("TRADE_CLOSED", "Cannot chat — trade is in terminal state", event.raw.id);
  }

  const next = cloneState(state);
  next.chatMessages.push(event as ParsedEscrowEvent<ChatPayload>);
  // Don't add to eventChain — chat doesn't affect state transitions
  return { ok: true, state: next };
}

// ── PREMIUM ───────────────────────────────────────────────────────────────
// Arbiter-premium notes (task #53 E1) don't change state but ride the
// trade's channel so the seated arbiter (a subscriber by construction)
// receives them. Unlike CHAT this is ACCEPTED in terminal states —
// premiums are paid at settlement, when the trade is already COMPLETED.

function handlePremium(state: EscrowState, event: ParsedEscrowEvent<PremiumPayload>): TransitionResult {
  // Self-dedup: PREMIUM never enters eventChain, so applyEvent's
  // chain-based idempotency guard can't catch relay echoes of it.
  const existing = state.premiumNotes ?? [];
  if (existing.some(e => e.raw.id === event.raw.id)) {
    return { ok: true, state };
  }

  // Only the trade principals pay premiums. Raw participants (not the
  // effective-at-timestamp view): by settlement the seats are final, and
  // join-hold expiry semantics don't apply post-terminal.
  const buyer = state.participants[Role.BUYER];
  const seller = state.participants[Role.SELLER];
  if (event.pubkey !== buyer && event.pubkey !== seller) {
    return err("NOT_PARTICIPANT", "Only trade principals can send an arbiter premium", event.raw.id);
  }

  const next = cloneState(state);
  next.premiumNotes = [...existing, event];
  // Don't add to eventChain — premium is non-consensus, like chat.
  return { ok: true, state: next };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN STATE MACHINE — applyEvent
// ══════════════════════════════════════════════════════════════════════════

/**
 * Apply a single parsed event to the current escrow state.
 *
 * For CREATE events, pass `null` as the state — it bootstraps from scratch.
 * For all other events, pass the current state.
 *
 * Returns either a new state or a validation error.
 * NEVER mutates the input state.
 */
export function applyEvent(
  state: EscrowState | null,
  event: ParsedEscrowEvent
): TransitionResult {

  // ── CREATE is special — bootstraps from nothing ──
  if (event.kind === EscrowEventKind.CREATE) {
    if (state !== null) {
      return err("DUPLICATE_CREATE", "CREATE event received but escrow already exists", event.raw.id);
    }
    return handleCreate(event as ParsedEscrowEvent<CreatePayload>);
  }

  // ── All other events require existing state ──
  if (state === null) {
    return err("NO_STATE", "Non-CREATE event received but no escrow state exists", event.raw.id);
  }

  // ── PREMIUM bypasses terminal/expiry/chain checks entirely ──
  // Premiums are paid AT settlement: COMPLETED is truly-terminal (rejected
  // below) and the expiry auto-flip isn't COMPLETED-aware, so a premium
  // routed through the normal gauntlet would either be dropped or flip a
  // COMPLETED trade to EXPIRED. It is non-consensus (never touches
  // eventChain or status) and self-dedups, so the early dispatch is safe.
  if (event.kind === EscrowEventKind.PREMIUM) {
    return handlePremium(state, event as ParsedEscrowEvent<PremiumPayload>);
  }

  // ── SECURITY: event-ID idempotency ──
  // Nostr is eventual-consistency by design: the same signed event can
  // arrive multiple times across relays, can be re-emitted on
  // reconnect, or can be replayed by a misbehaving relay. Without this
  // guard, the eventChain would accumulate duplicates and any handler
  // side-effects (vote tallying, share consumption) would be evaluated
  // more than once. Handler-level checks like ALREADY_VOTED catch some
  // cases but not all; the cleanest defense is to short-circuit here
  // on a duplicate event id and return the existing state unchanged.
  if (state.eventChain.some((e) => e.raw.id === event.raw.id)) {
    return { ok: true, state };
  }

  // ── Check terminal ──
  // v0.1.66.26: use TRULY_TERMINAL_STATES so EXPIRED events can heal.
  // EXPIRED is transient; healing votes must be able to reach the
  // handlers. COMPLETED and CANCELLED remain unrecoverable.
  if (TRULY_TERMINAL_STATES.has(state.status)) {
    return err("TERMINAL_STATE",
      `Escrow is in terminal state ${state.status} — no further events accepted`,
      event.raw.id
    );
  }

  // ── Check expiry ──
  // v0.1.66.26: previously, any post-expiry event auto-expired the
  // state and returned WITHOUT dispatching to the handler. That made
  // Mechanism A (healing votes) impossible — VOTE events arriving past
  // expiry were swallowed and never recorded.
  //
  // New behavior:
  //   - If state is ALREADY EXPIRED: skip the auto-expire clause and
  //     proceed to dispatch. Handlers (handleVote, handleResolve) now
  //     accept EXPIRED and can record healing votes.
  //   - If state is not-yet-EXPIRED and event is a VOTE past deadline:
  //     flip to EXPIRED but continue to the handler so the vote is
  //     recorded in the same apply call (no "lost first heal vote").
  //   - For any other event past deadline on a non-expired state:
  //     keep the original flip-and-return behavior.
  const activatesDeferredTranche = state.tranche
    && (event.kind === EscrowEventKind.LOCK || event.kind === EscrowEventKind.CHILD_KEY);
  if (!activatesDeferredTranche && event.timestamp > state.expiresAt && state.status !== EscrowStatus.APPROVED && state.status !== EscrowStatus.CLAIMED) {
    if (state.status === EscrowStatus.EXPIRED) {
      // Already expired — fall through to dispatch (healing path).
    } else if (event.kind === EscrowEventKind.VOTE) {
      // First post-expiry event is a VOTE: flip state and let handleVote run.
      state = cloneState(state);
      state.status = EscrowStatus.EXPIRED;
      // fall through to dispatch
    } else {
      // Non-vote event past deadline on a live state: standard auto-expire.
      const next = cloneState(state);
      next.status = EscrowStatus.EXPIRED;
      return { ok: true, state: next };
    }
  }

  // ── Check event chain continuity (soft — relay events arrive out of order) ──
  // In a multi-relay async environment, events often arrive before their
  // predecessors. The handler-level checks (status, votes, roles) are the
  // real validation. Chain ordering is a convenience for replay, not a
  // security boundary. We log mismatches but don't reject.
  if (event.kind !== EscrowEventKind.CHAT) {
    const lastEvent = state.eventChain[state.eventChain.length - 1];
    if (lastEvent && event.prevEventId !== lastEvent.raw.id) {
      const referencedInChain = state.eventChain.some(e => e.raw.id === event.prevEventId);
      if (!referencedInChain && event.prevEventId !== null) {
        // Soft warning — proceed to handler validation instead of rejecting
        // The handler will catch any real issues (wrong status, missing votes, etc.)
        console.debug(
          `[escrow] Chain gap: event ${event.raw.id.slice(0, 8)} refs ` +
          `${event.prevEventId?.slice(0, 8)} but chain tip is ${lastEvent.raw.id.slice(0, 8)} — allowing`
        );
      }
    }
  }

  // ── Dispatch to handler ──
  switch (event.kind) {
    case EscrowEventKind.JOIN:
      return handleJoin(state, event as ParsedEscrowEvent<JoinPayload>);
    case EscrowEventKind.LOCK:
      return handleLock(state, event as ParsedEscrowEvent<LockPayload>);
    case EscrowEventKind.VOTE:
      return handleVote(state, event as ParsedEscrowEvent<VotePayload>);
    case EscrowEventKind.RESOLVE:
      return handleResolve(state, event as ParsedEscrowEvent<ResolvePayload>);
    case EscrowEventKind.CLAIM:
      return handleClaim(state, event as ParsedEscrowEvent<ClaimPayload>);
    case EscrowEventKind.COMPLETE:
      return handleComplete(state, event as ParsedEscrowEvent<CompletePayload>);
    case EscrowEventKind.CANCEL:
      return handleCancel(state, event as ParsedEscrowEvent<CancelPayload>);
    case EscrowEventKind.CHAT:
      return handleChat(state, event as ParsedEscrowEvent<ChatPayload>);
    case EscrowEventKind.SUBSCRIBE:
      return handleSubscribe(state, event as ParsedEscrowEvent<SubscribePayload>);
    case EscrowEventKind.PERIOD_RELEASE:
      return handlePeriodRelease(state, event as ParsedEscrowEvent<PeriodReleasePayload>);
    case EscrowEventKind.PLAN_START:
      return handlePlanStart(state, event as ParsedEscrowEvent<PlanStartPayload>);
    case EscrowEventKind.CHILD_KEY:
      return handleChildKey(state, event as ParsedEscrowEvent<ChildKeyPayload>);
    default:
      return err("UNKNOWN_EVENT_KIND", `Unknown event kind: ${event.kind}`, event.raw.id);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// REPLAY — Reconstruct full state from an event chain
// ══════════════════════════════════════════════════════════════════════════

/**
 * Replay a full chain of parsed escrow events to reconstruct state.
 *
 * Events MUST be in dependency order (sorted by e-tag chain, not timestamp).
 * The first event must be a CREATE.
 *
 * Returns the final state or the first validation error encountered.
 */
export function replayEventChain(events: ParsedEscrowEvent[]): TransitionResult {
  if (events.length === 0) {
    return err("EMPTY_CHAIN", "Cannot replay empty event chain");
  }

  if (events[0].kind !== EscrowEventKind.CREATE) {
    return err("MISSING_CREATE", "First event in chain must be CREATE");
  }

  let state: EscrowState | null = null;

  // Benign error codes that can be safely skipped during replay.
  // These occur when multiple participants publish redundant events
  // (e.g. all 3 browsers auto-publish RESOLVE after seeing 2 votes).
  // Skipping them is safe because:
  //   - ALREADY_VOTED: duplicate vote from same pubkey (relay echo)
  //   - ALREADY_JOINED: duplicate JOIN ACK from same pubkey
  //   - ALREADY_SUBSCRIBED: duplicate subscribe event
  //   - DUPLICATE_CREATE: relay returned same CREATE twice
  //   - ROLE_TAKEN: duplicate JOIN for same role from a different pubkey
  //     after the slot was already filled (rare; prefer first-writer-wins)
  //   - ARBITER_POOL_EMPTY / ARBITER_NOT_IN_POOL: stale volunteer arbiter
  //     JOINs on community trades; ignore rather than poisoning the chain
  const benignCodes = new Set([
    "ALREADY_VOTED", "ALREADY_JOINED", "ALREADY_SUBSCRIBED",
    "DUPLICATE_CREATE", "ROLE_TAKEN", "TERMINAL_STATE",
    "ARBITER_POOL_EMPTY", "ARBITER_NOT_IN_POOL",
  ]);

  for (const event of events) {
    const result = applyEvent(state, event);
    if (!result.ok) {
      // Skip benign duplicates silently
      if (benignCodes.has(result.error.code)) {
        continue;
      }
      // INVALID_STATE on RESOLVE/COMPLETE/CLAIM is also benign
      // (duplicate auto-resolve from multiple browsers)
      if (result.error.code === "INVALID_STATE" && state &&
          [EscrowEventKind.RESOLVE, EscrowEventKind.COMPLETE, EscrowEventKind.CLAIM]
            .includes(event.kind)) {
        continue;
      }
      // CHAT is auxiliary state, not the escrow's money/state chain. A legacy
      // or malicious nonparticipant chat must not make the CREATE/JOIN/LOCK
      // history unloadable from relays; keep rejecting it on live send/apply,
      // but skip it during full-chain replay.
      if (event.kind === EscrowEventKind.CHAT && result.error.code === "NOT_PARTICIPANT") {
        continue;
      }
      // Same for PREMIUM — auxiliary, a bad one must never brick replay.
      if (event.kind === EscrowEventKind.PREMIUM && result.error.code === "NOT_PARTICIPANT") {
        continue;
      }
      // Real error — fail the replay
      return result;
    }
    state = result.state;
  }

  return { ok: true, state: state! };
}

// ══════════════════════════════════════════════════════════════════════════
// QUERY HELPERS — Read-only state inspection
// ══════════════════════════════════════════════════════════════════════════

/** Check if a specific pubkey can vote in the current state */
export function canVote(state: EscrowState, pubkey: string, nowSec?: number): { canVote: boolean; reason?: string } {
  // v0.1.66.26: accept EXPIRED in addition to LOCKED. Mirrors
  // handleVote — healing votes on timed-out trades are allowed.
  if (state.status !== EscrowStatus.LOCKED && state.status !== EscrowStatus.EXPIRED) {
    return { canVote: false, reason: `State is ${state.status}, not LOCKED or EXPIRED` };
  }
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  // HEALING includes a LOCKED trade past its deadline. The reducer only flips
  // status to EXPIRED when an EVENT arrives post-deadline — so on a quiet
  // dead trade every client still reads LOCKED, and judging "healing" by
  // status alone deadlocked the rescue: the sender's gate demanded live
  // dispute votes (which a pool backup can't even decrypt) while the healing
  // path that needs NO votes sat unreachable. Judge by the clock instead;
  // the receiving reducer flips to EXPIRED on the vote's arrival and accepts
  // it through the same healing gates.
  const isHealing = state.status === EscrowStatus.EXPIRED
    || (state.expiresAt > 0 && now > state.expiresAt);

  let role = getRole(state, pubkey);
  let isSubstitute = false;
  if (!role) {
    // Arbiter substitution: on a pooled-share lock, an eligible pool backup
    // may cast the ARBITER vote (mirrors handleVote's substitution gate) —
    // including the HEALING rescue vote on an expired trade (REFUND only,
    // enforced by the reducer; clients only send REFUND in healing).
    if (!state.lock.arbiterPoolShare
      || arbiterVotePriority(state, pubkey) === null) {
      return { canVote: false, reason: "Not a participant" };
    }
    role = Role.ARBITER;
    isSubstitute = true;
  }

  // Already voted — per PUBKEY, mirroring handleVote: with substitution the
  // ARBITER slot may hold a backup's vote while the assigned arbiter (a
  // different pubkey) is still entitled to vote and retake it.
  const votedAlready = state.eventChain.some(
    (ve) => ve.kind === EscrowEventKind.VOTE && ve.pubkey === pubkey,
  );
  if (votedAlready) return { canVote: false, reason: "Already voted" };

  // Arbiter ordering only applies during live disputes, not during
  // expiry healing (all heal votes are REFUND, ordering is irrelevant).
  if (role === Role.ARBITER && !isHealing) {
    const buyerVote = state.votes[Role.BUYER];
    const sellerVote = state.votes[Role.SELLER];
    const bothVoted = buyerVote !== undefined && sellerVote !== undefined;
    if (!bothVoted) {
      // v2.9: mirror handleVote — a standing RELEASE past its escalation window
      // lets the arbiter rule against a ghosting locker.
      const escalateAt = oneSidedEscalationAt(state);
      if (escalateAt === null || now < escalateAt) {
        return { canVote: false, reason: "Waiting for buyer and seller to vote first" };
      }
    } else if (buyerVote === sellerVote) {
      return { canVote: false, reason: "Buyer and seller agree — arbiter not needed" };
    }
  }

  // A backup must also wait out the assigned arbiter's grace window — except
  // in HEALING, where the trade is already expired and the rescue is open to
  // the whole pool immediately.
  if (isSubstitute && !isHealing) {
    const eligibleAt = substitutionEligibleAt(state);
    if (eligibleAt === null || now < eligibleAt) {
      return { canVote: false, reason: "The assigned arbiter still has the floor" };
    }
  }

  return { canVote: true };
}

/** Determine who the winner is (or null if not yet resolved) */
/** The resolved winner — recipient for the *resolved* outcome. Returns null
 *  before resolution. For vote-time recipient routing use payoutRecipientFor()
 *  (re-exported from ./recipients) with the candidate outcome instead — it does
 *  not read resolvedOutcome (holder-only refinement #2). */
export function getWinner(state: EscrowState): { pubkey: string; role: Role } | null {
  if (!state.resolvedOutcome) return null;
  return payoutRecipientFor(state, state.resolvedOutcome);
}

/** Check if the escrow has expired based on a given timestamp */
export function isExpired(state: EscrowState, now: number): boolean {
  if (TERMINAL_STATES.has(state.status)) return state.status === EscrowStatus.EXPIRED;
  // Don't expire if already approved or claimed (let the claim complete)
  if (state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED) return false;
  return now > state.expiresAt;
}

/** Get a human-readable summary of the escrow state */
export function getSummary(state: EscrowState): string {
  const lines = [
    `Escrow ${state.id} — ${state.status}`,
    `${state.description}`,
    `Amount: ${state.amountMsats} msats`,
  ];

  if (state.fiatAmount && state.fiatCurrency) {
    lines.push(`Fiat: ${state.fiatAmount} ${state.fiatCurrency}`);
  }

  const roles = [Role.BUYER, Role.SELLER, Role.ARBITER];
  for (const role of roles) {
    const pk = state.participants[role];
    lines.push(`${role}: ${pk ? pk.slice(0, 12) + "…" : "(empty)"}`);
  }

  if (Object.keys(state.votes).length > 0) {
    const voteStr = Object.entries(state.votes)
      .map(([role, outcome]) => `${role}=${outcome}`)
      .join(", ");
    lines.push(`Votes: ${voteStr}`);
  }

  if (state.resolvedOutcome) {
    lines.push(`Resolved: ${state.resolvedOutcome} (${state.resolvedMajority?.join(" + ")})`);
  }

  return lines.join("\n");
}
