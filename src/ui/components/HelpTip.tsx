// Reusable contextual "?" — a tiny affordance that opens a short popover anchored
// near it, dismissed by tapping the backdrop or pressing Esc (focus returns to the
// trigger). Land it anywhere a field or label needs a plain-language aside (first
// home: the arbiter application form). Theme-tokened so it reads correctly in dark
// AND light, with no new dependency.
//
// The popover is position:FIXED, measured from the trigger's rect on open and
// clamped to the viewport. That's deliberate: an inline absolute popover gets
// clipped by any overflow:hidden ancestor (e.g. the narrow arbiter card), and a
// "?" often sits near a container edge. Fixed + clamp escapes the clip and never
// runs off-screen.

import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

const POPOVER_WIDTH = 248;

export function HelpTip({ title, children, label }: {
  title?: string;
  children: ReactNode;
  /** Accessible name for the trigger. Defaults to a localized "What is this?". */
  label?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = globalThis.innerWidth || 360;
    const vh = globalThis.innerHeight || 640;
    const margin = 8;
    // Centre under the trigger, then clamp into the viewport on both axes.
    let left = r.left + r.width / 2 - POPOVER_WIDTH / 2;
    left = Math.max(margin, Math.min(left, vw - POPOVER_WIDTH - margin));
    const top = Math.min(r.bottom + 6, vh - 200);
    setPos({ top, left });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    const reflow = () => place();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
  }, [open]);

  return (
    <span style={{ display: "inline-flex", verticalAlign: "middle" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label ?? t("browse.helpTipLabel")}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          // Visual circle is the inner span; the button pads out to a ≥40px touch
          // target, with a negative margin so it doesn't bloat the inline layout.
          background: "none", border: "none", padding: 10, margin: -10,
          cursor: "pointer", display: "inline-grid", placeItems: "center", lineHeight: 0,
        }}
      >
        <span aria-hidden="true" style={{
          width: 20, height: 20, borderRadius: 999,
          background: open ? T.accent : T.surface,
          border: `1px solid ${open ? T.accent : T.border}`,
          color: open ? T.onInk : T.muted,
          fontFamily: T.sans, fontSize: T.fs.body, fontWeight: 800,
          display: "grid", placeItems: "center", lineHeight: 1,
        }}>?</span>
      </button>
      {open && pos && (
        <>
          {/* Backdrop — a tap anywhere outside dismisses (same fixed-overlay idiom
              the app's modals use). Transparent so the screen stays visible. */}
          <div
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            style={{ position: "fixed", inset: 0, zIndex: 200, background: "transparent" }}
          />
          <div
            role="dialog"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed", zIndex: 201,
              top: pos.top, left: pos.left,
              width: POPOVER_WIDTH, maxWidth: "92vw",
              background: T.card, border: `1px solid ${T.borderHi}`,
              borderRadius: T.r, padding: "12px 14px",
              boxShadow: "0 14px 36px #0009",
              textAlign: "left",
            }}
          >
            {title && (
              <div style={{ fontFamily: T.sans, fontSize: 10, fontWeight: 800, letterSpacing: 0.8, color: T.accent, marginBottom: 6 }}>
                {title}
              </div>
            )}
            <div style={{ fontFamily: T.sans, fontSize: 12.5, lineHeight: 1.55, color: T.text }}>
              {children}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
