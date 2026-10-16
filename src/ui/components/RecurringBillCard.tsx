// ══════════════════════════════════════════════════════════════════════════
// Chama — "Monthly bill" card (recurring Community Bill Pay indicator + Stop)
// ══════════════════════════════════════════════════════════════════════════
//
// The owner's clear indicator that a CBP bill is set to auto-re-post ~monthly to
// their home community, plus the one-tap way to STOP it. Recurrence is purely
// client-side (no bond, online-gated, re-publish-only) — this card reads the
// local `cbp-recurrence` store and offers a Cancel per series. Money-safe: it
// never moves sats; stopping just flips the local flag so no further re-post
// fires.

import { type EscrowState } from "../../escrow-engine/types.js";
import { type CbpRecurrenceConfig, nextRepostAt } from "../../escrow-engine/cbp-recurrence.js";
import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { useT } from "../../i18n/index.js";

export function RecurringBillCard({
  series,
  onStop,
}: {
  /** Active recurring series + their currently-loaded instance state (if any). */
  series: { cfg: CbpRecurrenceConfig; state: EscrowState | null }[];
  onStop: (seriesId: string) => void;
}) {
  const { t } = useT();
  if (series.length === 0) return null;
  const dateFmt = (unixSec: number) =>
    new Date(unixSec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div
      style={{
        width: "calc(100% - 32px)",
        margin: "12px 16px 0",
        padding: "12px 14px",
        background: `${T.accent}12`,
        border: `1px solid ${T.accent}55`,
        borderRadius: T.r,
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          fontSize: T.fs.secondary, color: T.accent, fontFamily: T.sans, fontWeight: 700,
          display: "flex", alignItems: "center", gap: 6,
        }}
      >
        <span aria-hidden="true">🔁</span>
        {series.length === 1
          ? t("me.recurringTitleOne")
          : t("me.recurringTitleMany", { count: series.length })}
      </div>
      <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
        {t("me.recurringSubtitle")}
      </div>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {series.map(({ cfg, state }) => (
          <div key={cfg.seriesId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13, color: T.text,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                }}
              >
                {state?.description || t("me.recurringUnnamedBill")}
              </div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 1, display: "flex", alignItems: "center", gap: 6 }}>
                {state ? (
                  <BitcoinAmount msats={state.amountMsats} size={T.fs.secondary} gap={3} glyphScale={1.18} />
                ) : null}
                <span>{t("me.recurringNextPost", { date: dateFmt(nextRepostAt(cfg)) })}</span>
              </div>
            </div>
            <button
              onClick={() => onStop(cfg.seriesId)}
              style={{
                flexShrink: 0,
                padding: "7px 14px",
                background: "transparent",
                color: T.muted,
                border: `1px solid ${T.border}`,
                borderRadius: T.r,
                fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("me.recurringStop")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
