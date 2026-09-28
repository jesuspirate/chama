import { ProfileAvatar } from './ProfileAvatar.js';
import { ROLE_COLOR, T } from '../theme.js';

/** One seat treatment across rooms, trade parties, and attention cards. */
export function RoleAvatar({ role, pubkey, size = 24 }: {
  role: string; pubkey: string | null; size?: number;
}) {
  const color = ROLE_COLOR[role as keyof typeof ROLE_COLOR] ?? T.muted;
  const inner = size - 4;
  const mark = 'url("/icons/chama-mark-256.png?v=approved-star-20260921")';
  return <span aria-hidden="true" data-role-avatar={role} style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: size, height: size, flexShrink: 0, boxSizing: 'border-box',
    borderRadius: '50%', border: `2px ${pubkey ? 'solid' : 'dashed'} ${color}`,
    background: 'transparent', verticalAlign: 'middle', overflow: 'hidden',
  }}>
    {pubkey && <ProfileAvatar pubkey={pubkey} size={inner} fallback={<span style={{
      display: 'block', width: inner - 4, height: inner - 4, backgroundColor: color,
      maskImage: mark, WebkitMaskImage: mark, maskSize: 'contain', WebkitMaskSize: 'contain',
      maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center',
    }} />} />}
  </span>;
}
