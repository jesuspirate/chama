import { useState } from 'react';
import type { EscrowState } from '../../escrow-engine/types.js';
import { listSavedHandles, getSavedHandle } from '../../payments/saved-handles.js';
import { getRailByKey } from '../../payments/rail-registry.js';
import { confirmLockPaymentChoice, enterLockPaymentDetails, handleMatchesTrade, type LockPaymentChoice } from '../../payments/lock-payment-details.js';
import { useT } from '../../i18n/index.js';
import { T } from '../theme.js';
import { OverlaySheet } from '../components/OverlaySheet.js';
export function LockPaymentDetailsModal({ state, initialId, onConfirm, onClose }: {
  state: EscrowState; initialId?: string; onConfirm: (choice: LockPaymentChoice) => void; onClose: () => void;
}) {
  const { t } = useT();
  const handles = listSavedHandles().filter(handle => handleMatchesTrade(handle, state));
  const [selection, setSelection] = useState(initialId && handles.some(h => h.id === initialId) ? initialId : handles[0]?.id ?? 'enter');
  const [rail, setRail] = useState(state.paymentMethods?.[0] ?? '');
  const [value, setValue] = useState(''), [error, setError] = useState<string | null>(null);
  const confirm = () => { try {
    const choice = selection === 'chat' ? confirmLockPaymentChoice(state, { inChat: true })
      : selection === 'enter' ? enterLockPaymentDetails(state, rail, value)
      : confirmLockPaymentChoice(state, { savedHandleId: selection });
    onConfirm(choice);
  } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const selected = getSavedHandle(selection);
  return <OverlaySheet title={t('trade.lockPaymentTitle')} subtitle={t('trade.lockPaymentPrivate')} onClose={onClose}>
    <label style={{ display: 'grid', gap: 8, font: `500 17px ${T.sans}` }}>{t('trade.lockPaymentChoose')}
      <select value={selection} onChange={e => { setSelection(e.target.value); setError(null); }} style={{ minHeight: 48, font: `500 17px ${T.sans}`, background: T.surface, color: T.text }}>
        {handles.map(h => <option key={h.id} value={h.id}>{getRailByKey(h.rail)?.displayName ?? h.rail}</option>)}
        <option value="enter">{t('trade.lockPaymentEnter')}</option><option value="chat">{t('trade.lockPaymentChat')}</option>
      </select>
    </label>
    {selected && <p style={{ overflowWrap: 'anywhere', font: `500 17px ${T.sans}` }}>{selected.handle}</p>}
    {selection === 'enter' && <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
      <select aria-label={t('trade.lockPaymentMethod')} value={rail} onChange={e => setRail(e.target.value)} style={{ minHeight: 48, fontSize: 17 }}>{(state.paymentMethods ?? []).map(key => <option key={key} value={key}>{getRailByKey(key)?.displayName ?? key}</option>)}</select>
      <input aria-label={t('trade.lockPaymentEnter')} autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} placeholder={getRailByKey(rail)?.placeholder} style={{ minHeight: 48, fontSize: 17 }} />
    </div>}
    {selection === 'chat' && <p>{t('trade.lockPaymentChatNote')}</p>}
    {error && <p role="alert" style={{ color: T.red }}>{error}</p>}
    <button type="button" disabled={selection === 'enter' && (!rail || !value.trim())} onClick={confirm} style={{ width: '100%', minHeight: 60, marginTop: 20, background: T.accent, color: T.bg, border: 0, borderRadius: T.r, font: `700 19px ${T.sans}` }}>{t('trade.lockPaymentContinue')}</button>
  </OverlaySheet>;
}
