// ══════════════════════════════════════════════════════════════════════════
// Chama — Atomic fund-and-lock orchestrator (v0.3.0 Phase 2)
// ══════════════════════════════════════════════════════════════════════════
//
// Per PHILOSOPHY.md §2.1 Option B: ecash exists only during LOCK→CLAIM.
// The user never sees an intermediate "you have N sats in your Chama"
// surface. v0.3.0 collapses the prior two-step "fund wallet then LOCK"
// into a single atomic flow: tap Fund on a listing → AtomicFundingModal
// generates a BOLT11 invoice for the exact trade amount → user pays from
// any external Lightning wallet → ecash mints into the wallet → LOCK
// fires automatically → the modal auto-closes.
//
// This module is the pure orchestrator (testable without React or a
// running Fedimint). The hook (useEscrow.ts) binds the dependencies
// to the live wallet; the AtomicFundingModal renders phase transitions
// to the user.
//
// ── Phase model ────────────────────────────────────────────────────────
//
// `creating-invoice`     transient — bridge call to mint BOLT11
// `receive-watch-ready`  transient — receive stream emitted its first
//                        non-terminal state; QR is safe to show
// `invoice-created`      transient — fires once, hands BOLT11 to the UI
// `awaiting-payment`     polling — balance unchanged from baseline
// `mint-confirming`      polling — receive-watch saw gateway funding or
//                        balance moved partial; waiting for federation
//                        to credit the wallet
// `receive-rejected`     in-flight hint — gateway saw the payment, then
//                        receive-watch reported canceled:rejected; keep
//                        checking briefly for late ecash credit
// `payment-confirmed`    transient — full threshold met; LOCK next
// `locking`              transient — calling lockAndPublish
// `locked`               TERMINAL — LOCK published, modal closes
// `expired`              TERMINAL — 15-min payment deadline elapsed
// `mint-timeout`         TERMINAL — gateway/partial credit got stuck
// `aborted`              TERMINAL — caller cancelled via AbortSignal
// `lock-failed`          TERMINAL — invoice creation or LOCK threw
//
// The two timeouts are independent (per the v0.3.0 brief Q1 + addition
// #2): paymentDeadline is the wall-clock budget for the user to pay
// (15 minutes — long enough to scan + walk to a different room + open
// Phoenix); mintConfirmTimeout is the additional grace once we see
// SOMETHING land but not the full amount, modeled on the v0.1.62
// claim-watchdog pattern.

import { recordSatsTrace } from "./sats-trace.js";
import { isSimModeOn } from "../sim/simMode.js";
import type { SelectedMenuItem } from "../escrow-engine/types.js";

// ── Funding-method guidance ────────────────────────────────────────────────
//
// #65: a practical ceiling above which a single Lightning payment is unlikely
// to route reliably through the federation's LN gateway (channel capacity /
// per-payment limits vary by gateway and there's no reliable way to probe the
// real cap, so we use a conservative constant). This is a UX STEERING
// threshold only — NOT a consensus/protocol limit and NOT enforced anywhere in
// the spend/lock math. Above it, the funding UI warns and steers the user to
// on-chain (peg-in) funding, but never hard-blocks (the user may proceed).
export const MAX_LN_FUNDING_SATS = 2_000_000;

// ── Phase types ──────────────────────────────────────────────────────────

/** The Lightning gateway a funding invoice was minted through. A federation
 *  announces several; the chosen one is the only route a payer may use, so
 *  when it can't be reached on the Lightning network the payer gets "no route"
 *  no matter how healthy everything else is. `provenPayable` is false until
 *  something has actually settled through it. */
export interface FundingGatewayInfo {
  id: string;
  alias?: string;
  api?: string;
  provenPayable: boolean;
  operationId?: string;
}

