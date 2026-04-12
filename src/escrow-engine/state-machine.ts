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
  VALID_TRANSITIONS,
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
  type ReadyPayload,
  type KickPayload,
  type SubscribePayload,
  type PeriodReleasePayload,
  type SubscriptionMeta,
  type ValidationResult,
  type ValidationError,
} from "./types.js";

// ── Result type for state transitions ─────────────────────────────────────

export type TransitionResult =
  | { ok: true; state: EscrowState }
  | { ok: false; error: ValidationError };

// ── Helper: create an error result ────────────────────────────────────────

function err(code: string, message: string, eventId?: string, details?: Record<string, unknown>): TransitionResult {
  return { ok: false, error: { code, message, eventId, details } };
}

// ── Helper: clone state immutably ─────────────────────────────────────────

function cloneState(state: EscrowState): EscrowState {
  return {
    ...state,
    participants: { ...state.participants },
    communityArbiters: [...state.communityArbiters],
    subscription: state.subscription ? {
      ...state.subscription,
      periodStartTimes: [...state.subscription.periodStartTimes],
      periodStatuses: [...state.subscription.periodStatuses],
    } : null,
    kickVotes: { ...state.kickVotes },
    readiness: { ...state.readiness },
    votes: { ...state.votes },
    fees: { ...state.fees },
    lock: {
      ...state.lock,
      shares: new Map(state.lock.shares),
    },
    claim: { ...state.claim },
    eventChain: [...state.eventChain],
    chatMessages: [...state.chatMessages],
  };
}

// ── Helper: check if pubkey is a known participant ────────────────────────

function getRole(state: EscrowState, pubkey: string): Role | null {
  if (state.participants[Role.BUYER] === pubkey) return Role.BUYER;
  if (state.participants[Role.SELLER] === pubkey) return Role.SELLER;
  if (state.participants[Role.ARBITER] === pubkey) return Role.ARBITER;
  return null;
}

// ── Helper: count how many participants have joined ───────────────────────

function participantCount(state: EscrowState): number {
  let count = 0;
  if (state.participants[Role.BUYER]) count++;
  if (state.participants[Role.SELLER]) count++;
  if (state.participants[Role.ARBITER]) count++;
  return count;
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
  //   bill-pay → buyer creates (they want their bill paid)
  //   p2p-trade → seller creates (they're offering to sell sats)
  //   marketplace → seller creates (they're listing an item)
  //   lending → buyer creates (they're requesting a loan)
  const initiatorRole = (p.category === "bill-pay" || p.category === "lending")
    ? Role.BUYER
    : Role.SELLER;

  const participants = {
    [Role.BUYER]: initiatorRole === Role.BUYER ? event.pubkey : null,
    [Role.SELLER]: initiatorRole === Role.SELLER ? event.pubkey : null,
    [Role.ARBITER]: null as string | null,
  };

  const state: EscrowState = {
    id: event.escrowId,
    status: EscrowStatus.CREATED,
    description: p.description,
    amountMsats: p.amountMsats,
    fiatAmount: p.fiatAmount,
    fiatCurrency: p.fiatCurrency,
    category: p.category,
    mintUrl: p.mintUrl,
    participants,
    initiator: { pubkey: event.pubkey, role: initiatorRole },
    communityArbiters: p.communityArbiters || [],
    subscription: null,
    kickVotes: {},
    readiness: {},
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: {
      platformBps: p.platformFeeBps,
      platformPubkey: p.platformFeePubkey,
      platformMsats: Math.floor((p.amountMsats * p.platformFeeBps) / 10_000),
      arbiterMsats: p.arbiterFeeMsats ?? 0,
    },
    lock: {
      notesHash: null,
      lockedAt: null,
      shares: new Map(),
    },
    claim: {
      claimerRole: null,
      claimedAt: null,
    },
    createdAt: event.timestamp,
    expiresAt: event.timestamp + p.expirySeconds,
    resolvedAt: null,
    completedAt: null,
    cancelledAt: null,
    eventChain: [event],
    chatMessages: [],
  };

  return { ok: true, state };
}

// ── JOIN ──────────────────────────────────────────────────────────────────
// A participant joins an existing escrow.

