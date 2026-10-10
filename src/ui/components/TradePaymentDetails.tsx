import type { EscrowState } from '../../escrow-engine/types.js';
import { handleDisplayForViewer } from '../../payments/saved-handles.js';
import { getRailByKey } from '../../payments/rail-registry.js';
import { needsLockPaymentDetails } from '../../payments/lock-payment-details.js';
import { useT } from '../../i18n/index.js';
import { CopyButton } from './CopyButton.js';
import { T } from '../theme.js';
/** Only rendered for participants; details are read from the committed LOCK. */
export function TradePaymentDetails({ state }: { state: EscrowState }) {
  const { t } = useT();
  if (!needsLockPaymentDetails(state) && !state.lock.handle) return null;
  const handle = state.lock.handle;
  return <section data-trade-payment-details style={{ marginTop: 16, font: `500 17px ${T.sans}`, lineHeight: 1.5 }}>
    <h3 style={{ fontSize: 18 }}>{t('trade.lockPaymentHow')}</h3>
    {handle ? <><div>{getRailByKey(handle.rail ?? '')?.displayName ?? handle.rail}</div><div style={{ overflowWrap: 'anywhere' }}>{handleDisplayForViewer(handle.value, true)}</div><CopyButton value={handle.value}/><div>{handle.networks?.map(key => getRailByKey(key)?.displayName ?? key).join(" · ")}</div></>
      : <><div>{(state.paymentMethods ?? []).map(key => getRailByKey(key)?.displayName ?? key).join(' · ') || t('trade.lockPaymentMethodUnknown')}</div><p>{t('trade.lockPaymentAskChat')}</p></>}
  </section>;
}
