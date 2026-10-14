// Hidden timing readout for Me tab taps (Jet, 6.4.24 rc: "a sec or two after
// each tap"). Off unless turned on with ?perf=1 or seven taps on the version
// label. When off, every helper is a cheap no-op apart from one flag read.
//
// A tap is timed from the click to the first painted frame after the tapped
// tab's content has committed. Named steps (signature checks, needs-you and
// dashboard builds, card drawing) are timed inside the same window; whatever
// is left is React's other work plus the browser's style, layout and paint.

const STORAGE_KEY = "chama_perf_readout_v1";

type Step = { ms: number; count: number; extra: number };
export type PerfTap = {
  label: string;
  totalMs: number;
  /** Tap → commit of the new tab (JavaScript: React and the steps below). */
  renderMs: number;
  /** Commit → painted frame (browser style, layout and paint). */
  drawMs: number;
  steps: Array<{ name: string; ms: number; count: number; extra: number }>;
  /** A timed flow (Lock invoice) rather than a Me tab tap: only the total
   *  and its steps mean anything. */
  flow?: boolean;
};

let enabled: boolean | null = null;
let current: { label: string; t0: number; committedAt: number | null; steps: Map<string, Step> } | null = null;
const history: PerfTap[] = [];
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perf") === "1") {
      localStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function perfEnabled(): boolean {
  if (enabled === null) enabled = readEnabled();
  return enabled;
}

export function setPerfEnabled(on: boolean): void {
  enabled = on;
  try { if (on) localStorage.setItem(STORAGE_KEY, "1"); else localStorage.removeItem(STORAGE_KEY); } catch { /* best effort */ }
  if (!on) { current = null; history.length = 0; }
  listeners.forEach(fn => fn());
}

