// ══════════════════════════════════════════════════════════════════════════
// Chama — Atomic claim-and-payout orchestrator (v0.3.0 Phase 3)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.7: claim time is when the user provides a destination
// to receive sats. v0.3.0 collapses the prior two-step "claim then withdraw"
// into a single atomic flow: tap Claim → DestinationPicker presents saved
// LN handles + new-address input + BOLT11 paste → user picks destination
// → claimAndPayout dispatches decrypt-shares → SSS-combine → redeemEcash
// → outbound LN payment → modal closes. The user never holds an
// intermediate balance (Pillar 2.1 Option B, send side).
//
// This module is the pure orchestrator (testable without React or a
// running Fedimint). The hook (useEscrow.ts) binds the dependencies
// to the live wallet; the ClaimPayoutModal renders phase transitions
// to the user.
//
// ── Phase model ────────────────────────────────────────────────────────
//
// `claiming`         transient — bridge.claimAndRedeem call (decrypt
//                    shares, SSS-combine, redeem ecash, publish CLAIM)
// `confirming`       polling — waiting for balance to land. Same
//                    v0.1.62 watchdog principle as Phase 2's mint-
//                    confirming: claimAndRedeem may return before the
//                    balance fully settles (partial-success / transient
//                    error paths). We poll up to a 90s grace (extended
//                    while the federation can't even be READ — a failed
//                    balance read proves nothing about non-arrival on a
//                    slow link) before falling back to the absolute-
//                    balance cover check below.
//
//                    v2.1.1 (the sm_mq1cmq6p_a2arwi0x incident): growth-
//                    from-baseline is structurally blind to settlement
//                    that happened on a PREVIOUS attempt. On a slow link
//                    the first attempt's redeem can land *after* its 60s
//                    window expired; every retry then re-baselines WITH
//                    the landed sats included, the re-redeem reports
//                    already-spent (treated as success), and growth can
//                    never be observed again → infinite claim-pending
//                    loop, while the sats sit invisibly in the wallet
//                    (sub-material amounts surface nowhere else). The
//                    fix: when growth times out, judge settlement by the
//                    ABSOLUTE balance — if the wallet can cover the
//                    payout right now, pay it out. Sats are fungible,
//                    the destination is the winner's own wallet, and the
//                    pending-redemption stash stays intact for the boot
//                    drain to reconcile the genuinely-pending case.
// `paying-invoice`   transient — outbound LN to the user's destination
// `payout-confirming` TERMINAL (3.5.1) — the outbound payout was SUBMITTED
//                    (the gateway accepted it; an operationId exists) but
//                    its settlement is not yet CONFIRMED — the watch window
//                    closed with the HTLC still in flight, the status stream
//                    broke, or a prior attempt left it submitted. The payout
//                    journal holds a `submitted` record; the orchestrator
//                    re-attaches to the operationId to learn the truth and
//                    NEVER pays again. The modal must NOT offer a re-pay
//                    retry here — that is exactly the double-send this guards
//                    against. Distinct from `payout-failed`, where no payment
//                    is in flight and re-paying is correct.
// `done`             TERMINAL — payout sent, optional handle saved
// `claim-failed`     TERMINAL — claim threw a HARD failure (bad shares,
//                    not the winner, hash mismatch). No orphan, no
//                    retry semantic. User cannot recover from this
//                    without protocol-level repair.
// `claim-bridge-threw` TERMINAL — claim threw a typed bridge error
//                    (FED_PROBE_FAILED, FED_MISMATCH). Structural,
//                    retry-able once the federation becomes reachable
//                    or the user switches feds. No orphan (the bridge
//                    bails before any redeem or CLAIM publish). User
//                    sees the underlying error + a Try-again button
//                    in the modal that re-probes before re-dispatch.
//                    v0.3.1 fix: previously this case silently fell
//                    through to claim-pending, hanging the user with
//                    "your sats are still arriving" while nothing was
//                    actually arriving.
// `claim-pending`    TERMINAL — claim returned (no throw) but balance
//                    hasn't landed within the confirm window AND the
//                    absolute balance can't cover the payout. Genuinely
//                    in-flight — sats may still arrive from the
//                    federation. The pending-redemption stash stays
//                    intact so boot can retry redeeming the notes; if
//                    balance later lands, the next claim retry's cover
//                    check pays it out (this is what makes "try the
//                    claim again" honest copy). RESERVED for the
//                    no-throw / balance-stalled case ONLY. A post-CLAIM
//                    terminal mint reissue failure routes to
//                    claim-failed — but only after the cover check has
//                    had a chance to rescue it: consumed notes + a
//                    covering balance means a previous attempt already
//                    credited this wallet.
// `payout-failed`    TERMINAL — claim succeeded, balance landed, but
//                    payInvoice threw. The trade is deliberately left
//                    un-COMPLETEd so the Claim button stays the retry
//                    path, including for sub-material payouts that the
//                    main recovery banner keeps quiet.
//
// The four-way split lets the modal surface UX that matches reality:
// `claim-bridge-threw` shows the actual error + retry; `claim-pending`
// shows "still arriving" reassurance; `claim-failed` shows terminal
// no-recovery framing; `payout-failed` points at retrying Claim while
// the recovered balance remains safely local.

import { markSatsTracesDrained, recordSatsTrace } from "./sats-trace.js";
import { maxLightningPayoutSats } from "./lightning-fees.js";
import { PAY_RECONCILE_SINCE_MARGIN_MS } from "./payout-journal.js";
import { recordClaimCredit } from "./claim-credit-ledger.js";

// ── Phase types ──────────────────────────────────────────────────────────

export type ClaimAndPayoutPhase =
  | { kind: "claiming" }
  | { kind: "confirming" }
  | { kind: "paying-invoice" }
  | { kind: "paying-onchain" }
  | { kind: "exporting-ecash" }
  | { kind: "ecash-ready"; notes: string; amountMsats: number }
  | { kind: "payout-confirming"; error?: string }
  | { kind: "done" }
  | { kind: "claim-failed"; error: string }
  | { kind: "claim-bridge-threw"; error: string }
  | { kind: "claim-pending"; error: string }
  | { kind: "payout-failed"; error: string; claimCompleted?: boolean };

