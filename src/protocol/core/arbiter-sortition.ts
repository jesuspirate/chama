// ══════════════════════════════════════════════════════════════════════════
// Protocol core — arbiter sortition (selection v2, library only)
// ══════════════════════════════════════════════════════════════════════════
//
// Stage 1 of the bonded-sortition arbiter plan. Pure functions only: nothing
// in the app calls them yet, no event carries their inputs yet, and no trade
// or money path changes. The legacy pick in arbiter-pick.ts stays the rule for
// every existing and new trade until a later, versioned change wires this in.
//
// Why a new rule: the legacy pick sums the char codes of the escrow id, which
// the creator chooses, so the creator can grind ids until a chosen arbiter
// lands. Here the seat comes from a seed neither party controls alone:
//
//   seed = SHA256(tag ‖ sellerNonce ‖ buyerNonce ‖ len(escrowId) ‖ escrowId ‖ round)
//
// The seller commits to sellerNonce (SHA256(nonceTag ‖ nonce)) before the
// buyer picks buyerNonce, and reveals it after. Either party can still walk
// away instead of revealing; the plan counts that as one of their redraws.
//
// The draw is uniform over the eligible set, not weighted by bond: bond sets
// how much an arbiter may take on (capacity), and weighting by it as well would
// let the largest bond dominate small trades.
//
// Panels (stage 6 of the plan, appeals) expand the same seed: index i comes
// from SHA256(panelTag ‖ seed ‖ i). They are pinned here so the vectors in
// docs/conformance/arbiter-sortition-vectors.json cover them from the start.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** Selection rule version this module implements. Legacy pick = 1. */
export const ARBITER_SORTITION_VERSION = 2;

/** Domain-separation tags. Changing any of them changes every draw. */
export const SORTITION_SEED_TAG = "chama/arbiter-sortition/v2/seed";
export const SORTITION_NONCE_TAG = "chama/arbiter-sortition/v2/nonce";
export const SORTITION_PANEL_TAG = "chama/arbiter-sortition/v2/panel";

/** Spec defaults (Chama Arbiter Module Spec, Parameters). Tunable later. */
export const SORTITION_DEFAULTS = Object.freeze({
  /** Bond must be at least kCase × the trade value. */
  kCase: 3,
  /** Open exposure plus this trade must stay within kTotal × bond. */
  kTotal: 1,
  /** Fewer eligible arbiters than this and the draw refuses. */
  minPool: 5,
  /** Most keys either party may exclude in advance. */
  maxExclude: 8,
});

const HEX64 = /^[0-9a-f]{64}$/;

/** Lowercase, validated 32-byte hex (x-only pubkey or nonce). */
function normHex32(value: string, what: string): string {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HEX64.test(v)) throw new Error(`${what} must be 32 bytes of hex`);
  return v;
}

