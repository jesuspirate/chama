import { NAV_SIDEBAR_WIDTH, NAV_WIDE_MIN_PX } from './components/BottomNav.js';
import { T } from './theme.js';

/** New look only: the sidebar owns the brand; every tab shares one column. */
export function newLookDesktopCss(): string {
  return `
  .chama-desktop-column{display:contents}
  .chama-sidebar-context{display:none}
  @media (min-width:${NAV_WIDE_MIN_PX}px){
    .chama-shell-nav[data-new-look="true"] .chama-sidebar-context{display:block;border-top:1px solid ${T.line};padding-top:16px}
    .chama-shell-nav[data-new-look="true"] .chama-desktop-column .chama-hero-wrap{display:none}
    .chama-shell-nav[data-new-look="true"] .chama-desktop-column .chama-federation-row{display:none}
    .chama-shell-nav[data-new-look="true"] .chama-sidebar-federation .chama-federation-row{display:flex}
    .chama-shell-nav[data-new-look="true"] .chama-status-row{justify-content:flex-end!important}
    .chama-sidebar-context .chama-hero{padding:0 0 12px!important;border:0!important}
    .chama-sidebar-context .chama-price-btn{padding:12px!important;box-shadow:none!important}
    .chama-sidebar-context .chama-price-btn>div:first-child{display:grid!important;grid-template-columns:1fr auto!important;gap:12px!important}
    .chama-sidebar-context .chama-price-btn>div:first-child>div:last-child{grid-column:1/-1;justify-content:flex-start!important}
    .chama-sidebar-context .chama-price-btn>div:last-child{flex-direction:column;align-items:flex-start!important;gap:6px!important}
    .chama-sidebar-context .chama-price-btn>div:last-child span{font-size:0.75rem!important;color:${T.ink2}!important;white-space:normal!important}
    .chama-sidebar-context .chama-walletbar>div{padding:10px 0!important}
    .chama-sidebar-context .chama-walletbar>div>div{flex-wrap:wrap;gap:6px!important;min-width:0}
    .chama-sidebar-federation{padding-top:12px}
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
    /* Price, identity and the Chama bar live at the foot of the sidebar
       (Jet, 2026-10-10), so the page starts with the question. */
    .chama-shell-nav[data-new-look="true"] .chama-status-stack{position:fixed;left:0;bottom:0;width:${NAV_SIDEBAR_WIDTH}px;z-index:101;box-sizing:border-box;padding:12px 12px 16px;display:flex;flex-direction:column;gap:6px;background:${T.chrome};border-right:1px solid ${T.line};border-top:1px solid ${T.line}}
    .chama-shell-nav[data-new-look="true"] .chama-status-stack .chama-hero{padding:0!important;border:0!important}
    .chama-shell-nav[data-new-look="true"] .chama-status-stack .chama-hero-full{display:none}
    .chama-shell-nav[data-new-look="true"] .chama-status-stack .chama-hero-slim{display:block}
    .chama-shell-nav[data-new-look="true"] .chama-status-stack>*>*,
    .chama-shell-nav[data-new-look="true"] .chama-status-stack>*{max-width:100%;min-width:0}
    .chama-shell-nav[data-new-look="true"] .chama-status-stack *{border-bottom-color:transparent}
  }`;
}
