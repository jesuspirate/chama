// ══════════════════════════════════════════════════════════════════════════
// Chama — Ecash mutual-slice funding loop (v6.0 sequential driver)
// ══════════════════════════════════════════════════════════════════════════
//
// The rail-slicing contract (PLANS/CHAMA_ECASH_MUTUAL_SLICING_CONTRACT.md)
// leaves exactly one net-new runtime piece: the driver that walks a frozen
// parent/child plan and funds each ecash child IN ORDER — child k+1 only
// after child k's payout proof lands. Everything else is reused:
//
//   - The sequential gate itself is NOT here. It is enforced at the reducer/
//     bridge layer (`canFundTranche` inside `prepareLockContext` →
//     `assertTrancheFundingAllowed`), so no driver — this one included — can
//     fund a non-active child. This loop only ever funds the child the gate
//     has already blessed as `activeChildId`.
//   - The per-child spend+lock is NOT reimplemented here. Each child funds
//     through the existing atomic `runFediFundAndLock` seam (the contract's
//     invariant-#4 anchor: commit only on LOCK-with-our-notesHash, re-absorb
//     otherwise). The hook injects that as `fundChild`.
//
// What this module adds is the one thing that did not exist: RESUMABLE
// ADVANCEMENT. It is stateless — every iteration re-derives the plan position
// from signed relay state via `getPlanState()` (a `derivePlanState` snapshot),
// so a crash, reload, or racing tab simply re-derives the same `activeChildId`
// and continues. There is no in-memory cursor to go stale and no double-fund:
// the deterministic `trancheChildId === escrowId` (H3) plus the reducer's
// single-LOCK-per-escrow backstop make a retried fund idempotent.
//
// Pure and dependency-injected (no React, no Fedimint imports) so the whole
// loop is testable in isolation — mirrors runFediFundAndLock. The hook binds
// the dependencies to the live wallet; the UI renders the per-slice phases.

import type { PlanState } from "../escrow-engine/tranche-plan.js";
import type { FundAndLockTerminal } from "./fund-and-lock.js";

// ── Dependencies (bound to the live wallet in useEscrow) ───────────────────

export interface RunSliceFundingLoopDeps {
  /** Re-derive the CURRENT plan position from signed relay state. Must be a
   *  fresh `derivePlanState(parent, children)` snapshot on every call — never
   *  a cached copy — so the loop resumes correctly after each child settles
   *  and after any crash/restart. Returns null if the parent has no frozen
   *  tranche plan (not a sliced trade). */
  getPlanState: () => Promise<PlanState | null>;
  /** Fund exactly one child through the atomic ecash seam. The hook binds this
   *  to the per-child fund path (`runFediFundAndLock` for the child's own
   *  escrowId). The loop passes ONLY the child the gate blessed; the bridge
   *  re-checks `canFundTranche` before any spend, so a stale read fails shut
   *  (re-absorbed), never double-committed. Resolves with the per-child
   *  terminal; never rejects (mirrors runFediFundAndLock). */
  fundChild: (input: {
    childId: string;
    index: number;
    amountMsats: number;
    signal?: AbortSignal;
  }) => Promise<FundAndLockTerminal>;
}

export interface RunSliceFundingLoopOpts extends RunSliceFundingLoopDeps {
  /** Parent escrow id (the public manifest; never itself locked). */
  parentId: string;
  /** Caller-controlled abort (modal Cancel, unmount). */
  signal?: AbortSignal;
  /** Per-slice progress callback — granular UI updates. */
  onProgress?: (p: SliceFundingProgress) => void;
}

// ── Progress + result ──────────────────────────────────────────────────────

export type SliceFundingProgress =
  | { kind: "slice-funding"; index: number; total: number; childId: string; amountMsats: number }
  | { kind: "slice-funded"; index: number; total: number; childId: string }
  | { kind: "slice-advance"; settledCount: number; total: number };

/** Why the loop stopped. `complete` = every slice funded+settled.
 *  `awaiting-settlement` = the active child is funded but its payout proof has
 *  not landed yet — settlement is a separate actor step, so the loop exits and
 *  is re-entered (re-derived) once it lands. `repair-plan` / `missing-children`
 *  surface the frozen plan's own stop reasons verbatim. */
export type SliceFundingStop =
  | "complete"
  | "awaiting-settlement"
  | "publish-missing-children"
  | "repair-plan"
  | "no-plan"
  | "fund-failed"
  | "aborted";

export interface SliceFundingResult {
  stop: SliceFundingStop;
  /** Slices confirmed LOCKED-with-our-notes this run. */
  fundedThisRun: number;
  /** `derivePlanState.settledCount` at exit (payout-proven slices). */
  settledCount: number;
  total: number;
  /** The child the loop stopped on, if any (active child at exit). */
  activeChildId: string | null;
  /** Fund-failure error text when stop === "fund-failed". */
  error?: string;
}

// ── runSliceFundingLoop ────────────────────────────────────────────────────

/** Walk the frozen plan funding each active child in order. Stateless and
 *  resumable: re-derives position every iteration, so it is safe to re-enter
 *  after a crash, a settle, or a prior partial run. Never rejects. */
