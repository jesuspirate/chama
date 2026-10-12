import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

// One-time-per-account positive runtime announcement.
// v1.1.0: the production-safe real-sats paths are the shells that ship
// their own Fedimint path directly: Fedi, Tauri desktop, and the APK.
// The component keeps the old name so callsites/storage migration stay
// small, but the copy is no longer browser-specific.
export function BrowserSupportBanner({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useT();
  return (
    <div style={{
      margin: "12px 16px", padding: "14px 16px",
      background: T.amberDim, border: `1px solid ${T.amber}44`,
      borderRadius: T.r,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{
        fontSize: T.fs.secondary, fontWeight: 700, color: T.amber, fontFamily: T.sans,
      }}>
        {t("browse.realMoneyTrades")}
      </div>
      <div style={{
        fontSize: 13, color: T.text, fontFamily: T.sans,
        lineHeight: 1.55,
      }}>
        {t("browse.realMoneyBody")}
      </div>
      <details style={{
        color: T.muted, fontFamily: T.sans, fontSize: 12, lineHeight: 1.55,
      }}>
        <summary style={{
          cursor: "pointer", color: T.amber, fontFamily: T.sans,
          fontSize: T.fs.secondary, fontWeight: 700,
        }}>
          {t("browse.technicalDetails")}
        </summary>
        <div style={{ marginTop: 8 }}>
          {t("browse.technicalDetailsBody")}
        </div>
      </details>
      <button
        onClick={onDismiss}
        style={{
          alignSelf: "flex-start",
          padding: "7px 14px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.amber}44`,
          color: T.amber, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("browse.gotIt")}
      </button>
    </div>
  );
}
