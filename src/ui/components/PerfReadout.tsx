import { useEffect, useState } from "react";
import { T } from "../theme.js";
import { PROFILER_BUILD, perfEnabled, perfHistory, perfReport, setPerfEnabled, subscribePerf } from "../perf-probe.js";

/** Hidden timing readout for Me tab taps and the Lock invoice (?perf=1 or
 *  seven taps on the version label). A developer diagnostic: English only,
 *  off by default. */
export function PerfReadout() {
  const [, setTick] = useState(0);
  useEffect(() => subscribePerf(() => setTick(n => n + 1)), []);
  const [copied, setCopied] = useState(false);
  if (!perfEnabled()) return null;
  const taps = perfHistory();
  const ms = (n: number) => `${Math.round(n)} ms`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(perfReport()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  };
  const button = { background: "transparent", border: `1px solid ${T.line}`, color: T.ink, borderRadius: 8, padding: "4px 10px", font: `600 12px ${T.sans}`, cursor: "pointer" } as const;
  return (
    <div data-perf-readout role="status" style={{
      position: "fixed", zIndex: 9998, left: 8, right: 8, top: "calc(env(safe-area-inset-top, 0px) + 64px)",
      maxHeight: "38vh", overflowY: "auto", padding: "10px 12px", borderRadius: 12,
      background: `${T.surface}f2`, border: `1px solid ${T.line}`, color: T.ink,
      font: `12px/1.45 ${T.mono}`, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <strong style={{ font: `700 12px ${T.sans}`, flex: 1 }}>Timing · {PROFILER_BUILD ? "React profiler on" : "React profiler off (release build)"}</strong>
        <button type="button" style={button} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" style={button} onClick={() => setPerfEnabled(false)}>Off</button>
      </div>
      {taps.length === 0 ? (
        <div style={{ color: T.ink2 }}>Tap a Me tab, or hold Lock, to time it.</div>
      ) : taps.slice(0, 4).map((tap, i) => (
        <div key={i} style={{ marginTop: i ? 8 : 0, opacity: i ? 0.7 : 1 }}>
          <div><b>{tap.label}</b>: {ms(tap.totalMs)}{tap.flow ? "" : ` · React ${ms(tap.renderMs)} · draw ${ms(tap.drawMs)}`}</div>
          {(tap.flow ? tap.steps : tap.steps.slice(0, 6)).map((step, j) => (
            <div key={`${step.name}:${j}`} style={{ paddingLeft: 10, color: T.ink2 }}>
              {step.name}: {ms(step.ms)}{tap.flow ? "" : ` · ${step.count}×`}{step.extra ? ` · ${step.extra} uncached` : ""}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