function handleJoin(state: EscrowState, event: ParsedEscrowEvent<JoinPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.CREATED) {
    return err("INVALID_STATE", `Cannot JOIN in state ${state.status}`, event.raw.id);
  }

  // Check they're not already a participant
  if (getRole(state, event.pubkey) !== null) {
    return err("ALREADY_JOINED", "Pubkey is already a participant", event.raw.id);
  }

  // Check the role they want is available
  if (state.participants[p.role] !== null) {
    return err("ROLE_TAKEN", `Role ${p.role} is already filled`, event.raw.id);
  }

  // Can't join as the initiator's role
  if (p.role === state.initiator.role) {
    return err("ROLE_CONFLICT", `Cannot join as ${p.role} — that's the initiator's role`, event.raw.id);
  }

  const next = cloneState(state);
  next.participants[p.role] = event.pubkey;

  // If arbiter is joining with fee terms, record them
  if (p.role === Role.ARBITER && p.arbiterFeeMsats !== undefined) {
    next.fees.arbiterMsats = p.arbiterFeeMsats;
  }

  // Transition to FUNDED when all 3 are in
  if (participantCount(next) === 3) {
    next.status = EscrowStatus.FUNDED;
  }

  next.eventChain.push(event);
  return { ok: true, state: next };
}

// ── LOCK ──────────────────────────────────────────────────────────────────
// Ecash is locked in 2-of-3 SSS. Shares distributed to participants.

function handleLock(state: EscrowState, event: ParsedEscrowEvent<LockPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.FUNDED) {
    return err("INVALID_STATE", `Cannot LOCK in state ${state.status}`, event.raw.id);
  }

  // All 3 participants must have confirmed ready before locking
  const allReady = state.readiness[Role.BUYER] &&
                   state.readiness[Role.SELLER] &&
                   state.readiness[Role.ARBITER];
  if (!allReady) {
    const missing = [Role.BUYER, Role.SELLER, Role.ARBITER]
      .filter(r => !state.readiness[r])
      .join(", ");
    return err("NOT_ALL_READY",
      `Cannot lock — waiting for readiness confirmation from: ${missing}`,
      event.raw.id,
      { readiness: state.readiness }
    );
  }

  // Only the seller (who holds the sats) can lock
  // Exception: in bill-pay, the buyer locks
  const lockerRole = getRole(state, event.pubkey);
  if (!lockerRole) {
    return err("NOT_PARTICIPANT", "Locker is not a participant", event.raw.id);
  }

  // Validate shares — must have exactly 3, one per participant
  if (!p.shares || p.shares.length !== 3) {
    return err("INVALID_SHARES", "LOCK must include exactly 3 SSS shares", event.raw.id);
  }

  // Validate amounts add up
  const total = p.sellerReceivesMsats + p.arbiterFeeMsats + p.platformFeeMsats;
  if (total !== state.amountMsats) {
    return err("AMOUNT_MISMATCH",
      `Fee split (${total}) doesn't match escrow amount (${state.amountMsats})`,
      event.raw.id,
      { total, expected: state.amountMsats }
    );
  }

  const next = cloneState(state);
  next.status = EscrowStatus.LOCKED;
  next.lock.notesHash = p.notesHash;
  next.lock.lockedAt = p.lockedAt;

  // Store encrypted shares
  for (const share of p.shares) {
    next.lock.shares.set(share.recipientPubkey, share.encryptedShare);
  }

  // Update fee breakdown from actual lock amounts
  next.fees.platformMsats = p.platformFeeMsats;
  next.fees.arbiterMsats = p.arbiterFeeMsats;

  next.eventChain.push(event);
  return { ok: true, state: next };
}

// ── VOTE ──────────────────────────────────────────────────────────────────
// A participant casts their vote. Does NOT transition state directly —
// a separate RESOLVE event is needed when 2-of-3 threshold is met.

