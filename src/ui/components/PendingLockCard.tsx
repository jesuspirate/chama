// ══════════════════════════════════════════════════════════════════════════
// Chama — Pending-lock resume card (#37 lock crash-safety, Part B)
// ══════════════════════════════════════════════════════════════════════════
//
// The HONEST surface for a lock attempt that didn't finish (reload/crash
// mid-funding or mid-lock). It replaces the drain-shaped alarm for this
// state: the balance/notes belong to a KNOWN trade, and the correct next
// step is to FINISH the lock — not to sweep the sats out over Lightning at
// a fee (which would abandon a live trade).
//
// Deliberately CALM (a recoverable in-flight state, not a failure): no
// pulse, no red, renders ABOVE the normal view instead of replacing it.
//
// "Finish lock" runs the normal foreground lock (actions.lockAndPublish
// with the stashed lock options). Under the hood the bridge first settles
// the stashed entry — re-absorbing the previous attempt's notes back into
// the wallet when provably safe, or returning the already-locked state if
// the crash-window publish actually landed — then locks fresh. One tap, no
// new invoice, no double payment.

import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import type { PendingNativeLock } from "../../fedimint/pending-native-locks.js";

export function PendingLockCard({
  entry,
  tradeDescription,
  busy,
  onFinishLock,
  onOpenTrade,
}: {
  entry: PendingNativeLock;
  /** Description of the trade, when it's loaded locally. */
  tradeDescription: string | null;
  /** True while the finish-lock call is in flight. */
  busy: boolean;
  /** Re-run the lock in the foreground (recovery + fresh lock inside). */
  onFinishLock: () => void;
  /** Navigate to the trade detail. */
  onOpenTrade: () => void;
}) {
  const { t } = useT();
  const spent = entry.stage !== "intent";
  return (
    <div style={{ padding: "12px 16px 0", maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        background: T.surface, border: `1px solid ${T.accent}55`,
        borderRadius: T.r, padding: 16,
      }}>
        <div style={{
          fontSize: T.fs.secondary, fontWeight: 700, color: T.accent, fontFamily: T.sans, marginBottom: 8,
        }}>
          {t("recovery.finishLockTag")}
        </div>

        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          lineHeight: 1.5, marginBottom: 4,
        }}>
          {spent
            ? <>{t("recovery.lockSpentBefore")}{" "}
                <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
                {t("recovery.lockSpentAfter")}</>
            : <>{t("recovery.lockIntentBefore")}{" "}
                <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
                {t("recovery.lockIntentAfter")}</>}
        </div>

        {tradeDescription && (
          <div style={{
            fontSize: 12, color: T.muted, fontFamily: T.sans,
            marginBottom: 12, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap" as const,
          }}>
            {tradeDescription}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: tradeDescription ? 0 : 12 }}>
          <button
            onClick={onFinishLock}
            disabled={busy}
            style={{
              flex: 1, padding: "12px",
              background: busy ? T.border : T.accent,
              border: "none", borderRadius: T.rs,
              color: T.bg, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? t("recovery.finishing") : t("recovery.finishLockCta")}
          </button>
          <button
            onClick={onOpenTrade}
            style={{
              padding: "12px 14px",
              background: "transparent",
              border: `1px solid ${T.border}`, borderRadius: T.rs,
              color: T.text, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("recovery.openTrade")}
          </button>
        </div>

        <div style={{
          marginTop: 8, fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
          lineHeight: 1.5,
        }}>
          {t("recovery.lockFooter")}
        </div>
      </div>
    </div>
  );
}
