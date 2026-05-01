// ══════════════════════════════════════════════════════════════════════════
// Chama Nostr Escrow Engine — Event Parser
// ══════════════════════════════════════════════════════════════════════════
//
// Transforms raw Nostr events into typed ParsedEscrowEvent objects.
//
// Responsibilities:
//   1. Validate event structure (kind, tags, signature)
//   2. Extract escrow ID from d-tag
//   3. Extract prev event ID from e-tag chain
//   4. Parse + type the decrypted content payload
//   5. Return a fully typed ParsedEscrowEvent or an error
//
// NIP-44 decryption is handled externally — this module receives
// already-decrypted content strings and parses them.

import {
  EscrowEventKind,
  TAGS,
  type NostrEvent,
  type ParsedEscrowEvent,
  type EscrowPayload,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type ChatPayload,
  type SubscribePayload,
  type PeriodReleasePayload,
  type ValidationError,
  Role,
  Outcome,
} from "./types.js";

// ── Valid event kinds set ─────────────────────────────────────────────────

const VALID_KINDS = new Set<number>(Object.values(EscrowEventKind).filter(v => typeof v === "number"));

// ── Kind → Payload type string mapping ────────────────────────────────────

const KIND_TO_TYPE: Record<number, string> = {
  [EscrowEventKind.CREATE]:   "escrow:create",
  [EscrowEventKind.JOIN]:     "escrow:join",
  [EscrowEventKind.LOCK]:     "escrow:lock",
  [EscrowEventKind.VOTE]:     "escrow:vote",
  [EscrowEventKind.RESOLVE]:  "escrow:resolve",
  [EscrowEventKind.CLAIM]:    "escrow:claim",
  [EscrowEventKind.COMPLETE]: "escrow:complete",
  [EscrowEventKind.CANCEL]:   "escrow:cancel",
  [EscrowEventKind.CHAT]:     "escrow:chat",
  [EscrowEventKind.SUBSCRIBE]:      "escrow:subscribe",
  [EscrowEventKind.PERIOD_RELEASE]: "escrow:period_release",
};

// ── Parse result type ─────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; event: ParsedEscrowEvent }
  | { ok: false; error: ValidationError };

// ── Tag extraction helpers ────────────────────────────────────────────────

function getTagValue(tags: string[][], tagName: string): string | null {
  const tag = tags.find(t => t[0] === tagName);
  return tag ? tag[1] ?? null : null;
}

function getTagValues(tags: string[][], tagName: string): string[] {
  return tags.filter(t => t[0] === tagName).map(t => t[1]).filter(Boolean);
}

/** Get e-tag with "reply" marker, or fallback to last e-tag */
function getPrevEventId(tags: string[][]): string | null {
  // First try: e-tag with "reply" marker
  const replyTag = tags.find(t => t[0] === "e" && t[3] === "reply");
  if (replyTag) return replyTag[1] ?? null;

  // Fallback: last e-tag
  const eTags = tags.filter(t => t[0] === "e");
  if (eTags.length > 0) return eTags[eTags.length - 1][1] ?? null;

  return null;
}

// ── Payload validators ────────────────────────────────────────────────────

function validateCreatePayload(data: unknown): data is CreatePayload {
  const d = data as Record<string, unknown>;
  // v0.1.72 federation gates: fedPrefix and fed are optional (backwards
  // compat with pre-.72 trades). When present, they must be the correct
  // shape — fedPrefix is exactly 10 chars, fed is a non-empty hex-ish
  // string. Loose validation; the gate logic is the real check.
  if (d.fedPrefix !== undefined && (typeof d.fedPrefix !== "string" || d.fedPrefix.length !== 10)) {
    return false;
  }
  if (d.fed !== undefined && (typeof d.fed !== "string" || d.fed.length === 0)) {
    return false;
  }
  // PR 2: community is optional (pre-registry trades have no slug).
  // When present, it's a non-empty string — the registry lookup at
  // render time decides whether the slug is still meaningful.
  if (d.community !== undefined && (typeof d.community !== "string" || d.community.length === 0)) {
    return false;
  }
  // PR 2: fulfillment is optional — handleCreate normalizes it. When
  // present it must be one of the three known values.
  if (d.fulfillment !== undefined
      && d.fulfillment !== "physical"
      && d.fulfillment !== "service"
      && d.fulfillment !== "digital") {
    return false;
  }
  return (
    d.type === "escrow:create" &&
    typeof d.description === "string" &&
    typeof d.amountMsats === "number" && d.amountMsats > 0 &&
    typeof d.mintUrl === "string" &&
    typeof d.category === "string" &&
    typeof d.platformFeeBps === "number" &&
    typeof d.platformFeePubkey === "string" &&
    typeof d.expirySeconds === "number" && d.expirySeconds > 0 &&
    typeof d.createdAt === "number"
  );
}