export type ClaimAndPayoutTerminal =
  | { kind: "done" }
  | { kind: "ecash-ready"; notes: string; amountMsats: number }
  | { kind: "claim-failed"; error: string }
  | { kind: "claim-bridge-threw"; error: string }
  | { kind: "claim-pending"; error: string }
  /** 3.5.1 — the payout is in flight (submitted, unconfirmed). RETRY must
   *  NOT re-pay; the orchestrator re-attaches to the operationId. Carries
   *  reassurance copy, never a re-pay affordance. */
  | { kind: "payout-confirming"; error?: string }
  /** `claimCompleted`: false when COMPLETE was deliberately not yet
   *  published because the outbound payout failed. The trade's Claim
   *  button is still alive, so "tap Claim again" is the honest retry
   *  path. Kept optional for older callers/terminals. */
  | { kind: "payout-failed"; error: string; claimCompleted?: boolean };

/** Error codes the bridge tags on typed retry-able failures. Defined
 *  alongside the orchestrator so test mocks + downstream consumers
 *  reference the same string source-of-truth. */
export const BRIDGE_THREW_ERROR_CODES = ["FED_PROBE_FAILED", "FED_MISMATCH"] as const;
export type BridgeThrewErrorCode = typeof BRIDGE_THREW_ERROR_CODES[number];

function isBridgeThrewError(e: unknown): e is { code: BridgeThrewErrorCode; message: string } {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === "string" && (BRIDGE_THREW_ERROR_CODES as readonly string[]).includes(code);
}

// ── Tunables ─────────────────────────────────────────────────────────────

/** v0.1.62 watchdog, widened in v2.1.1: 90s grace for the federation to
 *  credit the user's wallet after CLAIM publishes. The original 60s was
 *  calibrated on good links; the sm_mq1cmq6p_a2arwi0x field incident
 *  (South Africa, high-latency mobile data) showed real redeems landing
 *  after the window closed. A too-short window costs a claim-pending
 *  bounce; with the cover check it no longer costs a stuck trade. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 90 * 1000;

/** Same cadence as the existing claim watchdog and Phase 2. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Failed balance reads extend the confirm deadline (they prove nothing
 *  about non-arrival), but never past this multiple of the nominal
 *  timeout — the loop must terminate even when the federation stays
 *  unreadable for the whole window. */
export const CONFIRM_HARD_CAP_MULTIPLIER = 3;

/** Accept any delta ≥ 90% of expected as "fully landed". Matches the
 *  Fedimint settlement tolerance baked into startClaimWatchdog. */
export const DEFAULT_THRESHOLD_PCT = 0.9;

/** 3.5.1 — copy for the `payout-confirming` terminal. Reassures without
 *  inviting a re-pay: the sats are on their way out and a retry would risk a
 *  second send, so the user is pointed at their destination wallet instead. */
export const PAYOUT_CONFIRMING_COPY =
  "Your payout was sent and is confirming. Don't tap Claim again — check your destination wallet. Chama will finish this claim once the payment confirms.";

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

function moneyDebugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem("chama_debug_money") !== null;
  } catch {
    return false;
  }
}

function moneyLog(checkpoint: string, fields: Record<string, unknown>): void {
  if (!moneyDebugEnabled()) return;
  const parts: string[] = [`[$$] ${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) val = "undef";
    else if (v === null) val = "null";
    else if (typeof v === "string") val = v.length > 64 ? `${v.slice(0, 60)}...(${v.length})` : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v).slice(0, 80);
    parts.push(`${k}=${val}`);
  }
  // eslint-disable-next-line no-console
  console.info(parts.join(" "));
}

function claimTrace(checkpoint: string, fields: Record<string, unknown>): void {
  if (!moneyDebugEnabled()) return;
  const parts: string[] = [`[claim-trace] ${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) val = "undef";
    else if (v === null) val = "null";
    else if (typeof v === "string") val = v.length > 64 ? `${v.slice(0, 60)}...(${v.length})` : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v).slice(0, 80);
    parts.push(`${k}=${val}`);
  }
  // eslint-disable-next-line no-console
  console.info(parts.join(" "));
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (
    e &&
    typeof e === "object" &&
    typeof (e as { message?: unknown }).message === "string" &&
    (e as { message: string }).message
  ) {
    return (e as { message: string }).message;
  }
  return fallback;
}

// ── balanceCoversPayout ──────────────────────────────────────────────────

/** Absolute-balance settlement check: can the wallet, RIGHT NOW, pay the
 *  payout this claim promised? Used when balance GROWTH can't be observed
 *  — either the confirm window timed out, or the mint reported the notes
 *  already consumed (a previous attempt's redeem landed after its own
 *  window closed; re-baselining hides the credit forever).
 *
 *  Lightning: the modal sized the invoice as
 *  maxLightningPayoutSats(expectedDeltaMsats), so the wallet covers it
 *  exactly when its own max payout reaches that figure (fee headroom
 *  included — maxLightningPayoutSats is monotone).
 *  Onchain: payOnchain receives gross sats and re-deducts peg-out fees
 *  itself, so whole-sat coverage of the gross amount suffices.
 *
 *  Safety: sats are fungible and the destination is the winner's OWN
 *  wallet. In the worst case (claim genuinely still pending + the cover
 *  came from pre-existing funds) the user is paid from money that was
 *  already theirs, the pending-redemption stash stays intact, and the
 *  boot drain reconciles the late credit. The user can only come out
 *  whole or ahead — never behind. */
export function balanceCoversPayout(
  balanceMsats: number,
  expectedDeltaMsats: number,
  payoutKind: "lightning" | "onchain" | "ecash" = "lightning",
): boolean {
  const balance = Math.max(0, Math.floor(balanceMsats));
  const expected = Math.max(0, Math.floor(expectedDeltaMsats));
  if (expected <= 0) return false;
  if (payoutKind === "onchain" || payoutKind === "ecash") {
    const grossSats = Math.floor(expected / 1000);
    return grossSats > 0 && Math.floor(balance / 1000) >= grossSats;
  }
  const invoiceSats = maxLightningPayoutSats(expected);
  return invoiceSats > 0 && maxLightningPayoutSats(balance) >= invoiceSats;
}

// ── waitForBalanceGrowth ─────────────────────────────────────────────────

