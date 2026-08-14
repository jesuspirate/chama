// ══════════════════════════════════════════════════════════════════════════
// Chama v6.0 — ecash mutual-slicing policy (option B: absolute per-slice cap)
// ══════════════════════════════════════════════════════════════════════════
//
// Jet ruled option B (2026-08-13): a HARD absolute per-slice exposure ceiling,
// self-enforced by us — not a relative cap that floats with trade size, and NOT
// delegated to the federation. This module is the single source of truth for
// the cap, the slice-count derivation, and the settlement-policy vocabulary.
//
// PROVENANCE (honest — do not overclaim): the codebase's nearest anchor is
// MAX_LN_FUNDING_SATS = 2_000_000 (payments/fund-and-lock.ts:59), which its own
// comment (#65) labels a *UX steering threshold only — NOT a consensus/protocol
// limit and NOT enforced anywhere in the spend/lock math*. Its sole consumer is
// a funding-UI warning (AtomicFundingModal.tsx:701). So 2M sats is a
// conservative ceiling aligned with the observed practical LN routing limit;
// v6.0 makes it a REAL, self-enforced protocol cap for the first time. We do
// NOT rely on any federation to reject an oversized slice.
//
// The cap closes the raised-threshold hole (Claude, cold-review [7]): the rail
// threshold ONCHAIN_ESCROW_THRESHOLD_SATS is a user-OVERRIDABLE suggestion, not
// a floor — a user who raises it to 5M and runs a 5M ecash trade would, under a
// relative cap, carry 2.5M unsecured on a 2-slice split. Here the derived floor
// forces ceil(5M / 2M) = 3 slices ≈ 1.67M each — under the cap regardless of
// any threshold override.

import { splitTranches } from "./tranche-plan.js";
import type { TrancheDescriptor } from "./types.js";

/** Hard absolute per-slice exposure ceiling, in sats. A party's irreversible
 *  unsecured contribution at any step is ≤ one slice ≤ this many sats. */
export const MAX_SLICE_EXPOSURE_SATS = 2_000_000;

/** The cap in msats (the unit splitTranches / amounts use). */
export const MAX_SLICE_EXPOSURE_MSATS = MAX_SLICE_EXPOSURE_SATS * 1_000;

/** Hard ceiling on a signed sliceCount (cold-review L1, 2026-08-13). Binds the
 *  number of child escrows one plan can spawn so an absurd signed count can't
 *  allocate a huge tranche array when the orchestrator derives the plan.
 *  Generous by construction: at 2M sats/slice a 100-slice plan covers a 200M-sat
 *  trade — far above the ecash rail threshold this rail serves — and matches the
 *  tranche protocol's own 1..100 count bound (tranche-plan.ts validatePlanStart). */
export const MAX_SLICE_COUNT = 100;

/** Settlement-policy vocabulary (versioned, wire-real). The signed
 *  `settlementPolicy` field must AGREE with `escrowMode` — a CREATE whose two
 *  disagree is rejected before any LOCK (SETTLEMENT_POLICY_MODE_MISMATCH). */
export const SETTLEMENT_POLICY_ONCHAIN_FULL = "onchain-full-collateral-single-settlement-v1";
export const SETTLEMENT_POLICY_ECASH_SLICES = "ecash-mutual-slices-v1";

/** The settlement policy implied by an escrowMode when none is stated
 *  (backwards compatibility: every historical trade predates the field). */
export function defaultSettlementPolicy(escrowMode: "ecash" | "onchain"): string {
  return escrowMode === "onchain" ? SETTLEMENT_POLICY_ONCHAIN_FULL : SETTLEMENT_POLICY_ECASH_SLICES;
}

/** True iff a stated settlementPolicy agrees with the stated escrowMode.
 *  `undefined` policy defers to the mode's default (legacy trades). */
export function settlementPolicyMatchesMode(
  settlementPolicy: string | undefined,
  escrowMode: "ecash" | "onchain",
): boolean {
  return (settlementPolicy ?? defaultSettlementPolicy(escrowMode)) === defaultSettlementPolicy(escrowMode);
}

export interface SlicePlanParams {
  /** Total trade amount. */
  totalMsats: number;
  /** The party's preferred slice count (default 2; 1 = single settlement).
   *  This is a PREFERENCE, not a guarantee — the derived floor wins. */
  userCount: number;
}

