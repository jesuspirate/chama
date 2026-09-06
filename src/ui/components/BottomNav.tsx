import type React from "react";
import { T } from "../theme.js";
import { getSignInEnvironment, shouldApplyCssSafeAreaInsets } from "../sign-in-environment.js";
import { useT } from "../../i18n/index.js";

export type Tab = "browse" | "dashboard" | "me";

export const BOTTOM_NAV_HEIGHT = 64;

// Bottom navigation — fixed at the viewport bottom. v0.2.0 will add
// active-trade interception on tab tap; v0.1.85 is visual only.
export function BottomNav({ active, onSelect, badges }: {
  active: Tab;
  onSelect: (t: Tab) => void;
  /** Small red count badges per tab (e.g. Me = "needs you" items). Zero/absent
   *  ⇒ no badge. */
  badges?: Partial<Record<Tab, number>>;
}) {
  const { t } = useT();
  const useSafeAreaInsets = shouldApplyCssSafeAreaInsets(getSignInEnvironment());
  // v4.2.1: the middle tab is now the Dashboard home (standing / stats /
  // earnings / ratings / the bond land here — placeholder for now). Creating
  // a trade lives on the Browse pencil FAB; this tab is its own destination.
  // v6.3 approved redesign: stroke-drawn ink icons (currentColor, so they take
  // the active accent for free) replace the emoji glyphs, matching the app's
  // drawn VerticalIcon language.
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "browse",    label: t("browse.navBrowse"),    icon: <NavGlyph kind="browse" /> },
    { id: "dashboard", label: t("browse.navDashboard"), icon: <NavGlyph kind="dashboard" /> },
    { id: "me",        label: t("browse.navMe"),        icon: <NavGlyph kind="me" /> },
  ];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      background: T.surface, borderTop: `1px solid ${T.border}`,
      display: "flex", justifyContent: "center",
      zIndex: 100,
      paddingBottom: useSafeAreaInsets ? "env(safe-area-inset-bottom, 0px)" : 0,
    }}>
      <div style={{
        display: "flex", width: "100%", maxWidth: 520,
      }}>
        {items.map(item => {
          const isActive = active === item.id;
          const badge = badges?.[item.id] ?? 0;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              data-coach={`nav-${item.id}`}
              style={{
                flex: 1, padding: "10px 4px",
                background: "none", border: "none",
                color: isActive ? T.accent : T.muted,
                opacity: 1,
                fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                cursor: "pointer", letterSpacing: 0.5,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                height: BOTTOM_NAV_HEIGHT,
                borderTop: `2px solid ${isActive ? T.accent : "transparent"}`,
                transition: "all 0.15s",
                position: "relative",
              }}
            >
              <span style={{ lineHeight: 1, position: "relative", display: "inline-flex" }}>
                {item.icon}
                {badge > 0 && (
                  <span
                    aria-label={`${badge}`}
                    style={{
                      position: "absolute", top: -6, left: "calc(50% + 6px)",
                      minWidth: 16, height: 16, padding: "0 4px",
                      borderRadius: 8, background: T.red, color: "#fff",
                      fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      lineHeight: "16px", textAlign: "center",
                      boxShadow: `0 0 0 2px ${T.surface}`,
                    }}
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </span>
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}


function NavGlyph({ kind }: { kind: "browse" | "dashboard" | "me" }) {
  const common = {
    width: 20, height: 20, viewBox: "0 0 20 20", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "browse") {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="6" />
        <path d="M13.5 13.5L18 18" />
      </svg>
    );
  }
  if (kind === "dashboard") {
    return (
      <svg {...common}>
        <path d="M2 17.5h16" />
        <path d="M4 17.5V10M8.5 17.5V4.5M13 17.5V11.5M17.5 17.5V7.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10" cy="6.5" r="3.4" />
      <path d="M3.6 17c1.2-3.1 3.5-4.4 6.4-4.4s5.2 1.3 6.4 4.4" />
    </svg>
  );
}
