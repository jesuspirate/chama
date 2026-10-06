import { useState } from 'react';
import type { EscrowState } from '../../escrow-engine/types.js';
import { matchingTradeHandles } from '../../payments/trade-payment-details.js';
import { addSavedHandle } from '../../payments/saved-handles.js';
import { getRailByKey } from '../../payments/rail-registry.js';
import { useT } from '../../i18n/index.js';
import { T, inputStyle } from '../theme.js';
import { PaymentButton } from './PaymentCard.js';
import { CopyButton } from './CopyButton.js';

export const CHAT_PAYMENT_CHOICE = 'chat';
export function TradePaymentDetailsChoice({ state, value, onChange }: {
  state: EscrowState; value: string; onChange: (value: string) => void;
}) {
  const { t } = useT();
  const [rail, setRail] = useState(state.paymentMethods?.[0] ?? '');
  const [handle, setHandle] = useState('');
  const handles = matchingTradeHandles(state);
  return <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
    <label>{t('trade.choosePaymentDetails')}
      <select style={{ ...inputStyle, minHeight: 44, marginTop: 6 }} aria-label={t('trade.choosePaymentDetails')} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{t('trade.choosePaymentDetails')}</option>
        {handles.map(h => <option key={h.id} value={h.id}>{getRailByKey(h.rail)?.displayName ?? h.rail} · {h.handle}</option>)}
        <option value={CHAT_PAYMENT_CHOICE}>{t('trade.sendDetailsInChat')}</option>
      </select>
    </label>
    {!value && <div style={{ display: 'grid', gap: 8 }}>
      <select style={{ ...inputStyle, minHeight: 44, marginTop: 6 }} aria-label={t('trade.paymentMethod')} value={rail} onChange={e => setRail(e.target.value)}>
        {(state.paymentMethods ?? []).map(key => <option key={key} value={key}>{getRailByKey(key)?.displayName ?? key}</option>)}
      </select>
      <input style={{ ...inputStyle, minHeight: 44 }} aria-label={t('trade.paymentHandle')} value={handle} onChange={e => setHandle(e.target.value)} placeholder={t('trade.paymentHandle')} />
      <PaymentButton type="button" disabled={!rail || !handle.trim()} onClick={() => {
        const saved = addSavedHandle(rail, handle.trim()); onChange(saved.id); setHandle('');
      }}>{t('trade.savePaymentDetails')}</PaymentButton>
    </div>}
  </div>;
}
export function BuyerPaymentDetails({ state }: { state: EscrowState }) {
  const { t } = useT();
  return <div style={{ padding: 12, color: T.text }}>
    <strong>{t('trade.howToPay')}</strong>
    <div>{(state.paymentMethods ?? []).map(key => getRailByKey(key)?.displayName ?? key).join(' · ')}</div>
    {state.lock.handle ? <>
      <div>{getRailByKey(state.lock.handle.rail ?? '')?.displayName ?? state.lock.handle.rail}</div>
      <div>{state.lock.handle.value}</div><CopyButton value={state.lock.handle.value} />
    </> : <div>{t('trade.detailsInChat')}</div>}
  </div>;
}
