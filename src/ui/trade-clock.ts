import { EscrowStatus, Role, NEVER_EXPIRES, hasObservedOnchainDeposit, isLateOnchainDeposit, type EscrowState } from '../escrow-engine/types.js';
import { preLockDeadline } from './decisions.js';
import { disputeStartAt, substitutionEligibleAt } from '../escrow-engine/arbiter-substitution.js';
import { expectedLockerRole } from '../escrow-engine/lock-custody.js';
import type { OnchainObservation } from '../escrow-engine/onchain-attention.js';

export type TradeClock = { kind: 'lock' | 'listing' | 'pay' | 'perform' | 'confirm' | 'dispute'; at: number; role?: Role }
  | { kind: 'confirmation' | 'lock-ready' }
  | { kind: 'refund' | 'appeal'; height: number; tip?: number };
/** No viewer or local arrival time: all parties use the same committed deadline. */
export function tradeClock(state: EscrowState, now: number, chain?: OnchainObservation): TradeClock | null {
  if ([EscrowStatus.COMPLETED, EscrowStatus.CANCELLED].includes(state.status) || chain?.refundSpent || chain?.payout) return null;
  const terms = state.lock?.onchain ?? state.onchainFundingTerms;
  const funder = (terms?.funder ?? expectedLockerRole(state.category)) as Role;
  const refund = (): TradeClock | null => terms ? { kind: 'refund', height: terms.refundLockUntil, tip: chain?.tipHeight } : null;
  if (state.status === EscrowStatus.CREATED && terms && !hasObservedOnchainDeposit(chain)) {
    const deadline = preLockDeadline(state, now);
    return deadline ? {kind: deadline.kind === "hold" ? "lock" : "listing", at: deadline.at, role: funder} : null;
  }
  if (isLateOnchainDeposit(state, chain, now)) return refund();
  if (terms && chain?.tipHeight !== undefined && chain.tipHeight >= terms.refundLockUntil) return refund();
  if (state.status === EscrowStatus.CREATED) {
    if (terms && chain?.deposit === 'confirmed') return { kind: 'lock-ready' };
    if (terms && chain?.deposit === 'seen') return { kind: 'confirmation' };
    const deadline = preLockDeadline(state, now);
    return deadline ? { kind: deadline.kind === 'hold' ? 'lock' : 'listing', at: deadline.at, role: funder } : null;
  }
  const dispute = disputeStartAt(state);
  if (dispute !== null && dispute <= now) {
    if (terms && terms.disputeCsvBlocks > 0 && chain?.fundingHeight !== undefined
      && (chain.tipHeight === undefined || chain.tipHeight < chain.fundingHeight + terms.disputeCsvBlocks))
      return { kind: 'appeal', height: chain.fundingHeight + terms.disputeCsvBlocks, tip: chain.tipHeight };
    const at = substitutionEligibleAt(state);
    if (at !== null && at > now) return { kind: 'dispute', at, role: Role.ARBITER };
    // A passed courtesy deadline is not an invented end to arbitration.
    return refund();
  }
  if (state.status === EscrowStatus.LOCKED && state.lock.lockedAt != null && state.expiresAt !== NEVER_EXPIRES) {
    if (now >= state.expiresAt && terms) return refund();
    const role = funder === Role.SELLER ? Role.BUYER : Role.SELLER;
    return state.votes[role] !== undefined ? { kind: 'confirm', at: state.expiresAt, role: funder }
      : { kind: role === Role.BUYER ? 'pay' : 'perform', at: state.expiresAt, role };
  }
  return refund();
}

export function clockDuration(seconds: number): string {
  const minutes = Math.max(0, Math.ceil(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
export function tradeClockText(clock: TradeClock, now: number, name: (role: Role) => string): string {
  if (clock.kind === 'lock-ready') return 'Deposit confirmed · ready to lock';
  if (clock.kind === 'confirmation') return 'Locks after 1 confirmation';
  if (clock.kind === 'refund' || clock.kind === 'appeal') {
    const approximate = clock.tip === undefined ? '' : ` (≈ ${Math.max(0, Math.ceil((clock.height - clock.tip) / 144))} days)`;
    return `${clock.kind === 'refund' ? 'Refund possible' : 'Arbitrated payout possible'} from block ${clock.height}${approximate}`;
  }
  if (!('at' in clock)) return '';
  if (clock.at <= now) return clock.kind === 'lock' ? 'Lock window ended' : clock.kind === 'listing' ? 'Listing expired' : 'Trade deadline passed';
  const remaining = clockDuration(clock.at - now);
  if (clock.kind === 'listing') return `Listing expires in ${remaining}`;
  const person = name(clock.role!);
  return clock.kind === 'dispute' ? `${person} has ${remaining} before a backup can step in`
    : `${person} has ${remaining} to ${clock.kind === 'lock' ? 'lock' : clock.kind === 'pay' ? 'pay' : clock.kind === 'confirm' ? 'confirm the payment' : 'complete the trade'}`;
}
