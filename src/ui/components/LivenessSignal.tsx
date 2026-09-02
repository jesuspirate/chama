// The live-chama liveness signal — a graduated strength readout, NOT a binary
// orange/green badge (chama-live-chama-signal-brief.md). Renders the computed
// score from arbiters/live-chama.ts: a segmented meter ("battery"), the honest
// "N arbiters · X% · ~D-day bonds" line, a "?" explainer, and — where coverage
// is thin — a soft "become an arbiter" nudge that reads as OPPORTUNITY, never a
// dead end. Magnitude, not a badge; a bare count, never a single OG name.
//
// Pure + prop-driven: it renders whatever ChamaLiveness it's handed (or a calm
// loading / unknown state). The DATA (an async Nostr + chain fetch) is the
// caller's job — this only draws.

import { useEffect, useRef, useState } from "react";
import { T } from "../theme.js";
import { useT, type TFunc } from "../../i18n/index.js";
import { HelpTip } from "./HelpTip.js";
import { type ChamaLiveness } from "../../arbiters/live-chama.js";
import {
  loadCoordinatedLiveness,
  readCachedLiveness,
  type LivenessGenerationDiagnostic,
} from "../../arbiters/liveness-coordinator.js";

/** Fetch + auto-keep-fresh a community's liveness. Refetches on mount, on window
 *  focus (returning to the app), and — if `intervalMs` > 0 — on a gentle poll.
 *  The loader (actions.getChamaLiveness) is a fresh identity each render but reads
 *  the live client internally, so we hold it in a ref and key only on the slug.
 *  Fails soft: any error just yields null (the caller omits the signal). */
