// ══════════════════════════════════════════════════════════════════════════
// Chama — Active-trade pill
// ══════════════════════════════════════════════════════════════════════════
//
// Informational only: active trades never close Browse, Create, chat, or
// vote surfaces. The pill keeps money-moving commitments visible and gives the
// user a quick route back to the most recent active trade. v0.6.5 made
// it plural-aware so sellers serving multiple buyers, or buyers waiting
// on one trade while browsing for the next, see the aggregate listed
// value rather than a singular pill that suggests there's only one.

import { type EscrowState, EscrowStatus } from "../../escrow-engine/types.js";
import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { useT } from "../../i18n/index.js";

// i18n: values are DICTIONARY KEYS, resolved with t() at render (module-level
// constants can't call hooks). The status fallback stays the raw enum value.
const STATUS_LABEL_KEY: Partial<Record<EscrowStatus, string>> = {
  [EscrowStatus.CREATED]: "card.pillOpen",
  [EscrowStatus.LOCKED]: "card.pillInEscrow",
  [EscrowStatus.APPROVED]: "card.pillReadyToClaim",
  // COMPLETED only enters the action pill when chain scanning found the
  // winner's still-unspent local on-chain output.
  [EscrowStatus.COMPLETED]: "onchain.payoutTitle",
  [EscrowStatus.EXPIRED]: "card.pillTimedOut",
};

export function ActiveTradePill({
  trade,
  activeTradeCount = 1,
  activeTradeMsats,
  actionMode = false,
  actionCount = 0,
  onTap,
}: {
  trade: EscrowState;
  /** Total money-moving buyer/seller commitments. When > 1 the headline reads
   *  "N active trades"; tap target stays the most recent trade. */
  activeTradeCount?: number;
  /** Aggregate msats across money-moving buyer/seller trades. Open
   *  listings stay in Browse/Me and do not light this attention banner. */
  activeTradeMsats?: number;
  /** Part ①: when the user has an item that NEEDS them to act (a buyer waiting,
   *  an order to deliver, a vote/claim owed), the pill goes loud + actionable —
   *  "N waiting · tap to act" in the accent colour — and taps route to the most
   *  urgent item. Idle (no action) keeps the calm purple active-trade reading. */
  actionMode?: boolean;
  /** How many items need the user right now (drives the loud headline count). */
  actionCount?: number;
  onTap: () => void;
}) {
  const { t } = useT();
  const statusLabelKey = STATUS_LABEL_KEY[trade.status];
  const statusLabel = statusLabelKey ? t(statusLabelKey) : trade.status.toLowerCase();
  const count = Math.max(1, activeTradeCount);
  const amountMsats = activeTradeMsats ?? trade.amountMsats;
  const nWaiting = Math.max(1, actionCount);
  const tone = actionMode ? T.accent : T.purple;
  const toneDim = actionMode ? T.accentDim : T.purpleDim;
  return (
    <button
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        width: "calc(100% - 32px)",
        margin: "12px 16px 0",
        padding: "10px 14px",
        background: toneDim, border: `1px solid ${tone}${actionMode ? "aa" : "66"}`,
        borderRadius: T.r,
        color: T.text, fontFamily: T.sans,
        cursor: "pointer", textAlign: "left" as const,
        transition: "all 0.15s",
      }}
    >
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        background: tone,
        boxShadow: `0 0 8px ${tone}88`,
        animation: "pulse 2s ease-in-out infinite",
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: tone, fontFamily: T.mono,
          letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 700,
        }}>
          {actionMode
            ? t("card.needsYouPill", { count: nWaiting })
            : <>{count === 1 ? t("card.activeTradeOne") : t("card.activeTradeMany", { count })} · <BitcoinAmount msats={amountMsats} size={11} gap={3} glyphScale={1.18} /> {t("card.totalSuffix")}</>}
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
          marginTop: 2,
        }}>
          {trade.description} · {statusLabel}
        </div>
      </div>
      <span style={{ color: T.muted, fontSize: 18, flexShrink: 0 }}>›</span>
    </button>
  );
}
