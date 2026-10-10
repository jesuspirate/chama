import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { InvalidRecoveryCode } from '../../fedimint/seed-backup-v2.js';
import { OverlaySheet } from '../components/OverlaySheet.js';
import { T } from '../theme.js';

/** Secrets live only in this mounted form; no clipboard, logs or persistence. */
export function SeedRecoveryPanel({ needsCode, onRestore, onClose }: {
  needsCode: boolean;
  onRestore: (code: string, confirmed: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT();
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    form.current?.querySelector<HTMLElement>('input, button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const dialog = form.current?.closest('[role="dialog"]');
      const items = Array.from(dialog?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', trap, true);
    return () => { mounted.current = false; window.removeEventListener('keydown', trap, true); previous?.focus(); };
  }, [onClose]);
  return <div style={{ position: 'fixed', inset: 0, zIndex: 10020 }}><OverlaySheet title={t(needsCode ? 'recovery.seed.codeTitle' : 'recovery.seed.restoreAction')} onClose={onClose}>
    {restored ? <p role="status">{t('recovery.seed.restored')}</p> : <form ref={form} onSubmit={async event => {
      event.preventDefault();
      if (inFlight.current || !confirmed || (needsCode && !code.trim())) return;
      inFlight.current = true; setBusy(true); setError(null);
      try {
        await onRestore(code, confirmed);
        if (mounted.current) { setCode(''); setRestored(true); }
      } catch (cause) {
        if (mounted.current) setError(t(cause instanceof InvalidRecoveryCode ? 'recovery.seed.wrongCode' : 'recovery.seed.openError'));
      } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
    }} style={{ fontFamily: T.sans, fontSize: 17, lineHeight: 1.5 }}>
      {needsCode && <label>
        {t('recovery.seed.codeLabel')}
        <input type="password" value={code} onChange={event => setCode(event.target.value)}
          autoComplete="off" autoCorrect="off" spellCheck={false} disabled={busy}
          style={{ display: 'block', boxSizing: 'border-box', width: '100%', fontSize: 19, padding: 12, marginTop: 8 }} />
      </label>}
      <p>{t('recovery.seed.restoreWarning')}</p>
      <label style={{ display: 'flex', gap: 10 }}>
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />
        {t('recovery.seed.restoreConfirm')}
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || !confirmed || (needsCode && !code.trim())}
        style={{ width: '100%', minHeight: 60, fontSize: 19, marginTop: 16, borderRadius: T.rs, background: T.text, color: T.bg }}>
        {t(busy ? 'recovery.seed.restoring' : 'recovery.seed.restoreAction')}
      </button>
    </form>}
  </OverlaySheet></div>;
}
