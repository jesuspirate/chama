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
  return avatar && failures < 2 ? <img src={reduced || failures > 0 ? avatar.still : avatar.animated} alt="" width={size} height={size}
    onError={() => setFailures(n => n + 1)} style={{borderRadius:'50%',objectFit:'cover'}} /> : <>{fallback}</>;
}
