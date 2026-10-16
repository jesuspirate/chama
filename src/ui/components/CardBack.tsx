import { T } from '../theme.js';
import { useT } from '../../i18n/index.js';

/** v7 redesign: a drawn chevron + "Back", left-aligned, 48px touch target. */
export function CardBack({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useT();
  return <button type="button" onClick={onClick} disabled={disabled} style={{
    display: 'inline-flex', alignItems: 'center', gap: 2, alignSelf: 'flex-start',
    border: 0, background: 'none', color: disabled ? T.ink3 : T.ink, fontFamily: T.sans,
    fontSize: T.fs.body, minHeight: T.size.touch, padding: '0 8px 0 0', cursor: disabled ? 'default' : 'pointer',
  }}>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    {t("lts.back")}
  </button>;
}
