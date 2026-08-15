// ══════════════════════════════════════════════════════════════════════════
// Chama — EcashExportModal (v2.4, #56 "withdraw as ecash, no LN fees")
// ══════════════════════════════════════════════════════════════════════════
//
// Spends the user's Chama balance into a Fedimint OOB note — a bearer string
// they can import into Fedi or any other Fedimint wallet on the SAME
// federation, with zero Lightning routing fees. This is the dust exit: it
// works even for balances too small for LN to move economically.
//
// Money-safety: the moment spendNotes returns, the sats have LEFT the wallet
// balance and exist only as the string. We stash it (ecash-exports.ts) before
// showing it, so a close/crash can't orphan it; a "pending ecash export"
// surface in Me re-opens this modal to retrieve it. Clearing the stash is
// two-tap, since it makes Chama forget the only copy it holds.

import { useMemo, useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { CopyButton } from "../components/CopyButton.js";
import { QRCode } from "../QRCode.js";
import { ecashToQrFrames } from "../../payments/ecash-qr.js";
import {
  assertEcashExportWritable,
  clearEcashExport,
  getEcashExport,
  stashEcashExport,
} from "../../payments/ecash-exports.js";

type Phase = "intro" | "generating" | "ready" | "error";

export function EcashExportModal({
  balanceMsats,
  federationLabel,
  spendNotes,
  recoverUnstashed,
  onExported,
  onConfirmCleared,
  closeAfterConfirm,
  onClose,
  preset,
}: {
  /** Full local balance to export, in msats. */
  balanceMsats: number;
  /** Human label for the federation the note will be bound to (e.g. "BLF"). */
  federationLabel: string;
  /** Bound to actions.spendNotes — spends the amount into an OOB note string. */
  spendNotes: (amountMsats: number) => Promise<string>;
  /** Reabsorb a freshly-created note if the post-spend durable stash write
   *  unexpectedly fails after its preflight passed. */
  recoverUnstashed?: (notes: string) => Promise<void>;
  /** Fired after a successful generate so the shell can refresh the balance. */
  onExported?: () => void;
  /** Optional durable finalizer (claim-backed exports use this to publish
   *  COMPLETE and clear only after explicit user approval). */
  onConfirmCleared?: () => void | Promise<void>;
  /** Override the normal dismiss callback after a successful confirmation. */
  closeAfterConfirm?: () => void;
  onClose: () => void;
  /** v3.4.0 C13 — show an EXISTING bearer note (a stranded claim stash
   *  entry) instead of spending balance into a fresh one. The modal
   *  opens straight on the ready phase with QR + copy; the two-tap
   *  "clear" confirms the user secured the note and clears the SOURCE
   *  stash entry via onConfirmCleared (not the ecash-export stash). */
  preset?: {
    notes: string;
    amountMsats: number;
    /** Small mono headline, e.g. "STRANDED CLAIM · EXPORT YOUR SATS". */
    headline: string;
    /** Replaces the ready-phase explainer copy. */
    body: string;
    onConfirmCleared: () => void | Promise<void>;
  };
}) {
  const { t } = useT();
  // Resume a prior unconfirmed export if one is stashed (the balance may now
  // read 0, so this modal is the only way back to it).
  const stashed = preset ? null : getEcashExport();
  const [phase, setPhase] = useState<Phase>(preset || stashed ? "ready" : "intro");
  const [notes, setNotes] = useState<string>(preset?.notes ?? stashed?.notes ?? "");
  const [exportedMsats, setExportedMsats] = useState<number>(
    preset?.amountMsats ?? stashed?.amountMsats ?? balanceMsats
  );
  const [error, setError] = useState<string>("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const sats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const exportedSats = Math.floor(Math.max(0, exportedMsats) / 1000);
  const qrFrames = useMemo(() => ecashToQrFrames(notes), [notes]);

  const generate = async () => {
    setPhase("generating");
    setError("");
    try {
      assertEcashExportWritable();
      const oob = await spendNotes(balanceMsats);
      // Crash-safety: persist BEFORE we show it.
      try {
        stashEcashExport({ notes: oob, amountMsats: balanceMsats, federationLabel, source: "wallet" });
      } catch (stashError) {
        try { await recoverUnstashed?.(oob); } catch (redeemError) {
          console.error("[chama] unstashed wallet export reabsorb failed; auto-refund remains armed:", redeemError);
        }
        throw new Error(
          t("recovery.exportStashFailedReabsorbed"),
          { cause: stashError },
        );
      }
      setNotes(oob);
      setExportedMsats(balanceMsats);
      setPhase("ready");
      onExported?.();
    } catch (e: any) {
      setError(e?.message || t("recovery.exportGenerateError"));
      setPhase("error");
    }
  };

  const dismissConfirmed = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    setError("");
    try {
      if (preset) {
        await preset.onConfirmCleared();
      } else if (onConfirmCleared) {
        await onConfirmCleared();
      } else {
        clearEcashExport();
      }
      (closeAfterConfirm ?? onClose)();
    } catch (e: any) {
      setError(e?.message || t("recovery.exportClearError"));
      setPhase("error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      onClick={() => { if (phase !== "generating") onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
          padding: 24, maxWidth: 440, width: "100%",
          maxHeight: "88vh", overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: preset ? T.amber : T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              {preset ? preset.headline : t("recovery.exportHeadline")}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
              <BitcoinAmount sats={phase === "ready" ? exportedSats : sats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          {phase !== "generating" && (
            <button onClick={onClose} style={{
              background: "none", border: "none", color: T.muted,
              fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
            }}>×</button>
          )}
        </div>

        {phase === "intro" && (
          <>
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
              {t("recovery.exportIntroBefore")} <strong style={{ color: T.text }}>{federationLabel}</strong>{" "}
              {t("recovery.exportIntroAfter")}
            </div>
            <div style={{
              padding: "10px 12px", borderRadius: T.rs, marginBottom: 14,
              background: T.amberDim, border: `1px solid ${T.amber}44`,
              color: T.amber, fontFamily: T.mono, fontSize: 10, lineHeight: 1.6,
            }}>
              {t("recovery.exportWarnBefore")} <strong>{t("recovery.exportWarnIs")}</strong>{" "}
              {t("recovery.exportWarnAfter", { federation: federationLabel })}
            </div>
            <button
              onClick={generate}
              style={{
                width: "100%", padding: "12px 16px", borderRadius: T.rs,
                background: T.accent, border: `1px solid ${T.accent}`,
                color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
                cursor: "pointer", letterSpacing: 0.5,
              }}
            >
              {t("recovery.exportGenerateCta")}
            </button>
          </>
        )}

        {phase === "generating" && (
          <div style={{
            padding: "32px 16px", textAlign: "center",
            background: T.purpleDim, border: `1px solid ${T.purple}44`, borderRadius: T.r,
          }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: T.purple, animation: "pulse 1.4s ease-in-out infinite",
              margin: "0 auto 12px",
            }} />
            <div style={{ fontSize: 11, fontWeight: 600, color: T.purple, fontFamily: T.mono, letterSpacing: 1 }}>
              {t("recovery.exportMinting")}
            </div>
          </div>
        )}

        {phase === "ready" && (
          <>
            <div style={{
              padding: "9px 11px", borderRadius: T.rs, marginBottom: 12,
              background: preset ? T.amberDim : T.greenDim,
              border: `1px solid ${preset ? T.amber : T.green}44`,
              color: preset ? T.amber : T.green,
              fontFamily: T.mono, fontSize: 10, lineHeight: 1.55,
            }}>
              {preset
                ? preset.body
                : t("recovery.exportReadyBody", { federation: federationLabel })}
            </div>

            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <QRCode
                data={qrFrames}
                size={240}
                margin={4}
                errorCorrectionLevel="L"
                showLogo={false}
                alt={t("recovery.exportQrAlt")}
              />
            </div>

            <div style={{
              margin: "-4px 0 12px", textAlign: "center", color: T.muted,
              fontFamily: T.mono, fontSize: 9, lineHeight: 1.45,
            }}>
              {t("recovery.exportQrHelp")}
            </div>

            <div style={{
              padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
              background: T.bg, border: `1px solid ${T.border}`,
              color: T.muted, fontFamily: T.mono, fontSize: 9, lineHeight: 1.4,
              wordBreak: "break-all" as const, maxHeight: 96, overflowY: "auto",
            }}>
              {notes}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <CopyButton
                value={notes}
                label={t("recovery.exportCopyCta")}
                copiedLabel={t("common.copied")}
                style={{
                  flex: 1, padding: "11px 12px", borderRadius: T.rs,
                  background: T.accent, border: `1px solid ${T.accent}`, color: "#000",
                  fontFamily: T.mono, fontSize: 12, fontWeight: 800, cursor: "pointer",
                }}
              />
            </div>

            <button
              onClick={onClose}
              style={{
                width: "100%", padding: "9px 12px", borderRadius: T.rs, marginBottom: 18,
                background: "none", border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              {t("recovery.exportKeepPending")}
            </button>
            <button
              onClick={() => { void dismissConfirmed(); }}
              disabled={clearing}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: T.rs,
                background: confirmClear ? T.amber : "transparent",
                border: `1px solid ${confirmClear ? T.amber : T.border}`,
                color: confirmClear ? "#000" : T.muted,
                opacity: confirmClear ? 1 : 0.58,
                fontFamily: T.mono, fontSize: 10, fontWeight: 700, cursor: "pointer",
              }}
            >
              {clearing
                ? t("recovery.exportClearing")
                : confirmClear
                ? t("recovery.exportClearConfirm")
                : t("recovery.exportClearCta")}
            </button>
          </>
        )}

        {phase === "error" && (
          <>
            <div style={{
              padding: "20px 16px", textAlign: "center", marginBottom: 12,
              background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
            }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✕</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
                {t("recovery.exportErrorTitle")}
              </div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {error}
              </div>
            </div>
            <button
              onClick={generate}
              style={{
                width: "100%", padding: "11px 16px", borderRadius: T.rs, marginBottom: 8,
                background: T.accent, border: `1px solid ${T.accent}`,
                color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800, cursor: "pointer",
              }}
            >
              {t("recovery.tryAgain")}
            </button>
            <button
              onClick={onClose}
              style={{
                width: "100%", padding: "9px 16px", borderRadius: T.rs,
                background: "none", border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              {t("common.close")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
