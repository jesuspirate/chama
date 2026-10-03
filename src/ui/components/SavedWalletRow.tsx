import { useT } from '../../i18n/index.js';
import { useState } from 'react';
import { T, inputStyle } from '../theme.js';

/** The receive target stays visible while its optional local name is edited. */
export function SavedWalletRow({ label, detail, onRename, onRemove, onSelect, selected, disabled }: {
  label: string; detail: string; onRename?: (label: string) => void; onRemove?: () => void;
  onSelect?: () => void; selected?: boolean; disabled?: boolean;
}) {
  const { t } = useT();
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const content = <><strong style={{ display: 'block', fontSize: 13 }}>{label}{selected ? ' ✓' : ''}</strong>
    {detail !== label && <span style={{ display: 'block', marginTop: 4, color: T.muted, fontSize: 11, overflowWrap: 'anywhere' }}>{detail}</span>}</>;
  const control = { background: 'none', border: 0, color: T.muted, minHeight: 36, cursor: 'pointer', padding: '4px 8px', fontSize: 12 };
  return <div style={{ border: `1px solid ${selected ? T.accent : T.border}`, borderRadius: T.rs, padding: 10, background: T.surface, minWidth: 0 }}>
    {onSelect ? <button type="button" disabled={disabled} aria-pressed={selected} onClick={onSelect}
      style={{ display: 'block', width: '100%', border: 0, padding: '4px', background: 'none', color: T.text, textAlign: 'left', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1 }}>{content}</button> : <div>{content}</div>}
    {!onSelect && !removing && onRename && onRemove && (editing ? <form onSubmit={event => { event.preventDefault(); onRename(draft); setEditing(false); }}>
      <label style={{ display: 'block', fontSize: 11, color: T.muted }}>{t("claim.walletName")}
        <input autoFocus maxLength={64} value={draft} onChange={event => setDraft(event.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
      </label>
      <button type="submit" style={control}>{t("claim.saveWalletName")}</button><button type="button" style={control} onClick={() => setEditing(false)}>{t("claim.cancelWalletEdit")}</button>
    </form> : <div>
      <button type="button" style={control} onClick={() => { setDraft(label); setEditing(true); }}>{t("claim.renameWallet")}</button>
      <button type="button" style={control} onClick={() => setRemoving(true)}>{t("claim.removeWallet")}</button>
    </div>)}
    {!onSelect && removing && onRemove && <div>
      <p style={{ color: T.muted, fontSize: 12 }}>{t("claim.removeWalletQuestion")}</p>
      <button type="button" style={control} onClick={onRemove}>{t("claim.confirmRemoveWallet")}</button>
      <button type="button" style={control} onClick={() => setRemoving(false)}>{t("claim.keepWallet")}</button>
    </div>}
  </div>;
}
