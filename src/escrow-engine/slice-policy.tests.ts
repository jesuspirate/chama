// v6.0 ecash mutual-slicing policy tests — option B (absolute per-slice cap).
import {
  MAX_SLICE_COUNT, MAX_SLICE_EXPOSURE_MSATS, MAX_SLICE_EXPOSURE_SATS, SETTLEMENT_POLICY_ECASH_SLICES,
  SETTLEMENT_POLICY_ONCHAIN_FULL, defaultSettlementPolicy, deriveSlicePlan,
  minSlicesForCap, settlementPolicyMatchesMode,
} from "./slice-policy.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}
function assertThrows(fn: () => unknown, message: string): void {
  try { fn(); } catch { console.log(`  ✓ ${message}`); return; }
  throw new Error(`FAIL (expected throw): ${message}`);
}

console.log("\n── V6 SLICE POLICY (option B) ──");
const M = 1_000; // msats per sat
const SAT = (n: number) => n * M;

// Test #9 boundary cases from the contract: 2M→1, 2M+1→2, 5M→3.
assert(MAX_SLICE_EXPOSURE_MSATS === 2_000_000_000, "cap is 2M sats in msats");
assert(minSlicesForCap(SAT(2_000_000)) === 1, "floor: exactly 2M sats → 1 slice");
assert(minSlicesForCap(SAT(2_000_000) + 1) === 2, "floor: 2M sats + 1 msat → 2 slices");
assert(minSlicesForCap(SAT(5_000_000)) === 3, "floor: 5M sats → 3 slices (raised-threshold hole closed)");
assert(minSlicesForCap(SAT(100_000)) === 1, "floor: a default-threshold trade is a single slice");
assert(minSlicesForCap(1) === 1, "floor: 1 msat → 1 slice");
assertThrows(() => minSlicesForCap(0), "floor: 0 total rejected");
assertThrows(() => minSlicesForCap(-5), "floor: negative total rejected");
assertThrows(() => minSlicesForCap(1.5), "floor: non-integer total rejected");

// Derived floor overrides a smaller user preference (the B rule).
const five = deriveSlicePlan({ totalMsats: SAT(5_000_000), userCount: 2 });
assert(five.sliceCount === 3, "5M trade with userCount=2 is forced UP to 3");
assert(five.capForcedUp === true, "capForcedUp flags the override");
assert(five.maxSliceMsats <= MAX_SLICE_EXPOSURE_MSATS, "no slice exceeds the cap");
assert(five.tranches.reduce((s, t) => s + t.amountMsats, 0) === SAT(5_000_000), "slices preserve the total");
assert(five.tranches.every((t, i) => t.index === i), "slice indices are sequential");

// User preference honoured when it already satisfies the cap.
const ok = deriveSlicePlan({ totalMsats: SAT(100_000), userCount: 2 });
assert(ok.sliceCount === 2 && ok.capForcedUp === false, "userCount=2 under the cap is honoured");
assert(ok.maxSliceMsats <= MAX_SLICE_EXPOSURE_MSATS, "honoured split still under cap");
assert(ok.tranches.reduce((s, t) => s + t.amountMsats, 0) === SAT(100_000), "honoured split preserves total");

// Degenerate single settlement.
const single = deriveSlicePlan({ totalMsats: SAT(50_000), userCount: 1 });
assert(single.sliceCount === 1 && single.tranches.length === 1, "userCount=1 is single settlement");

// A user requesting MORE slices than the floor gets them, all under cap.
const more = deriveSlicePlan({ totalMsats: SAT(5_000_000), userCount: 5 });
assert(more.sliceCount === 5 && more.tranches.length === 5, "userCount above the floor is honoured");
assert(more.maxSliceMsats <= MAX_SLICE_EXPOSURE_MSATS, "even the largest of 5 slices is under cap");
assert(more.tranches.reduce((s, t) => s + t.amountMsats, 0) === SAT(5_000_000), "5-way split preserves total");
const spread = Math.max(...more.tranches.map(t => t.amountMsats)) - Math.min(...more.tranches.map(t => t.amountMsats));
assert(spread <= 1, "even split differs by at most 1 msat");