function receiveRejectedMessage(
  reason: string,
  opts: Pick<RunFundAndLockOpts, "escrowId" | "amountMsats">,
  gateway?: FundingGatewayInfo,
  receiveDiagnostic?: Record<string, unknown>,
): string {
  const message =
    (reason === "claim_rejected"
      ? "Payment funded the incoming contract, but the federation rejected Chama's claim transaction. "
      : `Federation didn't accept the payment (reason: ${reason}). `) +
    "Do not pay another invoice for this trade. Your sending wallet " +
    "may refund automatically. This can also fail on a same-federation " +
    "internal payment, so the gateway is not assumed to be the cause.";
  const diagnostic = {
    issue: "lightning_receive_rejected",
    reason,
    meaning: reason === "claim_rejected"
      ? "The incoming contract funded; the receiver claim transaction was rejected by the federation."
      : null,
    escrowId: opts.escrowId,
    amountMsats: opts.amountMsats,
    gateway: gateway
      ? {
          id: gateway.id,
          alias: gateway.alias ?? null,
          api: gateway.api ?? null,
          operationId: gateway.operationId ?? null,
          provenPayable: gateway.provenPayable,
        }
      : null,
    receiveOperation: receiveDiagnostic ?? null,
    protection:
      reason === "claim_rejected"
        ? "Browser Lightning receives for this federation are paused for six hours; no gateway fault is asserted."
        : "No automatic federation-route pause was applied for this reason.",
  };
  return `${message}\n\nChama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`;
}

/** Phases emitted during the polling loop (a sub-set of the orchestrator's
 *  full phase set). pollForFunding emits these.
 *
 *  v0.5.1: `mint-confirming-slow` is an in-flight hint, not a terminal —
 *  it fires once after `mintSlowWarnMs` of mint-confirming with no further
 *  progress, so the UI can switch from the optimistic "crediting…" copy
 *  to a "federation is slow · keep waiting or cancel" surface. The poll
 *  loop keeps running; only `mint-timeout` (the hard cap) terminates. */
export type FundingPhase =
  | { kind: "awaiting-payment" }
  | { kind: "mint-confirming" }
  | { kind: "mint-confirming-slow" }
  | { kind: "payment-confirmed" }
  | { kind: "expired" }
  | { kind: "mint-timeout" }
  | { kind: "aborted" };

/** Full phase model emitted by runFundAndLock. Includes invoice creation
 *  and lock dispatch in addition to FundingPhase.
 *  v0.6.5: `creating-invoice-slow` fires when invoice creation has been
 *  in flight for more than DEFAULT_INVOICE_SLOW_WARN_MS without
 *  resolving — typically because the federation's WebSocket transport
 *  is flaky and the gateway-lookup call is hanging. The poll loop
 *  keeps trying until the hard timeout (DEFAULT_INVOICE_TIMEOUT_MS)
 *  fires. */
export type FundAndLockPhase =
  | { kind: "creating-invoice" }
  | { kind: "creating-invoice-slow" }
  | { kind: "creating-onchain-address" }
  | {
      kind: "onchain-address-created";
      address: string;
      operationId: string;
      finalityDelay: number;
      pegInFeeSats: number;
      depositAmountSats: number;
      minimumDepositSats: number;
    }
  | {
      kind: "awaiting-onchain-confirmations";
      address: string;
      operationId: string;
      finalityDelay: number;
      pegInFeeSats: number;
      depositAmountSats: number;
      minimumDepositSats: number;
    }
  | { kind: "onchain-deposit-confirmed" }
  | { kind: "requesting-fedi-ecash" }
  | { kind: "fedi-ecash-created" }
  | { kind: "receive-watch-ready" }
  | {
      kind: "invoice-created";
      bolt11: string;
      expiresAt: number;
      /** Which gateway minted it, when the wallet can say. */
      gateway?: FundingGatewayInfo;
    }
  | { kind: "paying-with-nwc" }
  | { kind: "receive-rejected"; reason: string }
  | FundingPhase
  | { kind: "locking" }
  | { kind: "locked" }
  | { kind: "lock-failed"; error: string };

/** Terminal phase kinds — pollForFunding / runFundAndLock resolve to one
 *  of these. */
export type FundingTerminal = Extract<
  FundingPhase,
  { kind: "payment-confirmed" | "expired" | "mint-timeout" | "aborted" }
>;

export type FundAndLockTerminal =
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "mint-timeout" }
  | { kind: "aborted" }
  | { kind: "lock-failed"; error: string };

// ── Tunables ─────────────────────────────────────────────────────────────

/** v0.3.0 Q1: 15 minutes. Long enough for scan + walk to another room +
 *  open Phoenix; short enough that abandoned-mid-flow invoices clear. */
export const DEFAULT_PAYMENT_DEADLINE_MS = 15 * 60 * 1000;

