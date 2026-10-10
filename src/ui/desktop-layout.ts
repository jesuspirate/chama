import { NAV_WIDE_MIN_PX } from './components/BottomNav.js';
import { T } from './theme.js';

/** New look only: the sidebar owns the brand; every tab shares one column. */
export function newLookDesktopCss(): string {
  return `
  .chama-desktop-column{display:contents}
  @media (min-width:${NAV_WIDE_MIN_PX}px){
    .chama-shell-nav[data-new-look="true"]>.chama-desktop-column{display:block;max-width:720px;margin:0 auto;width:100%}
    .chama-shell-nav[data-new-look="true"] .chama-page-brand{display:none!important}
    .chama-shell-nav[data-new-look="true"] .chama-page-header{justify-content:flex-end!important}
    .chama-shell-nav[data-new-look="true"] .chama-home{display:flex;flex-direction:column;max-width:none;padding:24px 16px}
    .chama-shell-nav[data-new-look="true"] .chama-home-main{max-width:none;margin:0}
    .chama-shell-nav[data-new-look="true"] .assisted-native{padding:24px 16px;min-height:0}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-main{max-width:none;margin:0}
    .chama-shell-nav[data-new-look="true"] .assisted-native h1{font-size:1.75rem!important}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-choice strong{font-size:1.125rem}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-choice small,
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-main>p{font-size:0.9375rem!important}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:24px;font-size:0.9375rem;color:${T.ink2}}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-footer>div{display:none}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-footer>span{gap:12px!important}
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-footer button,
    .chama-shell-nav[data-new-look="true"] .assisted-native .assisted-canvas-footer small{font-size:0.9375rem;color:${T.ink2}}
  }`;
}
