import { useEffect, useRef, type ReactNode } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

// ══════════════════════════════════════════════════════════════════════════
// Chama — small information, shown in front of you
// ══════════════════════════════════════════════════════════════════════════
//
// Jet, 2026-09-20: *"maybe do a simple overlay that displays the listed
// addresses by blurring everything behind it, something simple. Let's get in
// the habit of displaying simple info right in front of the user's eyes."*
//
// A short, read-mostly surface should not become a PAGE. A page costs the
// user their place: the app navigates away, and "back" becomes a guess (the
// saved-address view closed to the wrong tab for exactly this reason). This
// sheet keeps the screen behind you — blurred, still there — and closes to
// precisely where you were, by tapping outside, pressing Escape, or Done.
export function OverlaySheet({ title, subtitle, onClose, children, dismissible = true, showDone = true, showClose = false }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** A task can supply its own action footer and prevent dismissal while working. */
  dismissible?: boolean;
  showDone?: boolean;
  showClose?: boolean;
}) {
  const { t } = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => { if (dismissible) onClose(); };
  const backdropPress = useRef(false);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // Contextual help above this sheet owns its own Escape and Tab first.
      if (document.querySelector("[data-help-popover]")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && dialog) {
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        )).filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first) {
          e.preventDefault();
          dialog.focus();
        } else if (!dialog.contains(document.activeElement) || document.activeElement === dialog ||
          (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      onMouseDown={e => { backdropPress.current = e.target === e.currentTarget; }}
      onClick={e => { if (backdropPress.current && e.target === e.currentTarget) closeRef.current(); backdropPress.current = false; }}
      role="presentation"
      data-overlay-backdrop
      style={{
        position: "fixed", inset: 0, zIndex: 400,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "24px 16px calc(24px + env(safe-area-inset-bottom, 0px))",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)",
        animation: "fadeIn 0.18s ease",
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460, maxHeight: "80dvh", overflowY: "auto",
          background: T.card, border: `1px solid ${T.borderHi}`,
          borderRadius: T.r, padding: "20px 20px 16px",
          outline: "none",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: !subtitle && showClose ? 16 : 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>{title}</div>
          {showClose && <button type="button" aria-label={t("common.close")} disabled={!dismissible} onClick={() => closeRef.current()}
            style={{ background: "none", border: 0, boxShadow: "none", color: T.muted, fontSize: 24, width: 44, minHeight: 44, flexShrink: 0, cursor: dismissible ? "pointer" : "default" }}>×</button>}
        </div>
        {subtitle && (
          <div style={{
            fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
            margin: "8px 0 16px", lineHeight: 1.5,
          }}>
            {subtitle}
          </div>
        )}
        {children}
        {showDone && <button
          type="button"
          disabled={!dismissible}
          onClick={() => closeRef.current()}
          style={{
            width: "100%", marginTop: 16, padding: "11px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.borderHi}`,
            color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t("common.done")}
        </button>}
      </div>
    </div>
  );
}
