import { T } from '../theme.js';

/** Identifiers are recovery links, never claims about a trade's date or money. */
export function UnverifiedHistory({ ids, onOpen }: { ids: readonly string[]; onOpen: (id: string) => void }) {
  if (!ids.length) return null;
  return <details style={{ marginTop: 16, color: T.muted, fontFamily: T.sans }}>
    <summary>Unverified history ({ids.length})</summary>
    <p>This device has no signed record of these trades. Missing history may be older than what relays keep.</p>
    <div style={{ display: 'grid', gap: 8 }}>
      {ids.map(id => <button key={id} type="button" onClick={() => onOpen(id)} style={{
        padding: 12, textAlign: 'left', color: T.muted, background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: T.rs, cursor: 'pointer', overflowWrap: 'anywhere',
      }}>
        <span style={{ display: 'block', fontFamily: T.sans }}>{id}</span>
        <span>This device has no signed record of this trade.</span>
      </button>)}
    </div>
  </details>;
}
