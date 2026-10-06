// ══════════════════════════════════════════════════════════════════════════
// Chama — Button + HoldToConfirm (v7 redesign foundation)
// ══════════════════════════════════════════════════════════════════════════
//
// Buttons are INK (near-white on dark, near-black on light). Role colours are
// never button fills — they name people. Variants follow the canvas:
//   primary     ink fill, onInk label            ("Find matches")
//   secondary   raised fill, line border         ("Message Swift Twiga")
//   destructive critical tint, critical label     ("Open a dispute")
//   plain       no fill, underlined ink label     ("Not now")
// `money` sizes a button for a money action: 60px tall with a 19px semibold
// label on phones (T.size.moneyButton / T.fs.moneyButton), 48px on desktop.
//
// HoldToConfirm replaces "tap again" for money moves (lock, release, refund,
// collect). It only CONFIRMS — the caller still owns every guard and the
// action itself, so wiring it in changes no money-path behaviour.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { T } from "../theme.js";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "plain";

export function buttonStyle(
  variant: ButtonVariant = "primary",
  opts: { money?: boolean; disabled?: boolean; fullWidth?: boolean } = {},
): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    minHeight: opts.money ? T.size.moneyButton : T.size.button,
    padding: "0 20px",
    width: opts.fullWidth === false ? undefined : "100%",
    borderRadius: T.r,
    fontFamily: T.sans,
    fontSize: opts.money ? T.fs.moneyButton : T.fs.button,
    fontWeight: 600, lineHeight: 1.2,
    textAlign: "center",
    cursor: opts.disabled ? "not-allowed" : "pointer",
    opacity: opts.disabled ? 0.45 : 1,
    border: "1px solid transparent",
    // Labels wrap rather than truncate (an amount is never cut off).
    whiteSpace: "normal",
  };
  switch (variant) {
    case "primary":
      return { ...base, background: T.ink, color: T.onInk };
    case "secondary":
      return { ...base, background: T.raised, color: T.ink, borderColor: T.line };
    case "destructive":
      return { ...base, background: T.critBg, color: T.crit };
    case "plain":
      return {
        ...base, background: "transparent", color: T.ink,
        textDecoration: "underline", textUnderlineOffset: 4,
      };
  }
}

