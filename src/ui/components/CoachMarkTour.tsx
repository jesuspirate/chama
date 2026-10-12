import { useEffect, useLayoutEffect, useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

// v4.1 C1 "US-activation": a one-time, NymChat-style coach-mark tour shown once
// after a user's first sign-in. It spotlights the home screen's reachable
// surfaces (the 3 bottom-nav tabs + the 2 floating action buttons) with a
// "Step X of N · Back / Next / Skip" card, so a newcomer SEES what they can do
// instead of guessing. Device-local "seen" flag (mirrors chama_intro_seen);
// fully skippable; never blocks a real action.

export const COACH_SEEN_KEY = "chama_coach_seen_v1";

export function readCoachSeen(): boolean {
  try {
    return localStorage.getItem(COACH_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCoachSeen(): void {
  try {
    localStorage.setItem(COACH_SEEN_KEY, "1");
  } catch {
    /* private mode / quota — the tour just shows again next launch, harmless */
  }
}

export type CoachStep = {
  /** CSS selector for the element to spotlight (data-coach="…"). */
  selector: string;
  /** i18n dictionary keys — resolved with t() at render (the steps array is a
   *  module-level constant in App.tsx and can't call hooks). */
  titleKey: string;
  bodyKey: string;
};

type Rect = { top: number; left: number; width: number; height: number };

function measure(selector: string): Rect | null {
  // The same target can exist in several layouts (e.g. Create is a "+" in the
  // phone header, an extended FAB on Android and a sidebar button on wide
  // screens) with CSS hiding all but one — spotlight the one that is visible.
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }
  return null;
}

export function CoachMarkTour({ steps, onDone }: {
  steps: CoachStep[];
  onDone: () => void;
}) {
  const { t } = useT();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const finish = () => {
    markCoachSeen();
    onDone();
  };

  // Measure the current target; skip a step whose target isn't on screen so a
  // missing FAB (e.g. user navigated away) never strands the tour on a blank
  // spotlight.
  useLayoutEffect(() => {
    if (i >= steps.length) return;
    const r = measure(steps[i]!.selector);
    if (r === null) {
      if (i + 1 < steps.length) setI(i + 1);
      else finish();
      return;
    }
    setRect(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, steps]);

  // Keep the spotlight glued to its target through resize / keyboard / rotation.
  useEffect(() => {
    if (i >= steps.length) return;
    const reflow = () => {
      const r = measure(steps[i]!.selector);
      if (r) setRect(r);
    };
    window.addEventListener("resize", reflow);
    window.addEventListener("orientationchange", reflow);
    return () => {
      window.removeEventListener("resize", reflow);
      window.removeEventListener("orientationchange", reflow);
    };
  }, [i, steps]);

  if (i >= steps.length || !rect) return null;

  const step = steps[i]!;
  const pad = 8;
  const ringTop = rect.top - pad;
  const ringLeft = rect.left - pad;
  const ringW = rect.width + pad * 2;
  const ringH = rect.height + pad * 2;

  // All tour targets sit at the screen bottom (nav + FABs), so the card always
  // floats ABOVE the spotlight. Clamp it inside a phone-width column.
  const vw = window.innerWidth;
  const cardMaxW = Math.min(320, vw - 32);
  const cardBottom = window.innerHeight - rect.top + 16;
  const isLast = i === steps.length - 1;

  return (
    <div
      role="dialog"
      aria-label={t("app.coachQuickTour")}
      style={{ position: "fixed", inset: 0, zIndex: 9998 }}
    >
      {/* Spotlight: a transparent ring whose massive box-shadow dims everything
          else, leaving the target element bright and legible underneath. */}
      <div style={{
        position: "fixed",
        top: ringTop, left: ringLeft, width: ringW, height: ringH,
        borderRadius: 14,
        boxShadow: `0 0 0 9999px rgba(0,0,0,0.72), 0 0 0 2px ${T.accent}`,
        pointerEvents: "none",
        transition: "all 0.25s ease",
      }} />

      {/* Callout card */}
      <div style={{
        position: "fixed",
        bottom: cardBottom,
        left: "50%", transform: "translateX(-50%)",
        width: cardMaxW, boxSizing: "border-box",
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: "14px 16px",
        boxShadow: "0 14px 38px rgba(0,0,0,0.6)",
        textAlign: "left",
      }}>
        <div style={{
          fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 800,
          color: T.accent, marginBottom: 6,
        }}>
          {t("app.coachStepOf", { step: i + 1, total: steps.length })}
        </div>
        <div style={{
          fontFamily: T.sans, fontSize: 16, fontWeight: 800, color: T.text,
          lineHeight: 1.2, marginBottom: 5,
        }}>
          {t(step.titleKey)}
        </div>
        <div style={{
          fontFamily: T.sans, fontSize: 13, color: T.muted, lineHeight: 1.5,
          marginBottom: 14,
        }}>
          {t(step.bodyKey)}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <button
            type="button" onClick={finish}
            style={{
              background: "none", border: "none", color: T.muted,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
              padding: "8px 4px",
            }}
          >
            {t("app.coachSkip")}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {i > 0 && (
              <button
                type="button" onClick={() => setI(i - 1)}
                style={{
                  padding: "9px 14px", borderRadius: T.rs,
                  background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {t("common.back")}
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? finish() : setI(i + 1))}
              style={{
                padding: "9px 16px", borderRadius: T.rs,
                background: T.accent, border: "none", color: T.bg,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
              }}
            >
              {isLast ? t("common.done") : t("app.coachNext")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
