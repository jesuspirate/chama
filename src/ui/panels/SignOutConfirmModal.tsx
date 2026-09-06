import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

// ══════════════════════════════════════════════════════════════════════════
// Chama — SignOutConfirmModal
// ══════════════════════════════════════════════════════════════════════════
//
// Sign out is destructive: on native/Tauri it wipes the recovery key from this
// device's secure storage (removeSavedNsec in App.tsx), and on web it drops the
// in-memory key on reload. Either way the user needs THEIR OWN saved copy to
// sign back in — Chama never keeps it and can't recover it. The creation-time
// gate (NsecLogin: forced copy + paste-back verify) makes sure a generated key
// was backed up at least once, but a returning user could still tap Sign out on
// a device holding their only copy. This confirm is that last-chance backstop.
//
// No window.confirm(): it's a silent no-op / blocking in the Capacitor and Tauri
// webviews (same class of problem as navigator.clipboard — see CopyButton), so
// every confirm in this app is an in-DOM modal like this one.
export function SignOutConfirmModal({
  onCancel,
  onConfirm,
}: {
  /** Dismiss without signing out; the key stays put. */
  onCancel: () => void;
  /** Proceed with the destructive sign-out (wipe + reload). */
  onConfirm: () => void;
}) {
  const { t } = useT();
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, zIndex: 1100,
    }}>
      <div style={{
        maxWidth: 400, width: "100%", padding: 20, borderRadius: T.r,
        background: T.card, border: `1px solid ${T.amber}66`,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          {t("me.signOutConfirmTag")}
        </div>
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
          {t("me.signOutConfirmBody")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Destructive action stays muted/outlined, never a filled accent —
              signing out is not the encouraged path. */}
          <button
            onClick={onConfirm}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: T.rs,
              background: "transparent", border: `1px solid ${T.red}`,
              color: T.red, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            {t("me.signOut")}
          </button>
          <button
            onClick={onCancel}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: T.rs,
              background: T.surface, border: `1px solid ${T.border}`,
              color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