function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("round must be a u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Index in [0, n) from the first 8 bytes of a hash. Bias is below 2^-50 for n ≤ 2^14. */
function indexFrom(hash: Uint8Array, n: number): number {
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(hash[i]);
  return Number(x % BigInt(n));
}

// ── Commit-reveal ───────────────────────────────────────────────────────────

/** The commitment a party publishes before the other party chooses. Hex. */
export function sortitionNonceCommitment(nonceHex: string): string {
  const nonce = hexToBytes(normHex32(nonceHex, "nonce"));
  return bytesToHex(sha256(concat(utf8ToBytes(SORTITION_NONCE_TAG), nonce)));
}

/** True when `nonceHex` opens `commitmentHex`. Never throws on bad input. */
export function verifySortitionNonce(commitmentHex: string, nonceHex: string): boolean {
  try {
    return sortitionNonceCommitment(nonceHex) === normHex32(commitmentHex, "commitment");
  } catch {
    return false;
  }
}

// ── Seed ────────────────────────────────────────────────────────────────────

export interface SortitionSeedInput {
  /** 32-byte hex the seller committed to, now revealed. */
  sellerNonce: string;
  /** 32-byte hex the buyer chose after seeing the seller's commitment. */
  buyerNonce: string;
  /** The trade's escrow id, as signed in CREATE. */
  escrowId: string;
  /** 0 for the first draw; +1 per redraw (veto, refusal, timeout). */
  round: number;
}

/** 32-byte seed. Every input is length-delimited, so no two inputs collide. */
export function deriveSortitionSeed(input: SortitionSeedInput): Uint8Array {
  const seller = hexToBytes(normHex32(input.sellerNonce, "sellerNonce"));
  const buyer = hexToBytes(normHex32(input.buyerNonce, "buyerNonce"));
  if (typeof input.escrowId !== "string" || input.escrowId.length === 0) {
    throw new Error("escrowId must be a non-empty string");
  }
  const id = utf8ToBytes(input.escrowId);
  return sha256(concat(
    utf8ToBytes(SORTITION_SEED_TAG),
    seller,
    buyer,
    u32be(id.length),
    id,
    u32be(input.round),
  ));
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/** One arbiter as the caller has already verified it (chain-checked bond). */
export interface SortitionCandidate {
  /** x-only pubkey, hex. */
  pubkey: string;
  /** Verified, funded bond in sats (sum across the arbiter's live bonds). */
  bondSats: number;
  /** Sats of open trades this arbiter already backs. */
  openExposureSats: number;
  /** Block height at which the bond becomes reclaimable by its owner. */
  bondMaturityHeight: number;
  /** Asking fee in basis points of trade value, if the arbiter publishes one. */
  feeBps?: number;
  /** Event-derived score in [0, 1], if the caller computes one. */
  score?: number;
}

/** What both parties agreed to (stage 3 of the plan signs this on CREATE). */
export interface SortitionFilter {
  kCase?: number;
  kTotal?: number;
  maxFeeBps?: number;
  minScore?: number;
  /** Up to SORTITION_DEFAULTS.maxExclude keys either party refuses. */
  exclude?: readonly string[];
}

export interface SortitionTrade {
  valueSats: number;
  buyer: string;
  seller: string;
  /** The bond must stay locked past this height (refund height + dispute window). */
  mustCoverHeight: number;
  /** Keys already seated in this trade in an earlier round. */
  previouslySeated?: readonly string[];
}

function isSats(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * The eligible set, sorted by pubkey. Pure and order-independent: the same
 * candidates in any order, in any letter case, give the same list. A
 * candidate with a malformed key or amount is skipped, never thrown on, so one
 * bad record can't block a draw for everyone else. Duplicate keys keep the
 * entry with the largest bond (the caller should aggregate; this is a guard).
 */
export function eligibleSortitionArbiters(
  candidates: readonly SortitionCandidate[],
  trade: SortitionTrade,
  filter: SortitionFilter = {},
): string[] {
  const kCase = filter.kCase ?? SORTITION_DEFAULTS.kCase;
  const kTotal = filter.kTotal ?? SORTITION_DEFAULTS.kTotal;
  if (!(kCase > 0) || !(kTotal > 0)) throw new Error("kCase and kTotal must be positive");
  if (!isSats(trade.valueSats) || trade.valueSats === 0) throw new Error("valueSats must be a positive integer");
  if (!Number.isSafeInteger(trade.mustCoverHeight) || trade.mustCoverHeight < 0) {
    throw new Error("mustCoverHeight must be a block height");
  }
  const exclude = filter.exclude ?? [];
  if (exclude.length > SORTITION_DEFAULTS.maxExclude) {
    throw new Error(`at most ${SORTITION_DEFAULTS.maxExclude} excluded keys`);
  }

  const lower = (k: string) => (typeof k === "string" ? k.trim().toLowerCase() : "");
  const barred = new Set<string>([
    lower(trade.buyer),
    lower(trade.seller),
    ...exclude.map(lower),
    ...(trade.previouslySeated ?? []).map(lower),
  ]);

  const best = new Map<string, SortitionCandidate>();
  for (const c of candidates) {
    const pk = lower(c?.pubkey);
    if (!HEX64.test(pk)) continue;
    const prev = best.get(pk);
    if (!prev || (isSats(c.bondSats) && (!isSats(prev.bondSats) || c.bondSats > prev.bondSats))) {
      best.set(pk, c);
    }
  }

  const out: string[] = [];
  for (const [pk, c] of best) {
    if (barred.has(pk)) continue;
    if (!isSats(c.bondSats) || !isSats(c.openExposureSats)) continue;
    if (!Number.isSafeInteger(c.bondMaturityHeight)) continue;
    if (c.bondMaturityHeight <= trade.mustCoverHeight) continue;
    if (c.bondSats < kCase * trade.valueSats) continue;
    if (c.openExposureSats + trade.valueSats > kTotal * c.bondSats) continue;
    if (filter.maxFeeBps !== undefined && c.feeBps !== undefined && !(c.feeBps <= filter.maxFeeBps)) continue;
    if (filter.minScore !== undefined && filter.minScore > 0 && !((c.score ?? 0) >= filter.minScore)) continue;
    out.push(pk);
  }
  return out.sort();
}

// ── Draw ────────────────────────────────────────────────────────────────────

export type SortitionDraw =
  | { ok: true; arbiter: string; index: number; poolSize: number }
  | { ok: false; reason: "POOL_TOO_SMALL"; poolSize: number; minPool: number };

/**
 * One arbiter from the eligible set. Refuses below `minPool` rather than
 * seating from a pool too small for chance to mean anything; the caller
 * decides the fallback.
 */
export function drawSortitionArbiter(
  eligible: readonly string[],
  seed: Uint8Array,
  minPool: number = SORTITION_DEFAULTS.minPool,
): SortitionDraw {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("seed must be 32 bytes");
  const pool = [...new Set(eligible.map((k) => normHex32(k, "eligible key")))].sort();
  if (pool.length === 0 || pool.length < minPool) {
    return { ok: false, reason: "POOL_TOO_SMALL", poolSize: pool.length, minPool };
  }
  const index = indexFrom(seed, pool.length);
  return { ok: true, arbiter: pool[index], index, poolSize: pool.length };
}

/**
 * A panel of `size` distinct arbiters from the same seed, skipping `skip`
 * (everyone who ruled in an earlier round). Returns null when the pool, after
 * skips, is smaller than the panel. Tries indices i = 0, 1, … until the panel
 * is full; the bound below is far past what a full panel needs in practice.
 */
export function drawSortitionPanel(
  eligible: readonly string[],
  seed: Uint8Array,
  size: number,
  skip: readonly string[] = [],
): string[] | null {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("seed must be 32 bytes");
  if (!Number.isInteger(size) || size < 1) throw new Error("panel size must be a positive integer");
  const skipped = new Set(skip.map((k) => (typeof k === "string" ? k.trim().toLowerCase() : "")));
  const pool = [...new Set(eligible.map((k) => normHex32(k, "eligible key")))].sort();
  const available = pool.filter((k) => !skipped.has(k));
  if (available.length < size) return null;

  const tag = utf8ToBytes(SORTITION_PANEL_TAG);
  const panel: string[] = [];
  const chosen = new Set<string>();
  const maxTries = 64 * pool.length + 1024;
  for (let i = 0; i < maxTries && panel.length < size; i++) {
    const k = pool[indexFrom(sha256(concat(tag, seed, u32be(i))), pool.length)];
    if (skipped.has(k) || chosen.has(k)) continue;
    chosen.add(k);
    panel.push(k);
  }
  return panel.length === size ? panel : null;
}
