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
  confirmedUnreservedLiquiditySats: number;      // this device's own confirmed, unreserved sponsor coins
  outstandingSignedCeilingSats: number;          // sum of signed ceilings across this device's other open contracts
  timing: { tipHeight: number; refundHeight: number; W: number; expectedRulingBlocks: number; expectedAppealBlocks: number; safetyMarginBlocks: number };
  maxFeeFractionOfEscrow: number;                // e.g. 0.05
}
export interface AdmissionReport { admitted: boolean; reasons: string[]; numbers: Record<string, number> }

export function admit(i: AdmissionInput): AdmissionReport {
  const reasons: string[] = [];
  const { lowSatPerVb: lo, highSatPerVb: hi } = i.assumedFeeRange;
  if (!(lo > 0 && hi >= lo)) reasons.push("assumed fee range is not a valid interval");
  if (lo < i.minRelaySatPerVb) reasons.push(`assumed low feerate ${lo} below node min relay ${i.minRelaySatPerVb}`);
  // Worst case within the envelope: both stages sponsored at the high rate, plus one eviction increment each.
  const evictionIncrement = Math.ceil(i.minRelaySatPerVb * 153) + 1;
  const worstRuling = Math.ceil(hi * i.stageVsize.ruling) + evictionIncrement;
  const worstAppeal = Math.ceil(hi * i.stageVsize.appeal) + evictionIncrement;
  const worstBoth = worstRuling + worstAppeal;
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
  if (t.W < appealNeeded) reasons.push(`appeal window W=${t.W} < expected appeal ${t.expectedAppealBlocks} + margin ${t.safetyMarginBlocks}`);
  if (t.W < 1 || t.W > 65535) reasons.push("W outside BIP68 block range");
  return { admitted: reasons.length === 0, reasons, numbers: { worstRuling, worstAppeal, worstBoth, feeFractionPct: Math.round(feeFraction * 1000) / 10, liquidityNeeded, rulingWindow, rulingNeeded, appealNeeded } };
}
