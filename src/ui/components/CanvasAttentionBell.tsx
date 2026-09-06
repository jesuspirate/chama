import { T } from "../theme.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

const tr = (key: string, params?: Record<string, string | number>) =>
  translate(getCurrentLang(), key, params);
import type { EscrowState } from "../../escrow-engine/types.js";

/**
 * Floating attention bell for the guided Canvas. When the viewer has a live
 * trade — especially one that NEEDS them (a vote or a claim owed) — this quiet
 * pill hovers over the canvas and taps straight into the trade view, so the
 * user never has to hunt through Me › My Trades to find their move. Calm by
 * default (purple, "Your trade"); accent + count when action is owed
 * ("Your move · N"). Mirrors ActiveTradePill's tone logic in a compact form.
 */
export function CanvasAttentionBell({ trade, needsYouCount, actionMode, onTap }: {
  trade: EscrowState;
  needsYouCount: number;
  actionMode: boolean;
  onTap: () => void;
}) {
  void trade; // destination is resolved by the caller; kept for future labelling
  const tone = actionMode ? T.accent : T.purple;
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={actionMode
        ? tr("canvas.bellNeedsYou", { count: needsYouCount })
        : tr("canvas.bellOpenActive")}
      style={{
        // Sits in the canvas breathing room just below the federation row, not
        // on the orange price bar (where it blended). Solid fill so it reads on
        // any ground. Offset is intentionally tunable.
        position: "fixed", top: 236, left: "50%", transform: "translateX(-50%)",
        zIndex: 50, display: "inline-flex", alignItems: "center", gap: 8,
        padding: "9px 15px 9px 13px", borderRadius: 999,
        background: tone, border: "none",
        boxShadow: `0 8px 24px ${tone}55, 0 2px 8px rgba(0,0,0,0.22)`,
        color: "#fff", fontFamily: T.sans, fontSize: 13, cursor: "pointer",
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {actionMode && needsYouCount > 0 && (
          <span style={{
            position: "absolute", top: -6, right: -7, minWidth: 15, height: 15,
            padding: "0 4px", borderRadius: 999, background: "#fff", color: tone,
            fontFamily: T.mono, fontSize: 9.5, fontWeight: 800,
            display: "grid", placeItems: "center",
            boxShadow: `0 0 0 2px ${tone}`,
          }}>
            {needsYouCount}
          </span>
        )}
      </span>
      <span style={{
        color: "#fff", fontFamily: T.mono, fontSize: 11, fontWeight: 700,
        letterSpacing: 0.4, textTransform: "uppercase",
      }}>
        {actionMode ? tr("canvas.yourMove") : tr("canvas.yourTrade")}
      </span>
      <span style={{ color: "#ffffffcc", fontSize: 15, lineHeight: 1 }}>›</span>
    </button>
  );
}
