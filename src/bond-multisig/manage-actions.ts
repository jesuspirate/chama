import type { CommitmentRecord } from './commitment-store.js';
export interface BondChainObservation { tip: number; unspent: boolean }
export interface BondManageAction { enabled: boolean; reason?: 'chain-unknown' | 'not-active' | 'reclaimed' | 'term-open' | 'unfunded' }
export function bondManageActions(rec: CommitmentRecord, chain: BondChainObservation | null): {
  announce: BondManageAction; add: BondManageAction; claim: BondManageAction;
} {
  const add = { enabled: true };
  if (rec.phase === 'reclaimed' || rec.renewalToBondId) return {
    announce: { enabled: false, reason: 'reclaimed' }, add, claim: { enabled: false, reason: 'reclaimed' },
  };
  if (!chain || !Number.isSafeInteger(chain.tip) || chain.tip < 0) return {
    announce: { enabled: false, reason: 'chain-unknown' }, add, claim: { enabled: false, reason: 'chain-unknown' },
  };
  if (rec.phase !== 'locked' || !chain.unspent) return {
    announce: { enabled: false, reason: 'not-active' }, add, claim: { enabled: false, reason: 'unfunded' },
  };
  const expired = chain.tip >= rec.bond.lockUntil;
  return { announce: { enabled: !expired, ...(expired ? { reason: 'not-active' as const } : {}) },
    add, claim: { enabled: expired, ...(!expired ? { reason: 'term-open' as const } : {}) } };
}
export function assertBondClaimReady(rec: CommitmentRecord, chain: BondChainObservation | null): void {
  if (!bondManageActions(rec, chain).claim.enabled) throw new Error('This bond is not yet confirmed claimable on Bitcoin.');
}