export function useLiveness(
  slug: string | null | undefined,
  loadLiveness: ((slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>) | undefined,
  opts: { intervalMs?: number } = {},
): {
  liveness: ChamaLiveness | null;
  loading: boolean;
  outcome: LivenessGenerationDiagnostic["outcome"] | null;
} {
  const [liveness, setLiveness] = useState<ChamaLiveness | null>(null);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<LivenessGenerationDiagnostic["outcome"] | null>(null);
  const loadRef = useRef(loadLiveness);
  loadRef.current = loadLiveness;
  const intervalMs = opts.intervalMs ?? 0;
  useEffect(() => {
    const load = loadRef.current;
    if (!load || !slug) { setLiveness(null); return; }
    // Public chain truth is safe to reuse across identities. Paint the most
    // recent verified result synchronously, then refresh behind it; a returning
    // user should never stare at "checking" merely because Me and Dashboard
    // mounted a fresh copy of the same signal.
    const warm = readCachedLiveness(slug);
    setLiveness(warm);
    let cancelled = false;
    const run = (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      loadCoordinatedLiveness(slug, (community, signal) => load(community, signal))
        .then((result) => {
          if (cancelled) return;
          setLiveness(result.liveness);
          setOutcome(result.outcome);
        })
        .catch(() => {
          if (!cancelled) {
            setLiveness(null);
            setOutcome("error");
          }
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    run(!warm);
    const id = intervalMs > 0 ? setInterval(() => run(false), intervalMs) : null;
    const onFocus = () => run(false);
    if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
    };
  }, [slug, intervalMs]);
  return { liveness, loading, outcome };
}

const SEGMENTS = 5;
/** Below this composite score (or ≤1 arbiter) coverage reads as thin — we show
 *  the "become an arbiter" invitation instead of implying the job's taken. */
const THIN_SCORE = 45;

/** Localized counterpart of the engine's diagnostic formatter. The UI must
 * never render its intentionally-English test/debug readout directly. */
export function localizedLivenessReadout(
  liveness: ChamaLiveness,
  blocksPerDay: number,
  t: TFunc,
): string {
  if (liveness.arbiterCount === 0) return t("bond.noBondedArbiters");
  const parts = [t(
    liveness.arbiterCount === 1 ? "bond.arbiterCountOne" : "bond.arbiterCountMany",
    { count: liveness.arbiterCount },
  )];
  if (liveness.ratings.count > 0) {
    parts.push(`${Math.round(liveness.ratings.positiveRate * 100)}%`);
  }
  if (liveness.avgRemainingBlocks > 0) {
    const days = Math.max(1, Math.round(liveness.avgRemainingBlocks / blocksPerDay));
    parts.push(t(days === 1 ? "bond.dayBondOne" : "bond.dayBondMany", { days }));
  }
  return parts.join(" · ");
}

/** The segmented "battery" — fill ∝ score. Thin fills amber (opportunity), a
 *  healthy score fills green; empty is neutral grey. Never red — thin coverage
 *  is an opening, not a failure. */
export function LivenessMeter({ score }: { score: number }) {
  const { t } = useT();
  const filled = Math.max(0, Math.min(SEGMENTS, Math.round((score / 100) * SEGMENTS)));
  const color = filled >= 3 ? T.green : filled >= 1 ? T.amber : T.muted;
  return (
    <div role="img" aria-label={t("bond.livenessAria", { score: Math.round(score) })} style={{ display: "flex", gap: 3 }}>
      {Array.from({ length: SEGMENTS }).map((_, i) => (
        <span key={i} style={{
          flex: 1, height: 8, borderRadius: 2,
          background: i < filled ? color : T.surface,
          border: `1px solid ${i < filled ? color : T.border}`,
        }} />
      ))}
    </div>
  );
}

export interface LivenessSignalProps {
  /** The computed score, or null when it isn't known (pre-connect / no fetch). */
  liveness: ChamaLiveness | null;
  loading?: boolean;
  outcome?: LivenessGenerationDiagnostic["outcome"] | null;
  /** Blocks per day for the "~D-day" term (signet ~2880, mainnet ~144). */
  blocksPerDay?: number;
  /** Optional — turns the thin-coverage nudge into a real CTA. Absent ⇒ the nudge
   *  is an informational line (the arbiter on-ramp lives elsewhere by default). */
  onBecomeArbiter?: () => void;
}

/** The full signal block: label + "?" + meter + honest readout + thin nudge. */
export function LivenessSignal({ liveness, loading, outcome, blocksPerDay = 144, onBecomeArbiter }: LivenessSignalProps) {
  const { t } = useT();
  const thin = !liveness || liveness.arbiterCount <= 1 || liveness.score < THIN_SCORE;
  const readout = loading
    ? t("bond.livenessChecking")
    : liveness
      ? localizedLivenessReadout(liveness, blocksPerDay, t)
      : outcome === "timeout"
        ? t("bond.livenessTimeout")
        : t("bond.livenessUnknown");

  return (
    <div style={{
      width: "100%", boxSizing: "border-box", textAlign: "left",
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r, padding: "12px 14px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, letterSpacing: 1, color: T.muted, textTransform: "uppercase" }}>
          {t("bond.livenessHeading")}
        </span>
        <HelpTip title={t("bond.livenessTipTitle")} label={t("bond.livenessTipLabel")}>
          {t("bond.livenessTipBody")}
        </HelpTip>
      </div>

      <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}>
        <LivenessMeter score={liveness?.score ?? 0} />
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 11, color: liveness && !thin ? T.text : T.muted, marginTop: 7, lineHeight: 1.5 }}>
        {readout}
      </div>

      {!loading && thin && (
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${T.border}` }}>
          {onBecomeArbiter ? (
            <button
              onClick={onBecomeArbiter}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 11px", borderRadius: T.rs,
                background: "none", border: `1px solid ${T.accent}`, color: T.accent,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              {t("bond.needsArbitersCta")} <span style={{ fontSize: 13, lineHeight: 1 }}>→</span>
            </button>
          ) : (
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.accent, lineHeight: 1.5 }}>
              {t("bond.needsArbitersInfo")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
