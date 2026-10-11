import { useEffect, type ReactNode } from "react";
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
export function OverlaySheet({ title, subtitle, onClose, children, fullHeight = false }: {
  fullHeight?: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed", inset: 0, zIndex: 400,
        display: "flex", alignItems: fullHeight ? "flex-end" : "center", justifyContent: "center",
        padding: fullHeight ? "env(safe-area-inset-top, 0px) 0 0" : "24px 16px calc(24px + env(safe-area-inset-bottom, 0px))",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)",
        animation: "fadeIn 0.18s ease",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: fullHeight ? "none" : 460, maxHeight: fullHeight ? "100%" : "80dvh", overflowY: fullHeight ? "hidden" : "auto",
          ...(fullHeight ? { height: "100%", display: "flex", flexDirection: "column" as const, minHeight: 0 } : {}),
          background: T.card, border: `1px solid ${T.borderHi}`,
          borderRadius: fullHeight ? "20px 20px 0 0" : T.r, padding: fullHeight ? "16px 12px calc(12px + env(safe-area-inset-bottom, 0px))" : "20px 20px 16px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
            margin: "8px 0 16px", lineHeight: 1.5,
          }}>
            {subtitle}
          </div>
        )}
        {fullHeight ? <div style={{ flex: 1, minHeight: 0, marginTop: 12 }}>{children}</div> : children}
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%", marginTop: 16, padding: "11px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.borderHi}`,
            color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t("common.done")}
        </button>
      </div>
    </div>
  );
}