function validateJoinPayload(data: unknown): data is JoinPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:join" &&
    typeof d.role === "string" && Object.values(Role).includes(d.role as Role) &&
    typeof d.joinedAt === "number"
  );
}

function validateLockPayload(data: unknown): data is LockPayload {
  // PR 1 atomic-funding: LOCK is self-describing about the buyer and
  // arbiter pubkeys (the chain no longer relies on prior JOIN events
  // to populate participants). Both fields are required.
  // v0.1.71: platformFeeMsats no longer required — it was removed from
  // the LockPayload schema. We accept old LOCKs that still carry the
  // field, we just don't check or use it.
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:lock" &&
    typeof d.notesHash === "string" &&
    Array.isArray(d.shares) && d.shares.length === 3 &&
    typeof d.sellerReceivesMsats === "number" &&
    typeof d.arbiterFeeMsats === "number" &&
    typeof d.buyerPubkey === "string" && d.buyerPubkey.length > 0 &&
    typeof d.arbiterPubkey === "string" && d.arbiterPubkey.length > 0 &&
    typeof d.lockedAt === "number"
  );
}

function validateVotePayload(data: unknown): data is VotePayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:vote" &&
    typeof d.outcome === "string" && Object.values(Outcome).includes(d.outcome as Outcome) &&
    typeof d.role === "string" && Object.values(Role).includes(d.role as Role) &&
    typeof d.votedAt === "number"
  );
}

function validateResolvePayload(data: unknown): data is ResolvePayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:resolve" &&
    typeof d.outcome === "string" && Object.values(Outcome).includes(d.outcome as Outcome) &&
    Array.isArray(d.majority) && d.majority.length === 2 &&
    typeof d.arbiterInvolved === "boolean" &&
    typeof d.resolvedAt === "number"
  );
}

function validateClaimPayload(data: unknown): data is ClaimPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:claim" &&
    typeof d.claimerRole === "string" && Object.values(Role).includes(d.claimerRole as Role) &&
    typeof d.notesHashVerification === "string" &&
    typeof d.claimedAt === "number"
  );
}

function validateCompletePayload(data: unknown): data is CompletePayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:complete" &&
    typeof d.completedAt === "number"
  );
}

function validateCancelPayload(data: unknown): data is CancelPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:cancel" &&
    typeof d.cancellerRole === "string" && Object.values(Role).includes(d.cancellerRole as Role) &&
    typeof d.cancelledAt === "number"
  );
}

function validateChatPayload(data: unknown): data is ChatPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:chat" &&
    typeof d.message === "string" &&
    typeof d.senderRole === "string" && Object.values(Role).includes(d.senderRole as Role) &&
    typeof d.sentAt === "number"
  );
}

function validateSubscribePayload(data: unknown): data is SubscribePayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:subscribe" &&
    typeof d.totalPeriods === "number" && d.totalPeriods > 0 && d.totalPeriods <= 52 &&
    typeof d.periodAmountMsats === "number" && d.periodAmountMsats > 0 &&
    typeof d.periodDurationSeconds === "number" && d.periodDurationSeconds > 0 &&
    typeof d.description === "string" &&
    typeof d.startsAt === "number"
  );
}

function validatePeriodReleasePayload(data: unknown): data is PeriodReleasePayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:period_release" &&
    typeof d.periodIndex === "number" && d.periodIndex >= 0 &&
    typeof d.amountMsats === "number" && d.amountMsats > 0 &&
    typeof d.triggeredBy === "string" &&
    typeof d.releasedAt === "number"
  );
}

// ── Payload validator dispatch ────────────────────────────────────────────