export async function runSliceFundingLoop(
  opts: RunSliceFundingLoopOpts,
): Promise<SliceFundingResult> {
  const emit = (p: SliceFundingProgress) => opts.onProgress?.(p);
  let fundedThisRun = 0;
  /** The child we just funded to a confirmed `locked` this run, if any. Used to
   *  survive a getPlanState() that LAGS the LOCK: if re-derivation still reads
   *  the same child as fund-active (its LOCK hasn't propagated to the snapshot
   *  yet), we must NOT re-fund it — we exit awaiting-settlement instead. This
   *  makes re-fund safety a property of the loop, not of hook write-ordering. */
  let lastFundedChildId: string | null = null;

  for (;;) {
    if (opts.signal?.aborted) {
      return { stop: "aborted", fundedThisRun, settledCount: 0, total: 0, activeChildId: null };
    }

    const plan = await opts.getPlanState();
    if (!plan) {
      return { stop: "no-plan", fundedThisRun, settledCount: 0, total: 0, activeChildId: null };
    }
    const total = plan.plan.total;

    // Terminal: every slice settled (payout-proven). Done.
    if (plan.nextSafeAction === "complete") {
      return { stop: "complete", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: null };
    }

    // Plan-level stops the loop must not paper over.
    if (plan.nextSafeAction === "repair-plan") {
      return { stop: "repair-plan", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: null };
    }
    if (plan.nextSafeAction === "publish-missing-children") {
      return { stop: "publish-missing-children", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId };
    }

    // The active child is funded but not yet payout-proven: settlement is a
    // separate actor step (claim → payout proof). The loop cannot advance
    // until it lands, so exit and let the caller re-enter on the next event.
    if (plan.nextSafeAction === "settle-active-child") {
      return { stop: "awaiting-settlement", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId };
    }

    // nextSafeAction === "fund-active-child": the gate has blessed exactly one
    // child. Fund it through the atomic seam. `derivePlanState` guarantees the
    // active row is valid and is row index === settledCount.
    const active = plan.children.find(c => c.id === plan.activeChildId && c.valid);
    if (!active || plan.activeChildId === null) {
      // Defensive: gate said fund but no valid active row — treat as repair.
      return { stop: "repair-plan", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId };
    }

    // Re-fund guard (LOCK-propagation lag). We just funded this exact child to
    // a confirmed `locked`, but the re-derived snapshot still shows it CREATED
    // — its LOCK has not propagated to getPlanState() yet. Re-funding now would
    // re-spend: the deterministic escrowId (H3) + reducer single-LOCK backstop
    // re-absorb it into a spurious fund-failed (not a double-spend, but a
    // wasted spend→reabsorb and, under persistent lag, a busy-loop). Instead
    // exit awaiting-settlement: the child IS locked; the caller re-enters once
    // the snapshot catches up. Fund-safety must not depend on hook ordering.
    if (active.id === lastFundedChildId) {
      return { stop: "awaiting-settlement", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId };
    }

    emit({ kind: "slice-funding", index: active.index, total, childId: active.id, amountMsats: active.amountMsats });
    // `fundChild` is contracted to never reject (mirrors runFediFundAndLock),
    // but a crash between spend and lock — or a wallet/relay fault inside the
    // seam — surfaces as a throw. The atomic seam's crash guard has already
    // stashed/re-absorbed any spend before it can drop sats, so a throw here
    // means "not committed, child still fundable", never a silent loss. Catch
    // it and report fund-failed so the loop NEVER rejects and the caller can
    // resume by re-entering (re-derivation picks the same child back up).
    let terminal: FundAndLockTerminal;
    try {
      terminal = await opts.fundChild({
        childId: active.id,
        index: active.index,
        amountMsats: active.amountMsats,
        signal: opts.signal,
      });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e ?? "")).trim();
      const error = `Slice ${active.index + 1} funding was interrupted${msg ? `: ${msg}` : ""} Any spent sats are stashed for return; re-enter to resume.`;
      return { stop: "fund-failed", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId, error };
    }

    if (terminal.kind === "locked") {
      fundedThisRun++;
      lastFundedChildId = active.id;
      emit({ kind: "slice-funded", index: active.index, total, childId: active.id });
      // Loop: re-derive. The freshly-locked child now reads settle-active-child
      // until its payout proof lands, at which point settledCount advances and
      // the NEXT child becomes active. No in-memory cursor — the signed relay
      // state is the cursor.
      continue;
    }

    if (terminal.kind === "aborted") {
      return { stop: "aborted", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId };
    }

    // lock-failed / expired / mint-timeout: the atomic seam already re-absorbed
    // any spend (commit-or-reabsorb), so the child is back to fundable CREATED,
    // never stranded. Surface the failure; the caller may retry by re-entering.
    const error = terminal.kind === "lock-failed" ? terminal.error : `Slice funding ended: ${terminal.kind}`;
    return { stop: "fund-failed", fundedThisRun, settledCount: plan.settledCount, total, activeChildId: plan.activeChildId, error };
  }
}