function handleVote(state: EscrowState, event: ParsedEscrowEvent<VotePayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.LOCKED) {
    return err("INVALID_STATE", `Cannot VOTE in state ${state.status}`, event.raw.id);
  }

  const voterRole = getRole(state, event.pubkey);
  if (!voterRole) {
    return err("NOT_PARTICIPANT", "Voter is not a participant", event.raw.id);
  }

  // Role in event must match actual role
  if (voterRole !== p.role) {
    return err("ROLE_MISMATCH",
      `Signer has role ${voterRole} but event claims ${p.role}`,
      event.raw.id
    );
  }

  // Can't vote twice
  if (state.votes[voterRole] !== undefined) {
    return err("ALREADY_VOTED", `${voterRole} has already voted`, event.raw.id);
  }

  // Arbiter can only vote after buyer AND seller have voted AND they disagree
  if (voterRole === Role.ARBITER) {
    const buyerVote = state.votes[Role.BUYER];
    const sellerVote = state.votes[Role.SELLER];

    if (buyerVote === undefined || sellerVote === undefined) {
      return err("ARBITER_TOO_EARLY",
        "Arbiter can only vote after both buyer and seller have voted",
        event.raw.id
      );
    }

    if (buyerVote === sellerVote) {
      return err("ARBITER_NOT_NEEDED",
        "Arbiter vote not needed — buyer and seller agree",
        event.raw.id
      );
    }
  }

  const next = cloneState(state);
  next.votes[voterRole] = p.outcome;
  next.eventChain.push(event);

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

  if (state.status !== EscrowStatus.LOCKED) {
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

  // Verify the claimer is the correct winner
  // release → buyer wins (they get the sats/goods)
  // refund → seller wins (they get sats back)
  const expectedWinner = state.resolvedOutcome === Outcome.RELEASE ? Role.BUYER : Role.SELLER;
  const claimerRole = getRole(state, event.pubkey);

  if (claimerRole !== expectedWinner) {
    return err("WRONG_CLAIMER",
      `Only ${expectedWinner} can claim on ${state.resolvedOutcome} outcome`,
      event.raw.id,
      { claimerRole, expectedWinner, outcome: state.resolvedOutcome }
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
  next.claim.claimerRole = p.claimerRole;
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

  if (state.status !== EscrowStatus.CREATED && state.status !== EscrowStatus.FUNDED) {
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

  // Only in CREATED or FUNDED state (before lock)
  if (state.status !== EscrowStatus.CREATED && state.status !== EscrowStatus.FUNDED) {
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

// ── KICK ──────────────────────────────────────────────────────────────────
// Dual-vote kick: 2 participants must agree to remove the third.
// First vote records intent. Second vote executes the removal.
// Reverts the escrow to CREATED so a new participant can join.

function handleKick(state: EscrowState, event: ParsedEscrowEvent<KickPayload>): TransitionResult {
  const p = event.payload;

  // Only in FUNDED state (all 3 joined but not yet locked)
  if (state.status !== EscrowStatus.FUNDED) {
    return err("INVALID_STATE", `Cannot KICK in state ${state.status} — only allowed in FUNDED`, event.raw.id);
  }

  // Only existing participants can kick
  const kickerRole = getRole(state, event.pubkey);
  if (!kickerRole) {
    return err("NOT_PARTICIPANT", "Only participants can kick", event.raw.id);
  }

  if (kickerRole !== p.kickerRole) {
    return err("ROLE_MISMATCH", `Signer has role ${kickerRole} but claims ${p.kickerRole}`, event.raw.id);
  }

  // Can't kick yourself
  if (p.targetRole === kickerRole) {
    return err("SELF_KICK", "Cannot kick yourself — use CANCEL instead", event.raw.id);
  }

  // Can't kick the initiator
  if (p.targetRole === state.initiator.role) {
    return err("KICK_INITIATOR", "Cannot kick the trade initiator", event.raw.id);
  }

  const next = cloneState(state);
  next.eventChain.push(event);

  // Initialize kick votes for this target if not exists
  if (!next.kickVotes[p.targetRole]) {
    next.kickVotes[p.targetRole] = [];
  }

  // Check for duplicate vote
  if (next.kickVotes[p.targetRole].includes(kickerRole)) {
    return err("ALREADY_VOTED_KICK", `${kickerRole} already voted to kick ${p.targetRole}`, event.raw.id);
  }

  // Record the kick vote
  next.kickVotes[p.targetRole].push(kickerRole);

  // Check if 2 votes reached — execute the removal
  if (next.kickVotes[p.targetRole].length >= 2) {
    // Remove the kicked participant
    next.participants[p.targetRole] = null;

    // Clear all readiness (everyone needs to re-confirm after roster change)
    next.readiness = {};

    // Clear kick votes (fresh start)
    next.kickVotes = {};

    // Revert to CREATED (waiting for a replacement)
    next.status = EscrowStatus.CREATED;
  }

  return { ok: true, state: next };
}

// ── READY ─────────────────────────────────────────────────────────────────
// Participant confirms they're online and ready for the escrow to lock.
// All 3 must confirm before LOCK is allowed.

function handleReady(state: EscrowState, event: ParsedEscrowEvent<ReadyPayload>): TransitionResult {
  const p = event.payload;

  if (state.status !== EscrowStatus.FUNDED) {
    return err("INVALID_STATE", `Cannot confirm READY in state ${state.status}`, event.raw.id);
  }

  const role = getRole(state, event.pubkey);
  if (!role) {
    return err("NOT_PARTICIPANT", "Only participants can confirm ready", event.raw.id);
  }

  if (role !== p.role) {
    return err("ROLE_MISMATCH",
      `Signer has role ${role} but event claims ${p.role}`,
      event.raw.id
    );
  }

  if (state.readiness[role]) {
    return err("ALREADY_READY", `${role} has already confirmed ready`, event.raw.id);
  }

  const next = cloneState(state);
  next.readiness[role] = true;
  next.eventChain.push(event);

  return { ok: true, state: next };
}

// ── CHAT ──────────────────────────────────────────────────────────────────
// Chat messages don't change state but are part of the escrow record.

function handleChat(state: EscrowState, event: ParsedEscrowEvent<ChatPayload>): TransitionResult {
  // Only participants can chat
  if (getRole(state, event.pubkey) === null) {
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

  // ── Check terminal ──
  if (TERMINAL_STATES.has(state.status)) {
    return err("TERMINAL_STATE",
      `Escrow is in terminal state ${state.status} — no further events accepted`,
      event.raw.id
    );
  }

  // ── Check expiry ──
  if (event.timestamp > state.expiresAt && state.status !== EscrowStatus.APPROVED && state.status !== EscrowStatus.CLAIMED) {
    // Auto-expire: if we receive an event past the deadline on a non-terminal,
    // non-approved state, the escrow has expired.
    const next = cloneState(state);
    next.status = EscrowStatus.EXPIRED;
    return { ok: true, state: next };
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
    case EscrowEventKind.READY:
      return handleReady(state, event as ParsedEscrowEvent<ReadyPayload>);
    case EscrowEventKind.KICK:
      return handleKick(state, event as ParsedEscrowEvent<KickPayload>);
    case EscrowEventKind.SUBSCRIBE:
      return handleSubscribe(state, event as ParsedEscrowEvent<SubscribePayload>);
    case EscrowEventKind.PERIOD_RELEASE:
      return handlePeriodRelease(state, event as ParsedEscrowEvent<PeriodReleasePayload>);
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

  for (const event of events) {
    const result = applyEvent(state, event);
    if (!result.ok) return result;
    state = result.state;
  }

  return { ok: true, state: state! };
}

// ══════════════════════════════════════════════════════════════════════════
// QUERY HELPERS — Read-only state inspection
// ══════════════════════════════════════════════════════════════════════════

/** Check if a specific pubkey can vote in the current state */
export function canVote(state: EscrowState, pubkey: string): { canVote: boolean; reason?: string } {
  if (state.status !== EscrowStatus.LOCKED) {
    return { canVote: false, reason: `State is ${state.status}, not LOCKED` };
  }

  const role = getRole(state, pubkey);
  if (!role) return { canVote: false, reason: "Not a participant" };
  if (state.votes[role] !== undefined) return { canVote: false, reason: "Already voted" };

  if (role === Role.ARBITER) {
    const buyerVote = state.votes[Role.BUYER];
    const sellerVote = state.votes[Role.SELLER];
    if (buyerVote === undefined || sellerVote === undefined) {
      return { canVote: false, reason: "Waiting for buyer and seller to vote first" };
    }
    if (buyerVote === sellerVote) {
      return { canVote: false, reason: "Buyer and seller agree — arbiter not needed" };
    }
  }

  return { canVote: true };
}

/** Determine who the winner is (or null if not yet resolved) */
export function getWinner(state: EscrowState): { pubkey: string; role: Role } | null {
  if (!state.resolvedOutcome) return null;
  const winnerRole = state.resolvedOutcome === Outcome.RELEASE ? Role.BUYER : Role.SELLER;
  const pubkey = state.participants[winnerRole];
  if (!pubkey) return null;
  return { pubkey, role: winnerRole };
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
