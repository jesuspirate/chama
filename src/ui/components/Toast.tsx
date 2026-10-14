import { missingWebCrypto } from "../browser-capability-copy.js";
import { useEffect, type ReactNode } from "react";
import { T } from "../theme.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { SIM_PILL_HEIGHT } from "../../sim/SimModeBanner.js";
import { useT } from "../../i18n/index.js";

/** What a toast says for an error message written for developers. Many callers
 *  pass `error.message` straight through; the native wallet bridge's messages
 *  carry a JSON diagnostics block and bridge jargon that filled a phone screen
 *  (Jet, 6.4.23-rc.5, first launch after the update). Bridge start-up and
 *  timeout errors get a plain sentence; any other message loses its
 *  diagnostics block. Non-string messages pass through untouched. */
export function toastText(message: ReactNode, t: (key: string) => string): ReactNode {
  if (typeof message !== "string") return message;
  if (/native_fedimint_bridge_unavailable|Native Fedimint bridge is enabled but unreachable/i.test(message)) {
    return t("app.walletStarting");
  }
  if (/native_fedimint_bridge_timeout|Native Fedimint bridge \S+ did not answer within/i.test(message)) {
    return t("app.walletSlow");
  }
  if (/couldn't read this wallet's balance, so it won't switch/i.test(message)) {
    return t("app.balanceUnknownNoSwitch");
  }
  const cut = message.indexOf("Chama diagnostics:");
  return cut >= 0 ? message.slice(0, cut).trim() : message;
}

export function Toast({ message, type, onDone, sticky = false, dismissOnTap = false }: {
  message: ReactNode; type: "success" | "error" | "info"; onDone: () => void;
  /** Hold until dismissed. For a toast that CARRIES A DECISION — a button the
   *  user is meant to press — an auto-dismiss makes the affordance a race the
   *  user usually loses. Sticky toasts get an explicit ✕ instead. */
  sticky?: boolean;
  /** 6.1: sticky comes in two flavours, and they want different exits.
   *
   *  A toast that carries a DECISION (the runtime-lease takeover button) must
   *  keep the ✕ as its only dismissal: a stray tap anywhere on the body would
   *  take the choice away mid-reach — the same race auto-dismiss loses.
   *
   *  A toast that is sticky only because it is LONG TO READ (the probe
   *  verdicts) carries no decision at all, so making the whole thing a dismiss
   *  target costs nothing and turns a 14px corner glyph into a target the size
   *  of the toast. Set it there, never on the decision-carrying ones. */
  dismissOnTap?: boolean;
}) {
  const { t } = useT();
  // A browser without Web Crypto (an http:// preview) gets one plain sentence;
  // every other message goes through toastText (no developer diagnostics).
  const displayMessage = typeof message === "string" && missingWebCrypto(message) ? t("claim.browserNeedsHttps") : toastText(message, t);
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
  // Only meaningful while sticky — a self-dismissing toast has nothing to tap.
  const tapToDismiss = sticky && dismissOnTap;
  return (
    <div
      onClick={tapToDismiss ? onDone : undefined}
      style={{
        position: "fixed", top: topOffset, left: "50%", transform: "translateX(-50%)",
        // A sticky toast carries a corner ✕. Pad the right so a long message
        // never runs under it, rather than letting it wrap to its own line.
        padding: sticky ? "14px 40px 14px 24px" : "14px 24px", borderRadius: 16,
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
        width: "max-content", maxWidth: "min(520px, calc(100vw - 32px))", maxHeight: "70dvh", overflowY: "auto", textAlign: "center", wordBreak: "break-word",
        cursor: tapToDismiss ? "pointer" : undefined,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "baseline", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
        <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>{type === "success" ? "✓" : type === "error" ? "✗" : "⚡"}</span>
        <span style={{ minWidth: 0, flex: "1 1 0" }}>{displayMessage}</span>
      </span>
      {sticky && (
        <button
          type="button"
          // stopPropagation so the ✕ and a tap-to-dismiss body don't both fire.
          onClick={(e) => { e.stopPropagation(); onDone(); }}
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