export interface SlicePlan {
  /** The enforced slice count: max(userCount, ceil(total / cap)). */
  sliceCount: number;
  /** The per-slice descriptors, each ≤ MAX_SLICE_EXPOSURE_MSATS. */
  tranches: TrancheDescriptor[];
  /** The largest single slice — the real per-step unsecured exposure. */
  maxSliceMsats: number;
  /** True when the cap forced sliceCount above the user's preference. */
  capForcedUp: boolean;
}

/** Smallest slice count that keeps every slice ≤ the cap. This is a FLOOR:
 *  the enforced count is max(userCount, this). Pure; no rounding drift because
 *  the cap and total are integers (ceil of exact integer division). */
export function minSlicesForCap(totalMsats: number): number {
  if (!Number.isSafeInteger(totalMsats) || totalMsats <= 0) {
    throw new Error("totalMsats must be a positive safe integer");
  }
  return Math.max(1, Math.ceil(totalMsats / MAX_SLICE_EXPOSURE_MSATS));
}

/** Derive the v6.0 slice plan under option B. The enforced count is
 *  `max(userCount, ceil(total / 2M))` — user preference is honoured only when
 *  it already satisfies the cap; otherwise the cap forces the count UP so no
 *  slice exceeds 2M sats. splitTranches then emits slices of
 *  min(remaining, cap), so every slice is ≤ the cap by construction. */
export function deriveSlicePlan(params: SlicePlanParams): SlicePlan {
  const { totalMsats } = params;
  const { userCount } = params;
  if (!Number.isSafeInteger(userCount) || userCount < 1) {
    throw new Error("userCount must be a positive safe integer (1 = single settlement)");
  }
  if (userCount > MAX_SLICE_COUNT) {
    throw new Error(`userCount exceeds MAX_SLICE_COUNT (${MAX_SLICE_COUNT})`);
  }
  // Cold-review L2: refuse a plan that can't put at least 1 sat in every slice.
  // totalMsats < sliceCount would split into zero-msat children — nonsensical
  // child escrows that would confuse the funding loop (1 msat, user 3 → [1,0,0]).
  // Real trades never approach this (amounts are msats ≫ count).
  if (totalMsats < userCount * 1_000) {
    throw new Error("totalMsats too small for a positive amount in every slice");
  }
  const floor = minSlicesForCap(totalMsats);
  if (floor > MAX_SLICE_COUNT) {
    throw new Error(`totalMsats requires more than MAX_SLICE_COUNT (${MAX_SLICE_COUNT}) slices`);
  }
  const sliceCount = Math.max(userCount, floor);
  // Self-enforcement: cap the per-child maximum at the exposure ceiling. The
  // splitter emits ceil(total/cap) slices when userCount ≤ floor; if the user
  // asked for MORE slices than the floor, each is smaller still (still ≤ cap).
  const tranches = splitTranches(totalMsats, MAX_SLICE_EXPOSURE_MSATS);
  // If the user wants more slices than the cap-minimum, re-split evenly-ish but
  // never above the cap. splitTranches with the cap already yields `floor`
  // slices; to honour a larger userCount we split into userCount equal parts
  // (each necessarily ≤ floor's slice size ≤ cap).
  const finalTranches = sliceCount === tranches.length
    ? tranches
    : splitEven(totalMsats, sliceCount);
  const maxSliceMsats = Math.max(...finalTranches.map(t => t.amountMsats));
  return { sliceCount, tranches: finalTranches, maxSliceMsats, capForcedUp: floor > userCount };
}

/** Split `totalMsats` into exactly `count` positive integer slices differing by
 *  at most 1 msat (largest first). Every slice ≤ ceil(total/count) ≤ cap when
 *  count ≥ minSlicesForCap. Used only when the user requests MORE slices than
 *  the cap-minimum (preference honoured, cap still satisfied). */
function splitEven(totalMsats: number, count: number): TrancheDescriptor[] {
  const base = Math.floor(totalMsats / count);
  const remainder = totalMsats - base * count;
  const out: TrancheDescriptor[] = [];
  for (let index = 0; index < count; index++) {
    out.push({ index, amountMsats: base + (index < remainder ? 1 : 0) });
  }
  return out;
}