/** v0.5.1: 5 minutes. The original 60s grace (v0.3.0) was modeled on
 *  the claim-watchdog cadence, but production smoke on browser Fedimint
 *  (v0.5.0 commit message, "Out of scope" notes) showed real federation
 *  mints regularly take longer than 60s after the gateway acks the
 *  receive — preimage flows back to the payer instantly, but the
 *  multi-guardian mint protocol that actually credits the user's wallet
 *  can take minutes. 60s was too aggressive and killed otherwise-good
 *  trades. The new cap is paired with `DEFAULT_MINT_SLOW_WARN_MS`
 *  (below) which surfaces an honest "still waiting — keep waiting or
 *  cancel" UI well before this hard timeout fires. */
export const DEFAULT_MINT_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/** v0.5.1: 60s into mint-confirming with no further progress, flip
 *  the UI from the optimistic "crediting…" copy to a "federation is
 *  slow — keep waiting or cancel" surface. The poll loop keeps running
 *  until either the threshold lands or the hard `mintConfirmTimeoutMs`
 *  cap fires. Decoupling the soft warn from the hard cap is what
 *  v0.5.0's brief asked for: an explicit wait-vs-cancel choice for the
 *  user, instead of a silent terminal that ate good trades. */
export const DEFAULT_MINT_SLOW_WARN_MS = 60 * 1000;

/** v0.7.1: short grace after a post-funded receive cancellation.
 *  Production v0.7.0 showed `funded → canceled:rejected` with no
 *  subsequent ecash credit. We still preserve the known race where
 *  balance can credit shortly after a rejected watch state, but after
 *  this window the app should stop showing the generic slow-mint
 *  surface and tell the user to check the sending wallet / recovery
 *  banner instead of waiting the full mint watchdog. */
export const DEFAULT_POST_FUNDED_CANCEL_GRACE_MS = 30 * 1000;

/** Same cadence as startClaimWatchdog (5s ticks). Keeps the wallet's
 *  Fedimint state consistent across watchdogs. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Accept any delta ≥ 90% of expected as "fully landed". Matches
 *  startClaimWatchdog's tolerance — Fedimint settles can have tiny
 *  variance from gateway routing fees, and we'd rather false-positive
 *  a success than false-negative into timeout territory. */
export const DEFAULT_THRESHOLD_PCT = 0.9;

/** v0.6.5: hard cap on createFundingInvoice. The Fedimint WASM
 *  client's gateway-lookup + invoice-create chain can hang silently
 *  when the federation's WebSocket transport is unreliable (see the
 *  iroh-canary failure spam in cold-start reports). Without a cap the
 *  modal sits forever on the small "GENERATING INVOICE…" spinner with
 *  no QR and no error — a black-hole UX. 45s is generous enough for a
 *  warm federation while still failing fast on a broken one. */
export const DEFAULT_INVOICE_TIMEOUT_MS = 45_000;

/** v0.6.5: at 10s into invoice creation, flip the modal to a
 *  "creating-invoice-slow" surface so the user sees we're still
 *  trying. The poll loop keeps going until the hard cap above. */
export const DEFAULT_INVOICE_SLOW_WARN_MS = 10_000;

/** v0.7.1: after create_bolt11_invoice returns, require the
 * subscribe_ln_receive stream to produce an initial state before we
 * expose the QR. This cannot prove paid settlement, but it does prove
 * the browser client is watching the operation it is asking the user
 * to fund. */
export const DEFAULT_RECEIVE_WATCH_READY_TIMEOUT_MS = 5_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

// ── pollForFunding ───────────────────────────────────────────────────────