export function subscribePerf(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function perfHistory(): readonly PerfTap[] {
  return history;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Adds time (and one occurrence) to a named step of the tap being timed. */
export function perfAdd(name: string, ms: number, extra = 0): void {
  if (!current) return;
  const step = current.steps.get(name) ?? { ms: 0, count: 0, extra: 0 };
  step.ms += ms; step.count += 1; step.extra += extra;
  current.steps.set(name, step);
}

/** Runs `fn`, adding its time to `name` while a tap is being timed. */
export function perfMeasure<T>(name: string, fn: () => T): T {
  if (!current) return fn();
  const t0 = now();
  try { return fn(); } finally { perfAdd(name, now() - t0); }
}

/** A Me tab was tapped. */
export function perfTapStart(label: string): void {
  if (!perfEnabled()) return;
  current = { label, t0: now(), committedAt: null, steps: new Map() };
}

/** The tapped tab's content committed; finish at the next painted frame. */
export function perfTapCommitted(label: string): void {
  const tap = current;
  if (!tap || tap.label !== label || tap.committedAt !== null) return;
  tap.committedAt = now();
  const finish = () => {
    if (current !== tap) return;
    const end = now();
    history.unshift({
      label: tap.label,
      totalMs: end - tap.t0,
      renderMs: (tap.committedAt ?? end) - tap.t0,
      drawMs: end - (tap.committedAt ?? end),
      steps: [...tap.steps.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.ms - a.ms),
    });
    history.length = Math.min(history.length, 12);
    current = null;
    listeners.forEach(fn => fn());
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(finish, 0));
  else setTimeout(finish, 0);
}

// ── Lock invoice timing (Step 0) ─────────────────────────────────────────
// From the completed Lock hold to the invoice on screen, in steps, so a
// device readout shows which part of the wait dominates. Each step is the
// time since the previous one.

let lockFlow: { t0: number; last: number; steps: Array<{ name: string; ms: number; count: number; extra: number }> } | null = null;

/** The Lock hold completed. */
export function perfLockStart(): void {
  if (!perfEnabled()) return;
  const t = now();
  lockFlow = { t0: t, last: t, steps: [] };
}

/** The funding sheet opened. If nothing started the timing (another entry
 *  point, or the readout switched on mid-flow), time from here. */
export function perfLockSheetOpened(): void {
  if (!lockFlow) perfLockStart();
  perfLockStep("sheet opens");
}

/** A step of the Lock flow finished. */
export function perfLockStep(name: string): void {
  if (!lockFlow) return;
  const t = now();
  lockFlow.steps.push({ name, ms: t - lockFlow.last, count: 1, extra: 0 });
  lockFlow.last = t;
}

/** The invoice is on screen (or the flow ended without one). */
export function perfLockEnd(outcome: "invoice shown" | "no invoice"): void {
  const flow = lockFlow;
  if (!flow) return;
  lockFlow = null;
  const finish = () => {
    const end = now();
    if (end - flow.last > 1) flow.steps.push({ name: outcome === "invoice shown" ? "draw" : "end", ms: end - flow.last, count: 1, extra: 0 });
    history.unshift({ label: `Lock invoice · ${outcome}`, totalMs: end - flow.t0, renderMs: end - flow.t0, drawMs: 0, steps: flow.steps, flow: true });
    history.length = Math.min(history.length, 12);
    listeners.forEach(fn => fn());
  };
  if (outcome === "invoice shown" && typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(finish, 0));
  else finish();
}

/** Plain text of the recorded taps, for pasting into a chat. */
export function perfReport(taps: readonly PerfTap[] = history): string {
  const ms = (n: number) => `${Math.round(n)} ms`;
  // The first line names the build and says this build times Lock, so a
  // pasted report shows which app produced it.
  const head = `Chama ${typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"} · Lock timing on · ${PROFILER_BUILD ? "React profiler on" : "React profiler off (release build)"}`;
  if (taps.length === 0) return `${head}\nNo timings yet: hold Lock on a trade (or tap a Me tab), then Copy.`;
  return `${head}\n` + taps.map(tap => [
    tap.flow ? `${tap.label}: ${ms(tap.totalMs)} total` : `${tap.label}: ${ms(tap.totalMs)} total (React ${ms(tap.renderMs)}, browser draw ${ms(tap.drawMs)})`,
    ...tap.steps.map(s => tap.flow ? `  ${s.name}: ${ms(s.ms)}` : `  ${s.name}: ${ms(s.ms)} · ${s.count}×${s.extra ? ` · ${s.extra} uncached` : ""}`),
  ].join("\n")).join("\n");
}

/** Seven taps within 4 seconds on the version label toggle the readout. */
export function versionTapToggle(): () => void {
  let taps: number[] = [];
  return () => {
    const t = now();
    taps = [...taps.filter(x => t - x < 4000), t];
    if (taps.length >= 7) { taps = []; setPerfEnabled(!perfEnabled()); }
  };
}

import { verifiedSymbol } from "nostr-tools/pure";
import { EscrowEventKind, type EscrowState } from "../escrow-engine/types.js";
import { hasVerifiedTradeCreate } from "../escrow-engine/trade-index.js";

/** hasVerifiedTradeCreate, counted for the readout. "Uncached" checks ran a
 *  full signature verification; cached ones reused nostr-tools' verdict. */
export function checkedTradeCreate(state: EscrowState): boolean {
  if (!current) return hasVerifiedTradeCreate(state);
  const raw = state.eventChain.find(event => event.kind === EscrowEventKind.CREATE)?.raw as Record<symbol, unknown> | undefined;
  const cached = raw?.[verifiedSymbol] === true;
  const t0 = now();
  const ok = hasVerifiedTradeCreate(state);
  perfAdd("signature checks", now() - t0, cached ? 0 : 1);
  return ok;
}

/** True while a Me tab tap is being timed. */
export function perfTiming(): boolean {
  return current !== null;
}

import { Profiler, createElement, type ProfilerOnRenderCallback, type ReactNode } from "react";

const onZoneRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  if (current) perfAdd(`render · ${id}`, actualDuration);
};

/** True when this build reports React render times (CHAMA_PROFILING=1). */
export const PROFILER_BUILD = typeof __CHAMA_PROFILING__ !== "undefined" && __CHAMA_PROFILING__ === true;

/** Names a part of the app in the timing readout: during a timed tap, its
 *  render time (including everything inside it) is reported as
 *  "render · <id>". Costs nothing measurable when the readout is off; React
 *  reports times only in the profiling build. */
export function PerfZone({ id, children }: { id: string; children: ReactNode }) {
  return createElement(Profiler, { id, onRender: onZoneRender }, children);
}