const PAYLOAD_VALIDATORS: Record<number, (data: unknown) => boolean> = {
  [EscrowEventKind.CREATE]:   validateCreatePayload,
  [EscrowEventKind.JOIN]:     validateJoinPayload,
  [EscrowEventKind.LOCK]:     validateLockPayload,
  [EscrowEventKind.VOTE]:     validateVotePayload,
  [EscrowEventKind.RESOLVE]:  validateResolvePayload,
  [EscrowEventKind.CLAIM]:    validateClaimPayload,
  [EscrowEventKind.COMPLETE]: validateCompletePayload,
  [EscrowEventKind.CANCEL]:   validateCancelPayload,
  [EscrowEventKind.CHAT]:     validateChatPayload,
  [EscrowEventKind.SUBSCRIBE]:      validateSubscribePayload,
  [EscrowEventKind.PERIOD_RELEASE]: validatePeriodReleasePayload,
};

// ══════════════════════════════════════════════════════════════════════════
// MAIN PARSER
// ══════════════════════════════════════════════════════════════════════════

/**
 * Parse a raw Nostr event into a typed ParsedEscrowEvent.
 *
 * @param raw - The raw Nostr event from a relay
 * @param decryptedContent - The NIP-44 decrypted content string.
 *   The caller is responsible for decryption — this module only parses.
 * @param skipSignatureCheck - If true, skip signature verification.
 *   Useful in testing or when the relay already verified signatures.
 */
export function parseEscrowEvent(
  raw: NostrEvent,
  decryptedContent: string,
  skipSignatureCheck = false
): ParseResult {

  // ── 1. Validate event kind ──
  if (!VALID_KINDS.has(raw.kind)) {
    return {
      ok: false,
      error: {
        code: "INVALID_KIND",
        message: `Event kind ${raw.kind} is not a recognized escrow event kind`,
        eventId: raw.id,
      },
    };
  }

  const kind = raw.kind as EscrowEventKind;

  // ── 2. Extract escrow ID from d-tag ──
  const escrowId = getTagValue(raw.tags, TAGS.ESCROW_ID);
  if (!escrowId) {
    return {
      ok: false,
      error: {
        code: "MISSING_ESCROW_ID",
        message: "Event is missing d-tag (escrow ID)",
        eventId: raw.id,
      },
    };
  }

  // ── 3. Extract prev event ID (null for CREATE) ──
  const prevEventId = kind === EscrowEventKind.CREATE ? null : getPrevEventId(raw.tags);

  // ── 4. Parse decrypted content ──
  let payload: EscrowPayload;
  try {
    const parsed = JSON.parse(decryptedContent);

    // Verify type field matches expected type for this kind
    const expectedType = KIND_TO_TYPE[kind];
    if (parsed.type !== expectedType) {
      return {
        ok: false,
        error: {
          code: "TYPE_MISMATCH",
          message: `Event kind ${kind} expects type "${expectedType}" but got "${parsed.type}"`,
          eventId: raw.id,
        },
      };
    }

    // Validate payload structure
    const validator = PAYLOAD_VALIDATORS[kind];
    if (validator && !validator(parsed)) {
      return {
        ok: false,
        error: {
          code: "INVALID_PAYLOAD",
          message: `Payload for ${expectedType} failed structural validation`,
          eventId: raw.id,
          details: { payload: parsed },
        },
      };
    }

    payload = parsed as EscrowPayload;
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "PARSE_ERROR",
        message: `Failed to parse decrypted content: ${e instanceof Error ? e.message : String(e)}`,
        eventId: raw.id,
      },
    };
  }

  // ── 5. Build the typed event ──
  const parsedEvent: ParsedEscrowEvent = {
    raw,
    payload,
    escrowId,
    prevEventId,
    kind,
    pubkey: raw.pubkey,
    timestamp: raw.created_at,
  };

  return { ok: true, event: parsedEvent };
}

// ══════════════════════════════════════════════════════════════════════════
// CHAIN SORTING — Order events by dependency (e-tag chain)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Sort parsed events into dependency order (topological sort on e-tag chain).
 *
 * The CREATE event (no prevEventId) comes first. Each subsequent event
 * references its predecessor via e-tag. Chat events are interleaved by
 * timestamp since they don't participate in the state chain.
 */