export interface WaitForBalanceGrowthOpts {
  debugId?: string;
  baselineMsats: number;
  expectedDeltaMsats: number;
  getBalance: () => Promise<number>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  thresholdPct?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Poll the wallet balance until it grows by ≥ thresholdPct * expected,
 *  or the timeout elapses, or the signal aborts. Resolves with the
 *  outcome — never throws. Used as the "claim-confirming" loop in
 *  runClaimAndPayout. */
export async function waitForBalanceGrowth(
  opts: WaitForBalanceGrowthOpts,
): Promise<"grew" | "timeout" | "aborted"> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? defaultNow;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const requiredDelta = Math.floor(opts.expectedDeltaMsats * thresholdPct);
  const start = now();
  let polls = 0;
  // v2.1.1 slow-link rule: a FAILED balance read proves nothing about
  // non-arrival, so it must not consume the confirm window. Each failed
  // read extends the deadline by one poll interval, hard-capped at
  // CONFIRM_HARD_CAP_MULTIPLIER × the nominal timeout so an unreachable
  // federation still terminates the loop.
  const hardCapMs = timeoutMs * CONFIRM_HARD_CAP_MULTIPLIER;
  let failedReadExtensionMs = 0;

  while (true) {
    if (opts.signal?.aborted) return "aborted";
    polls++;
    let balance = opts.baselineMsats;
    let balanceReadOk = true;
    try {
      balance = await opts.getBalance();
    } catch {
      balanceReadOk = false;
      // Transient federation hiccups during polling — retry on next tick,
      // and push the deadline out by the interval this read wasted.
      failedReadExtensionMs = Math.min(
        failedReadExtensionMs + pollIntervalMs,
        Math.max(0, hardCapMs - timeoutMs),
      );
    }
    const elapsedMs = now() - start;
    const delta = balance - opts.baselineMsats;
    const grew = delta >= requiredDelta;
    moneyLog("CLAIM-WAIT", {
      escrowId: opts.debugId,
      poll: polls,
      balanceReadOk,
      balance,
      baseline: opts.baselineMsats,
      delta,
      requiredDelta,
      elapsedMs,
      result: grew ? "grew" : "waiting",
    });
    claimTrace("orchestrator-balance-poll", {
      escrowId: opts.debugId,
      poll: polls,
      balanceReadOk,
      balance,
      baseline: opts.baselineMsats,
      delta,
      requiredDelta,
      elapsedMs,
      result: grew ? "grew" : "waiting",
    });
    if (grew) return "grew";
    const effectiveTimeoutMs = Math.min(timeoutMs + failedReadExtensionMs, hardCapMs);
    if (elapsedMs >= effectiveTimeoutMs) {
      moneyLog("CLAIM-WAIT", {
        escrowId: opts.debugId,
        poll: polls,
        delta,
        requiredDelta,
        elapsedMs,
        result: "timeout",
      });
      claimTrace("orchestrator-balance-timeout", {
        escrowId: opts.debugId,
        poll: polls,
        delta,
        requiredDelta,
        elapsedMs,
      });
      return "timeout";
    }
    await sleep(pollIntervalMs);
  }
}

// ── runClaimAndPayout ────────────────────────────────────────────────────

export interface RunClaimAndPayoutDeps {
  /** Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Bound to the raw bridge claim path (decrypt + SSS + publish CLAIM
   *  + redeem). May resolve before balance has fully settled — the
   *  orchestrator polls separately to handle the watchdog case. */
  claimAndRedeem: (escrowId: string) => Promise<unknown>;
  /** Browser-safe bearer payout: reconstruct the released escrow note,
   *  durably stash that exact note, then publish CLAIM. This deliberately
   *  performs no browser-wallet mint reissue. */
  claimAndExportEcash?: (escrowId: string) => Promise<{
    notes: string;
    amountMsats: number;
  }>;
  /** Bound to bridge.payInvoice. Outbound Lightning send. Resolves with the
   *  durable LN-pay operationId (success ⇒ `success{preimage}` reached).
   *  Throws a coded error on failure: `code` is LN_PAY_INFLIGHT (submitted,
   *  outcome UNKNOWN ⇒ never re-pay), LN_PAY_REFUNDED (confirmed refund ⇒
   *  retry-safe) or LN_PAY_SUBMIT_FAILED (no payment made ⇒ retry-safe), and
   *  `operationId` carries the handle for re-attach. */
  payInvoice: (bolt11: string) => Promise<string | undefined | void>;
  /** Optional native on-chain payout. Amount is the gross claimed sats
   *  available before wallet-module peg-out fees. */
  payOnchain?: (grossAmountSats: number) => Promise<void>;
  /** Mint and durably stash a fresh bearer note for the net winner amount.
   *  Must persist before resolving; COMPLETE waits for explicit approval. */
  exportEcash?: (amountMsats: number) => Promise<{ notes: string; amountMsats: number }>;
  /** Pre-spend fail-closed guard. Returns a same-claim pending export to
   *  resume, throws if another export exists or durable storage is unavailable. */
  prepareEcashExport?: () => {
    notes: string;
    amountMsats: number;
    claimPublished?: boolean;
  } | null;
  // ── 3.5.1 payout double-pay guard (Lightning only) ──────────────────────
  // All optional so existing callers/tests run unchanged (guard becomes a
  // no-op). Bound to payments/payout-journal.ts + bridge.awaitPayoutOutcome
  // in the hook. See that module's header for the incident this prevents.
  /** Read the persisted payout record for this escrow (null when none). */
  getPayoutRecord?: (escrowId: string) => {
    status: "intent" | "submitted" | "settled";
    operationId?: string;
    createdAt?: number;
  } | null;
  /** V7 pre-send intent: persist that a payout dispatch is imminent, BEFORE
   *  payInvoice — a crash mid-pay then leaves a record for the
   *  reconcile-by-escrow guard instead of an empty journal. */
  recordPayoutIntent?: (input: { escrowId: string; amountMsats?: number }) => void;
  /** Persist that a payout was submitted (gateway accepted; outcome unknown). */
  recordPayoutSubmitted?: (input: { escrowId: string; operationId?: string; amountMsats?: number }) => void;
  /** Persist that a payout reached `success{preimage}`. Blocks all re-pay. */
  markPayoutSettled?: (escrowId: string, operationId?: string) => void;
  /** Drop the payout record — ONLY on a CONFIRMED refund (retry becomes safe). */
  clearPayoutRecord?: (escrowId: string) => void;
  /** V7 reconcile-by-escrow: resolve the payout(s) the wallet ever dispatched
   *  for this escrow by scanning the fedimint operation log for LN-pay ops
   *  stamped `chama_escrow_id` — durable in the client DB, so it survives a
   *  crash that lost the operationId (the V7 window). `sinceMs` bounds the
   *  scan: reaching ops older than it proves completeness, so "none" is a
   *  POSITIVE no-payment-exists verdict, not a blind miss. Outcomes:
   *  settled / refunded / inflight (operationId carried for re-attach) /
   *  none / unknown (scan failed or unavailable ⇒ refuse re-pay for now —
   *  the boot sweep + trade-open reattach retry the reconcile later). */
  payOutcomeByEscrow?: (escrowId: string, sinceMs?: number) => Promise<{
    outcome: "settled" | "refunded" | "inflight" | "none" | "unknown";
    operationId?: string;
  }>;
  /** Probe (v4.0.0 fail-closed): throws if the payout journal can't be
   *  persisted right now (quota / private mode / disabled storage). Called
   *  pre-send so the orchestrator refuses to dispatch a payout it can't guard
   *  against a re-pay. No-op when unset (older callers/tests). */
  assertPayoutJournalWritable?: () => void;
  /** Re-attach to a submitted payout and report its terminal outcome
   *  without paying again. "unknown" ⇒ keep the record, refuse to re-pay. */
  awaitPayoutOutcome?: (operationId: string) => Promise<"settled" | "refunded" | "unknown">;
  payoutKind?: "lightning" | "onchain" | "ecash";
  /** Publish escrow COMPLETE after the wallet balance has actually
   *  confirmed. Best-effort: failure must not block payout/recovery. */
  completeClaim?: (escrowId: string) => Promise<void>;
  /** Release the crash-recovery/reservation entry only after the outbound
   *  payout is confirmed. Wallet credit by itself is not user payment. */
  clearPendingRedemption?: (escrowId: string) => void;
  /** Convert the live bearer-note recovery entry into a credited payout
   *  reservation after observed balance growth. */
  markPendingRedemptionCredited?: (escrowId: string) => void;
  /** Bound to addOrTouchLightningHandle. Best-effort post-success save. */
  addOrTouchLightningHandle: (address: string) => void;
}