// Exact-cap multiples and the +1 edge across the floor.
const exact = deriveSlicePlan({ totalMsats: SAT(4_000_000), userCount: 1 });
assert(exact.sliceCount === 2 && exact.maxSliceMsats === MAX_SLICE_EXPOSURE_MSATS, "exact 4M → 2 slices of exactly 2M");
const edge = deriveSlicePlan({ totalMsats: SAT(4_000_000) + 1, userCount: 1 });
assert(edge.sliceCount === 3 && edge.maxSliceMsats <= MAX_SLICE_EXPOSURE_MSATS, "4M+1msat → 3 slices, none over cap");

// Cold-review L1: the signed count is hard-bounded (allocation bound).
assert(MAX_SLICE_COUNT === 100, "slice-count ceiling is 100 (matches the tranche protocol bound)");
assertThrows(() => deriveSlicePlan({ totalMsats: SAT(300_000_000), userCount: MAX_SLICE_COUNT + 1 }),
  "userCount above MAX_SLICE_COUNT rejected");
const atCeiling = deriveSlicePlan({ totalMsats: SAT(200_000_000), userCount: MAX_SLICE_COUNT });
assert(atCeiling.sliceCount === 100 && atCeiling.maxSliceMsats === MAX_SLICE_EXPOSURE_MSATS,
  "exactly MAX_SLICE_COUNT slices of exactly the cap is accepted");
assertThrows(() => deriveSlicePlan({ totalMsats: SAT(200_000_000) + 1, userCount: 1 }),
  "cap-derived floor above MAX_SLICE_COUNT is rejected before tranche allocation");

// Cold-review L2: every slice must carry at least 1 sat — no zero-msat children.
assertThrows(() => deriveSlicePlan({ totalMsats: 1, userCount: 3 }), "1 msat across 3 slices rejected (was [1,0,0])");
assertThrows(() => deriveSlicePlan({ totalMsats: SAT(5) - 1, userCount: 5 }), "1 msat short of 5 slices rejected");
const minimum = deriveSlicePlan({ totalMsats: SAT(5), userCount: 5 });
assert(minimum.tranches.every(t => t.amountMsats >= 1_000), "exactly 1 sat per slice is accepted, no zero-msat slices");
assert(minimum.tranches.reduce((s, t) => s + t.amountMsats, 0) === SAT(5), "minimum split preserves total");

assertThrows(() => deriveSlicePlan({ totalMsats: SAT(100_000), userCount: 0 }), "userCount 0 rejected");
assertThrows(() => deriveSlicePlan({ totalMsats: 0, userCount: 2 }), "0 total rejected");

// Settlement-policy vocabulary + agreement gate.
assert(defaultSettlementPolicy("ecash") === SETTLEMENT_POLICY_ECASH_SLICES, "ecash → slices policy");
assert(defaultSettlementPolicy("onchain") === SETTLEMENT_POLICY_ONCHAIN_FULL, "onchain → full-collateral policy");
assert(settlementPolicyMatchesMode(undefined, "ecash"), "absent policy defers to ecash default (legacy)");
assert(settlementPolicyMatchesMode(undefined, "onchain"), "absent policy defers to onchain default (legacy)");
assert(settlementPolicyMatchesMode(SETTLEMENT_POLICY_ECASH_SLICES, "ecash"), "ecash policy agrees with ecash mode");
assert(!settlementPolicyMatchesMode(SETTLEMENT_POLICY_ONCHAIN_FULL, "ecash"), "onchain policy on ecash mode → mismatch");
assert(!settlementPolicyMatchesMode(SETTLEMENT_POLICY_ECASH_SLICES, "onchain"), "ecash policy on onchain mode → mismatch");
assert(settlementPolicyMatchesMode(SETTLEMENT_POLICY_ONCHAIN_FULL, "onchain"), "onchain policy agrees with onchain mode");

console.log("\nV6 slice-policy tests passed.");
