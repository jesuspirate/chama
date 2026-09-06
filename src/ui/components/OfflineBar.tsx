import { T } from "../theme.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

/**
 * Unmissable offline banner. The subtle header status is easy to miss, so when
 * relays are down this pins a loud bar to the top — reinforcing the requireOnline
 * gate that already blocks any publish/money action while offline.
 */
export function OfflineBar() {
  return (
    <div
      role="status"
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
        padding: "9px 14px", background: T.red, color: "#fff",
        fontFamily: T.mono, fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
        textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.28)",
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: "#fff",
        opacity: 0.9, flexShrink: 0, animation: "pulse 2s ease-in-out infinite",
      }} />
      {translate(getCurrentLang(), "canvas.offlineBar")}
    </div>
  );
}
