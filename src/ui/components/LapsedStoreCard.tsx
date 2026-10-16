import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

/** One preference for all unfunded offers; stores need no separate renewal nag.
 *  v7 redesign (Jet): a compact single-row switch under the Me title, so it
 *  never competes with it. The explanation stays available to screen readers
 *  and as the row's tooltip. */
export function LapsedStoreCard({ autoRenewEnabled, onAutoRenewChange }: {
  autoRenewEnabled: boolean;
  onAutoRenewChange: (enabled: boolean) => void;
}) {
  const { t } = useT();
  return (
    <div style={{ maxWidth: 760, margin: "8px auto 0", padding: "0 16px", fontFamily: T.sans }}>
      <button
        type="button"
        role="switch"
        aria-checked={autoRenewEnabled}
        aria-describedby="chama-store-autorenew-hint"
        title={t("me.storeAutoRenewHint")}
        onClick={() => onAutoRenewChange(!autoRenewEnabled)}
        style={{
          width: "100%", minHeight: T.size.touch, display: "flex", alignItems: "center", gap: 12,
          padding: "0 2px", border: "none", borderBottom: `1px solid ${T.line}`, background: "none",
          textAlign: "left", cursor: "pointer", fontFamily: T.sans,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: T.fs.secondary, color: T.ink2, fontWeight: 500 }}>
          {t("me.storeAutoRenew")}
        </span>
        <span id="chama-store-autorenew-hint" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {t("me.storeAutoRenewHint")}
        </span>
        <span aria-hidden="true" style={{
          flexShrink: 0, width: 44, height: 26, borderRadius: 999, position: "relative",
          background: autoRenewEnabled ? T.pos : T.line,
        }}>
          <span style={{
            position: "absolute", top: 3, left: autoRenewEnabled ? 21 : 3,
            width: 20, height: 20, borderRadius: "50%", background: "#FFFFFF",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .2s",
          }} />
        </span>
      </button>
    </div>
  );
}
