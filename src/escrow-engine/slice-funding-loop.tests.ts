// Adversarial tests for the v6.0 ecash mutual-slice funding loop.
// Mirrors the tracked-deps pattern of the runFediFundAndLock recovery tests.
// The loop is a pure DI driver (src/payments/slice-funding-loop.ts): it
// re-derives plan position from a getPlanState() snapshot each iteration and
// funds only the gate-blessed active child through an injected fundChild.

import type { PlanState } from "./tranche-plan.js";
import { EscrowStatus } from "./types.js";
import { runSliceFundingLoop } from "../payments/slice-funding-loop.js";
import type { FundAndLockTerminal } from "../payments/fund-and-lock.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

const MSAT = 1_000; // msats per sat
const SAT = (n: number) => n * MSAT;
const TOTAL = 3;
const AMOUNTS = [SAT(2_000_000), SAT(2_000_000), SAT(1_000_000)]; // 5M sats, 3 slices ≤ 2M cap
const CHILD = (i: number) => `child_${i}`;

type ChildStatus = "CREATED" | "LOCKED" | "COMPLETED";

/** Build a PlanState snapshot from per-child statuses, exactly as
 *  derivePlanState would: activeChild = first non-settled valid child;
 *  nextSafeAction follows the real reducer vocabulary. */
function planState(statuses: ChildStatus[]): PlanState {
  const settledCount = statuses.filter(s => s === "COMPLETED").length;
  const children = statuses.map((s, index) => ({
    id: CHILD(index),
    index,
    amountMsats: AMOUNTS[index],
    status: s === "COMPLETED" ? EscrowStatus.COMPLETED : s === "LOCKED" ? EscrowStatus.LOCKED : EscrowStatus.CREATED,
    valid: true,
  }));
  const active = settledCount < TOTAL ? children[settledCount] : null;
  const nextSafeAction: PlanState["nextSafeAction"] =
    settledCount === TOTAL ? "complete"
    : statuses[settledCount] === "CREATED" ? "fund-active-child"
    : "settle-active-child";
  return {
    plan: { total: TOTAL, totalMsats: AMOUNTS.reduce((a, b) => a + b, 0) } as any,
    children,
    settledCount,
    outstandingMsats: AMOUNTS.slice(settledCount).reduce((a, b) => a + b, 0),
    activeChildId: active?.id ?? null,
    stoppedReason: null,
    nextSafeAction,
  };
}

/** A controllable world: child statuses + a fundChild that applies a scripted
 *  per-call behaviour and (optionally) mutates the world, so the loop's next
 *  getPlanState() re-derivation sees the consequence — mirroring how the real
 *  seam's LOCK/SETTLE advance derivePlanState. */
function makeWorld(opts: {
  // What fundChild returns for each child, by index.
  fundResults?: Partial<Record<number, FundAndLockTerminal>>;
  // If true, a successful lock immediately settles the child (happy path fast-forward).
  autoSettle?: boolean;
  // Crash hook: throw inside fundChild for a child index to simulate a kill.
  crashOnIndex?: number;
  // Racing-tab: a child's lock returns a DIFFERENT notesHash → terminal is
  // lock-failed (the seam re-absorbed), and the child stays CREATED.
  racingOnIndex?: number;
  // Terminal-stuck children by index: fundChild returns `locked` but the status
  // never advances (settlement never lands). The loop must exit, not spin.
  terminalStatuses?: Partial<Record<number, ChildStatus>>;
} = {}) {
  const statuses: ChildStatus[] = ["CREATED", "CREATED", "CREATED"];
  const fundCalls: Array<{ childId: string; index: number; amountMsats: number }> = [];
  const getPlanStateCalls: number[] = [];
  const world = {
    statuses,
    fundCalls,
    getPlanStateCalls,
    async getPlanState(): Promise<PlanState> {
      getPlanStateCalls.push(1);
      return planState(statuses);
    },
    async fundChild(input: { childId: string; index: number; amountMsats: number }): Promise<FundAndLockTerminal> {
      fundCalls.push({ childId: input.childId, index: input.index, amountMsats: input.amountMsats });
      if (opts.crashOnIndex === input.index) throw new Error("simulated crash between spend and lock");
      const scripted = opts.fundResults?.[input.index];
      const terminal: FundAndLockTerminal = scripted ?? { kind: "locked" };
      if (opts.racingOnIndex === input.index) {
        // Seam re-absorbed our notes; child never left CREATED.
        return { kind: "lock-failed", error: "racing tab locked first — sats returned" };
      }
      if (terminal.kind === "locked") {
        const stuck = opts.terminalStatuses?.[input.index];
        statuses[input.index] = stuck ?? (opts.autoSettle ? "COMPLETED" : "LOCKED");
      }
      return terminal;
    },
  };
  return world;
}

