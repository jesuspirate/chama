import type { ButtonHTMLAttributes } from 'react';
import { T } from '../theme.js';

/** The one way back, on every screen (Jet, after 6.4.31-rc.2: "why do we have
 *  to squint to see them?"). An ink-outlined pill with a drawn chevron and a
 *  bold body-size label, so it reads as a real button beside the filled ink
 *  action without competing with it. Navigation only: never a money action,
 *  so no press-and-hold. The label carries no arrow; the chevron is drawn. */
export function BackButton({ label, className, style, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <>
    <style>{`.chama-back{display:inline-flex;align-items:center;justify-content:center;gap:6px;align-self:flex-start;box-sizing:border-box;min-height:${T.size.touch};padding:0 18px 0 12px;border:2px solid ${T.ink};border-radius:999px;background:transparent;color:${T.ink};font-size:${T.fs.body};font-weight:700;line-height:1.2;white-space:nowrap;cursor:pointer;transition:background .12s,transform .12s}.chama-back:hover{background:${T.raised}}.chama-back:active{transform:translateY(1px)}.chama-back:focus-visible{outline:2px solid ${T.ink};outline-offset:3px}.chama-back:disabled{color:${T.ink3};border-color:${T.line};background:transparent;cursor:default;transform:none}@media(prefers-reduced-motion:reduce){.chama-back{transition:none}}`}</style>
    <button {...props} type={props.type ?? 'button'} className={`chama-back${className ? ` ${className}` : ''}`} style={{ fontFamily: T.sans, ...style }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      <span>{label}</span>
    </button>
  </>;
}
