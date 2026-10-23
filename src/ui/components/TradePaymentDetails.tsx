import { useState, type ReactNode } from 'react';
import type { EscrowState } from '../../escrow-engine/types.js';
import { matchingTradeHandles } from '../../payments/trade-payment-details.js';
import { addSavedHandle } from '../../payments/saved-handles.js';
import { railLabel, railEntryName } from '../../payments/rail-registry.js';
import { useT } from '../../i18n/index.js';
import { T, inputStyle } from '../theme.js';
import { PaymentButton } from './PaymentCard.js';
import { CopyButton } from './CopyButton.js';
import { OverlaySheet } from './OverlaySheet.js';
import { privatePaymentFieldProps } from '../payment-field-autofill.js';

// Jet (6.4.25-rc.7): the Android WebView drew these as the old native
// picker. The choice now opens the app's own overlay, like every other
// picker, and adding new details uses chips. Only the look changed: the
// same ids reach onChange and the same handle is saved.
export function TradePaymentDetailsChoice({ state, value, onChange }: {
  state: EscrowState; value: string; onChange: (value: string) => void;
}) {
  const { t } = useT();
  const methods = state.paymentMethods ?? [];
  const [rail, setRail] = useState(methods[0] ?? '');
  const [handle, setHandle] = useState('');
  const [picking, setPicking] = useState(false);
  const handles = matchingTradeHandles(state);
  // Jet (6.4.31): "send in chat" is gone. Funding needs a real address for
  // one of the agreed methods, so nobody locks without saying where the cash goes.
  const options: Array<{ id: string; label: string }> = handles.map(h => ({ id: h.id, label: `${railEntryName(h.rail)} · ${h.handle}` }));
  const current = options.find(o => o.id === value);
  const choose = (id: string) => { onChange(id); setPicking(false); };
  return <div style={{ display: 'grid', gap: 8, marginBottom: 12, fontFamily: T.sans, fontSize: T.fs.body }}>
    <div style={{ fontSize: T.fs.secondary, fontWeight: 600, color: T.ink2 }}>{t('trade.choosePaymentDetails')}</div>
    <button type="button" data-payment-details-picker aria-haspopup="dialog" aria-label={t('trade.choosePaymentDetails')} onClick={() => setPicking(true)}
      style={{ ...inputStyle, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', cursor: 'pointer', fontWeight: current ? 600 : 400, color: current ? T.ink : T.ink2 }}>
      <span style={{ overflowWrap: 'anywhere' }}>{current ? current.label : t('trade.choosePaymentDetails')}</span>
      <span aria-hidden style={{ color: T.ink2, flexShrink: 0 }}>›</span>
    </button>
    {picking && <OverlaySheet title={t('trade.choosePaymentDetails')} onClose={() => setPicking(false)} showDone={false} showClose>
      <div role="radiogroup" aria-label={t('trade.choosePaymentDetails')} style={{ display: 'grid', gap: 8 }}>
        {options.map(o => <ChoiceRow key={o.id} selected={o.id === value} onClick={() => choose(o.id)}>{o.label}</ChoiceRow>)}
        {value && <ChoiceRow selected={false} onClick={() => choose('')}>{t('trade.addPaymentDetails')}</ChoiceRow>}
      </div>
    </OverlaySheet>}
    {!value && <div style={{ display: 'grid', gap: 8 }}>
      {methods.length > 1 && <div role="radiogroup" aria-label={t('trade.paymentMethod')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {methods.map(key => <button key={key} type="button" role="radio" aria-checked={rail === key} onClick={() => setRail(key)}
          style={{ minHeight: 44, padding: '0 14px', borderRadius: 999, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600, cursor: 'pointer',
            background: rail === key ? T.ink : T.surface, color: rail === key ? T.onInk : T.ink, border: `1px solid ${rail === key ? T.ink : T.borderHi}` }}>{railEntryName(key)}</button>)}
      </div>}
      {methods.length === 1 && <div style={{ fontSize: T.fs.secondary, fontWeight: 600, color: T.ink2 }}>{railEntryName(methods[0])}</div>}
      <input {...privatePaymentFieldProps} name="trade-payment-detail" style={{ ...inputStyle, minHeight: 44 }} aria-label={t('trade.paymentHandle')} value={handle} onChange={e => setHandle(e.target.value)} placeholder={t('trade.paymentHandle')} />
      <PaymentButton type="button" disabled={!rail || !handle.trim()} onClick={() => {
        const saved = addSavedHandle(rail, handle.trim()); onChange(saved.id); setHandle('');
      }}>{t('trade.savePaymentDetails')}</PaymentButton>
    </div>}
  </div>;
}

function ChoiceRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={selected} onClick={onClick}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%', minHeight: 52, padding: '10px 14px',
      borderRadius: T.rs, textAlign: 'left', cursor: 'pointer', fontFamily: T.sans, fontSize: T.fs.body, fontWeight: selected ? 700 : 500,
      background: selected ? T.raised : T.surface, color: T.ink, border: `1px solid ${selected ? T.ink : T.borderHi}` }}>
    <span style={{ overflowWrap: 'anywhere' }}>{children}</span>
    {selected && <span aria-hidden>✓</span>}
  </button>;
}
export function BuyerPaymentDetails({ state }: { state: EscrowState }) {
  const { t } = useT();
  return <div data-buyer-payment-details style={{ display: 'grid', gap: 6, padding: '12px 14px', marginBottom: 16, borderRadius: T.rCard, background: T.raised, color: T.ink, fontFamily: T.sans, fontSize: T.fs.body }}>
    <strong style={{ fontSize: T.fs.headline }}>{t('trade.howToPay')}</strong>
    <div>{(state.paymentMethods ?? []).map(key => railLabel(key)).join(' · ')}</div>
    {state.lock.handle ? <>
      <div>{railLabel(state.lock.handle.rail)}</div>
      <div data-selectable style={{ overflowWrap: 'anywhere', fontSize: T.fs.headline, fontWeight: 600 }}>{state.lock.handle.value}</div><CopyButton value={state.lock.handle.value} />
    </> : <div>{t('trade.detailsInChat')}</div>}
  </div>;
}