console.log("\n── V6 SLICE FUNDING LOOP (adversarial) ──");

// 1. Happy path: three slices fund + settle in strict order, exposure ≤ cap.
{
  const w = makeWorld({ autoSettle: true });
  const progress: string[] = [];
  const r = await runSliceFundingLoop({
    parentId: "parent",
    getPlanState: w.getPlanState,
    fundChild: w.fundChild,
    onProgress: p => progress.push(p.kind),
  });
  assert(r.stop === "complete", "happy path runs to complete");
  assert(r.settledCount === TOTAL, "happy path settles all slices");
  assert(r.fundedThisRun === TOTAL, "happy path funds each slice once");
  assert(w.fundCalls.map(c => c.index).join(",") === "0,1,2", "slices fund in strict 0,1,2 order (sequential gate)");
  assert(w.fundCalls.every(c => c.amountMsats <= SAT(2_000_000)), "every funded slice ≤ 2M-sat cap (one-slice exposure)");
  assert(w.fundCalls.every((c, i) => c.childId === CHILD(i)), "each fund targets the deterministic child escrowId (H3)");
  assert(progress[0] === "slice-funding" && progress.filter(k => k === "slice-funded").length === TOTAL, "progress emits per-slice funding/funded");
}

// 2. Sequential gate: child k+1 is never funded while child k awaits settlement.
{
  const w = makeWorld({ autoSettle: false }); // lock does NOT auto-settle
  const r = await runSliceFundingLoop({
    parentId: "parent",
    getPlanState: w.getPlanState,
    fundChild: w.fundChild,
  });
  assert(r.stop === "awaiting-settlement", "loop stops at awaiting-settlement when the funded child has no payout proof yet");
  assert(w.fundCalls.length === 1 && w.fundCalls[0].index === 0, "only child 0 funded — child 1 locked out until child 0 is PAID-PROVEN");
  assert(r.activeChildId === CHILD(0), "loop reports the funded-but-unsettled active child");
}

// 3. Crash between spend and LOCK: the loop NEVER rejects — it converts the
//    seam's throw into a structured fund-failed, then a re-entry resumes.
{
  // First run crashes on child 1's spend → nothing committed, child 1 stays CREATED.
  const w = makeWorld({ autoSettle: true, crashOnIndex: 1 });
  const crashed = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  assert(crashed.stop === "fund-failed", "a mid-seam crash resolves fund-failed — the loop never rejects");
  assert(typeof crashed.error === "string" && crashed.error.length > 0, "the crash surfaces resumable error copy");
  assert(w.statuses[0] === "COMPLETED" && w.statuses[1] === "CREATED", "crash mid-plan leaves child 1 un-funded (CREATED), child 0 settled");
  // Re-enter with a healthy world over the SAME statuses → resumes at child 1.
  const w2fundCalls: number[] = [];
  const r2 = await runSliceFundingLoop({
    parentId: "parent",
    getPlanState: async () => planState(w.statuses),
    fundChild: async input => {
      w2fundCalls.push(input.index);
      w.statuses[input.index] = "COMPLETED";
      return { kind: "locked" };
    },
  });
  assert(r2.stop === "complete", "resumed run completes the plan");
  assert(w2fundCalls.join(",") === "1,2", "resume re-derives position and funds ONLY the remaining slices (no re-fund of settled child 0)");
}

// 4. Retry / double-fund safety: re-entering an already-funded child does not re-spend.
{
  const w = makeWorld({ autoSettle: false });
  // First entry funds child 0 (now LOCKED, awaiting settlement).
  await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  const afterFirst = w.fundCalls.length;
  // Re-enter with no state change (payout proof not yet landed).
  const r = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  assert(r.stop === "awaiting-settlement", "re-entry on a LOCKED child stops at awaiting-settlement");
  assert(w.fundCalls.length === afterFirst, "re-entry does NOT re-fund a child already LOCKED (no double-spend)");
}