export function sortEventChain(events: ParsedEscrowEvent[]): ParsedEscrowEvent[] {
  // Separate state events from chat events
  const stateEvents = events.filter(e => e.kind !== EscrowEventKind.CHAT);
  const chatEvents = events.filter(e => e.kind === EscrowEventKind.CHAT);

  // Find the root (CREATE event — no prevEventId)
  const root = stateEvents.find(e => e.prevEventId === null);
  if (!root) {
    // Fallback: sort by timestamp
    return [...events].sort((a, b) => a.timestamp - b.timestamp);
  }

  // Build adjacency: eventId → next events (multiple events can reference same prev)
  const byPrevId = new Map<string, ParsedEscrowEvent[]>();
  for (const event of stateEvents) {
    if (event.prevEventId) {
      const existing = byPrevId.get(event.prevEventId) || [];
      existing.push(event);
      byPrevId.set(event.prevEventId, existing);
    }
  }

  // BFS walk the chain — handles branches (e.g. two VOTEs referencing same LOCK)
  const sorted: ParsedEscrowEvent[] = [root];
  const visited = new Set<string>([root.raw.id]);
  const queue: ParsedEscrowEvent[] = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = byPrevId.get(current.raw.id) || [];
    // Sort children by kind priority first (state machine order), then timestamp.
    // JOIN sits before LOCK so that when both arrive close together the ACK
    // is recorded first — but JOIN no longer gates LOCK, so out-of-order
    // delivery is harmless; LOCK validates participants from its own payload.
    const KIND_PRIORITY: Record<number, number> = {
      38100: 0,  // CREATE
      38111: 1,  // SUBSCRIBE
      38101: 2,  // JOIN (ACK)
      38102: 3,  // LOCK
      38103: 4,  // VOTE
      38104: 5,  // RESOLVE
      38105: 6,  // CLAIM
      38106: 7,  // COMPLETE
      38107: 8,  // CANCEL
      38112: 4,  // PERIOD_RELEASE (same level as VOTE)
    };
    children.sort((a, b) => {
      const pa = KIND_PRIORITY[a.kind] ?? 99;
      const pb = KIND_PRIORITY[b.kind] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });
    for (const child of children) {
      if (!visited.has(child.raw.id)) {
        sorted.push(child);
        visited.add(child.raw.id);
        queue.push(child);
      }
    }
  }

  // Add any state events not reached by chain walk (shouldn't happen in valid chains)
  for (const event of stateEvents) {
    if (!visited.has(event.raw.id)) {
      sorted.push(event);
    }
  }

  // Second pass: global kind-priority sort to fix cross-branch misordering.
  // The BFS handles siblings correctly but events referencing different parents
  // can end up in wrong global order (e.g. CLAIM before LOCK).
  // Stable sort preserves BFS order for same-kind events.
  const GLOBAL_KIND_ORDER: Record<number, number> = {
    38100: 0,  // CREATE
    38111: 1,  // SUBSCRIBE
    38101: 2,  // JOIN (ACK)
    38102: 3,  // LOCK
    38103: 4,  // VOTE
    38112: 4,  // PERIOD_RELEASE
    38104: 5,  // RESOLVE
    38105: 6,  // CLAIM
    38106: 7,  // COMPLETE
    38107: 8,  // CANCEL
  };
  sorted.sort((a, b) => {
    const pa = GLOBAL_KIND_ORDER[a.kind] ?? 99;
    const pb = GLOBAL_KIND_ORDER[b.kind] ?? 99;
    if (pa !== pb) return pa - pb;
    return 0; // stable: preserve BFS order within same kind
  });

  // Interleave chat events by timestamp
  const all = [...sorted];
  for (const chat of chatEvents) {
    // Insert chat after the last state event that happened before it
    let insertIdx = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].timestamp <= chat.timestamp) {
        insertIdx = i + 1;
        break;
      }
    }
    all.splice(insertIdx, 0, chat);
  }

  return all;
}

// ══════════════════════════════════════════════════════════════════════════
// RELAY FILTER BUILDER — Construct Nostr filter for escrow events
// ══════════════════════════════════════════════════════════════════════════

/** Build a Nostr relay filter to fetch all events for an escrow */
export function buildEscrowFilter(escrowId: string) {
  return {
    kinds: Object.values(EscrowEventKind).filter(v => typeof v === "number"),
    "#d": [escrowId],
  };
}

/** Build a Nostr relay filter to discover escrows a pubkey participates in */
export function buildParticipantFilter(pubkey: string, since?: number) {
  return {
    kinds: [EscrowEventKind.CREATE, EscrowEventKind.JOIN],
    "#p": [pubkey],
    ...(since ? { since } : {}),
  };
}
