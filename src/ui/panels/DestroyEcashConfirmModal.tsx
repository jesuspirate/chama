import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";

// ══════════════════════════════════════════════════════════════════════════
// Chama — DestroyEcashConfirmModal
// ══════════════════════════════════════════════════════════════════════════
//
// Surfaces when a federation switch attempt would destroy ecash held in
// the user's current Chama. The button hierarchy has evolved across
// three releases as Pillar 2.1 doctrine tightened:
//
//   v0.1.83  Cancel  ·  Switch and destroy
//             Two-button: a binary choice between safety and destruction.
//             Wrong because it framed sat-loss as an equal-weight option.
//
//   v0.2.0   Withdraw via Lightning (primary)
//             Cancel — keep my sats (secondary)
//             Switch and destroy (tertiary, red)
//             Three-button: surfaced the safe path and demoted destroy
//             to muted styling. Withdraw opened FundWalletModal-Send-LN;
//             once balance reached zero, the shell auto-dispatched the
//             queued switch via pendingSwitchAfterWithdraw.
//
//   v0.3.0   ⚡ Recover N sats and switch (primary, accent)
//             Cancel — keep my Chama (secondary)
//             TWO-button: removes the destroy escape hatch entirely.
//             Pure Option B — there is no legitimate user flow where
//             destroying sats is correct. Sandbox-mode users who truly
//             need to nuke OPFS use Settings → Advanced → Sandbox →
//             Reset OPFS, the explicit power-user path.
//
// The pendingSwitchAfterWithdraw state machine in App.tsx is unchanged
// — only the trigger surface moves from FundWalletModal to
// RecoveryPayoutModal (which composes DestinationPicker).
export function DestroyEcashConfirmModal({
  targetLabel,
  balanceMsats,
  onCancel,
  onWithdraw,
  hasPendingNativeLock,
}: {
  targetLabel: string;
  balanceMsats: number;
  /** Reverts to the current Chama; sats untouched. */
  onCancel: () => void;
  /** v0.3.0: opens RecoveryPayoutModal (DestinationPicker → outbound
   *  LN). The shell tracks the originally-attempted switch in
   *  pendingSwitchAfterWithdraw and auto-dispatches it once balance
   *  reaches zero. If the user cancels the picker before resolving,
   *  the shell drops the pending switch (explicit abandonment). */
  onWithdraw: () => void;
  /** #37: the balance belongs to a trade mid-lock-recovery on THIS Chama.
   *  Draining it over Lightning would abandon that trade, so the recover-
   *  and-switch CTA hides and Cancel becomes the primary action. */
  hasPendingNativeLock?: boolean;
}) {
  const { t } = useT();
  const totalSats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const recoverableSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const recoveryLabel = recoverableSats > 0
    ? <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
    : t("recovery.recoverableBalanceFallback");
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, zIndex: 1100,
    }}>
      <div style={{
        maxWidth: 440, width: "100%", padding: 20, borderRadius: T.r,
        background: T.card, border: `1px solid ${T.amber}66`,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          {t("recovery.fundsAtRiskTag")}
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55,
          marginBottom: 16,
        }}>
          {t("recovery.switchBody1")} <strong>{targetLabel}</strong> {t("recovery.switchBody2")}{" "}
          <strong>{totalSats > 0 ? <BitcoinAmount sats={totalSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> : t("recovery.aBalance")}</strong>{" "}
          {t("recovery.switchBody3")} <strong>{recoveryLabel}</strong> {t("recovery.switchBody4")}
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
          marginBottom: 16,
        }}>
          {t("recovery.guardNote")}
          {reserveSats > 0 && (
            <>
              {" "}{t("recovery.reservedBefore")} <BitcoinAmount sats={reserveSats} size={T.fs.secondary} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("recovery.reservedAfter")}
            </>
          )}
          {" "}{t("recovery.bearerWarning")}
        </div>
        {/* #37: while a lock attempt is mid-recovery on this Chama, the
            balance belongs to that trade — a Lightning drain would abandon
            it. Say so, hide the drain CTA, promote Cancel. */}
        {hasPendingNativeLock && (
          <div style={{
            fontSize: 12, color: T.amber, fontFamily: T.sans, lineHeight: 1.5,
            marginBottom: 16,
          }}>
            {t("recovery.pendingLockNote")}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Primary: recover, then auto-dispatch the queued switch.
              Bitcoin-orange to match Pillar 5.2 (accent = sats moving
              with intent). */}
          {!hasPendingNativeLock && (
            <button
              onClick={onWithdraw}
              style={{
                width: "100%", padding: "12px 14px", borderRadius: T.rs,
                background: T.accent, border: "none",
                color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
                cursor: "pointer", letterSpacing: 0.3,
              }}
            >
              {t("recovery.recoverSwitchBefore")}{recoverableSats > 0 ? <> <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /></> : ""} {t("recovery.recoverSwitchAfter")}
            </button>
          )}
          {/* Secondary (primary when a pending lock owns the balance):
              keep current Chama, abandon the switch. */}
          <button
            onClick={onCancel}
            style={{
              width: "100%", padding: hasPendingNativeLock ? "12px 14px" : "10px 14px", borderRadius: T.rs,
              background: hasPendingNativeLock ? T.accent : T.surface,
              border: hasPendingNativeLock ? "none" : `1px solid ${T.border}`,
              color: hasPendingNativeLock ? T.bg : T.text,
              fontFamily: T.mono, fontSize: hasPendingNativeLock ? 13 : 12,
              fontWeight: hasPendingNativeLock ? 800 : 700,
              cursor: "pointer",
            }}
          >
            {t("recovery.cancelKeepChama")}
          </button>
        </div>
      </div>
    </div>
  );
}