export interface RunClaimAndPayoutOpts extends RunClaimAndPayoutDeps {
  escrowId: string;
  /** BOLT11 invoice the user's destination resolved to. */
  bolt11: string;
  /** Expected post-fee payout in msats. The wallet's balance after CLAIM
   *  should grow by this much, give or take 10% threshold tolerance. */
  expectedDeltaMsats: number;
  /** The protocol CLAIM is already on relays (for example after a direct
   * bearer-note export was returned to this wallet). If the current balance
   * covers the requested payout, resume at payout without re-claiming or
   * waiting through a growth window that can no longer occur. */
  claimAlreadyPublished?: boolean;
  /** Whether to call addOrTouchLightningHandle on success. Set by the
   *  DestinationPicker — true when user tapped a saved row OR typed an
   *  address with the "Save for next time" toggle on. */
  saveAfter: boolean;
  /** The Lightning Address to save (if saveAfter). Unset for BOLT11
   *  paste — there's no address to save. */
  addressUsed?: string;

  onPhase: (phase: ClaimAndPayoutPhase) => void;

  // Polling tunables.
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Compose claimAndRedeem → balance-confirm → payInvoice → optional
 *  handle-save into one atomic flow. Resolves with the terminal phase.
 *  Never rejects.
 *
 *  Failure modes are split so the recovery banner UX is clean:
 *   - claim-failed: claim threw HARD; balance unchanged; no orphan
 *   - claim-pending: claim returned but balance never landed in 60s;
 *     keep pending-redemption stash so boot can retry the redeem
 *   - payout-failed: claim landed (balance grew or covered), but the
 *     outbound send failed; sats remain local and Claim stays retryable */
export async function runClaimAndPayout(
  opts: RunClaimAndPayoutOpts,
): Promise<ClaimAndPayoutTerminal> {
  const emit = (p: ClaimAndPayoutPhase) => opts.onPhase(p);
  const payoutKind = opts.payoutKind ?? "lightning";

  // Ecash is a bearer payout. Refuse to reconstruct/redeem anything until
  // durable storage is proven writable, and resume an already-created note
  // instead of ever spending twice after a restart.
  if (opts.payoutKind === "ecash") {
    try {
      const pending = opts.prepareEcashExport?.() ?? null;
      if (pending && pending.claimPublished !== false) {
        emit({ kind: "ecash-ready", ...pending });
        return { kind: "ecash-ready", ...pending };
      }
    } catch (e) {
      const error = errorMessage(e, "Ecash export cannot start safely");
      emit({ kind: "payout-failed", error, claimCompleted: false });
      return { kind: "payout-failed", error, claimCompleted: false };
    }

    // A browser ecash payout must never take the legacy
    // escrow-note -> browser reissue -> fresh export route. The first reissue
    // is precisely the failure boundary that can consume valid escrow notes
    // without crediting the browser wallet. Export the already-reconstructed
    // escrow bearer note directly instead.
    if (!opts.claimAndExportEcash) {
      const error = "Direct ecash claim is not available on this client. No sats moved.";
      emit({ kind: "payout-failed", error, claimCompleted: false });
      return { kind: "payout-failed", error, claimCompleted: false };
    }
    emit({ kind: "claiming" });
    try {
      const exported = await opts.claimAndExportEcash(opts.escrowId);
      emit({ kind: "ecash-ready", ...exported });
      return { kind: "ecash-ready", ...exported };
    } catch (e) {
      const error = errorMessage(e, "Couldn't prepare this ecash claim safely");
      emit({ kind: "claim-failed", error });
      return { kind: "claim-failed", error };
    }
  }

  // Best-effort COMPLETE publish — shared by the normal success path and the
  // already-settled short-circuits in the double-pay guard below.
  const publishCompleteBestEffort = async (via: string): Promise<void> => {
    if (!opts.completeClaim) return;
    try {
      moneyLog("CLAIM-COMPLETE-IN", { escrowId: opts.escrowId, via });
      claimTrace("orchestrator-complete-in", { escrowId: opts.escrowId, via });
      await opts.completeClaim(opts.escrowId);
      moneyLog("CLAIM-COMPLETE-OUT", { escrowId: opts.escrowId, result: "success", via });
      claimTrace("orchestrator-complete-out", { escrowId: opts.escrowId, result: "success", via });
    } catch (e: any) {
      moneyLog("CLAIM-COMPLETE-OUT", {
        escrowId: opts.escrowId, result: "error", via,
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      claimTrace("orchestrator-complete-out", {
        escrowId: opts.escrowId, result: "error", via,
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      // Advisory protocol event only; the user already has their sats.
    }
  };

  // ── 3.5.1 payout double-pay guard (Lightning only) ───────────────────────
  // BEFORE any claim/redeem/balance work: if a payout was already submitted
  // or settled for this escrow on a prior attempt, NEVER pay again. This MUST
  // run first — a successful prior payout drains the balance, so the Phase 2
  // cover check would otherwise bounce a retry to claim-pending and never
  // reach the pay step where the journal is consulted. The reported field
  // double-pay (two payouts ~78s apart) was exactly a retry after the 60s
  // pay-watch window timed out mid-flight.
  if (payoutKind === "lightning") {
    const prior = opts.getPayoutRecord?.(opts.escrowId) ?? null;
    if (prior?.status === "settled") {
      claimTrace("orchestrator-payout-already-settled", { escrowId: opts.escrowId });
      await publishCompleteBestEffort("already-settled");
      opts.clearPendingRedemption?.(opts.escrowId);
      emit({ kind: "done" });
      return { kind: "done" };
    }
    // V7 reconcile-by-escrow, shared by the intent and opId-less-submitted
    // branches below. Resolves via the operation log's chama_escrow_id stamp
    // (survives restarts that lost the operationId). `trustNone` encodes the
    // fund-safety asymmetry: for an INTENT record, "none" is a positive
    // proof no payment was ever dispatched (intents are new, so their pays
    // always carry the meta stamp) ⇒ safe to pay fresh. For a SUBMITTED
    // record, the gateway DID accept a payment — a "none" scan can only mean
    // the op predates meta-stamping ⇒ treat as unknown, refuse re-pay.
    const reconcileByEscrow = async (
      via: "intent" | "submitted-no-opid",
      createdAt: number | undefined,
      trustNone: boolean,
    ): Promise<ClaimAndPayoutTerminal | "pay-fresh"> => {
      emit({ kind: "payout-confirming" });
      let res: { outcome: "settled" | "refunded" | "inflight" | "none" | "unknown"; operationId?: string } =
        { outcome: "unknown" };
      if (opts.payOutcomeByEscrow) {
        try {
          res = await opts.payOutcomeByEscrow(
            opts.escrowId,
            createdAt !== undefined ? createdAt - PAY_RECONCILE_SINCE_MARGIN_MS : undefined,
          );
        } catch {
          res = { outcome: "unknown" };
        }
      }
      claimTrace("orchestrator-payout-reconcile-by-escrow", {
        escrowId: opts.escrowId, via, outcome: res.outcome,
        op: (res.operationId ?? "?").slice(0, 16),
      });
      if (res.outcome === "settled") {
        try {
          opts.markPayoutSettled?.(opts.escrowId, res.operationId);
        } catch (persistErr) {
          // The existing record still blocks a blind re-pay — fund-safe.
          console.warn(
            "[chama] claim: reconcile markPayoutSettled persist failed (prior record still guards):",
            persistErr,
          );
        }
        await publishCompleteBestEffort(`reconcile-${via}`);
        opts.clearPendingRedemption?.(opts.escrowId);
        emit({ kind: "done" });
        return { kind: "done" };
      }
      if (res.outcome === "inflight") {
        // A live payment exists — adopt its operationId so future attempts
        // re-attach directly, then refuse to re-pay.
        try {
          opts.recordPayoutSubmitted?.({
            escrowId: opts.escrowId,
            operationId: res.operationId,
            amountMsats: opts.expectedDeltaMsats,
          });
        } catch { /* prior record still guards */ }
        emit({ kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY });
        return { kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY };
      }
      if (res.outcome === "refunded" || (res.outcome === "none" && trustNone)) {
        // Sats demonstrably back / payment demonstrably never existed —
        // clear the record and pay fresh.
        opts.clearPayoutRecord?.(opts.escrowId);
        return "pay-fresh";
      }
      // unknown (or an untrusted "none") ⇒ refuse to re-pay NOW. The record
      // stays; the boot sweep and trade-open reattach retry this reconcile
      // until it resolves — refusal with a resolver, never a dead end.
      emit({ kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY });
      return { kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY };
    };
    if (prior?.status === "intent") {
      // V7 window: a pre-send intent survived but no submit/settle upgrade —
      // the app died somewhere around the dispatch. Only the operation log
      // knows whether a payment actually left.
      const verdict = await reconcileByEscrow("intent", prior.createdAt, true);
      if (verdict !== "pay-fresh") return verdict;
    }
    if (prior?.status === "submitted") {
      if (!prior.operationId) {
        // V6 residue: a submitted record whose operationId never persisted.
        // Reconcile by escrow instead of stranding on "confirming" forever.
        // NOTE trustNone=false: submitted means the gateway accepted a
        // payment, so an empty scan is blindness, not proof of absence.
        const verdict = await reconcileByEscrow("submitted-no-opid", prior.createdAt, false);
        if (verdict !== "pay-fresh") return verdict;
      } else {
        // A payout is in flight for this escrow. Resolve its TRUE outcome by
        // re-attaching to the operationId — never by paying again.
        emit({ kind: "payout-confirming" });
        let outcome: "settled" | "refunded" | "unknown" = "unknown";
        if (opts.awaitPayoutOutcome) {
          try {
            outcome = await opts.awaitPayoutOutcome(prior.operationId);
          } catch {
            outcome = "unknown";
          }
        }
        claimTrace("orchestrator-payout-reattach", { escrowId: opts.escrowId, outcome });
        if (outcome === "settled") {
          try {
            opts.markPayoutSettled?.(opts.escrowId, prior.operationId);
          } catch (persistErr) {
            // Couldn't upgrade submitted→settled, but the SUBMITTED record (which
            // got here) still persists and blocks re-pay — fund-safe. Proceed.
            console.warn(
              "[chama] claim: re-attach markPayoutSettled persist failed (submitted record still guards):",
              persistErr,
            );
          }
          await publishCompleteBestEffort("reattach-settled");
          opts.clearPendingRedemption?.(opts.escrowId);
          emit({ kind: "done" });
          return { kind: "done" };
        }
        if (outcome === "refunded") {
          // The sats came back — clear the record and fall through to a fresh
          // claim+payout (re-pay is now correct, not a double-send).
          opts.clearPayoutRecord?.(opts.escrowId);
        } else {
          // unknown ⇒ refuse to re-pay. Keep the submitted record so a later
          // attempt re-attaches again rather than sending a second payment.
          emit({ kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY });
          return { kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY };
        }
      }
    }
  }

  // Snapshot baseline before we dispatch anything. The polling phase
  // measures growth from here.
  let baseline: number;
  try {
    baseline = await opts.getBalance();
  } catch (e: any) {
    const error = errorMessage(e, "Couldn't read wallet balance");
    emit({ kind: "claim-failed", error });
    return { kind: "claim-failed", error };
  }
  moneyLog("CLAIM-BASELINE", {
    escrowId: opts.escrowId,
    baseline,
    expectedDeltaMsats: opts.expectedDeltaMsats,
  });
  claimTrace("orchestrator-baseline", {
    escrowId: opts.escrowId,
    baseline,
    expectedDeltaMsats: opts.expectedDeltaMsats,
  });

  const resumedPublishedClaimCover = opts.claimAlreadyPublished === true
    && balanceCoversPayout(baseline, opts.expectedDeltaMsats, payoutKind);

  // Phase 1: claim. Decrypt shares, SSS-combine, redeem ecash, publish
  // CLAIM. May resolve via:
  //   - synchronous success (balance already grew)
  //   - watchdog success (balance grows during polling)
  //   - hard failure (throws non-bridge error — surfaced as claim-failed)
  //   - typed bridge error (throws with code FED_PROBE_FAILED or
  //     FED_MISMATCH — surfaced as claim-bridge-threw, retry-able)
  emit({ kind: "claiming" });
  // v2.1.1: when the mint reports the notes terminally consumed, balance
  // GROWTH is impossible by definition — either a previous attempt's
  // redeem already credited this wallet (the sm_mq1cmq6p_a2arwi0x loop)
  // or the credit is unprovable. Skip the growth poll and judge by the
  // absolute-balance cover check; only if that also fails do we surface
  // the terminal claim-failed.
  let settlementFailedHard = false;
  let settlementFailedError = "";
  try {
    if (!resumedPublishedClaimCover) await opts.claimAndRedeem(opts.escrowId);
    claimTrace("orchestrator-claim-returned", {
      escrowId: opts.escrowId,
      resumedPublishedClaimCover,
    });
  } catch (e: any) {
    const error = errorMessage(e, "Claim failed");
    // v0.3.1 Phase 1: typed bridge errors get their own retry-able
    // terminal. Discrimination is on e.code (the bridge tags
    // FED_PROBE_FAILED + FED_MISMATCH at throw sites in
    // escrow-bridge.ts). Other throws — hard claim failures, generic
    // protocol errors — stay on claim-failed (no retry semantic).
    if (isBridgeThrewError(e)) {
      claimTrace("orchestrator-claim-bridge-threw", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      emit({ kind: "claim-bridge-threw", error });
      return { kind: "claim-bridge-threw", error };
    }
    // CLAIM already hit relays, but the SDK has reported a terminal mint
    // reissue failure. Growth polling is pointless (the notes are gone),
    // but the wallet may ALREADY hold the credit from a previous attempt
    // whose confirm window expired before settlement — the cover check
    // below decides. Only a non-covering balance keeps this terminal.
    if (e?.claimPublished && e?.settlementFailed) {
      claimTrace("orchestrator-claim-settle-failed", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      settlementFailedHard = true;
      settlementFailedError = error;
      // Fall through to the settlement verdict below (poll skipped).
    } else if (e?.claimPublished) {
      // CLAIM already hit relays, but redeem/balance settlement is still
      // uncertain. This is not a hard claim failure; continue into the
      // balance-confirming watchdog. If the balance lands, payout proceeds.
      // If it does not, the terminal remains claim-pending.
      moneyLog("CLAIM-PUBLISHED-THROW", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      claimTrace("orchestrator-claim-published-throw", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      // Fall through to confirming below.
    } else {
      claimTrace("orchestrator-claim-failed", {
        escrowId: opts.escrowId,
        errMsg: error.slice(0, 120),
      });
      emit({ kind: "claim-failed", error });
      return { kind: "claim-failed", error };
    }
  }

  // Phase 2: settlement verdict. Two independent proofs, tried in order:
  //
  //   growth — balance grew from this attempt's baseline (the classic
  //            watchdog; cryptographically tied to THIS redeem landing).
  //   cover  — the absolute balance can pay the promised payout right
  //            now. Catches every settlement the baseline can't see:
  //            a previous attempt's redeem landing late, the boot
  //            drain landing it, or a resumed historical operation.
  //            Without this, a retry after late settlement loops on
  //            claim-pending FOREVER (baseline includes the credit, so
  //            growth can never be observed again).
  emit({ kind: "confirming" });
  let grew: "grew" | "timeout" | "aborted" = "timeout";
  if (!settlementFailedHard && !resumedPublishedClaimCover) {
    grew = await waitForBalanceGrowth({
      debugId: opts.escrowId,
      baselineMsats: baseline,
      expectedDeltaMsats: opts.expectedDeltaMsats,
      getBalance: opts.getBalance,
      timeoutMs: opts.confirmTimeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
      now: opts.now,
    });
  }
  let settledBy: "growth" | "cover" | null = resumedPublishedClaimCover
    ? "cover"
    : grew === "grew" ? "growth" : null;
  let coverBalanceMsats: number | undefined = resumedPublishedClaimCover ? baseline : undefined;
  if (!settledBy) {
    try { coverBalanceMsats = await opts.getBalance(); } catch {}
    if (
      coverBalanceMsats !== undefined &&
      balanceCoversPayout(coverBalanceMsats, opts.expectedDeltaMsats, payoutKind)
    ) {
      settledBy = "cover";
    }
  }
  moneyLog("CLAIM-CONFIRM-OUT", {
    escrowId: opts.escrowId,
    result: grew,
    settledBy: settledBy ?? "none",
    coverBalance: coverBalanceMsats,
    settlementFailedHard,
  });
  claimTrace("orchestrator-confirm-out", {
    escrowId: opts.escrowId,
    result: grew,
    settledBy: settledBy ?? "none",
    coverBalance: coverBalanceMsats,
    settlementFailedHard,
  });
  if (!settledBy) {
    if (settlementFailedHard) {
      // Notes consumed AND the wallet can't cover the payout: this is
      // the honest terminal failure. Do not invite retries against
      // already-consumed notes with comforting "still arriving" copy.
      emit({ kind: "claim-failed", error: settlementFailedError });
      return { kind: "claim-failed", error: settlementFailedError };
    }
    const error =
      "Your sats are still arriving from the federation. They'll land shortly. If this trade stays settling, try the claim again.";
    emit({ kind: "claim-pending", error });
    return { kind: "claim-pending", error };
  }

  let balanceAfterClaim: number | undefined;
  if (coverBalanceMsats !== undefined) {
    balanceAfterClaim = coverBalanceMsats;
  } else {
    try { balanceAfterClaim = await opts.getBalance(); } catch {}
  }

  // Stash discipline: GROWTH proves this attempt's redeem landed, so mark the
  // entry credited but KEEP it as a reservation. Wallet credit is only the
  // inbound half of a claim; clearing before the outbound payout allowed an
  // unrelated premium sweep to spend the claimant's sats. COVER remains
  // circumstantial and leaves the existing reservation untouched.
  // ⭐ Durable proof that the sats LANDED. This is the only moment the app can
  // prove it — the balance grew by the expected amount after redeeming. Every
  // other artifact (CLAIM event, COMPLETED status, a published chain) records
  // what was announced, and v5.4 showed those three diverging from reality in
  // the field. The tranche gate reads this and nothing else.
  //
  // Deliberately NOT recorded on the `cover` path below: that only proves the
  // wallet had enough money, which may predate this claim entirely.
  if (settledBy === "growth") {
    try {
      recordClaimCredit(opts.escrowId, opts.expectedDeltaMsats);
    } catch (e) {
      // Best-effort: a lost proof makes the gate more conservative, never less.
      console.warn("[chama] claim-credit record failed:", e);
    }
    try {
      opts.markPendingRedemptionCredited?.(opts.escrowId);
      moneyLog("CLAIM-STASH-RESERVE", {
        escrowId: opts.escrowId,
        result: "success",
      });
      claimTrace("orchestrator-stash-reserve", {
        escrowId: opts.escrowId,
        result: "success",
      });
    } catch (e: any) {
      moneyLog("CLAIM-STASH-RESERVE", {
        escrowId: opts.escrowId,
        result: "error",
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
      claimTrace("orchestrator-stash-reserve", {
        escrowId: opts.escrowId,
        result: "error",
        errMsg: (e?.message || String(e)).slice(0, 120),
      });
    }
  }

  // Phase 3: outbound payout. Pay the user's destination.
  // If this throws, COMPLETE has not been published yet, so re-tapping
  // Claim retries cleanly (picker → fresh invoice → cover check →
  // payout). This matters for tiny claims too: the balance can be real
  // but below the main recovery banner's material line.
  emit({ kind: payoutKind === "onchain"
    ? "paying-onchain"
    : payoutKind === "ecash"
      ? "exporting-ecash"
      : "paying-invoice" });
  try {
    moneyLog("CLAIM-PAY-IN", {
      escrowId: opts.escrowId,
      kind: payoutKind,
      destination: payoutKind === "lightning" ? opts.bolt11.slice(0, 24) : payoutKind,
    });
    claimTrace("orchestrator-pay-in", {
      escrowId: opts.escrowId,
      kind: payoutKind,
      destination: payoutKind === "lightning" ? opts.bolt11.slice(0, 24) : payoutKind,
    });
    if (payoutKind === "onchain") {
      if (!opts.payOnchain) throw new Error("Onchain payout is not available");
      await opts.payOnchain(Math.floor(opts.expectedDeltaMsats / 1000));
    } else if (payoutKind === "ecash") {
      if (!opts.exportEcash) throw new Error("Ecash payout is not available");
      const exported = await opts.exportEcash(opts.expectedDeltaMsats);
      moneyLog("CLAIM-PAY-OUT", { escrowId: opts.escrowId, result: "ecash-ready" });
      claimTrace("orchestrator-pay-out", { escrowId: opts.escrowId, result: "ecash-ready" });
      emit({ kind: "ecash-ready", ...exported });
      return { kind: "ecash-ready", ...exported };
    } else {
      // v4.0.0 FAIL-CLOSED: never SEND a payout we can't guard against a re-pay.
      // If the device can't persist the journal (quota / private mode / disabled
      // storage), refuse to start — nothing is sent, so retrying later (once
      // storage recovers) is safe. Without this, a swallowed journal write would
      // let a later re-tap double-pay.
      try {
        opts.assertPayoutJournalWritable?.();
      } catch (e) {
        const error = errorMessage(
          e,
          "Can't pay out safely right now — this device's storage is full or unavailable, so the anti-double-pay guard can't be saved. No payment was sent; free up space (or leave private browsing) and try again.",
        );
        claimTrace("orchestrator-payout-journal-unwritable", { escrowId: opts.escrowId });
        emit({ kind: "payout-failed", error, claimCompleted: false });
        return { kind: "payout-failed", error, claimCompleted: false };
      }
      // V7: persist the pre-send INTENT before dispatching. If the app dies
      // anywhere between here and the settled/submitted upgrade below, the
      // retry's top guard reconciles BY ESCROW (the payment carries
      // chama_escrow_id in the op log) instead of finding an empty journal
      // and paying twice. A failed write here refuses the send — same
      // fail-closed stance as the probe (nothing sent yet, retry is safe).
      try {
        opts.recordPayoutIntent?.({
          escrowId: opts.escrowId,
          amountMsats: opts.expectedDeltaMsats,
        });
      } catch (e) {
        const error = errorMessage(
          e,
          "Can't pay out safely right now — the anti-double-pay guard couldn't be saved. No payment was sent; try again.",
        );
        claimTrace("orchestrator-payout-intent-unwritable", { escrowId: opts.escrowId });
        emit({ kind: "payout-failed", error, claimCompleted: false });
        return { kind: "payout-failed", error, claimCompleted: false };
      }
      const res = await opts.payInvoice(opts.bolt11);
      // payInvoice only RESOLVES on `success{preimage}`. Journal it settled
      // BEFORE COMPLETE so that even a COMPLETE-publish failure + retry is a
      // no-op (the top guard short-circuits), never a second send. If THAT write
      // fails (the rare quota-between-probe-and-write case), do NOT advance to
      // `done` with no guard — force payout-confirming (no retry button) so a
      // re-tap can't re-pay an already-sent payout.
      const operationId = typeof res === "string" ? res : undefined;
      try {
        opts.markPayoutSettled?.(opts.escrowId, operationId);
      } catch (persistErr) {
        console.error(
          "[chama] claim: markPayoutSettled persist failed after a sent payout; forcing payout-confirming:",
          persistErr,
        );
        emit({ kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY });
        return { kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY };
      }
    }
  } catch (e: any) {
    const code = (e as { code?: string })?.code;
    const opId = (e as { operationId?: string })?.operationId;
    // 3.5.1: a SUBMITTED-but-unconfirmed Lightning payout (watch timed out
    // mid-flight, stream broke, unexpected state) must NOT become a re-payable
    // failure — that is the exact double-send. Journal it `submitted` and
    // surface payout-confirming; the next attempt re-attaches to operationId.
    if (payoutKind === "lightning" && code === "LN_PAY_INFLIGHT") {
      try {
        opts.recordPayoutSubmitted?.({
          escrowId: opts.escrowId,
          operationId: opId,
          amountMsats: opts.expectedDeltaMsats,
        });
      } catch (persistErr) {
        // The payment is IN FLIGHT but the submitted guard couldn't persist.
        // Still force payout-confirming below — NEVER fall through to the
        // re-payable terminal. (The pre-send writability probe makes this rare.)
        console.error(
          "[chama] claim: recordPayoutSubmitted persist failed for an in-flight payout; forcing payout-confirming anyway:",
          persistErr,
        );
      }
      moneyLog("CLAIM-PAY-OUT", { escrowId: opts.escrowId, result: "inflight" });
      claimTrace("orchestrator-pay-inflight", {
        escrowId: opts.escrowId,
        op: (opId ?? "?").slice(0, 16),
      });
      emit({ kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY });
      return { kind: "payout-confirming", error: PAYOUT_CONFIRMING_COPY };
    }
    // Definite failure (confirmed refund, submit-failed, onchain, or any
    // other throw): the sats are still local, so re-paying is correct. Drop
    // any record so the top guard doesn't block the legitimate retry.
    if (payoutKind === "lightning") opts.clearPayoutRecord?.(opts.escrowId);
    const error = errorMessage(
      e,
      payoutKind === "onchain"
        ? "Onchain payout failed"
        : payoutKind === "ecash"
          ? "Ecash export failed"
          : "Lightning payment failed",
    );
    recordSatsTrace({
      source: "claim",
      escrowId: opts.escrowId,
      amountMsats: opts.expectedDeltaMsats,
      balanceMsats: balanceAfterClaim,
      reason: "claim-payout-failed",
    });
    moneyLog("CLAIM-PAY-OUT", {
      escrowId: opts.escrowId,
      result: "error",
      errMsg: error.slice(0, 120),
    });
    claimTrace("orchestrator-pay-out", {
      escrowId: opts.escrowId,
      result: "error",
      errMsg: error.slice(0, 120),
    });
    const claimCompleted = false;
    emit({ kind: "payout-failed", error, claimCompleted });
    return { kind: "payout-failed", error, claimCompleted };
  }
  moneyLog("CLAIM-PAY-OUT", {
    escrowId: opts.escrowId,
    result: "success",
  });
  claimTrace("orchestrator-pay-out", {
    escrowId: opts.escrowId,
    result: "success",
  });

  // COMPLETE is deferred until the user is demonstrably made whole
  // (payout sent). At this point the attestation is materially true
  // whether settlement was proven by fresh growth or by a covering
  // balance from an earlier/late redeem. Best-effort: the money path
  // succeeded, so a relay publish failure must not undo the payout.
  await publishCompleteBestEffort(settledBy ?? "payout");
  // Only the confirmed outbound payout releases the reservation. A wallet
  // credit alone is not user payment and must remain protected from other
  // background spends (notably arbiter premiums).
  opts.clearPendingRedemption?.(opts.escrowId);

  let balanceAfterPayout: number | undefined;
  try { balanceAfterPayout = await opts.getBalance(); } catch {}
  if (balanceAfterPayout !== undefined && Math.floor(Math.max(0, balanceAfterPayout) / 1000) > 0) {
    recordSatsTrace({
      source: "claim",
      escrowId: opts.escrowId,
      amountMsats: opts.expectedDeltaMsats,
      balanceMsats: balanceAfterPayout,
      reason: "claim-payout-leftover",
    });
  } else if (balanceAfterPayout !== undefined) {
    markSatsTracesDrained("claim-payout-drained");
  }

  // Phase 4: best-effort handle save. Failures here are cosmetic —
  // the payout already succeeded.
  if (opts.saveAfter && opts.addressUsed) {
    try {
      opts.addOrTouchLightningHandle(opts.addressUsed);
    } catch {
      // ignore
    }
  }

  emit({ kind: "done" });
  moneyLog("CLAIM-DONE", {
    escrowId: opts.escrowId,
  });
  claimTrace("orchestrator-done", {
    escrowId: opts.escrowId,
  });
  return { kind: "done" };
}