// 5. Racing tab: lock commits DIFFERENT notes → seam re-absorbs, child stays fundable, loop reports fund-failed (not a commit).
{
  const w = makeWorld({ racingOnIndex: 0 });
  const r = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  assert(r.stop === "fund-failed", "racing-tab lock surfaces as fund-failed, not a commit");
  assert(w.statuses[0] === "CREATED", "racing-tab child stays CREATED (fundable again, never stranded)");
  assert(typeof r.error === "string" && r.error.length > 0, "fund-failed carries error copy");
  assert(r.fundedThisRun === 0, "a re-absorbed spend does NOT count as funded");
}

// 6. Fund failure leaves the child fundable (atomic seam re-absorbed).
{
  const w = makeWorld({ fundResults: { 0: { kind: "lock-failed", error: "publish failed — sats returned" } } });
  const r = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  assert(r.stop === "fund-failed", "a lock failure stops the loop as fund-failed");
  assert(w.statuses[0] === "CREATED", "failed child returns to CREATED (no stranding, invariant #6)");
}

// 7. Abort before any fund → clean exit, nothing funded.
{
  const ac = new AbortController();
  ac.abort();
  const w = makeWorld({ autoSettle: true });
  const r = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild, signal: ac.signal });
  assert(r.stop === "aborted" && w.fundCalls.length === 0, "abort before funding funds nothing");
}

// 8. No frozen plan → no-plan (not a sliced trade).
{
  const r = await runSliceFundingLoop({
    parentId: "parent",
    getPlanState: async () => null,
    fundChild: async () => ({ kind: "locked" }),
  });
  assert(r.stop === "no-plan", "a parent with no frozen tranche plan stops as no-plan");
}

// 9. Repair-plan stop is surfaced verbatim (a child failed verification).
{
  const broken = planState(["CREATED", "CREATED", "CREATED"]);
  const r = await runSliceFundingLoop({
    parentId: "parent",
    getPlanState: async () => ({ ...broken, nextSafeAction: "repair-plan", stoppedReason: "Invalid tranche 2" }),
    fundChild: async () => { throw new Error("must never fund during repair-plan"); },
  });
  assert(r.stop === "repair-plan", "a plan-level repair stop is surfaced, never funded through");
}

// 10. Exposure invariant across the whole run: cumulative unsecured ≤ one slice at every step.
{
  const w = makeWorld({ autoSettle: true });
  // At any instant, at most one child is in LOCKED-but-not-COMPLETED (in-flight)
  // because autoSettle moves LOCKED→COMPLETED within a single fundChild call.
  // Track the max number of simultaneously in-flight children via fund calls.
  let inflight = 0;
  let maxInflight = 0;
  const r = await runSliceFundingLoop({
    parentId: "parent",
    getPlanState: w.getPlanState,
    fundChild: async input => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await w.fundChild(input);
      inflight--;
      return { kind: "locked" };
    },
  });
  assert(r.stop === "complete", "exposure-fuzz run completes");
  assert(maxInflight === 1, "never more than one slice in flight at once (one-slice live exposure)");
}

// 11. Liveness guard: a child whose settlement never lands (terminal-stuck) must
//     make the loop EXIT, never spin. The loop funds it once, re-derives the
//     unchanged LOCKED state, and stops at awaiting-settlement.
{
  const w = makeWorld({ terminalStatuses: { 0: "LOCKED" } }); // locked but never settles
  const r = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  assert(r.stop === "awaiting-settlement", "a terminal-stuck (never-settling) child stops the loop at awaiting-settlement — no infinite spin");
  assert(w.fundCalls.filter(c => c.index === 0).length === 1, "the stuck child is funded exactly once, not re-funded in a loop");
}

// 12. LOCK-propagation lag (Claude cold-review finding, Codex acceptance):
//     fundChild returns `locked` but the NEXT getPlanState() still shows the
//     child CREATED (the LOCK hasn't propagated). The loop must NOT re-fund —
//     exactly one fundChild call, no tight loop, non-failure awaiting-settlement.
{
  const w = makeWorld({ terminalStatuses: { 0: "CREATED" } }); // lock "succeeds" but status lags at CREATED
  const r = await runSliceFundingLoop({ parentId: "parent", getPlanState: w.getPlanState, fundChild: w.fundChild });
  assert(w.fundCalls.filter(c => c.index === 0).length === 1, "lag: child funded EXACTLY ONCE — no re-fund despite the snapshot still reading CREATED");
  assert(r.stop === "awaiting-settlement", "lag: loop exits awaiting-settlement (non-failure), not fund-failed and not a spin");
  assert(r.fundedThisRun === 1, "lag: the one confirmed lock counts as funded");
}

console.log("\n  ✓ all slice-funding-loop adversarial assertions passed\n");
