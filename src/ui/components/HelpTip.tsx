import { useId, useState, useRef, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

/** Short help uses the Community popover style. Reading it never leaves the
 * current task. The portal keeps it above clipped cards and funding sheets. */
export function HelpTip({ title, children, label }: {
  title?: string;
  children: ReactNode;
  label?: string;
}) {
  const { t } = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const name = label ?? t("custody.what");
  const close = (restore = true) => {
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  };
  const place = () => {
    if (!trigger.current || !dialog.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
    const topEdge = (viewport?.offsetTop ?? 0) + 8;
    const width = Math.min(248, (viewport?.width ?? innerWidth) - 16);
    const maxHeight = (viewport?.height ?? innerHeight) - 16;
    const height = Math.min(dialog.current.getBoundingClientRect().height, maxHeight);
    const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 16;
    const bottomEdge = topEdge + maxHeight;
    const below = rect.bottom + 6;
    const above = rect.top - 6 - height;
    const preferred = below + height <= bottomEdge ? below : above >= topEdge ? above : below;
    const next = {
      left: Math.max(leftEdge, Math.min(rect.left + rect.width / 2 - width / 2, rightEdge - width)),
      top: Math.max(topEdge, Math.min(preferred, bottomEdge - height)), width, maxHeight,
    };
    setPos(previous => previous && Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useLayoutEffect(() => { if (open && pos) dialog.current?.focus({ preventScroll: true }); }, [open, !!pos]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (event.key === "Tab" && dialog.current) {
        const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]'))
          .filter(el => el.getClientRects().length > 0);
        const active = document.activeElement;
        // Short read-only help does not trap someone in a task. Tab enters any
        // help link, then dismisses and continues from the original trigger.
        if (active === dialog.current && controls.length && !event.shiftKey) {
          event.preventDefault(); controls[0].focus();
        } else if (!controls.length || (event.shiftKey ? active === controls[0] || active === dialog.current : active === controls.at(-1))) {
          close();
        }
      }
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!dialog.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const back = () => close(false);
    const observer = new ResizeObserver(place);
    if (dialog.current) observer.observe(dialog.current);
    window.addEventListener("keydown", key, true);
    window.addEventListener("focusin", focus);
    window.addEventListener("popstate", back);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("focusin", focus);
      window.removeEventListener("popstate", back);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  return <span data-help-tip style={{ display: "inline-flex", verticalAlign: "middle", flexShrink: 0 }}>
    <style>{`.chama-help-trigger:focus-visible{outline:2px solid ${T.accent};outline-offset:2px}@keyframes chama-help-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}.chama-help-popover{animation:chama-help-in .16s ease-out}@media(prefers-reduced-motion:reduce){.chama-help-popover{animation:none}}`}</style>
    <button ref={trigger} className="chama-help-trigger" type="button" aria-label={name}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onClick={event => { event.stopPropagation(); open ? close() : setOpen(true); }}
      style={{ width: 44, height: 44, flexShrink: 0, background: "none", border: "none", boxShadow: "none", padding: 12, margin: -12, borderRadius: T.rs, cursor: "pointer", display: "inline-grid", placeItems: "center", lineHeight: 0 }}>
      <span aria-hidden="true" style={{ width: 20, height: 20, boxSizing: "border-box", borderRadius: 999,
        background: open ? T.accent : T.surface, border: `1px solid ${open ? T.accent : T.border}`,
        color: open ? "#fff" : T.muted, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
        display: "grid", placeItems: "center", lineHeight: 1 }}>?</span>
    </button>
    {open && createPortal(<>
      <div data-help-backdrop onClick={event => { event.stopPropagation(); close(); }}
        style={{ position: "fixed", inset: 0, zIndex: 10020, background: "transparent" }} />
      <div ref={dialog} id={id} data-help-popover className="chama-help-popover" role="dialog" tabIndex={-1}
        aria-label={title ?? name} aria-describedby={`${id}-body`}
        onClick={event => event.stopPropagation()}
        style={{ position: "fixed", zIndex: 10021, top: pos?.top ?? 0, left: pos?.left ?? 0,
          width: pos?.width ?? 248, maxHeight: pos?.maxHeight ?? "calc(100dvh - 16px)",
          maxWidth: "calc(100vw - 16px)", boxSizing: "border-box", overflowY: "auto", visibility: pos ? "visible" : "hidden",
          background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, padding: "12px 14px",
          boxShadow: "0 14px 36px #0009", textAlign: "left", outline: "none", overflowWrap: "anywhere" }}>
        {title && <div style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, color: T.accent, marginBottom: 6 }}>{title}</div>}
        <div id={`${id}-body`} style={{ fontFamily: T.sans, fontSize: 12.5, lineHeight: 1.55, color: T.text }}>{children}</div>
      </div>
    </>, document.body)}
  </span>;
}
