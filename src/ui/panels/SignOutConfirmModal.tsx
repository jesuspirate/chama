import { PaymentButton } from "../components/PaymentCard.js";
import { useCallback, useState } from "react";
import { RecoveryKeyBlock, useRecoveryKeyBackup } from "../components/RecoveryKey.js";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

export function SignOutConfirmModal({
  onCancel, pubkey = "", loadActiveRecoveryKey,
  onConfirm,
}: {
  pubkey?: string;
  loadActiveRecoveryKey?: () => Promise<string | null>;
  /** Dismiss without signing out; the key stays put. */
  onCancel: () => void;
  /** Proceed with the destructive sign-out (wipe + reload). */
  onConfirm: () => void;
}) {
  const { t } = useT();
  const saved = useRecoveryKeyBackup(pubkey);
  const [ready, setReady] = useState(saved);
  const markReady = useCallback(() => setReady(true), []);
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, zIndex: 1100,
    }}>
      <div role="dialog" aria-modal="true" style={{
        maxHeight: "calc(100dvh - 40px)", overflowY: "auto",
        maxWidth: 400, width: "100%", padding: 20, borderRadius: T.r,
        background: T.card, border: `1px solid ${T.border}`,
      }}>
        <div style={{
          fontSize: 15, fontWeight: 800, color: T.text, fontFamily: T.sans,
          marginBottom: 10,
        }}>
          {t("me.signOutConfirmTitle")}
        </div>
        <div style={{
          fontSize: 13, color: T.muted, fontFamily: T.sans, lineHeight: 1.55,
          marginBottom: 18,
        }}>
          {t(saved ? "backup.signOutLight" : "backup.signOutBody")}
        </div>
        {!saved && <RecoveryKeyBlock pubkey={pubkey} loadKey={loadActiveRecoveryKey} onReady={markReady} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Destructive action stays muted/outlined, never a filled accent —
              signing out is not the encouraged path. */}
          <PaymentButton
            disabled={!ready && !saved}
            onClick={onConfirm}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: 999,
              background: "transparent", border: `1px solid ${T.red}`,
              color: T.red, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            {t(saved ? "me.signOut" : "backup.signOutSaved")}
          </PaymentButton>
          <PaymentButton
            onClick={onCancel}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 999,
              background: T.surface, border: `1px solid ${T.border}`,
              color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </PaymentButton>
        </div>
      </div>
    </div>
  );
}
