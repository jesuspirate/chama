import { useEffect, type ReactNode } from 'react';
import { T } from '../theme.js';

/** Shared by Lightning/ecash funding and direct Bitcoin escrow funding. */
export function FundingModalShell({ onClose, children, label = 'Fund trade' }: { onClose: () => void; children: ReactNode; label?: string }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: '#000e', zIndex: 9998,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, animation: 'fadeIn 0.2s ease' }}>
    <div role="dialog" aria-modal="true" aria-label={label} onClick={event => event.stopPropagation()} style={{
      background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, padding: '20px 16px',
      maxWidth: 420, width: '100%', maxHeight: '92dvh', overflowY: 'auto', boxSizing: 'border-box',
    }}>{children}</div>
  </div>;
}
export function FundingNote({ children }: { children: ReactNode }) {
  return children ? <div role="status" style={{ color: T.muted, fontSize: 12, lineHeight: 1.5, marginTop: 8, overflowWrap: 'anywhere' }}>{children}</div> : null;
}
