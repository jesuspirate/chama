import { useState, useRef, useEffect } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

/** Copy text to the clipboard, robustly. navigator.clipboard is undefined or a
 *  no-op in some Tauri/Capacitor webviews (same class as window.confirm), so
 *  fall back to a hidden-textarea + execCommand("copy"). Exported for the few
 *  programmatic (non-button) copy sites — every visible copy BUTTON should be a
 *  <CopyButton> instead. */
export function copyTextRobust(text: string): void {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
      return;
    }
  } catch { /* fall through */ }
  execCommandCopy(text);
}
/** Used when the UI promises that a failed wallet handoff was copied. */
export async function copyTextConfirmed(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } }
  catch { /* Try the legacy clipboard API below. */ }
  return execCommandCopy(text);
}
function execCommandCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    return copied;
  } catch { return false; }
}

// A copy button that actually FEELS alive: on click it copies, then swaps to
// "✓ Copied!" with a brief green tint + scale pulse, and reverts after ~1.3s.
// Drop-in for any `<button onClick={copy}>Copy</button>`; pass the site's own
// `style` to keep its look. (Used app-wide so no copy button is a dead button.)
export function CopyButton({
  value,
  label,
  copiedLabel,
  style,
  disabled,
  onCopied,
}: {
  value: string;
  /** Defaults to a localized "Copy". */
  label?: string;
  /** Defaults to a localized "✓ Copied!". */
  copiedLabel?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  /** Called after the explicit copy action. Useful when a flow must prove
   *  that the user performed a real backup step before continuing. */
  onCopied?: () => void;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = () => {
    if (disabled) return;
    copyTextRobust(value);
    onCopied?.();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1300);
  };

  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      style={{
        ...style,
        transition: "transform .12s ease, background .2s ease, color .2s ease, border-color .2s ease",
        transform: copied ? "scale(0.97)" : "scale(1)",
        ...(copied
          ? { background: "rgba(52,199,89,0.14)", borderColor: T.green, color: T.green }
          : {}),
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {copied ? (copiedLabel ?? t("browse.copiedDefault")) : (label ?? t("common.copy"))}
    </button>
  );
}
