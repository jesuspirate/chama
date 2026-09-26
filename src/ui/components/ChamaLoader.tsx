import { T } from '../theme.js';
import { translate, getCurrentLang } from '../../i18n/index.js';

/** A resolution-independent orange dot with a smooth orbit. No image download,
 * frame stepping or downsampled boot animation at small sizes. */
export function ChamaLoader({size = 24, label}: {size?: number; label?: string}) {
  return <span role="status" aria-label={label ?? translate(getCurrentLang(), 'common.loading')}
    style={{display:'inline-flex',alignItems:'center',gap:7,whiteSpace:'nowrap',color:T.accent}}>
    <style>{`
      @keyframes chamaLoaderOrbit { to { transform: rotate(360deg); } }
      .chama-loader-orbit { transform-origin: 12px 12px; animation: chamaLoaderOrbit 1.1s linear infinite; }
      @media (prefers-reduced-motion: reduce) { .chama-loader-orbit { animation: none; } }
    `}</style>
    <svg className="chama-loader-vector" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{display:'block',flexShrink:0}}>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" opacity="0.18" />
      <path className="chama-loader-orbit" d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </svg>
    {label && <span style={{fontFamily:T.mono,fontSize:12,color:T.muted}}>{label}</span>}
  </span>;
}
