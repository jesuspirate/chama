import { useEffect, useState, type ReactNode } from 'react';
import { readAvatar } from '../avatars.js';
import { T } from '../theme.js';
export function ProfileAvatar({ pubkey, fallback, size = 36 }: { pubkey: string | null; fallback: ReactNode; size?: number }) {
  const [revision, refresh] = useState(0);
  const [failures, setFailures] = useState(0);
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const update = () => { refresh(n => n + 1); setFailures(0); };
    window.addEventListener('chama-avatar',update);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches); media.addEventListener('change',motion);
    return () => { window.removeEventListener('chama-avatar',update); media.removeEventListener('change',motion); };
  }, []);
  useEffect(() => setFailures(0), [pubkey]);
  const avatar = pubkey ? readAvatar(pubkey) : null;
  void revision;
  // The role dot supplies colour; an absent photo stays neutral in both themes.
  const placeholder = <span aria-hidden="true" style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: size, height: size, flexShrink: 0, boxSizing: 'border-box',
    borderRadius: '50%', verticalAlign: 'middle', background: 'transparent',
    border: `1px solid ${T.borderHi}`, color: T.muted,
  }}>
    <svg width={Math.round(size * 0.67)} height={Math.round(size * 0.67)} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5.5 20v-1.5a6.5 6.5 0 0 1 13 0V20" />
    </svg>
  </span>;
  return avatar && failures < 2 ? <img src={reduced || failures > 0 ? avatar.still : avatar.animated} alt="" width={size} height={size}
    onError={() => setFailures(n => n + 1)} style={{display:'block',flexShrink:0,borderRadius:'50%',objectFit:'cover'}} /> : <>{fallback ?? placeholder}</>;
}
