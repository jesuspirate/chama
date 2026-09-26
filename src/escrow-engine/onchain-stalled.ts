import { EscrowStatus, Outcome, Role, type EscrowState } from './types.js';
import { payoutRecipientFor } from './recipients.js';
import { winnerSettlementChoice } from './onchain-settlement-choice.js';

export const STALLED_PAYOUT_WAIT = 86_400;
export function stalledPayoutEligibility(state: EscrowState, now: number) {
  if (!state.lock.onchain || state.status !== EscrowStatus.APPROVED || state.resolvedOutcome !== Outcome.RELEASE
    || state.resolvedMajority?.includes(Role.ARBITER) || state.settlementStalled || state.resolvedAt == null) return null;
  const winner = payoutRecipientFor(state, Outcome.RELEASE);
  if (!winner) return null;
  const other = winner.role === Role.BUYER ? Role.SELLER : Role.BUYER;
  if (state.votes[other] !== Outcome.RELEASE) return null;
  const choice = winnerSettlementChoice(state);
  if (!choice || choice.locked) return null;
  const availableAt = state.resolvedAt + STALLED_PAYOUT_WAIT;
  return { winner, other, choice, availableAt, ready: now >= availableAt };
}