export interface PollFundingOpts {
  /** Wallet balance in msats just before the invoice was created. The
   *  delta from this baseline is what we're watching for. */
  baselineMsats: number;
  /** Trade amount in msats. Threshold = expectedMsats * thresholdPct. */
  expectedMsats: number;
  /** Async balance reader. Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Phase callback — fires once for each transition. */
  onPhase: (phase: FundingPhase) => void;
  /** Caller-controlled abort (modal cancel button, unmount, etc.). */
  signal?: AbortSignal;
  /** Defaults to DEFAULT_PAYMENT_DEADLINE_MS (15 min). */
  paymentDeadlineMs?: number;
  /** Defaults to DEFAULT_MINT_CONFIRM_TIMEOUT_MS (5 min). Hard cap on
   *  how long the orchestrator stays in mint-confirming before
   *  resolving with `mint-timeout`. */
  mintConfirmTimeoutMs?: number;
  /** Defaults to DEFAULT_MINT_SLOW_WARN_MS (60s). Time into
   *  mint-confirming after which `mint-confirming-slow` fires once so
   *  the UI can show the wait-vs-cancel surface. The loop continues
   *  polling until mintConfirmTimeoutMs is reached. */
  mintSlowWarnMs?: number;
  /** Defaults to DEFAULT_POLL_INTERVAL_MS (5s). */
  pollIntervalMs?: number;
  /** Defaults to DEFAULT_THRESHOLD_PCT (0.9). */
  thresholdPct?: number;
  /** v0.6.5 follow-up: low-latency receive-watch hint. True once the
   *  gateway reports `funded`/`awaiting_funds`/`claimed`, even before
   *  wallet balance changes. This starts the mint-confirming watchdog
   *  from the gateway's evidence of payment instead of waiting for a
   *  partial balance delta that may never arrive on rejected receives. */
  mintDetected?: () => boolean;
  /** v0.7.1: reason from a post-funded receive cancellation, if any.
   *  This does not immediately outrank balance polling; it only starts
   *  a short grace window so late wallet credit can still lock. */
  postFundedCancelReason?: () => string | null;
  /** Defaults to DEFAULT_POST_FUNDED_CANCEL_GRACE_MS. */
  postFundedCancelGraceMs?: number;
  /** Test seam: inject a fast/synchronous sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: inject a synthetic clock. */
  now?: () => number;
}

/** Poll for inbound payment, emitting phases as it goes. Resolves with
 *  the terminal phase. Never rejects — caller branches on the returned
 *  kind to decide what to do next. */
export async function pollForFunding(opts: PollFundingOpts): Promise<FundingTerminal> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? defaultNow;
  const paymentDeadlineMs = opts.paymentDeadlineMs ?? DEFAULT_PAYMENT_DEADLINE_MS;
  const mintConfirmTimeoutMs = opts.mintConfirmTimeoutMs ?? DEFAULT_MINT_CONFIRM_TIMEOUT_MS;
  const mintSlowWarnMs = opts.mintSlowWarnMs ?? DEFAULT_MINT_SLOW_WARN_MS;
  const postFundedCancelGraceMs =
    opts.postFundedCancelGraceMs ?? DEFAULT_POST_FUNDED_CANCEL_GRACE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const requiredDelta = Math.floor(opts.expectedMsats * thresholdPct);

  const start = now();
  let mintStartedAt: number | null = null;
  let postFundedCancelStartedAt: number | null = null;
  let inMintPhase = false;
  let slowWarnFired = false;

  // Initial phase fire so the UI immediately reflects "waiting".
  opts.onPhase({ kind: "awaiting-payment" });

  // Loop until terminal.
  while (true) {
    if (opts.signal?.aborted) {
      const result: FundingTerminal = { kind: "aborted" };
      opts.onPhase(result);
      return result;
    }

    // Read balance with defensive try/catch — transient federation
    // hiccups during polling shouldn't crash the orchestrator.
    let balance = opts.baselineMsats;
    try {
      balance = await opts.getBalance();
    } catch {
      // Ignore — next tick will retry.
    }
    const delta = balance - opts.baselineMsats;

    // Full threshold met → done.
    if (delta >= requiredDelta) {
      const result: FundingTerminal = { kind: "payment-confirmed" };
      opts.onPhase(result);
      return result;
    }

    // First evidence of inbound funds → flip to mint-confirming.
    // Balance deltas are strongest, but the SDK receive watcher can
    // report `funded` before balance credit is observable. Treat that
    // as mint-confirming too so the watchdog starts even if the mint
    // later rejects without ever moving wallet balance.
    const mintDetected = delta > 0 || Boolean(opts.mintDetected?.());
    if (mintDetected && !inMintPhase) {
      inMintPhase = true;
      mintStartedAt = now();
      opts.onPhase({ kind: "mint-confirming" });
    }

    if (inMintPhase && opts.postFundedCancelReason?.()) {
      postFundedCancelStartedAt ??= now();
    }

    // Timeout checks — evaluated AFTER the threshold check so a
    // last-tick payment that lands exactly at the deadline still
    // succeeds.
    const elapsed = now() - start;
    if (!inMintPhase && elapsed >= paymentDeadlineMs) {
      const result: FundingTerminal = { kind: "expired" };
      opts.onPhase(result);
      return result;
    }
    if (inMintPhase) {
      const mintElapsed = now() - (mintStartedAt ?? start);
      const postFundedCancelElapsed = postFundedCancelStartedAt === null
        ? null
        : now() - postFundedCancelStartedAt;
      // Soft warn — one-time UI flip so the user knows the federation
      // is slow but we're still waiting. Not a terminal.
      if (
        postFundedCancelElapsed === null &&
        !slowWarnFired &&
        mintElapsed >= mintSlowWarnMs
      ) {
        slowWarnFired = true;
        opts.onPhase({ kind: "mint-confirming-slow" });
      }
      if (
        postFundedCancelElapsed !== null &&
        postFundedCancelElapsed >= postFundedCancelGraceMs
      ) {
        const result: FundingTerminal = { kind: "mint-timeout" };
        opts.onPhase(result);
        return result;
      }
      // Hard cap — terminal.
      if (mintElapsed >= mintConfirmTimeoutMs) {
        const result: FundingTerminal = { kind: "mint-timeout" };
        opts.onPhase(result);
        return result;
      }
    }

    await sleep(pollIntervalMs);
  }
}

