import { useEffect, type ReactNode } from "react";
import { T } from "../theme.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { SIM_PILL_HEIGHT } from "../../sim/SimModeBanner.js";

export function Toast({ message, type, onDone, sticky = false }: {
  message: ReactNode; type: "success" | "error" | "info"; onDone: () => void;
  /** Hold until dismissed. For a toast that CARRIES A DECISION — a button the
   *  user is meant to press — an auto-dismiss makes the affordance a race the
   *  user usually loses. Sticky toasts get an explicit ✕ instead. */
  sticky?: boolean;
}) {
  // Type-aware dwell: a success/info confirmation only needs a glance, so it
  // shouldn't linger; an error carries more to read, so it stays a touch longer.
  const dwellMs = type === "error" ? 4500 : type === "info" ? 3000 : 2200;
  useEffect(() => {
    if (sticky) return;
    const t = setTimeout(onDone, dwellMs);
    return () => clearTimeout(t);
  }, [onDone, dwellMs, sticky]);
  const colors = { success: T.green, error: T.red, info: T.accent };
  // v0.4.2 hotfix round 2: SIM MODE pill (top:0, z:10000) was clipping
  // the top of the toast (top:16, z:9999). Slide the toast below the
  // pill when sim mode is on so the green community-switch confirmation
  // and other toasts read cleanly.
  const topOffset = isSimModeOn() ? SIM_PILL_HEIGHT + 16 : 16;
  return (
    <div style={{
      position: "fixed", top: topOffset, left: "50%", transform: "translateX(-50%)",
      // A sticky toast carries a corner ✕. Pad the right so a long message
      // never runs under it, rather than letting it wrap to its own line.
      padding: sticky ? "14px 40px 14px 24px" : "14px 24px", borderRadius: 999,
      // OPAQUE surface so the toast never blends into whatever's behind it — a
      // toast is allowed to hide the page for its few seconds. The type colour
      // lives in the border, icon, and text; a soft shadow lifts it off.
      background: T.card, border: `1.5px solid ${colors[type]}99`,
      boxShadow: `0 10px 28px rgba(0,0,0,0.45), 0 0 0 1px ${T.bg}`,
      // Readable-first: bold DM Sans (NOT mono) at a size anyone can catch at a
      // glance — this is a human notification, not a crypto string. "Be bold on
      // important stuff" (fed switches, reconnects, vote confirmations).
      color: colors[type], fontFamily: T.sans, fontSize: 15.5, fontWeight: 800,
      lineHeight: 1.35, letterSpacing: 0.1,
      zIndex: 9999, animation: "fadeIn 0.3s ease",
      maxWidth: "92vw", textAlign: "center", wordBreak: "break-word",
    }}>
      <span style={{ display: "inline-flex", alignItems: "baseline", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
        <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>{type === "success" ? "✓" : type === "error" ? "✗" : "⚡"}</span>
        <span>{message}</span>
      </span>
      {sticky && (
        <button
          type="button"
          onClick={onDone}
          aria-label="Dismiss"
          style={{
            position: "absolute", top: 10, right: 14,
            background: "none", border: "none", color: colors[type],
            fontFamily: T.sans, fontSize: 14, fontWeight: 800,
            cursor: "pointer", padding: 0, lineHeight: 1, opacity: 0.65,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
