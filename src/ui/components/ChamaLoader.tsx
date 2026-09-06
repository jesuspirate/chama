import { T } from "../theme.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

/**
 * The boot color-cycle Chama mark, packaged as a reusable inline loading
 * indicator — the same animated PNG the app opens with, so "loading" looks
 * like Chama everywhere instead of a generic ring. Falls back to the static
 * woven-trust mark under prefers-reduced-motion (classes swapped in globalCss).
 */
export function ChamaLoader({ size = 30, label }: { size?: number; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? translate(getCurrentLang(), "common.loading")}
      style={{ display: "inline-flex", alignItems: "center", gap: 11 }}
    >
      <img className="chama-loader-motion" src="/icons/chama-color-cycle-boot-hd-v6.png"
        width={size} height={size} alt="" decoding="async" />
      <img className="chama-loader-static" src="/icons/chama-woven-trust-mark-transparent-64.png"
        width={size} height={size} alt="" decoding="async" />
      {label && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>{label}</span>}
    </span>
  );
}
