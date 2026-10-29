import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { OverlaySheet } from '../components/OverlaySheet.js';
import { T } from '../theme.js';

/** Audit M9: the key kept on this device is stored but can't be opened right
 *  now. Never shown as "no key": Retry reads it again, and signing in another
 *  way keeps the stored key aside (saved-nsec.ts archives it first). */
export function SavedKeyUnreadablePanel({ onRetry, onSignInAnotherWay }: {
  /** Resolves false when the key still won't open. */
  onRetry: () => Promise<boolean>;
  onSignInAnotherWay: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [stillLocked, setStillLocked] = useState(false);
  return <div style={{ position: 'fixed', inset: 0, zIndex: 10020 }} data-saved-key-unreadable>
    <OverlaySheet title={t('recovery.savedKey.unreadableTitle')} onClose={onSignInAnotherWay} dismissible={!busy} showDone={false}>
      <div style={{ fontFamily: T.sans, fontSize: 17, lineHeight: 1.5 }}>
        <p>{t('recovery.savedKey.unreadableBody')}</p>
        <button type="button" disabled={busy} data-saved-key-retry onClick={async () => {
          setBusy(true);
          setStillLocked(false);
          try { setStillLocked(!(await onRetry())); } catch { setStillLocked(true); } finally { setBusy(false); }
        }} style={{ width: '100%', minHeight: 60, fontSize: 19, marginTop: 8, borderRadius: T.rs, background: T.text, color: T.bg }}>
          {t(busy ? 'recovery.savedKey.retrying' : 'recovery.savedKey.retry')}
        </button>
        {stillLocked && <p role="alert" data-saved-key-still-locked>{t('recovery.savedKey.stillUnreadable')}</p>}
        <button type="button" disabled={busy} data-saved-key-other onClick={onSignInAnotherWay}
          style={{ width: '100%', minHeight: 52, fontSize: 17, marginTop: 12, borderRadius: T.rs, background: 'transparent', color: T.text, border: `1px solid ${T.border}` }}>
          {t('recovery.savedKey.signInAnotherWay')}
        </button>
        <p style={{ fontSize: 15, color: T.muted, marginTop: 12 }}>{t('recovery.savedKey.anotherWayNote')}</p>
      </div>
    </OverlaySheet>
  </div>;
}
