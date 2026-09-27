import { useEffect, useState, type ReactNode } from 'react';
import { readAvatar } from '../avatars.js';
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
  // A missing photo still occupies the avatar's circle. The same key keeps
  // the same colours across rooms and devices; these colours imply no status.
  let hash = 0;
  for (const char of (pubkey ?? '').toLowerCase()) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const placeholder = <span aria-hidden="true" style={{
    display: 'inline-block', width: size, height: size, flexShrink: 0,
    borderRadius: '50%', verticalAlign: 'middle',
    background: `linear-gradient(135deg, hsl(${hue} 72% 62%), hsl(${(hue + 65) % 360} 68% 38%))`,
    boxShadow: 'inset 0 0 0 1px #ffffff30',
  }} />;
  return avatar && failures < 2 ? <img src={reduced || failures > 0 ? avatar.still : avatar.animated} alt="" width={size} height={size}
    onError={() => setFailures(n => n + 1)} style={{display:'block',flexShrink:0,borderRadius:'50%',objectFit:'cover'}} /> : <>{fallback ?? placeholder}</>;
}
