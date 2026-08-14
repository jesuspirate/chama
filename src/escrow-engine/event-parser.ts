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
  type ChatImageAttachment,
  type ChatPayload,
  type PremiumPayload,
  type SettlementPayload,
  type HandleEnvelope,
  type SubscribePayload,
  type PeriodReleasePayload,
  type PlanStartPayload,
  type ChildKeyPayload,
  type ValidationError,
  Role,
  Outcome,
} from "./types.js";
import { areSupportedListingImageRefs, isSupportedListingImageRef } from "../media/listing-image-upload.js";

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
  [EscrowEventKind.PREMIUM]:  "escrow:premium",
  [EscrowEventKind.SETTLEMENT]: "escrow:settlement",
  [EscrowEventKind.SUBSCRIBE]:      "escrow:subscribe",
  [EscrowEventKind.PERIOD_RELEASE]: "escrow:period_release",
  [EscrowEventKind.PLAN_START]: "escrow:plan_start",
  [EscrowEventKind.CHILD_KEY]: "escrow:child_key",
};

function isFulfillment(v: unknown): v is "physical" | "service" | "digital" {
  return v === "physical" || v === "service" || v === "digital";
}

function isMenuItemKind(v: unknown): boolean {
  return v === "exchange-bracket" || v === "bill" || v === "loan" || v === "market-item";
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isOptionalPositiveNumber(v: unknown): boolean {
  return v === undefined || isPositiveNumber(v);
}

function isOptionalFiniteNumber(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function validateMenuItem(data: unknown): boolean {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== "object") return false;
  const minAmount = d.minAmountMsats;
  const maxAmount = d.maxAmountMsats;
  const hasRange = minAmount !== undefined || maxAmount !== undefined;
  if (d.kind !== undefined && !isMenuItemKind(d.kind)) return false;
  if (!isOptionalPositiveNumber(minAmount) || !isOptionalPositiveNumber(maxAmount)) return false;
  if (isPositiveNumber(minAmount) && isPositiveNumber(maxAmount) && minAmount > maxAmount) return false;
  if (d.kind === "exchange-bracket" && (!isPositiveNumber(minAmount) || !isPositiveNumber(maxAmount))) return false;
  if (hasRange && d.kind !== undefined && d.kind !== "exchange-bracket") return false;
  if (d.imageDataUrl !== undefined && !isSupportedListingImageRef(d.imageDataUrl)) return false;
  if (d.imageUrls !== undefined && !areSupportedListingImageRefs(d.imageUrls)) return false;
  return (
    typeof d.id === "string" && d.id.length > 0 &&
    typeof d.label === "string" && d.label.trim().length > 0 &&
    isPositiveNumber(d.amountMsats) &&
    (d.description === undefined || typeof d.description === "string") &&
    (d.fiatAmount === undefined || typeof d.fiatAmount === "number") &&
    (d.fiatCurrency === undefined || typeof d.fiatCurrency === "string") &&
    (d.fulfillment === undefined || isFulfillment(d.fulfillment)) &&
    isOptionalPositiveNumber(d.dueAt) &&
    isOptionalPositiveNumber(d.termDays) &&
    isOptionalPositiveNumber(d.aprBps) &&
    isOptionalPositiveNumber(d.trustTier) &&
    (d.maxQuantity === undefined ||
      (isPositiveNumber(d.maxQuantity) && Number.isInteger(d.maxQuantity)))
  );
}

function validateMenuItems(data: unknown): boolean {
  if (data === undefined) return true;
  if (!Array.isArray(data) || data.length === 0 || data.length > 50) return false;
  const ids = new Set<string>();
  for (const item of data) {
    if (!validateMenuItem(item)) return false;
    const id = (item as Record<string, unknown>).id as string;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function validateSelectedMenuItem(data: unknown): boolean {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== "object") return false;
  return validateMenuItem({
    id: d.itemId,
    label: d.label,
    amountMsats: d.amountMsats,
    kind: d.kind,
    minAmountMsats: d.minAmountMsats,
    maxAmountMsats: d.maxAmountMsats,
    description: d.description,
    fiatAmount: d.fiatAmount,
    fiatCurrency: d.fiatCurrency,
    fulfillment: d.fulfillment,
    dueAt: d.dueAt,
    termDays: d.termDays,
    aprBps: d.aprBps,
    trustTier: d.trustTier,
  }) &&
    typeof d.quantity === "number" &&
    Number.isInteger(d.quantity) &&
    d.quantity > 0 &&
    d.quantity <= 99;
}

function validateSelectedMenuItems(data: unknown): boolean {
  if (data === undefined) return true;
  if (!Array.isArray(data) || data.length === 0 || data.length > 50) return false;
  return data.every(validateSelectedMenuItem);
}

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
  if (!validEscrowXonly(d.escrowXonly)) return false;
  if (d.listingKind !== undefined && d.listingKind !== "work" && d.listingKind !== "work-request") return false;
  if (d.imageDataUrl !== undefined && !isSupportedListingImageRef(d.imageDataUrl)) return false;
  if (d.imageUrls !== undefined && !areSupportedListingImageRefs(d.imageUrls)) return false;
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
  if (!validateMenuItems(d.items)) return false;
  // #7 multi-unit storefront (Stage 1): optional, additive. stock on a
  // parent listing; parent (parent escrow id) + claimedQuantity on a child.
  if (d.stock !== undefined && (!isPositiveNumber(d.stock) || !Number.isInteger(d.stock))) return false;
  if (d.parent !== undefined && (typeof d.parent !== "string" || d.parent.length === 0)) return false;
  if (d.claimedQuantity !== undefined && (!isPositiveNumber(d.claimedQuantity) || !Number.isInteger(d.claimedQuantity))) return false;
  if (d.sellerPubkey !== undefined && (typeof d.sellerPubkey !== "string" || d.sellerPubkey.length === 0)) return false;
  if (d.trancheChild !== undefined) {
    const t = d.trancheChild as Record<string, unknown>;
    if (!t || typeof t !== "object" || t.privatePlanChild !== true
      || typeof t.parent !== "string" || typeof t.planId !== "string"
      || typeof t.planStartEventId !== "string" || !Number.isInteger(t.index)
      || !Number.isInteger(t.total) || typeof t.totalMsats !== "number"
      || typeof t.buyerPubkey !== "string" || typeof t.sellerPubkey !== "string"
      || typeof t.arbiterPubkey !== "string" || typeof t.termsDigest !== "string"
      || typeof t.coordinatorPubkey !== "string"
      || (t.bitcoinNetwork !== "mainnet" && t.bitcoinNetwork !== "signet")) return false;
    if (d.parent !== t.parent || d.sellerPubkey !== t.sellerPubkey) return false;
  }
  // Stage 2b: a CHILD purchase (parent set) must name its seller. The buyer
  // publishes the child CREATE (Option A — seller offline), so without the
  // carried seller pubkey there's no SELLER to seat and the child could never
  // lock to the right counterparty. Reject the malformed child outright.
  if (d.parent !== undefined && (typeof d.sellerPubkey !== "string" || d.sellerPubkey.length === 0)) return false;
  return (
    d.type === "escrow:create" &&
    typeof d.description === "string" &&
    typeof d.amountMsats === "number" && d.amountMsats > 0 &&
    isOptionalFiniteNumber(d.fiatAmount) &&
    (d.fiatCurrency === undefined || typeof d.fiatCurrency === "string") &&
    isOptionalFiniteNumber(d.premiumBps) &&
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
  if (!validateJoinEscrowKey(d)) return false;
  if (!validateSelectedMenuItems(d.selectedItems)) return false;
  if (d.amountMsats !== undefined && (typeof d.amountMsats !== "number" || d.amountMsats <= 0)) {
    return false;
  }
  if (d.orderFinalizedAt !== undefined && (typeof d.orderFinalizedAt !== "number" || d.orderFinalizedAt <= 0)) {
    return false;
  }
  return (
    d.type === "escrow:join" &&
    typeof d.role === "string" && Object.values(Role).includes(d.role as Role) &&
    typeof d.joinedAt === "number" &&
    (d.holdExpiresAt === undefined || typeof d.holdExpiresAt === "number")
  );
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Tier 2.1: an optional published escrow key must be 64-hex when present.
 *  Shape only — whether it is a valid curve point is discovered when the address
 *  is built, and reported there as a blocker rather than a crash. */
function validEscrowXonly(v: unknown): boolean {
  return v === undefined || (typeof v === "string" && HEX64_RE.test(v.trim().toLowerCase()));
}

/** Structural check on on-chain lock terms.
 *
 *  ⚠ STRICT ON PURPOSE, and stricter than it looks necessary. Every field here
 *  is an input to the escrow ADDRESS, so a sloppy value does not degrade
 *  gracefully — it derives a different address, and the recipient's own
 *  recomputation then rejects the whole lock. Failing at ingest with a clear
 *  "malformed" is far better than admitting a lock that every honest client will
 *  later refuse to believe.
 *
 *  Note this validates SHAPE only. Whether the address actually reproduces from
 *  these terms, and whether the funding outpoint really holds those sats, are
 *  chain questions — answered by the client (recompute + Esplora), never by the
 *  pure reducer, which cannot read the chain. */
function isValidOnchainLockTermsShape(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (typeof t.address !== "string" || t.address.length === 0) return false;
  if (typeof t.fundingTxid !== "string" || !HEX64_RE.test(t.fundingTxid)) return false;
  if (typeof t.fundingVout !== "number" || !Number.isInteger(t.fundingVout) || t.fundingVout < 0) return false;
  // Sats as a decimal STRING: an on-chain escrow can exceed Number.MAX_SAFE_
  // INTEGER in msats, and a float would silently round real money.
  if (typeof t.amountSats !== "string" || !/^\d+$/.test(t.amountSats) || t.amountSats === "0") return false;
  for (const k of ["buyerXonly", "sellerXonly", "arbiterXonly"] as const) {
    if (typeof t[k] !== "string" || !HEX64_RE.test(t[k] as string)) return false;
  }
  // Three distinct keys, or "2-of-3" is a lie.
  if (new Set([t.buyerXonly, t.sellerXonly, t.arbiterXonly]).size !== 3) return false;
  if (t.funder !== "buyer" && t.funder !== "seller") return false;
  // Below 500,000,000 keeps CLTV in the BLOCK-HEIGHT domain (BIP65). A
  // timestamp-domain value would produce a leaf that can never be spent.
  if (typeof t.refundLockUntil !== "number" || !Number.isInteger(t.refundLockUntil)
    || t.refundLockUntil <= 0 || t.refundLockUntil >= 500_000_000) return false;
  if (typeof t.disputeCsvBlocks !== "number" || !Number.isInteger(t.disputeCsvBlocks)
    || t.disputeCsvBlocks < 0 || t.disputeCsvBlocks > 65535) return false;
  // Network is load-bearing: a signet address must never validate against a
  // mainnet trade, or a client could be pointed at play money.
  if (t.network !== "mainnet" && t.network !== "signet") return false;
  return true;
}

function validateJoinEscrowKey(d: Record<string, unknown>): boolean {
  return validEscrowXonly(d.escrowXonly);
}

function validateLockPayload(data: unknown): data is LockPayload {
  // PR 1 atomic-funding: LOCK is self-describing about the buyer and
  // arbiter pubkeys (the chain no longer relies on prior JOIN events
  // to populate participants). Both fields are required.
  // v0.1.71: platformFeeMsats no longer required — it was removed from
  // the LockPayload schema. We accept old LOCKs that still carry the
  // field, we just don't check or use it.
  const d = data as Record<string, unknown>;
  // PR 3 handle reveal (deprecated wire format, accepted on replay):
  // handle / handleId / rail at the top level. PR 4 prefers the
  // envelope path below, but legacy top-level fields still validate.
  // Non-empty string when present.
  if (d.handleId !== undefined && (typeof d.handleId !== "string" || d.handleId.length === 0)) {
    return false;
  }
  if (d.handle !== undefined && (typeof d.handle !== "string" || d.handle.length === 0)) {
    return false;
  }
  if (d.rail !== undefined && (typeof d.rail !== "string" || d.rail.length === 0)) {
    return false;
  }
  // PR 4 handle envelope: optional. When present, must be an object
  // with an encryptedFor map of pubkey → ciphertext (both strings).
  // Empty maps are allowed at the wire level — the consumer decides
  // whether to treat that as "no recipients" or an error. We don't
  // sanity-check pubkey shape here; that's a higher-layer concern.
  if (d.handleEnvelope !== undefined) {
    const env = d.handleEnvelope as Record<string, unknown>;
    if (!env || typeof env !== "object") return false;
    const encFor = env.encryptedFor as Record<string, unknown> | undefined;
    if (!encFor || typeof encFor !== "object") return false;
    for (const [k, v] of Object.entries(encFor)) {
      if (typeof k !== "string" || k.length === 0) return false;
      if (typeof v !== "string" || v.length === 0) return false;
    }
  }
  if (!validateSelectedMenuItems(d.selectedItems)) return false;
  // Arbiter substitution: optional marker, must be a boolean when present
  // (a truthy non-boolean could enable backup voting on a lock whose arbiter
  // share was never actually pooled).
  if (d.arbiterPoolShare !== undefined && typeof d.arbiterPoolShare !== "boolean") {
    return false;
  }
  // v2.3 substitution grace: optional, must be a finite number when present
  // (a non-number could otherwise corrupt the eligibility math on replay).
  // Range is clamped downstream in the reducer; here we only gate the type.
  if (
    d.substitutionGraceSeconds !== undefined &&
    (typeof d.substitutionGraceSeconds !== "number" || !Number.isFinite(d.substitutionGraceSeconds))
  ) {
    return false;
  }
  // ── Tier 2.1: on-chain locks ────────────────────────────────────────────
  // ⭐ ACCEPT-BOTH-SHAPES, with a hard rule about the middle. An ecash lock
  // carries a notesHash + 3 shares; an on-chain lock carries `onchain` terms and
  // NO shares (there are no notes to split). What must never validate is a
  // half-shape — an `onchain` field alongside share-based fields, or an
  // `onchain` field that is malformed. A lock the reducer accepts but cannot
  // fully understand becomes a trade whose state says LOCKED with no reachable
  // money, which is strictly worse than a rejected event.
  const onchain = d.onchain;
  if (onchain !== undefined) {
    if (!isValidOnchainLockTermsShape(onchain)) return false;
    // Shares and a notesHash are meaningless here; an honest on-chain lock
    // carries neither. Refuse the ambiguous hybrid rather than guessing.
    if (Array.isArray(d.shares) && d.shares.length > 0) return false;
    return (
      d.type === "escrow:lock" &&
      typeof d.sellerReceivesMsats === "number" && Number.isFinite(d.sellerReceivesMsats) &&
      typeof d.arbiterFeeMsats === "number" && Number.isFinite(d.arbiterFeeMsats) &&
      typeof d.buyerPubkey === "string" && d.buyerPubkey.length > 0 &&
      typeof d.arbiterPubkey === "string" && d.arbiterPubkey.length > 0 &&
      typeof d.lockedAt === "number"
    );
  }
  return (
    d.type === "escrow:lock" &&
    typeof d.notesHash === "string" &&
    Array.isArray(d.shares) && d.shares.length === 3 &&
    // INVARIANT(arbiter-fee-bounds) — v3.3 (C2): keep the type check and reject
    // only NaN/Infinity (which never appear in an honest payload and would
    // corrupt the sum math). Negatives / fractionals still PARSE — they are
    // sanitized into [0, amount] at the reducer (sanitizeArbiterFeeMsats), so
    // an odd-but-historically-accepted chain stays loadable rather than being
    // rejected at ingest.
    typeof d.sellerReceivesMsats === "number" && Number.isFinite(d.sellerReceivesMsats) &&
    typeof d.arbiterFeeMsats === "number" && Number.isFinite(d.arbiterFeeMsats) &&
    typeof d.buyerPubkey === "string" && d.buyerPubkey.length > 0 &&
    typeof d.arbiterPubkey === "string" && d.arbiterPubkey.length > 0 &&
    typeof d.lockedAt === "number"
  );
}

/** Holder-only shares: structural shape of a VOTE shareEnvelope. The semantic
 *  BINDING (shareIndex matches the voter's role, recipient == engine recipient,
 *  notesHash == lock) is enforced at apply time in handleVote, which has the
 *  escrow state; here we only reject a malformed shape on ingest. */
function isValidVoteShareEnvelopeShape(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.shareIndex !== "number" || !Number.isInteger(e.shareIndex) || e.shareIndex < 0 || e.shareIndex > 2) return false;
  if (typeof e.outcome !== "string" || !Object.values(Outcome).includes(e.outcome as Outcome)) return false;
  if (typeof e.notesHash !== "string") return false;
  if (typeof e.recipientPubkey !== "string" || e.recipientPubkey.length === 0) return false;
  if (!e.encryptedFor || typeof e.encryptedFor !== "object") return false;
  const ef = e.encryptedFor as Record<string, unknown>;
  return typeof ef[e.recipientPubkey as string] === "string";
}

function validateVotePayload(data: unknown): data is VotePayload {
  const d = data as Record<string, unknown>;
  if (d.shareEnvelope !== undefined && !isValidVoteShareEnvelopeShape(d.shareEnvelope)) return false;
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

function validateEnvelope(data: unknown): data is HandleEnvelope {
  const d = data as Record<string, unknown>;
  const encryptedFor = d?.encryptedFor as Record<string, unknown> | undefined;
  return !!encryptedFor &&
    typeof encryptedFor === "object" &&
    !Array.isArray(encryptedFor) &&
    Object.values(encryptedFor).every(v => typeof v === "string");
}

function validateChatAttachment(data: unknown): data is ChatImageAttachment {
  const d = data as Record<string, unknown>;
  return (
    d?.kind === "image" &&
    typeof d.id === "string" &&
    typeof d.mimeType === "string" &&
    d.mimeType.startsWith("image/") &&
    typeof d.dataUrl === "string" &&
    d.dataUrl.startsWith("data:image/") &&
    (d.name === undefined || typeof d.name === "string") &&
    (d.width === undefined || typeof d.width === "number") &&
    (d.height === undefined || typeof d.height === "number") &&
    (d.sizeBytes === undefined || typeof d.sizeBytes === "number")
  );
}

function validateChatPayload(data: unknown): data is ChatPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:chat" &&
    typeof d.message === "string" &&
    (d.attachments === undefined ||
      (Array.isArray(d.attachments) && d.attachments.every(validateChatAttachment))) &&
    (d.bodyEnvelope === undefined || validateEnvelope(d.bodyEnvelope)) &&
    typeof d.senderRole === "string" && Object.values(Role).includes(d.senderRole as Role) &&
    typeof d.sentAt === "number"
  );
}

function validatePremiumPayload(data: unknown): data is PremiumPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:premium" &&
    validateEnvelope(d.noteEnvelope) &&
    typeof d.payerRole === "string" && Object.values(Role).includes(d.payerRole as Role) &&
    (d.noteKind === "ambient" || d.noteKind === "dispute") &&
    typeof d.sentAt === "number"
  );
}

