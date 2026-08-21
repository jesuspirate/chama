// ══════════════════════════════════════════════════════════════════════════
// Chama — AttentionQueue (the Me-screen hero)
// ══════════════════════════════════════════════════════════════════════════
//
// The single "needs your attention" hero. Renders the urgency-ranked trades
// (from selectNeedsYouTrades — we NEVER reimplement the ranking here) as clean,
// TradeDetail-style cards: each with the trade identity, a one-line "what's
// owed", one clear primary action (open the trade), and small pin / snooze
// controls. Pinned cards float to the top; snoozed cards drop out of the hero
// until their status changes or the 12h cap lapses (see attention-triage.ts).
//
// Presentation only — no reducer/consensus/money-path involvement.

import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.js";
import {
  type EscrowState,
  Role,
  getEffectiveParticipantsAt,
} from "../../escrow-engine/types.js";
import { needsYouReasonFor } from "../decisions.js";
import { CAT_ICON, T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import {
  getPins,
  getSnoozes,
  isPinned,
  orderAttention,
  pinTrade,
  snoozeTrade,
  soonestJoinHoldExpirySec,
  unpinTrade,
} from "../attention-triage.js";

export function AttentionQueue({
  ranked,
  pubkey,
  onOpenTrade,
  latestTrade,
  suppressEmptyState = false,
}: {
  /** Urgency-ranked needs-you trades (selectNeedsYouTrades output). */
  ranked: EscrowState[];
  pubkey: string;
  onOpenTrade: (id: string) => void;
  /** Shown under the "all caught up" line when nothing needs action — a calm
   *  pointer to the user's latest / live trade. */
  latestTrade?: EscrowState | null;
  /** Money-safety actions live directly below this trade queue. When one is
   *  visible, do not contradict it with the broad "all caught up" empty copy. */
  suppressEmptyState?: boolean;
}) {
  const { t } = useT();
  // Bump to re-read the triage store after a pin/snooze mutation.
  const [tick, bump] = useState(0);
  const nowMs = Date.now();
  const ordered = orderAttention(ranked, getPins(), getSnoozes(), nowMs);

  if (ordered.length === 0 && suppressEmptyState) return null;

  if (ordered.length === 0) {
    return (
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ fontSize: 22, lineHeight: 1 }}>✅</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: T.text, fontFamily: T.sans }}>
              {t("me.allCaughtUp")}
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
              {t("me.allCaughtUpHint")}
            </div>
          </div>
        </div>
        {latestTrade && (
          <button
            onClick={() => onOpenTrade(latestTrade.id)}
            style={{
              marginTop: 14, width: "100%", textAlign: "left" as const,
              display: "flex", alignItems: "center", gap: 10,
              padding: "11px 12px", borderRadius: T.rs,
              background: T.surface, border: `1px solid ${T.border}`,
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{CAT_ICON[latestTrade.category] || "📦"}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{
                display: "block", fontFamily: T.sans, fontSize: 13, fontWeight: 700,
                color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {latestTrade.description}
              </span>
              <span style={{ display: "block", fontFamily: T.mono, fontSize: 10, color: T.muted, marginTop: 2 }}>
                {t("me.latestTrade")}
              </span>
            </span>
            <BitcoinAmount msats={latestTrade.amountMsats} size={13} gap={3} glyphScale={1.15} color={T.text} glyphColor={T.muted} />
            <span aria-hidden="true" style={{ color: T.muted, opacity: 0.6, fontFamily: T.mono, fontSize: 13 }}>›</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
          letterSpacing: 1, textTransform: "uppercase",
        }}>
          {t("me.attentionTitle")}
        </div>
        <span style={{
          fontFamily: T.mono, color: T.accent, fontSize: 10, fontWeight: 900,
          padding: "4px 8px", borderRadius: 999,
          background: T.accentDim, border: `1px solid ${T.accent}44`,
        }}>
          {t("me.needsYouCount", { count: ordered.length })}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-tick={tick}>
        {ordered.map((trade) => (
          <AttentionCard
            key={trade.id}
            trade={trade}
            pubkey={pubkey}
            onOpenTrade={onOpenTrade}
            onChanged={() => bump((n) => n + 1)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * #69 A live mm:ss lock-hold ticker. Re-renders once a second off the shared
 * expiry (unix seconds). Reads as urgency ("⏳ lock in 4:32") and flips to
 * "deadline passed" styling once the seat lapses. Presentation only.
 */
function HoldCountdown({ expirySec }: { expirySec: number }) {
  const { t } = useT();
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = expirySec - nowSec;
  const passed = remaining <= 0;
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  const time = `${mm}:${String(ss).padStart(2, "0")}`;
  // Under two minutes reads red (act now); otherwise amber (still time).
  const tone = passed ? T.red : remaining < 120 ? T.red : T.amber;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 12,
      padding: "5px 9px", borderRadius: 999,
      background: `${tone}14`, border: `1px solid ${tone}44`,
      fontFamily: T.mono, fontSize: 12, fontWeight: 800, color: tone,
    }}>
      {passed ? t("card.deadlinePassed") : t("me.holdCountdown", { time })}
    </div>
  );
}

function AttentionCard({
  trade,
  pubkey,
  onOpenTrade,
  onChanged,
}: {
  trade: EscrowState;
  pubkey: string;
  onOpenTrade: (id: string) => void;
  onChanged: () => void;
}) {
  const { t } = useT();
  const reason = needsYouReasonFor(trade, pubkey);
  const owed = reason === "claim" ? t("me.owedClaim")
    : reason === "dispute" ? t("me.owedDispute")
    : reason === "vote" ? t("me.owedVote")
    : reason === "arbiter-key" ? t("onchain.publishMyKey")
    : reason === "waiting" ? t("me.owedWaiting")
    : t("me.owedGeneric");
  const tone = reason === "claim" ? T.accent
    : reason === "dispute" ? T.red
    : reason === "vote" ? T.purple
    : T.amber;
  const pinned = isPinned(trade.id);
  // #69 lock-hold urgency: a pre-lock trade with a live join-hold gets a live
  // mm:ss countdown so the seller knows to lock before the seat lapses (and the
  // buyer, symmetrically, how long they have). Null when nothing is counting.
  const holdExpirySec = soonestJoinHoldExpirySec(trade);
  const participants = getEffectiveParticipantsAt(trade);
  const lower = pubkey.toLowerCase();
  const counterparty = participants[Role.BUYER]?.toLowerCase() === lower
    ? participants[Role.SELLER]
    : participants[Role.SELLER]?.toLowerCase() === lower
      ? participants[Role.BUYER]
      : participants[Role.BUYER] ?? participants[Role.SELLER];

  return (
    <div style={{
      background: T.card, border: `1px solid ${tone}55`,
      borderRadius: T.r, padding: 16,
      boxShadow: `0 0 24px ${tone}14`,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>
          {CAT_ICON[trade.category] || "📦"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontFamily: T.sans, fontSize: 15, fontWeight: 800, color: T.text,
            lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
          }}>
            {trade.description}
          </div>
          {counterparty && (
            <div style={{
              marginTop: 3, fontFamily: T.mono, fontSize: 10, color: T.muted,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
            }}>
              {t("me.withCounterparty", { who: counterparty.slice(0, 6) + "…" })}
            </div>
          )}
          <div style={{
            marginTop: 3, fontFamily: T.mono, fontSize: 9, color: T.muted,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
          }}>
            {trade.id}
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: "right" as const }}>
          <BitcoinAmount msats={trade.amountMsats} size={13} gap={3} glyphScale={1.15} color={tone} glyphColor={T.muted} />
          {pinned && (
            <div style={{ marginTop: 4, fontSize: 10, color: T.accent }} title={t("me.pinned")}>📌</div>
          )}
        </div>
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 7, marginBottom: 12,
        fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: tone,
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: tone,
          boxShadow: `0 0 8px ${tone}66`, flexShrink: 0,
        }} />
        {owed}
      </div>

      {holdExpirySec !== null && (
        <HoldCountdown expirySec={holdExpirySec} />
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => onOpenTrade(trade.id)}
          style={{
            flex: 1, minHeight: 44, borderRadius: T.rs,
            background: `${tone}22`, border: `1px solid ${tone}66`,
            color: tone, fontFamily: T.sans, fontSize: 14, fontWeight: 800,
            cursor: "pointer",
          }}
        >
          {t("me.attentionOpen")}
        </button>
        <button
          onClick={() => { (pinned ? unpinTrade : pinTrade)(trade.id); onChanged(); }}
          aria-pressed={pinned}
          title={pinned ? t("me.unpin") : t("me.pin")}
          style={{
            width: 44, minHeight: 44, borderRadius: T.rs,
            background: pinned ? T.accentDim : T.surface,
            border: `1px solid ${pinned ? T.accent + "66" : T.border}`,
            color: pinned ? T.accent : T.muted, fontSize: 16, cursor: "pointer",
          }}
        >
          📌
        </button>
        <button
          onClick={() => { snoozeTrade(trade.id, trade.status); onChanged(); }}
          title={t("me.snooze")}
          style={{
            width: 44, minHeight: 44, borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontSize: 16, cursor: "pointer",
          }}
        >
          💤
        </button>
      </div>
    </div>
  );
}
