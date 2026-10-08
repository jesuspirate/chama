import { T, ON_ATTN } from "../theme.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

const tr = (key: string, params?: Record<string, string | number>) =>
  translate(getCurrentLang(), key, params);
import type { EscrowState } from "../../escrow-engine/types.js";

/**
 * Floating attention bell for the guided Canvas. When the viewer has a live
 * trade — especially one that NEEDS them (a vote or a claim owed) — this quiet
 * pill hovers over the canvas and taps straight into the trade view, so the
 * user never has to hunt through Me › My Trades to find their move.
 * v7 redesign: ONE style — attention yellow with ink text, identical in both
 * themes and for every role ("Your trade", or "Your move · N" when owed).
 */
export function CanvasAttentionBell({ trade, needsYouCount, actionMode, onTap }: {
  trade: EscrowState;
  needsYouCount: number;
  actionMode: boolean;
  onTap: () => void;
}) {
  void trade; // destination is resolved by the caller; kept for future labelling
  const tone = T.attn;
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
        boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
        minHeight: T.size.touch,
        color: ON_ATTN, fontFamily: T.sans, fontSize: T.fs.secondary, cursor: "pointer",
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {actionMode && needsYouCount > 0 && (
          <span style={{
            position: "absolute", top: -6, right: -7, minWidth: 15, height: 15,
            padding: "0 4px", borderRadius: 999, background: ON_ATTN, color: tone,
            fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
            display: "grid", placeItems: "center",
            boxShadow: `0 0 0 2px ${tone}`,
          }}>
            {needsYouCount}
          </span>
        )}
      </span>
      <span style={{
        color: ON_ATTN, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
      }}>
        {actionMode ? tr("canvas.yourMove") : tr("canvas.yourTrade")}
      </span>
      <span style={{ color: ON_ATTN, fontSize: 15, lineHeight: 1 }}>›</span>
    </button>
  );
}