function validateSettlementPayload(data: unknown): data is SettlementPayload {
  const d = data as Record<string, unknown>;
  return (
    d.type === "escrow:settlement" &&
    typeof d.psbt === "string" && d.psbt.length > 0 &&
    (d.leaf === "coop" || d.leaf === "arbiter") &&
    typeof d.role === "string" && Object.values(Role).includes(d.role as Role) &&
    (d.final === undefined || typeof d.final === "boolean")
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

function validatePlanStartPayload(data: unknown): data is PlanStartPayload {
  const d = data as Record<string, unknown>;
  return d.type === "escrow:plan_start"
    && typeof d.planId === "string" && typeof d.termsDigest === "string"
    && Number.isInteger(d.total) && typeof d.totalMsats === "number"
    && typeof d.buyerPubkey === "string" && typeof d.sellerPubkey === "string"
    && typeof d.arbiterPubkey === "string" && typeof d.coordinatorPubkey === "string"
    && (d.bitcoinNetwork === "mainnet" || d.bitcoinNetwork === "signet")
    && (d.settlementPolicy === undefined || typeof d.settlementPolicy === "string")
    && (d.sliceCount === undefined || Number.isInteger(d.sliceCount))
    && (d.sliceCapMsats === undefined || typeof d.sliceCapMsats === "number")
    && Array.isArray(d.tranches)
    && d.tranches.every((t: unknown) => {
      const row = t as Record<string, unknown>;
      return row && Number.isInteger(row.index) && typeof row.amountMsats === "number";
    })
    && typeof d.startedAt === "number";
}

function validateChildKeyPayload(data: unknown): data is ChildKeyPayload {
  const d = data as Record<string, unknown>;
  return d.type === "escrow:child_key" && typeof d.planId === "string"
    && typeof d.parent === "string" && Number.isInteger(d.index)
    && typeof d.role === "string" && Object.values(Role).includes(d.role as Role)
    && (d.bitcoinNetwork === "mainnet" || d.bitcoinNetwork === "signet")
    && typeof d.xOnlyPubkey === "string" && /^[0-9a-f]{64}$/.test(d.xOnlyPubkey)
    && typeof d.publishedAt === "number";
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
  [EscrowEventKind.PREMIUM]:  validatePremiumPayload,
  [EscrowEventKind.SETTLEMENT]: validateSettlementPayload,
  [EscrowEventKind.SUBSCRIBE]:      validateSubscribePayload,
  [EscrowEventKind.PERIOD_RELEASE]: validatePeriodReleasePayload,
  [EscrowEventKind.PLAN_START]: validatePlanStartPayload,
  [EscrowEventKind.CHILD_KEY]: validateChildKeyPayload,
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
  // Separate state events from auxiliary (non-consensus) events. CHAT,
  // PREMIUM, and SETTLEMENT carry no e-tag (prevEventId null) — leaving them in the state
  // bucket would let `find(prevEventId === null)` pick one as the chain
  // ROOT ahead of CREATE, and the replay would fail MISSING_CREATE (trade
  // unloadable). They interleave by timestamp below instead.
  const isAux = (e: ParsedEscrowEvent) =>
    e.kind === EscrowEventKind.CHAT ||
    e.kind === EscrowEventKind.PREMIUM ||
    e.kind === EscrowEventKind.SETTLEMENT;
  const stateEvents = events.filter(e => !isAux(e));
  const chatEvents = events.filter(isAux);

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
    // Relay arrival order is not stable across relays. Orphaned same-kind
    // branches (notably repeated JOIN holds that reference chat/old branch tips)
    // must still replay chronologically so expired holds can be replaced by the
    // newest valid JOIN.
    return a.timestamp - b.timestamp;
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

  // A direct on-chain COMPLETE carries an explicit settlement-proof tag. The
  // final journal and COMPLETE are commonly signed in the same second; pure
  // timestamp interleaving would then place the auxiliary proof after COMPLETE
  // and make replay skip the otherwise valid terminal transition. Move only
  // the specifically linked proof immediately before its COMPLETE event.
  for (let completeIdx = 0; completeIdx < all.length; completeIdx++) {
    const complete = all[completeIdx];
    if (complete.kind !== EscrowEventKind.COMPLETE) continue;
    const proofId = complete.raw.tags.find(tag => tag[0] === "settlement")?.[1];
    if (!proofId) continue;
    const proofIdx = all.findIndex(event => event.raw.id === proofId && event.kind === EscrowEventKind.SETTLEMENT);
    if (proofIdx < 0 || proofIdx === completeIdx - 1) continue;
    const [proof] = all.splice(proofIdx, 1);
    const adjustedCompleteIdx = proofIdx < completeIdx ? completeIdx - 1 : completeIdx;
    all.splice(adjustedCompleteIdx, 0, proof);
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
