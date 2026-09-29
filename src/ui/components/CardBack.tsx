import { T } from '../theme.js';

export function CardBack({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} aria-label="Back" style={{
    border: 0, background: 'none', color: T.muted, fontFamily: T.sans,
    fontSize: 13, minHeight: 44, padding: '0 8px 0 0', cursor: disabled ? 'default' : 'pointer',
  }}>‹ Back</button>;
}