// ── runFundAndLock ───────────────────────────────────────────────────────

/** v0.6.5: receive-watch state, narrowed to a stable string union for
 *  this orchestrator. The full SDK state union lives in sdk-adapter;
 *  this is the public-facing shape callers (the orchestrator) work
 *  with. Mirrors LnReceiveStateKind in fedimint/sdk-adapter but
 *  redefined here to keep fund-and-lock.ts free of any Fedimint
 *  imports — it stays a pure orchestrator, testable in isolation. */
export type LnReceiveWatchKind =
  | "created"
  | "waiting_for_payment"
  | { canceled: { reason: string; diagnostic?: Record<string, unknown> } }
  | "funded"
  | "awaiting_funds"
  | "claimed";

export interface RunFundAndLockDeps {
  /** Bound to fedimint.getBalance() in the hook. */
  getBalance: () => Promise<number>;
  /** Bound to actions.createFundingInvoice in the hook. Returns BOLT11.
   *  v0.6.5: optional `onReceiveState` listener — the SDK fires the
   *  LN receive watch on every state transition (created → funded →
   *  awaiting_funds → claimed). We use this to advance the modal to
   *  mint-confirming the instant the gateway acks the HTLC, rather
   *  than waiting up to 5s for the balance poll loop to notice. */
  createFundingInvoice: (
    amountMsats: number,
    description: string,
    onReceiveState?: (kind: LnReceiveWatchKind) => void,
    /** Reports the Lightning gateway that minted the invoice. Optional so
     *  wallets that can't say (browser SDK, mock, sim) simply never call it. */
    onGateway?: (gateway: FundingGatewayInfo) => void,
  ) => Promise<string>;
  /** Optional auto-payer for generated funding invoices, e.g. NWC
   *  pay_invoice. When set, runFundAndLock still creates the Fedimint
   *  receive invoice, then asks the external wallet to pay it before
   *  entering the balance poll. */
  autoPayInvoice?: (bolt11: string) => Promise<void>;
  /** Bound to actions.lockAndPublish in the hook. */
  lockAndPublish: (escrowId: string, opts: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
  }) => Promise<unknown>;
}

