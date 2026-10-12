import { bondManageActions, type BondChainObservation } from '../../bond-multisig/manage-actions.js';
import type { CommitmentRecord } from '../../bond-multisig/commitment-store.js';
import { useT } from '../../i18n/index.js';
import { PaymentButton } from './PaymentCard.js';

export function BondManageActions({ rec, chain, busy, onAnnounce, onAdd, onClaim }: {
  rec: CommitmentRecord; chain: BondChainObservation | null; busy?: boolean;
  onAnnounce?: () => void; onAdd: () => void; onClaim: () => void;
}) {
  const { t } = useT();
  const actions = bondManageActions(rec, chain);
  const reason = (value: typeof actions.claim) => value.reason === 'term-open'
    ? t('bond.claimAtBlock', { block: rec.bond.lockUntil })
    : t(value.reason === 'reclaimed' ? 'bond.alreadyClaimed'
      : value.reason === 'not-active' ? 'bond.announceWhenActive'
      : value.reason === 'unfunded' ? 'bond.nothingConfirmed' : 'bond.checkChainFirst');
  return <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
    <PaymentButton disabled={busy || !actions.announce.enabled || !onAnnounce} onClick={onAnnounce}>{t('bond.announceAgain')}</PaymentButton>
    {!actions.announce.enabled && <div>{reason(actions.announce)}</div>}
    <PaymentButton tier="quiet" disabled={busy || !actions.add.enabled} onClick={onAdd}>{t('bond.postAdditionalBond')}</PaymentButton>
    <PaymentButton tier="quiet" disabled={busy || !actions.claim.enabled} onClick={onClaim}>{t('bond.reclaimMyBond')}</PaymentButton>
    {!actions.claim.enabled && <div>{reason(actions.claim)}</div>}
  </div>;
}
