import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

/** One preference for all unfunded offers; stores need no separate renewal nag. */
export function LapsedStoreCard({ autoRenewEnabled, onAutoRenewChange }: {
  autoRenewEnabled: boolean;
  onAutoRenewChange: (enabled: boolean) => void;
}) {
  const { t } = useT();
  return (
    <div
      style={{
        width: "calc(100% - 32px)",
        margin: "12px 16px 0",
        padding: "12px 14px",
        background: T.purpleDim,
        border: `1px solid ${T.purple}66`,
        borderRadius: T.r,
        fontFamily: T.sans,
      }}
    >
      {(
        <button
          type="button"
          onClick={() => onAutoRenewChange(!autoRenewEnabled)}
          aria-pressed={autoRenewEnabled}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: 0, border: "none", background: "none", textAlign: "left",
            cursor: "pointer", fontFamily: T.sans,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12, color: T.text, fontWeight: 700 }}>
              {t("me.storeAutoRenew")}
            </span>
            <span style={{ display: "block", fontSize: 10.5, color: T.muted, marginTop: 2, lineHeight: 1.4 }}>
              {t("me.storeAutoRenewHint")}
            </span>
          </span>
          <span aria-hidden="true" style={{
            flexShrink: 0, width: 40, height: 22, borderRadius: 999, position: "relative",
            background: autoRenewEnabled ? T.purple : T.border,
          }}>
            <span style={{
              position: "absolute", top: 2, left: autoRenewEnabled ? 20 : 2,
              width: 18, height: 18, borderRadius: "50%", background: "#fff",
              transition: "left .2s",
            }} />
          </span>
        </button>
      )}
    </div>
  );
}