export interface RunFundAndLockOpts extends RunFundAndLockDeps {
  /** Trade ID being funded. */
  escrowId: string;
  /** Trade amount in msats. */
  amountMsats: number;
  /** Description embedded in the BOLT11 invoice. Shows in the payer's
   *  Lightning wallet — keep readable. */
  description: string;
  /** Optional handle to reveal in the LOCK payload. */
  savedHandleId?: string;
  /** Optional menu basket snapshot to attach to LOCK. */
  selectedItems?: SelectedMenuItem[];
  /** Phase callback. */
  onPhase: (phase: FundAndLockPhase) => void;
  /** Caller-controlled abort. */
  signal?: AbortSignal;
  // Polling tunables (passthrough to pollForFunding).
  paymentDeadlineMs?: number;
  mintConfirmTimeoutMs?: number;
  mintSlowWarnMs?: number;
  pollIntervalMs?: number;
  postFundedCancelGraceMs?: number;
  /** v0.6.5: createFundingInvoice tunables. */
  invoiceTimeoutMs?: number;
  invoiceSlowWarnMs?: number;
  receiveWatchReadyTimeoutMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Compose createFundingInvoice → pollForFunding → lockAndPublish into
 *  one atomic flow. Resolves with the terminal phase. Never rejects.
 *
 *  Callers (the AtomicFundingModal via useEscrow) get phase events for
 *  granular UI updates; the return value is just the terminal kind for
 *  post-modal navigation. */
export async function runFundAndLock(
  opts: RunFundAndLockOpts,
): Promise<FundAndLockTerminal> {
  const emit = (p: FundAndLockPhase) => opts.onPhase(p);

  emit({ kind: "creating-invoice" });
  if (opts.signal?.aborted) {
    const result: FundAndLockTerminal = { kind: "aborted" };
    emit({ kind: "aborted" });
    return result;
  }

  // Snapshot baseline BEFORE creating the invoice. If the user already
  // had ecash from a prior failed flow, the recovery banner should have
  // gated this surface upstream — we proceed defensively, treating the
  // existing balance as baseline so the threshold check measures only
  // the new inbound payment.
  let baseline: number;
  try {
    baseline = await opts.getBalance();
  } catch (e: any) {
    const err = e?.message || "Couldn't read wallet balance";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }

  // v0.6.5: race createFundingInvoice against a hard timeout. The
  // Fedimint WASM client's gateway-lookup + invoice-create chain can
  // hang silently when the federation's WebSocket transport is broken
  // (iroh-canary relay failures in cold-start reports). Without this
  // race the modal sat forever on the tiny "GENERATING INVOICE…"
  // spinner with no QR and no error. A slow-warn at 10s gives the
  // user honest progress while we keep trying; the hard timeout at
  // 45s fails fast with a recoverable lock-failed error.
  const invoiceTimeoutMs = opts.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS;
  const invoiceSlowWarnMs = opts.invoiceSlowWarnMs ?? DEFAULT_INVOICE_SLOW_WARN_MS;
  const receiveWatchReadyTimeoutMs =
    opts.receiveWatchReadyTimeoutMs ?? DEFAULT_RECEIVE_WATCH_READY_TIMEOUT_MS;
  let slowWarnTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let receiveWatchReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let receiveWatchReady = false;
  let resolveReceiveWatchReady: (() => void) | null = null;
  let rejectReceiveWatchReady: ((error: Error) => void) | null = null;
  const receiveWatchReadyPromise = new Promise<void>((resolve, reject) => {
    resolveReceiveWatchReady = resolve;
    rejectReceiveWatchReady = reject;
  });
  const finishReceiveWatchReady = (error?: Error) => {
    if (receiveWatchReady) return;
    receiveWatchReady = true;
    if (receiveWatchReadyTimer) clearTimeout(receiveWatchReadyTimer);
    receiveWatchReadyTimer = null;
    if (error) rejectReceiveWatchReady?.(error);
    else resolveReceiveWatchReady?.();
  };
  // v0.6.5: receive-watch listener. Fires as the SDK observes the
  // LN receive operation transition states. We emit mint-confirming
  // the moment `funded` lands (gateway received the HTLC) so the
  // modal stops sitting on the QR — pollForFunding would have
  // noticed the same fact within 5s, but the watch is the lower-
  // latency signal. Deduped so re-fires (awaiting_funds, claimed
  // arriving after funded) don't spam onPhase.
  //
  // Cancellation handling is deliberately conservative. Production v0.6.4
  // let the balance poll remain the source of truth, and BLF payments could
  // still succeed even when the receive watch later reported
  // canceled:rejected. So: before the gateway reports `funded`, a cancel is
  // terminal. After `funded`, keep polling for actual balance credit during
  // a short grace window; the balance gate still decides whether we can LOCK.
  let mintConfirmingEmittedByWatch = false;
  let watchOverride: FundAndLockTerminal | null = null;
  let postFundedCancelReason: string | null = null;
  let receiveFailureDiagnostic: Record<string, unknown> | undefined;
  const watchAbort = new AbortController();
  const onReceiveState = (kind: LnReceiveWatchKind) => {
    if (typeof kind === "object" && "canceled" in kind) {
      // Already overridden — keep the first reason; subsequent
      // events from the SDK after a cancel are no-ops anyway.
      if (watchOverride) return;
      const reason = kind.canceled.reason;
      receiveFailureDiagnostic = kind.canceled.diagnostic;
      if (mintConfirmingEmittedByWatch) {
        // The gateway already saw the HTLC. Preserve the v0.6.4 race
        // protection by continuing to poll balance for a short grace
        // window, but surface the rejection immediately so the modal
        // stops implying "slow mint" is the only thing happening.
        if (!postFundedCancelReason) {
          postFundedCancelReason = reason;
          emit({ kind: "receive-rejected", reason });
        }
        return;
      }
      if (reason === "expired") {
        watchOverride = { kind: "expired" };
        emit({ kind: "expired" });
        finishReceiveWatchReady(new Error("Lightning invoice expired"));
      } else {
        const msg = receiveRejectedMessage(
          reason,
          opts,
          fundingGateway,
          receiveFailureDiagnostic,
        );
        watchOverride = { kind: "lock-failed", error: msg };
        emit({ kind: "lock-failed", error: msg });
        finishReceiveWatchReady(new Error(msg));
      }
      // Force pollForFunding to bail on its next tick. We can't
      // touch opts.signal (caller owns it); the local watchAbort is
      // chained into pollForFunding's signal below.
      watchAbort.abort();
      return;
    }
    finishReceiveWatchReady();
    if (mintConfirmingEmittedByWatch) return;
    if (kind === "funded" || kind === "awaiting_funds" || kind === "claimed") {
      mintConfirmingEmittedByWatch = true;
      emit({ kind: "mint-confirming" });
    }
  };
  let bolt11: string;
  let fundingGateway: FundingGatewayInfo | undefined;
  try {
    const slowWarnPromise = new Promise<void>((resolve) => {
      slowWarnTimer = setTimeout(() => {
        emit({ kind: "creating-invoice-slow" });
        resolve();
      }, invoiceSlowWarnMs);
    });
    void slowWarnPromise; // suppress unused-warning; emits a side-effect phase

    const timeoutPromise = new Promise<never>((_, reject) => {
      hardTimeoutTimer = setTimeout(() => {
        reject(new Error(
          "Couldn't reach the federation to generate an invoice. " +
          "The connection looks unreliable right now — try again in a moment, " +
          "or switch communities if it persists.",
        ));
      }, invoiceTimeoutMs);
    });
    bolt11 = await Promise.race([
      opts.createFundingInvoice(
        opts.amountMsats,
        opts.description,
        onReceiveState,
        (gateway) => { fundingGateway = gateway; },
      ),
      timeoutPromise,
    ]);
    if (watchOverride) return watchOverride;
    // #35 sim: the sim wallet's Lightning receive is mocked (invoices auto-settle)
    // and never fires a real receive-watch-ready signal. The watcher gate is a
    // real-money "can we detect the incoming payment" defense — meaningless in
    // sim — so resolve it immediately and let pollForFunding pick up the
    // auto-settled balance. Real mode is untouched.
    if (isSimModeOn()) finishReceiveWatchReady();
    if (!receiveWatchReady) {
      receiveWatchReadyTimer = setTimeout(() => {
        finishReceiveWatchReady(new Error(
          "Couldn't verify the Lightning receive watcher for this invoice. " +
          "Chama did not show the QR because it may not be able to detect " +
          "or recover the payment.",
        ));
      }, receiveWatchReadyTimeoutMs);
    }
    await receiveWatchReadyPromise;
    emit({ kind: "receive-watch-ready" });
  } catch (e: any) {
    const err = e?.message || "Couldn't create funding invoice";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  } finally {
    if (slowWarnTimer) clearTimeout(slowWarnTimer);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
    if (receiveWatchReadyTimer) clearTimeout(receiveWatchReadyTimer);
  }
  const expiresAt = (opts.now ?? defaultNow)() +
    (opts.paymentDeadlineMs ?? DEFAULT_PAYMENT_DEADLINE_MS);
  emit({ kind: "invoice-created", bolt11, expiresAt, gateway: fundingGateway });

  if (opts.autoPayInvoice) {
    emit({ kind: "paying-with-nwc" });
    try {
      await opts.autoPayInvoice(bolt11);
    } catch (e: any) {
      const err = e?.message || "NWC wallet could not pay the funding invoice";
      emit({ kind: "lock-failed", error: err });
      return { kind: "lock-failed", error: err };
    }
  }

  // v0.6.5: pollForFunding's signal is the OR of the caller's signal
  // and watchAbort (set when the receive watch reports a pre-funded
  // terminal cancellation).
  // Whichever fires first ends the poll loop; runFundAndLock then
  // returns either the caller-initiated `aborted` or the watch-
  // initiated terminal (lock-failed / expired) — whichever is set.
  if (opts.signal) {
    if (opts.signal.aborted) watchAbort.abort();
    else opts.signal.addEventListener(
      "abort",
      () => watchAbort.abort(),
      { once: true },
    );
  }
  const polled = await pollForFunding({
    baselineMsats: baseline,
    expectedMsats: opts.amountMsats,
    getBalance: opts.getBalance,
    onPhase: (p) => {
      // A receive-watch terminal uses watchAbort only to stop the balance
      // poll. Do not let that internal abort overwrite the richer receive
      // reason the modal already received (for example canceled:claim_rejected).
      if (p.kind === "aborted" && watchOverride) return;
      emit(p);
    },
    signal: watchAbort.signal,
    paymentDeadlineMs: opts.paymentDeadlineMs,
    mintConfirmTimeoutMs: opts.mintConfirmTimeoutMs,
    mintSlowWarnMs: opts.mintSlowWarnMs,
    pollIntervalMs: opts.pollIntervalMs,
    mintDetected: () => mintConfirmingEmittedByWatch,
    postFundedCancelReason: () => postFundedCancelReason,
    postFundedCancelGraceMs: opts.postFundedCancelGraceMs,
    sleep: opts.sleep,
    now: opts.now,
  });

  // Receive watch override takes precedence for pre-funded terminal states.
  // Post-funded cancel reports preserve the known-working balance race, but
  // only for a short grace window before becoming an explicit lock-failed.
  if (watchOverride) return watchOverride;

  if (polled.kind === "mint-timeout" && postFundedCancelReason) {
    const err = receiveRejectedMessage(
      postFundedCancelReason,
      opts,
      fundingGateway,
      receiveFailureDiagnostic,
    ) + "\n\n" +
      `Payment reached the Lightning gateway, but the federation rejected ` +
      `the mint before Chama received ecash (canceled:${postFundedCancelReason}). ` +
      "Do not pay another invoice for this trade yet. Check the sending " +
      "wallet for a failed or refunded payment. If sats later appear in " +
      "Chama, use the recovery prompt before trying again.";
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }

  if (polled.kind !== "payment-confirmed") {
    try {
      const balance = await opts.getBalance();
      if (balance > baseline) {
        recordSatsTrace({
          source: "funding",
          escrowId: opts.escrowId,
          amountMsats: opts.amountMsats,
          balanceMsats: balance,
          reason: `funding-${polled.kind}`,
        });
      }
    } catch {
      // Best-effort trace only.
    }
    return polled;
  }

  emit({ kind: "locking" });
  if (opts.signal?.aborted) {
    emit({ kind: "aborted" });
    return { kind: "aborted" };
  }

  try {
    await opts.lockAndPublish(opts.escrowId, {
      savedHandleId: opts.savedHandleId,
      selectedItems: opts.selectedItems,
    });
    emit({ kind: "locked" });
    return { kind: "locked" };
  } catch (e: any) {
    const err = e?.message || "LOCK failed";
    try {
      const balance = await opts.getBalance();
      if (balance > baseline) {
        recordSatsTrace({
          source: "funding",
          escrowId: opts.escrowId,
          amountMsats: opts.amountMsats,
          balanceMsats: balance,
          reason: "lock-failed-after-funding",
        });
      }
    } catch {
      // Best-effort trace only.
    }
    emit({ kind: "lock-failed", error: err });
    return { kind: "lock-failed", error: err };
  }
}
