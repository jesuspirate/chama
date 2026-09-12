// Setup ADMISSION report for one contract. RESEARCH. Pure: no RPC, no side effects.
//
// A policy check against stated operating assumptions, not proof against future
// congestion. It answers: given what this device holds and assumes, should it
// enter this contract at all? Reject outside the envelope; never silently shrink it.
export interface AdmissionInput {
  escrowSats: number;
  capSats: number;                               // hard per-contract fee cap this device would commit to
  assumedFeeRange: { lowSatPerVb: number; highSatPerVb: number };   // the operating assumption, chosen by the operator
  stageVsize: { ruling: number; appeal: number };                    // parent + anchor child vsize per stage
  minRelaySatPerVb: number;
  competingFeeCeilingSats?: { ruling: number; appeal: number }; // optional explicit bound on adversarial absolute fee offers
  confirmedUnreservedLiquiditySats: number;      // this device's own confirmed, unreserved sponsor coins
  outstandingSignedCeilingSats: number;          // sum of signed ceilings across this device's other open contracts
  timing: { tipHeight: number; refundHeight: number; W: number; expectedRulingBlocks: number; expectedAppealBlocks: number; safetyMarginBlocks: number };
  maxFeeFractionOfEscrow: number;                // e.g. 0.05
}
export interface AdmissionReport { admitted: boolean; reasons: string[]; caveats?: string[]; numbers: Record<string, number> }

export function admit(i: AdmissionInput): AdmissionReport {
  const reasons: string[] = [];
  if (!i || !i.assumedFeeRange || !i.stageVsize || !i.timing) return { admitted: false, reasons: ["missing policy structure"], numbers: {} };
  const integer = (name: string, v: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isSafeInteger(v) || v < min || v > max) reasons.push(`invalid ${name}`);
  };
  integer("escrowSats", i.escrowSats, 1, 2100000000000000);
  integer("capSats", i.capSats, 0, 2100000000000000);
  integer("confirmedUnreservedLiquiditySats", i.confirmedUnreservedLiquiditySats, 0, 2100000000000000);
  integer("outstandingSignedCeilingSats", i.outstandingSignedCeilingSats, 0, 2100000000000000);
  integer("stageVsize.ruling", i.stageVsize.ruling, 1, 1000000);
  integer("stageVsize.appeal", i.stageVsize.appeal, 1, 1000000);
  integer("tipHeight", i.timing.tipHeight, 0, 499999999);
  integer("refundHeight", i.timing.refundHeight, 1, 499999999);
  integer("W", i.timing.W, 1, 65535);
  for (const k of ["expectedRulingBlocks", "expectedAppealBlocks", "safetyMarginBlocks"] as const) integer(k, i.timing[k], 0);
  for (const [name, v] of [["low feerate", i.assumedFeeRange.lowSatPerVb], ["high feerate", i.assumedFeeRange.highSatPerVb], ["min relay", i.minRelaySatPerVb]] as const) if (!Number.isFinite(v) || v <= 0) reasons.push(`invalid ${name}`);
  if (!Number.isFinite(i.maxFeeFractionOfEscrow) || i.maxFeeFractionOfEscrow <= 0 || i.maxFeeFractionOfEscrow > 1) reasons.push("invalid fee fraction limit");
  if (i.competingFeeCeilingSats) { integer("competing fee ruling", i.competingFeeCeilingSats.ruling, 0, 2100000000000000); integer("competing fee appeal", i.competingFeeCeilingSats.appeal, 0, 2100000000000000); }
  if (reasons.length) return { admitted: false, reasons, numbers: {} };
  const { lowSatPerVb: lo, highSatPerVb: hi } = i.assumedFeeRange;
  if (!(lo > 0 && hi >= lo)) reasons.push("assumed fee range is not a valid interval");
  if (lo < i.minRelaySatPerVb) reasons.push(`assumed low feerate ${lo} below node min relay ${i.minRelaySatPerVb}`);
  // Own-package rate estimate; an adversarial absolute-fee bound must be stated separately.
  const evictionIncrement = Math.ceil(i.minRelaySatPerVb * 153) + 1;
  const worstRuling = Math.max(Math.ceil(hi * i.stageVsize.ruling), i.competingFeeCeilingSats?.ruling ?? 0) + evictionIncrement;
  const worstAppeal = Math.max(Math.ceil(hi * i.stageVsize.appeal), i.competingFeeCeilingSats?.appeal ?? 0) + evictionIncrement;
  const worstBoth = worstRuling + worstAppeal;
  if (!Number.isSafeInteger(worstBoth)) return { admitted: false, reasons: ["fee estimate exceeds safe arithmetic range"], numbers: {} };
  if (i.capSats < worstBoth) reasons.push(`cap ${i.capSats} < worst-case both stages at ${hi} sat/vB (${worstBoth})`);
  const feeFraction = i.capSats / i.escrowSats;
  if (feeFraction > i.maxFeeFractionOfEscrow) reasons.push(`cap is ${(feeFraction * 100).toFixed(1)}% of escrow, above the ${(i.maxFeeFractionOfEscrow * 100).toFixed(1)}% limit`);
  // Liquidity: this contract's cap on top of what other open contracts may still draw, plus dust for change.
  const liquidityNeeded = i.capSats + i.outstandingSignedCeilingSats + 330;
  if (i.confirmedUnreservedLiquiditySats < liquidityNeeded) reasons.push(`confirmed unreserved liquidity ${i.confirmedUnreservedLiquiditySats} < needed ${liquidityNeeded} (cap + outstanding ceilings + dust)`);
  // Time: the ruling must be confirmable before the refund becomes eligible; the appeal before the default award.
  const t = i.timing;
  const rulingWindow = t.refundHeight - t.tipHeight;                 // blocks until the refund can be included
  const rulingNeeded = t.expectedRulingBlocks + t.safetyMarginBlocks;
  if (rulingWindow < rulingNeeded) reasons.push(`refund window ${rulingWindow} blocks < expected ruling ${t.expectedRulingBlocks} + margin ${t.safetyMarginBlocks}`);
  const appealNeeded = t.expectedAppealBlocks + t.safetyMarginBlocks;
  if (t.W - 1 < appealNeeded) reasons.push(`exclusive appeal window W-1=${t.W - 1} < expected appeal ${t.expectedAppealBlocks} + margin ${t.safetyMarginBlocks}`);
  if (t.W < 1 || t.W > 65535) reasons.push("W outside BIP68 block range");
  return { admitted: reasons.length === 0, reasons, caveats: i.competingFeeCeilingSats ? ["competing absolute-fee bounds are assumptions, not enforcement"] : ["no competing absolute-fee bound: rate estimate alone does not cover adversarial replacement costs"], numbers: { worstRuling, worstAppeal, worstBoth, feeFractionPct: Math.round(feeFraction * 1000) / 10, liquidityNeeded, rulingWindow, rulingNeeded, appealNeeded } };
}