export function Button({
  variant = "primary", money, fullWidth, disabled, onClick, children, style, type = "button", ...rest
}: {
  variant?: ButtonVariant;
  money?: boolean;
  fullWidth?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
  type?: "button" | "submit";
  "aria-label"?: string;
  "data-coach"?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{ ...buttonStyle(variant, { money, disabled, fullWidth }), ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** How long a hold takes to confirm (canvas: 1.2 s). */
export const HOLD_TO_CONFIRM_MS = 1200;
/** Window in which a second assistive-tech activation confirms. */
export const ASSISTIVE_CONFIRM_WINDOW_MS = 5000;

/**
 * Pure state for HoldToConfirm, separate from React so the confirm rule is
 * testable: a pointer or key HOLD of `holdMs` confirms; lifting early cancels;
 * a click that did not come from a pointer (detail === 0 — what VoiceOver,
 * TalkBack and switch access dispatch) ARMS on the first activation and
 * confirms on a second within the window. A plain pointer tap never confirms.
 */
export type HoldEvent =
  | { type: "press"; at: number }
  | { type: "release"; at: number }
  | { type: "tick"; at: number }
  | { type: "assistive-activate"; at: number };
export type HoldState =
  | { kind: "idle" }
  | { kind: "holding"; since: number }
  | { kind: "armed"; at: number }
  | { kind: "confirmed" };

export function holdReducer(state: HoldState, ev: HoldEvent, holdMs = HOLD_TO_CONFIRM_MS): HoldState {
  if (state.kind === "confirmed") return state;
  switch (ev.type) {
    case "press":
      return { kind: "holding", since: ev.at };
    case "release":
      return state.kind === "holding" ? { kind: "idle" } : state;
    case "tick":
      if (state.kind === "holding" && ev.at - state.since >= holdMs) return { kind: "confirmed" };
      if (state.kind === "armed" && ev.at - state.at > ASSISTIVE_CONFIRM_WINDOW_MS) return { kind: "idle" };
      return state;
    case "assistive-activate":
      if (state.kind === "armed" && ev.at - state.at <= ASSISTIVE_CONFIRM_WINDOW_MS) return { kind: "confirmed" };
      return { kind: "armed", at: ev.at };
  }
}

/** The finish of a completed hold: a quick scale pop (still under reduced motion). */
const HOLD_CSS = `@keyframes chamaHoldPop{0%{transform:scale(1)}40%{transform:scale(1.035)}100%{transform:scale(1)}}
.chama-hold-done{animation:chamaHoldPop 260ms cubic-bezier(.34,1.56,.64,1)}
@media (prefers-reduced-motion: reduce){.chama-hold-done{animation:none}}`;

function CheckGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
  );
}

function haptic(kind: "light" | "heavy"): void {
  try {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (cap?.isNativePlatform?.()) {
      void import("@capacitor/haptics")
        .then(({ Haptics, ImpactStyle }) =>
          Haptics.impact({ style: kind === "light" ? ImpactStyle.Light : ImpactStyle.Heavy }))
        .catch(() => {});
      return;
    }
    globalThis.navigator?.vibrate?.(kind === "light" ? 10 : 30);
  } catch {
    // Haptics are a nicety; never let them affect the action.
  }
}

/**
 * A money-move button: hold to confirm. `label` is the resting text ("Hold to
 * lock ₿ 250,000"); `armedLabel` is spoken/shown after a first assistive
 * activation. `onConfirm` fires once per completed hold; the component resets
 * when `resetKey` changes (e.g. after the action settles) or when re-enabled.
 */
export function HoldToConfirm({
  label, armedLabel, hint, onConfirm, disabled, busy, icon, variant = "primary", resetKey, holdMs = HOLD_TO_CONFIRM_MS,
  "data-coach": dataCoach, plain = false,
}: {
  label: ReactNode;
  /** Shown + announced after a first screen-reader activation. */
  armedLabel: string;
  /** Always-visible caption under the button ("Press and hold to confirm").
   *  Emphasised after a tap that let go too early. */
  hint: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  variant?: "primary" | "secondary" | "destructive";
  resetKey?: unknown;
  holdMs?: number;
  "data-coach"?: string;
  /** Render as a plain tap button with the same handler (used where a later
   *  step holds instead — e.g. Collect opening a claim sheet that holds). */
  plain?: boolean;
}) {
  const [state, setState] = useState<HoldState>({ kind: "idle" });
  const [progress, setProgress] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const raf = useRef<number | null>(null);
  const keyHeld = useRef(false);
  const pointerActive = useRef(false);
  const confirmedFired = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const inactive = !!disabled || !!busy;

  const reset = () => {
    setState({ kind: "idle" });
    setProgress(0);
    confirmedFired.current = false;
  };
  // A new action (resetKey) always starts fresh.
  useEffect(reset, [resetKey]);
  // Becoming usable again resets — so a failed action can be retried — but
  // becoming BUSY must not: the confirm sets busy, and resetting then swept the
  // fill back to 0 and dimmed the button mid-action (the glitch Jet saw on
  // vote 1, vote 2 and the LN-address send). A completed hold stays complete.
  const wasInactive = useRef(!!disabled || !!busy);
  useEffect(() => {
    const nowInactive = !!disabled || !!busy;
    if (wasInactive.current && !nowInactive) reset();
    wasInactive.current = nowInactive;
  }, [disabled, busy]);

  useEffect(() => {
    if (state.kind === "confirmed" && !confirmedFired.current) {
      confirmedFired.current = true;
      haptic("heavy");
      setProgress(1);
      onConfirmRef.current();
    }
    if (state.kind !== "holding") {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      if (state.kind === "idle") setProgress(0);
      return;
    }
    const loop = () => {
      const now = performance.now();
      setProgress(Math.min(1, (now - state.since) / holdMs));
      setState(s => holdReducer(s, { type: "tick", at: now }, holdMs));
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
  }, [state, holdMs]);

  const press = () => {
    if (inactive || state.kind === "confirmed") return;
    setShowHint(false);
    haptic("light");
    setState(s => holdReducer(s, { type: "press", at: performance.now() }, holdMs));
  };
  const release = () => {
    if (state.kind === "holding" && progress < 1) setShowHint(true);
    setState(s => holdReducer(s, { type: "release", at: performance.now() }, holdMs));
  };

  const done = state.kind === "confirmed";
  // A completed hold keeps full strength while its action runs (no dimming).
  const base = buttonStyle(variant, { money: true, disabled: inactive && !done });
  if (plain) {
    return (
      <button type="button" disabled={inactive} data-coach={dataCoach} style={base} onClick={() => onConfirmRef.current()}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{icon}{label}</span>
      </button>
    );
  }
  const fillColor = variant === "primary" ? T.onInk : variant === "secondary" ? T.ink : T.crit;
  const armed = state.kind === "armed";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
      <style>{HOLD_CSS}</style>
      <button
        type="button"
        disabled={inactive}
        data-coach={dataCoach}
        data-hold-state={state.kind}
        className={done ? "chama-hold-done" : undefined}
        style={{ ...base, position: "relative", overflow: "hidden", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
        onPointerDown={e => {
          if (e.button !== 0) return;
          pointerActive.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          press();
        }}
        onPointerUp={() => { pointerActive.current = false; release(); }}
        onPointerCancel={() => { pointerActive.current = false; release(); }}
        onContextMenu={e => e.preventDefault()}
        onKeyDown={e => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            keyHeld.current = true;
            press();
          }
        }}
        onKeyUp={e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            keyHeld.current = false;
            release();
          }
        }}
        onClick={e => {
          // Pointer taps and keyboard presses are handled as holds above.
          // A click with no pointer behind it is an assistive activation.
          if (inactive || e.detail !== 0 || keyHeld.current || pointerActive.current) return;
          setState(s => holdReducer(s, { type: "assistive-activate", at: performance.now() }, holdMs));
        }}
      >
        <span aria-hidden="true" style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: `${Math.round(progress * 100)}%`,
          background: fillColor, opacity: done ? 0.3 : 0.22,
          transition: state.kind === "holding" || done ? "none" : "width 200ms ease",
        }} />
        <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {done ? <CheckGlyph /> : icon}
          {armed ? armedLabel : label}
        </span>
      </button>
      <div aria-live="polite" style={{
        minHeight: "1.4em", textAlign: "center",
        fontSize: T.fs.secondary, fontFamily: T.sans,
        color: armed || showHint ? T.ink : T.ink2, fontWeight: armed || showHint ? 600 : 400,
      }}>
        {armed ? armedLabel : hint}
      </div>
    </div>
  );
}
