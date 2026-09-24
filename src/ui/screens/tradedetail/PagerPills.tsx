// ══════════════════════════════════════════════════════════════════════════
// Chama — TradeView pager pills (Chat · Details · Parties)
// ══════════════════════════════════════════════════════════════════════════
//
// The same sliding segmented control language as Create's single↔storefront
// toggle (CreateForm.tsx): a pill-shaped track with one filled indicator that
// slides under the active segment. Generalized here from 2 → N segments and
// flanked by a gentle nudging ‹ › swipe hint, so the control teaches the
// horizontal pager gesture. Purely presentational — the parent owns the pager
// scroll; this reflects `active` and reports taps via `onSelect`.

import { T } from "../../theme.js";
import { useT } from "../../../i18n/index.js";

export function PagerPills({ tabs, active, onSelect, badges, icons, disabled, tabIds, chevrons = true, label }: {
  tabs: string[];
  disabled?: boolean[];
  tabIds?: string[];
  icons?: React.ReactNode[];
  chevrons?: boolean;
  label?: string;
  /** Index of the live pane (driven by the pager's scroll position). */
  active: number;
  onSelect: (index: number) => void;
  /** v4.1 (#15): optional unread count per tab index — a small accent badge sits
   *  on the pill when its count > 0 (e.g. unread chat while you're on Details). */
  badges?: (number | null | undefined)[];
}) {
  const { t } = useT();
  const n = Math.max(1, tabs.length);
  const clamped = Math.min(Math.max(0, active), n - 1);
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: 8, padding: "2px 0 9px", flex: "0 0 auto",
    }}>
      {chevrons && <button
        type="button"
        aria-label={t("trade.prevPaneAria")}
        disabled={clamped === 0}
        onClick={() => onSelect(clamped - 1)}
        style={{
          background: "none", border: "none", padding: "4px 6px",
          color: T.muted, fontSize: 30, lineHeight: 1, fontWeight: 700,
          opacity: clamped === 0 ? 0.18 : 0.6,
          cursor: clamped === 0 ? "default" : "pointer",
          animation: clamped === 0 ? "none" : "pagerNudgeL 2.6s ease-in-out infinite",
        }}
      >‹</button>}

      <div
        role="tablist"
        aria-label={label ?? t("trade.tradePanesAria")}
        style={{
          position: "relative",
          display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 999, padding: 4, minWidth: 0, width: "100%", maxWidth: 360, flex: "0 1 auto",
        }}
      >
        {/* Sliding indicator — one button-width wide, translated by whole
            button-widths so it tracks the active pane (same motion grammar as
            Create's toggle). */}
        <div aria-hidden="true" style={{
          position: "absolute", top: 4, bottom: 4, left: 4,
          width: `calc((100% - 8px) / ${n})`,
          borderRadius: 999,
          background: T.card, border: `1px solid ${T.borderHi}`,
          boxShadow: "0 1px 0 #0006",
          transform: `translateX(calc(${clamped} * 100%))`,
          transition: "transform .24s cubic-bezier(.4,0,.2,1)",
        }} />
        {tabs.map((label, i) => {
          const on = i === clamped;
          const badge = badges?.[i] ?? 0;
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={disabled?.[i]}
              data-funding-rail={tabIds?.[i]}
              onClick={() => onSelect(i)}
              style={{
                position: "relative", zIndex: 1,
                background: "transparent", border: "none",
                padding: "7px 4px", minHeight: 44, borderRadius: 999,
                cursor: disabled?.[i] ? "default" : "pointer",
                opacity: disabled?.[i] ? .5 : 1,
                fontFamily: T.sans, fontSize: 12, fontWeight: 700,
                color: on ? T.text : T.muted,
                transition: "color .2s",
                whiteSpace: "nowrap",
                overflowWrap: "anywhere", minWidth: 0,
              }}
            >
              {icons?.[i] && <span aria-hidden="true" style={{ opacity: on ? 1 : .5, marginRight: 5, display: "inline", transition: "opacity .2s" }}>{icons[i]}</span>}{label}
              {badge > 0 && (
                <span aria-label={t("trade.unreadAria", { count: badge })} style={{
                  position: "absolute", top: 0, right: 2,
                  minWidth: 14, height: 14, padding: "0 3px", boxSizing: "border-box",
                  borderRadius: 999, background: T.accent, color: "#fff",
                  fontFamily: T.mono, fontSize: 8.5, fontWeight: 800,
                  lineHeight: "14px", textAlign: "center",
                }}>
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {chevrons && <button
        type="button"
        aria-label={t("trade.nextPaneAria")}
        disabled={clamped === n - 1}
        onClick={() => onSelect(clamped + 1)}
        style={{
          background: "none", border: "none", padding: "4px 6px",
          color: T.muted, fontSize: 30, lineHeight: 1, fontWeight: 700,
          opacity: clamped === n - 1 ? 0.18 : 0.6,
          cursor: clamped === n - 1 ? "default" : "pointer",
          animation: clamped === n - 1 ? "none" : "pagerNudgeR 2.6s ease-in-out infinite",
        }}
      >›</button>}
    </div>
  );
}
