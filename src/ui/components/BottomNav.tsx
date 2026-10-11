import type { Ref } from "react";
import { T, ON_ATTN } from "../theme.js";
import { getSignInEnvironment, shouldApplyCssSafeAreaInsets } from "../sign-in-environment.js";
import { useT } from "../../i18n/index.js";
import { Wordmark } from "./Wordmark.js";

// v7 redesign: four tabs — Home, Browse, Circles, Me. Create is not a tab: it
// is a "+" in the top bar (iOS / web phones), an extended FAB on Android, and
// a primary button at the top of the sidebar on wide screens.
//
// One <nav> element serves every width. CSS (navCss, injected by the App
// shell) lays it out as a bottom bar on phones and as a left sidebar from
// NAV_WIDE_MIN_PX up, so there is no resize listener and each data-coach
// target exists exactly once.
export type Tab = "home" | "browse" | "circles" | "me";

export const BOTTOM_NAV_HEIGHT = 64;
export const NAV_SIDEBAR_WIDTH = 240;
export const NAV_WIDE_MIN_PX = 1024;

/** Android shows Create as an extended FAB; everything else uses "+". */
export function isAndroidUserAgent(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return /Android/i.test(ua);
}

export function BottomNav({ active, onSelect, onCreate, badges, sidebarRowsRef, sidebarFederationRef }: {
  sidebarRowsRef?: Ref<HTMLDivElement>;
  sidebarFederationRef?: Ref<HTMLDivElement>;
  active: Tab;
  onSelect: (t: Tab) => void;
  /** Create entry point for the sidebar layout (phones use CreateButton). */
  onCreate?: () => void;
  /** Attention count badges per tab (e.g. Home = "needs you"). Zero/absent ⇒
   *  no badge. */
  badges?: Partial<Record<Tab, number>>;
}) {
  const { t } = useT();
  const useSafeAreaInsets = shouldApplyCssSafeAreaInsets(getSignInEnvironment());
  const android = isAndroidUserAgent();
  const items: { id: Tab; label: string; coach: string }[] = [
    { id: "home",    label: t("browse.navHome"),    coach: "nav-home" },
    { id: "browse",  label: t("browse.navBrowse"),  coach: "nav-browse" },
    { id: "circles", label: t("browse.navCircles"), coach: "nav-circles" },
    { id: "me",      label: t("browse.navMe"),      coach: "nav-me" },
  ];
  return (
    <nav
      data-chama-bottom-nav
      aria-label={t("browse.navMain")}
      className={`chama-nav${android ? " chama-nav-android" : ""}`}
      style={{ paddingBottom: useSafeAreaInsets ? "env(safe-area-inset-bottom, 0px)" : 0 }}
    >
      <div className="chama-nav-brand"><Wordmark size={22} markSize={26} /></div>
      {onCreate && (
        <button type="button" className="chama-nav-create" onClick={onCreate} data-coach="fab-create">
          <PlusGlyph size={20} />{t("browse.navCreate")}
        </button>
      )}
      <div className="chama-nav-items">
        {items.map(item => {
          const isActive = active === item.id;
          const badge = badges?.[item.id] ?? 0;
          return (
            <button
              key={item.id}
              type="button"
              className="chama-nav-item"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(item.id)}
              data-coach={item.coach}
            >
              <span className="chama-nav-icon">
                <NavGlyph kind={item.id} active={isActive} />
                {badge > 0 && (
                  <span className="chama-nav-badge" aria-label={`${badge}`}>
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </span>
              <span className="chama-nav-label">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="chama-sidebar-context"><div ref={sidebarRowsRef} className="chama-sidebar-rows" /><div ref={sidebarFederationRef} className="chama-sidebar-federation" /></div>
    </nav>
  );
}

/** Phone Create control: "+" in the top bar, or an extended FAB on Android.
 *  Hidden on wide screens, where the sidebar carries Create. */
export function CreateButton({ onCreate }: { onCreate: () => void }) {
  const { t } = useT();
  if (isAndroidUserAgent()) {
    return (
      <button type="button" className="chama-create-fab" onClick={onCreate}
        data-coach="fab-create" aria-label={t("browse.createTrade")}>
        <PlusGlyph size={22} />{t("browse.navCreate")}
      </button>
    );
  }
  return (
    <button type="button" className="chama-create-plus" onClick={onCreate}
      data-coach="fab-create" aria-label={t("browse.createTrade")}>
      <PlusGlyph size={22} />
    </button>
  );
}

/** Layout for the nav, the Create controls and the shell offset. Read at
 *  render time (T is swapped in place on theme change). */
export function navCss(): string {
  const W = NAV_SIDEBAR_WIDTH;
  return `
  .chama-nav{position:fixed;left:0;right:0;bottom:0;z-index:100;background:${T.chrome};border-top:1px solid ${T.line};font-family:${T.sans}}
  .chama-nav-brand,.chama-nav-create{display:none}
  .chama-nav-items{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));max-width:560px;margin:0 auto}
  .chama-nav-item{min-height:${BOTTOM_NAV_HEIGHT}px;padding:8px 2px 6px;background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:${T.ink3};font-family:inherit;font-size:var(--chama-fs-tab);font-weight:600;line-height:1.15}
  .chama-nav-item[aria-current="page"]{color:${T.ink};font-weight:700}
  .chama-nav-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;height:30px;width:56px;border-radius:15px}
  .chama-nav-android .chama-nav-item[aria-current="page"] .chama-nav-icon{background:${T.raised}}
  .chama-nav-badge{position:absolute;top:-4px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:${T.attn};color:${ON_ATTN};font-size:11px;font-weight:700;line-height:18px;text-align:center;box-shadow:0 0 0 2px ${T.chrome}}
  .chama-nav-label{max-width:100%;overflow-wrap:anywhere;text-align:center}
  .chama-create-plus{width:44px;height:44px;border-radius:22px;border:none;background:${T.raised};color:${T.ink};display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
  .chama-create-fab{position:fixed;right:16px;bottom:calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom,0px) + 16px);z-index:90;min-height:56px;padding:0 20px 0 16px;border-radius:16px;border:none;background:${T.ink};color:${T.onInk};display:inline-flex;align-items:center;gap:8px;font-family:${T.sans};font-size:var(--chama-fs-button);font-weight:600;box-shadow:0 6px 16px rgba(0,0,0,0.22);cursor:pointer}
  /* The Android extended FAB floats above the bottom nav; page footers keep
     clear of it so it never covers their links or step dots. */
  @media (max-width:${NAV_WIDE_MIN_PX - 1}px){body:has(.chama-create-fab) .assisted-canvas-footer{margin-bottom:76px}}
  @media (min-width:${NAV_WIDE_MIN_PX}px){
    .chama-nav{top:0;right:auto;width:${W}px;border-top:none;border-right:1px solid ${T.line};padding:24px 16px!important;display:flex;flex-direction:column;gap:20px;overflow-y:auto}
    .chama-nav-brand{display:block;padding:0 8px}
    .chama-nav-create{display:flex;align-items:center;justify-content:center;gap:8px;min-height:var(--chama-h-button);border-radius:${T.r}px;border:none;background:${T.ink};color:${T.onInk};font-family:inherit;font-size:var(--chama-fs-button);font-weight:600;cursor:pointer}
    .chama-nav-items{display:flex;flex-direction:column;gap:4px;max-width:none;margin:0}
    .chama-nav-item{flex-direction:row;justify-content:flex-start;gap:12px;min-height:48px;padding:0 10px;border-radius:12px;font-size:var(--chama-fs-body);font-weight:500}
    .chama-nav-item:hover{background:${T.raised}}
    .chama-nav-item[aria-current="page"]{background:${T.raised}}
    .chama-nav-icon{width:28px;height:28px;background:none!important}
    .chama-create-plus,.chama-create-fab{display:none!important}
    /* The bottom nav already pads for the home indicator; with the nav as a
       sidebar, page footers pad for it themselves. */
    :root{--chama-footer-safe:env(safe-area-inset-bottom, 0px)}
    .chama-shell-nav{padding-bottom:0!important;margin-right:0!important}
    .chama-shell-nav[data-shell-width="wide"]{margin-left:${W}px!important}
    .chama-shell-nav[data-shell-width="narrow"]{margin-left:calc(${W}px + max(0px, (100% - ${W}px - 520px) / 2))!important}
  }`;
}

function PlusGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function NavGlyph({ kind, active }: { kind: Tab; active: boolean }) {
  const common = {
    width: 24, height: 24, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: active ? 2 : 1.75,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "home") {
    return <svg {...common}><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" /></svg>;
  }
  if (kind === "browse") {
    return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>;
  }
  if (kind === "circles") {
    return (
      <svg {...common}>
        <circle cx="12" cy="4.5" r="1.8" /><circle cx="18.5" cy="8.25" r="1.8" />
        <circle cx="18.5" cy="15.75" r="1.8" /><circle cx="12" cy="19.5" r="1.8" />
        <circle cx="5.5" cy="15.75" r="1.8" /><circle cx="5.5" cy="8.25" r="1.8" />
      </svg>
    );
  }
  return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5" /></svg>;
}
