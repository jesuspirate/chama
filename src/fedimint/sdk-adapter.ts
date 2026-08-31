// ══════════════════════════════════════════════════════════════════════════
// Chama — @fedimint/core SDK Adapter
// ══════════════════════════════════════════════════════════════════════════
//
// Adapts the real @fedimint/core 0.1.x FedimintWallet class to Chama's
// internal IFedimintWallet interface (defined in fedimint-client.ts).
//
// The high-level FedimintClient + EscrowFedimintBridge are written
// against IFedimintWallet. This adapter is what actually runs in the
// browser — it wraps a real WASM-backed FedimintWallet and maps its
// slightly different method shapes onto the shape our code expects.
//
// Notable API deltas handled here:
//   - mint.spendNotes returns { notes, operation_id }  → unwrap .notes
//   - mint.parseNotes returns number (msats)           → wrap as { total_amount }
//   - ln.createInvoice returns { invoice, operation_id } and must keep
//     subscribe_ln_receive alive until the receive is claimed
//   - ln.createInvoice receives an explicit SDK-vetted gateway. Unvetted
//     receive gateways can fund the HTLC and still have the claim transaction
//     rejected before ecash is minted, so we refuse to show an invoice unless
//     the wallet marks the gateway with gateway.vetted=true.
//   - ln.payInvoice also receives an explicit federation-trusted gateway.
//     Leaving outbound payment to the SDK default can pick an untrusted gateway
//     and fail after claim/redeem succeeds.
//     Some Fedi-era federations publish gateway trust in config meta
//     (`vetted_gateways`) while the SDK still reports gateway.vetted=false,
//     so we accept either signal for outbound payout only.
//   - federation.getInviteCode returns string | null   → throw if null
//   - joinFederation returns boolean                   → unwrap
//   - subscribeBalance(onSuccess, onError) => CancelFn → one-arg wrapper
//
// No change to the FedimintClient public API. Swap the factory and go.

import type { IFedimintWallet } from "./fedimint-client.js";
import type { ChamaOperationMeta } from "../payments/sats-trace.js";
import { randomId } from "../storage/random-id.js";
import { setMintLockScope } from "./mint-mutex.js";
import {
  browserLightningReceiveIsBlocked,
  consumeBrowserLightningReceiveProbe,
} from "./lightning-receive-safety.js";
import {
  readBrowserWalletRecoveryJournal,
  updateBrowserWalletRecoveryJournal,
  writeBrowserWalletRecoveryJournal,
} from "./browser-wallet-recovery-journal.js";
import { decideOrphanWipe, NO_CLIENT_OPEN_ERROR_RE, type OrphanPeek } from "./orphan-wipe-policy.js";
import {
  LN_PAY_INFLIGHT,
  LN_PAY_REFUNDED,
  LN_PAY_SUBMIT_FAILED,
  codedPayError,
  type CodedPayError,
} from "../payments/ln-pay-codes.js";

// ── Minimal structural types for the real SDK ────────────────────────────
// We define these locally so that a consumer without @fedimint/core
// installed (e.g. running unit tests) can still typecheck the file.

interface RealBalanceService {
  getBalance(): Promise<number>;
  subscribeBalance(
    onSuccess?: (balanceMsats: number) => void,
    onError?: (err: string) => void
  ): () => void;
}

interface RealMintService {
  spendNotes(
    amountMsats: number,
    tryCancelAfter?: number | { nanos: number; secs: number },
    includeInvite?: boolean,
    extraMeta?: ChamaOperationMeta,
  ): Promise<{ notes: string; operation_id: string }>;
  redeemEcash(notes: string): Promise<string>;
  reissueExternalNotes?(
    notes: string,
    extraMeta?: ChamaOperationMeta,
  ): Promise<string>;
  subscribeReissueExternalNotes?(
    operationId: string,
    onSuccess?: (state: RealReissueExternalNotesState) => void,
    onError?: (error: string) => void
  ): () => void;
  parseNotes(oobNotes: string): Promise<number>;
}

type RealReissueExternalNotesState = "Created" | "Issuing" | "Done" | string | Record<string, unknown>;

type RealLnReceiveState =
  | "created"
  | { waiting_for_payment: { invoice: string; timeout: number } }
  | { canceled: { reason: string } }
  | "funded"
  | "awaiting_funds"
  | "claimed";

type RealLnPayState =
  | "created"
  | "canceled"
  | "awaiting_change"
  | { funded: { block_height: number } }
  | { waiting_for_refund: { error_reason: string } }
  | { success: { preimage: string } }
  | { refunded: { gateway_error: string } }
  | { unexpected_error: { error_message: string } };

type RealLnInternalPayState =
  | "funding"
  | { preimage: string }
  | { refund_success: { out_points?: unknown[]; error?: string } }
  | { refund_error: { error_message?: string; error?: string } }
  | { funding_failed: { error?: string } }
  | { unexpected_error: string };

type RealGatewayInfo = {
  gateway_id?: string;
  api?: string;
  lightning_alias?: string;
  supports_private_payments?: boolean;
  [key: string]: unknown;
};

type RealLightningGateway = {
  info?: RealGatewayInfo;
  vetted?: boolean;
  ttl?: unknown;
};

type RealOutgoingLightningPayment = {
  contract_id?: string;
  operation_id?: string;
  operationId?: string;
  payment_type?: { lightning?: unknown; internal?: unknown };
  [key: string]: unknown;
};

type RealPayOperation =
  | { kind: "lightning"; operationId: string; source: string; contractId?: string }
  | { kind: "internal"; operationId: string; source: string; contractId?: string };

type RealLightningTransaction = {
  kind: "ln";
  type: "send" | "receive";
  operationId: string;
  outcome?: string;
};

type RealMintTransaction = {
  kind: "mint";
  type: "reissue" | "spend_oob";
  operationId: string;
  outcome?: string;
  amountMsats?: number;
  timestamp?: number;
};

type RealTransaction = RealLightningTransaction | RealMintTransaction | Record<string, unknown>;

/**
 * Fedimint browser WASM ultimately passes sleeps to JS setTimeout through an
 * i32 millisecond argument (`n0-future` does `duration.as_millis() as i32`).
 * A larger OOB auto-cancel horizon wraps negative and fires immediately,
 * returning the bearer notes to the sender before the receiver can redeem.
 */
export const MAX_BROWSER_OOB_TIMEOUT_SECS = Math.floor(0x7fffffff / 1000);

export function assertBrowserSafeOobTimeoutSecs(seconds: number): number {
  const normalized = Math.floor(seconds);
  if (!Number.isFinite(seconds) || normalized <= 0) {
    throw new Error("Fedimint OOB spend timeout must be a positive number of seconds");
  }
  if (normalized > MAX_BROWSER_OOB_TIMEOUT_SECS) {
    throw new Error(
      `Fedimint OOB spend timeout ${normalized}s exceeds the browser WASM timer ceiling ` +
        `(${MAX_BROWSER_OOB_TIMEOUT_SECS}s); refusing to create notes that would refund immediately`,
    );
  }
  return normalized;
}

/** V7 reconcile-by-escrow scan window (newest-first). A payment being
 *  reconciled was dispatched around its journal record's lifetime, so it
 *  sits among the newest ops; a sub-limit page proves the scan saw
 *  EVERYTHING (⇒ "none" is trustworthy). */
const PAY_RECONCILE_SCAN_LIMIT = 200;

interface RealLightningService {
  createInvoice(
    amountMsats: number,
    description: string,
    expiryTime?: number,
    gatewayInfo?: RealGatewayInfo,
    extraMeta?: ChamaOperationMeta,
  ): Promise<{ invoice: string; operation_id: string }>;
  payInvoice(
    invoice: string,
    gatewayInfo?: RealGatewayInfo,
    extraMeta?: ChamaOperationMeta,
  ): Promise<RealOutgoingLightningPayment | unknown>;
  payInvoiceSync?(
    invoice: string,
    timeoutMs?: number,
    gatewayInfo?: RealGatewayInfo
  ): Promise<unknown>;
  subscribeLnPay?(
    operationId: string,
    onSuccess?: (state: RealLnPayState) => void,
    onError?: (error: string) => void
  ): () => void;
  subscribeInternalPayment?(
    operationId: string,
    onSuccess?: (state: RealLnInternalPayState) => void,
    onError?: (error: string) => void
  ): () => void;
  subscribeLnReceive(
    operationId: string,
    onSuccess?: (state: RealLnReceiveState) => void,
    onError?: (error: string) => void
  ): () => void;
  updateGatewayCache?(): Promise<unknown>;
  listGateways?(): Promise<RealLightningGateway[]>;
  getAvailableGateway?(args?: {
    gateway?: RealGatewayInfo;
    invoice?: string;
  }): Promise<RealGatewayInfo | null>;
}

interface RealFederationService {
  getConfig?(): Promise<unknown>;
  getMetaConsensusValue?(key?: number): Promise<unknown | null>;
  getFederationId(): Promise<string>;
  getInviteCode(peer?: number): Promise<string | null>;
  getOperation?(operationId: string): Promise<unknown | null>;
  listTransactions?(limit?: number): Promise<RealTransaction[]>;
  [key: string]: unknown;
}

interface RealRecoveryService {
  hasPendingRecoveries(): Promise<boolean>;
  waitForAllRecoveries(): Promise<void>;
}

export interface RealFedimintWallet {
  balance: RealBalanceService;
  mint: RealMintService;
  lightning: RealLightningService;
  federation: RealFederationService;
  recovery: RealRecoveryService;
  open(clientName?: string): Promise<boolean>;
  joinFederation(
    inviteCode: string,
    clientNameOrOptions?: string | {
      clientName?: string;
      forceRecover?: boolean;
    },
  ): Promise<boolean>;
  cleanup(): Promise<void>;
  isOpen(): boolean;
}

// ══════════════════════════════════════════════════════════════════════════
// ADAPTER
// ══════════════════════════════════════════════════════════════════════════

const RECEIVE_WATCH_TIMEOUT_MS = 16 * 60 * 1000;
const PAY_WATCH_TIMEOUT_MS = 60 * 1000;
// Re-attach watch (3.5.1 double-pay guard): when a payout's first watch
// window expired with the HTLC still in flight, the claim orchestrator
// re-attaches to the SAME operationId to learn the true outcome instead of
// ever paying again. Give settlement a long, patient window here — this is a
// background confirm, not a user-facing spinner.
const REATTACH_PAY_WATCH_TIMEOUT_MS = 8 * 60 * 1000;
const REISSUE_WATCH_TIMEOUT_MS = 90 * 1000;
// v1.2.2 claim-hang fix: submitting `reissueExternalNotes` to the WASM
// mint module can silently hang when the federation is unreachable
// mid-RPC — the wasm-side state machine waits forever for a guardian
// reply and the JS Promise never resolves nor rejects. waitForMintReissue
// has its own 90 s subscription timeout, but only if we got an
// operationId first. We never did, so the modal sat on "RECOVERING
// YOUR SHARE…" indefinitely. Bound the submit step so a stuck submit
// surfaces as a transient error and falls into the redeemWithRetry
// retry loop (which the federation will deduplicate via
// resumeMintReissueFromHistory if the WASM call eventually lands).
const REISSUE_SUBMIT_TIMEOUT_MS = 30 * 1000;

/** Clock slop allowed when deciding whether a mint-reissue transaction belongs
 *  to the redeem attempt currently in flight. The federation stamps the record,
 *  so its clock and ours can differ; this is generous enough to absorb that and
 *  a slow submit, and far too short to reach back to a previous trade. */
const MINT_REISSUE_HISTORY_SKEW_MS = 2 * 60 * 1000;

const CURATED_LIGHTNING_GATEWAY_TRUST: Record<string, string[]> = {
  // Bitcoin Life Federation. The guardian admin UI exposes this gateway in
  // Manage Meta as `vetted_gateways`, but older browser SDK paths do not expose
  // that admin metadata to wallet clients. Keep this list tiny and
  // federation-scoped: it mirrors the guardian-published trust signal, it does
  // not make Chama trust every public gateway.
  "888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e": [
    "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4",
  ],
};

// Keep a paid receive failure attached to the federation, not the selected
// gateway. A separate wallet-lifecycle repair is not evidence that this route
// is safe again, so upgrades deliberately preserve the existing pause.
const RECEIVE_ROUTE_QUARANTINE_KEY = "chama_ln_receive_route_quarantine_v3";
const RECEIVE_ROUTE_QUARANTINE_MS = 6 * 60 * 60 * 1000;
export const BROWSER_WALLET_RECOVERY_REQUIRED_CODE =
  "BROWSER_WALLET_RECOVERY_REQUIRED";
const BROWSER_WALLET_RECOVERY_PERSIST_FAILED_CODE =
  "BROWSER_WALLET_RECOVERY_PERSIST_FAILED";
const BROWSER_WALLET_RECOVERY_REQUEST_PREFIX =
  "chama_fedimint_recovery_request_v1:";

type ReceiveRouteQuarantine = {
  federationId: string;
  reason: string;
  operationId: string;
  until: number;
};

type BrowserWalletRecoveryRequest = {
  operationId: string;
  federationId: string;
  requestedAt: number;
  trigger?: "operation-proof" | "explicit-diagnostic" | "mint-reissue-failed";
};

function browserWalletRecoveryRequestKey(storageScope?: string | null): string {
  return `${BROWSER_WALLET_RECOVERY_REQUEST_PREFIX}${storageScope || "legacy"}`;
}

function requestBrowserWalletRecovery(
  storageScope: string | null | undefined,
  request: BrowserWalletRecoveryRequest,
): boolean {
  try {
    globalThis.localStorage?.setItem(
      browserWalletRecoveryRequestKey(storageScope),
      JSON.stringify(request),
    );
    return globalThis.localStorage?.getItem(
      browserWalletRecoveryRequestKey(storageScope),
    ) !== null;
  } catch {
    // The receive route remains blocked. Without durable storage Chama cannot
    // safely rotate this wallet automatically, so initialization must fail.
    return false;
  }
}

function consumeBrowserWalletRecoveryRequest(
  storageScope?: string | null,
): BrowserWalletRecoveryRequest | null {
  try {
    const key = browserWalletRecoveryRequestKey(storageScope);
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BrowserWalletRecoveryRequest>;
    if (
      typeof parsed.operationId !== "string" ||
      typeof parsed.federationId !== "string" ||
      typeof parsed.requestedAt !== "number"
    ) return null;
    globalThis.localStorage?.removeItem(key);
    return parsed as BrowserWalletRecoveryRequest;
  } catch {
    return null;
  }
}

function readReceiveRouteQuarantines(
  now = Date.now(),
  includeExpired = false,
): ReceiveRouteQuarantine[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECEIVE_ROUTE_QUARANTINE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ReceiveRouteQuarantine =>
      !!entry && typeof entry === "object" &&
      typeof entry.federationId === "string" &&
      typeof entry.reason === "string" &&
      typeof entry.operationId === "string" &&
      typeof entry.until === "number" && (includeExpired || entry.until > now),
    );
  } catch {
    return [];
  }
}

function writeReceiveRouteQuarantines(entries: ReceiveRouteQuarantine[]): void {
  try {
    globalThis.localStorage?.setItem(RECEIVE_ROUTE_QUARANTINE_KEY, JSON.stringify(entries));
  } catch {
    // Safety still comes from the current terminal flow; persistence is a
    // best-effort guard against repeating it on the next invoice.
  }
}

async function quarantinedReceiveRoute(
  real: RealFedimintWallet,
): Promise<ReceiveRouteQuarantine | null> {
  try {
    const federationId = normalizeFederationId(await real.federation.getFederationId());
    if (!federationId) return null;
    return readReceiveRouteQuarantines().find((entry) =>
      entry.federationId === federationId
    ) ?? null;
  } catch {
    return null;
  }
}

async function quarantineReceiveRoute(
  real: RealFedimintWallet,
  operationId: string,
  reason: string,
): Promise<void> {
  if (reason !== "claim_rejected") return;
  try {
    const federationId = normalizeFederationId(await real.federation.getFederationId());
    if (!federationId) return;
    const now = Date.now();
    // Keep expired failures as a recovery ledger. Expiry ends only the
    // temporary receive-route pause; it must not erase the operation id that
    // lets the owning identity prove and repair its rejected mint claim.
    const next = readReceiveRouteQuarantines(now, true).filter((entry) =>
      entry.federationId !== federationId,
    );
    next.push({
      federationId,
      reason,
      operationId,
      until: now + RECEIVE_ROUTE_QUARANTINE_MS,
    });
    writeReceiveRouteQuarantines(next);
    console.warn(
      `[chama] LN receive route paused for 6h after ${reason}: federation=${federationId}`,
    );
  } catch (error) {
    console.debug("[chama] Could not persist receive route pause:", error);
  }
}

/**
 * Development-only field verifier. The caller is already signed in as the
 * wallet being repaired and explicitly selects that identity by loading the
 * diagnostic URL. Unlike the automatic path, this does not infer identity
 * ownership from an origin-wide failure record.
 */
export function armBrowserWalletRecoveryForDiagnostics(
  storageScope: string,
): BrowserWalletRecoveryRequest {
  const incident = readReceiveRouteQuarantines(Date.now(), true)
    .filter((entry) => entry.reason === "claim_rejected")
    .sort((a, b) => b.until - a.until)[0];
  if (!incident) {
    throw new Error("No rejected browser receive is recorded on this origin");
  }
  const request: BrowserWalletRecoveryRequest = {
    operationId: incident.operationId,
    federationId: incident.federationId,
    requestedAt: Date.now(),
    trigger: "explicit-diagnostic",
  };
  if (!requestBrowserWalletRecovery(storageScope, request)) {
    throw new Error("The browser refused to persist the wallet recovery request");
  }
  if (!writeBrowserWalletRecoveryJournal(storageScope, {
    version: 1,
    stage: "requested",
    operationId: request.operationId,
    federationId: request.federationId,
    trigger: "explicit-diagnostic",
    requestedAt: request.requestedAt,
    updatedAt: Date.now(),
  })) {
    throw new Error("The browser refused to persist the wallet recovery receipt");
  }
  return request;
}

function isReceiveTerminal(state: RealLnReceiveState): boolean {
  return state === "claimed" ||
    (typeof state === "object" && state !== null && "canceled" in state);
}

function formatReceiveState(state: RealLnReceiveState): string {
  if (typeof state === "string") return state;
  if ("canceled" in state) return `canceled:${state.canceled.reason}`;
  return Object.keys(state)[0] ?? "unknown";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function summarizeReceiveOutcome(outcome: unknown): unknown {
  if (typeof outcome === "string") return outcome;
  const record = recordOf(outcome);
  if (!record) return typeof outcome;
  if ("canceled" in record) {
    const canceled = recordOf(record.canceled);
    return {
      canceled: {
        reason: typeof canceled?.reason === "string" ? canceled.reason : null,
      },
    };
  }
  return { keys: Object.keys(record).sort() };
}

function summarizeReceiveOperationLog(log: unknown): Record<string, unknown> {
  const operation = recordOf(log);
  const meta = recordOf(operation?.meta);
  const variant = recordOf(meta?.variant);
  const receive = recordOf(variant?.receive);
  const pay = recordOf(variant?.pay);
  const outPoint = recordOf(receive?.out_point);
  const outcomeBox = recordOf(operation?.outcome);
  const invoice = typeof receive?.invoice === "string"
    ? receive.invoice
    : typeof pay?.invoice === "string"
      ? pay.invoice
      : null;

  return {
    present: !!operation,
    module: typeof operation?.operation_module_kind === "string"
      ? operation.operation_module_kind
      : null,
    amountMsats: typeof meta?.amount === "number" ? meta.amount : null,
    variant: receive ? "receive" : pay ? "pay" : null,
    gatewayId: typeof receive?.gateway_id === "string"
      ? receive.gateway_id
      : typeof pay?.gateway_id === "string"
        ? pay.gateway_id
        : null,
    txid: typeof outPoint?.txid === "string" ? outPoint.txid : null,
    outIdx: typeof outPoint?.out_idx === "number" ? outPoint.out_idx : null,
    invoicePrefix: invoice ? invoice.slice(0, 24) : null,
    invoiceLen: invoice ? invoice.length : null,
    outcome: summarizeReceiveOutcome(outcomeBox?.outcome),
    extraMetaKeys: recordOf(meta?.extra_meta)
      ? Object.keys(recordOf(meta?.extra_meta)!).sort()
      : [],
  };
}

async function traceReceiveOperation(
  real: RealFedimintWallet,
  operationId: string,
  checkpoint: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const getOperation = real.federation.getOperation;
  if (typeof getOperation !== "function") {
    console.info(
      `[chama] LN receive trace ${operationId} ${checkpoint}: getOperation unavailable`,
      extra,
    );
    return;
  }

  try {
    const log = await getOperation.call(real.federation, operationId);
    console.info(
      `[chama] LN receive trace ${operationId} ${checkpoint}`,
      {
        ...extra,
        operation: summarizeReceiveOperationLog(log),
      },
    );
  } catch (e) {
    console.warn(
      `[chama] LN receive trace ${operationId} ${checkpoint}: getOperation failed`,
      e,
    );
  }
}

async function buildReceiveFailureDiagnostic(
  real: RealFedimintWallet,
  operationId: string,
  reason: string,
  gateway?: RealGatewayInfo,
): Promise<Record<string, unknown>> {
  let federationId: string | null = null;
  let operation: Record<string, unknown> = { present: false };
  try {
    federationId = normalizeFederationId(await real.federation.getFederationId()) || null;
  } catch {
    // The operation evidence below remains useful without the federation id.
  }
  try {
    const getOperation = real.federation.getOperation;
    if (typeof getOperation === "function") {
      operation = summarizeReceiveOperationLog(
        await getOperation.call(real.federation, operationId),
      );
    }
  } catch (error) {
    operation = { present: false, readError: String(error) };
  }
  return {
    issue: "lightning_receive_rejected",
    reason,
    meaning: reason === "claim_rejected"
      ? "The incoming contract funded; the receiver claim transaction was rejected by the federation."
      : null,
    federationId,
    operationId,
    gateway: gateway?.gateway_id
      ? {
          id: gateway.gateway_id,
          alias: gateway.lightning_alias ?? null,
          api: gateway.api ?? null,
        }
      : null,
    operation,
    sdkPackages: FEDIMINT_SDK_DIAGNOSTICS,
    payerPath:
      "The receive wallet cannot determine whether the payer used Fedimint's internal-payment path. The sender operation is required to prove that. A gateway id here identifies invoice context; it does not prove the gateway caused this rejection.",
  };
}

/**
 * v0.6.5: public-facing classification of the SDK's LN receive state.
 * Exposed (re-exported via fedimint-client) so the orchestrator can
 * pattern-match without needing the raw `RealLnReceiveState` union
 * (which carries gateway-internal detail). The progression for a
 * normal payment is:
 *
 *   created
 *     → waiting_for_payment       (QR is up, no payment yet)
 *     → funded                    (gateway received the HTLC)
 *     → awaiting_funds            (federation mint protocol running)
 *     → claimed                   (federation credited the wallet)
 *
 * The classifier is intentionally simple: hand the orchestrator a
 * stable enum string and let it decide what UI to drive.
 */
export type LnReceiveStateKind =
  | "created"
  | "waiting_for_payment"
  | { canceled: { reason: string; diagnostic?: Record<string, unknown> } }
  | "funded"
  | "awaiting_funds"
  | "claimed";

function classifyReceiveState(state: RealLnReceiveState): LnReceiveStateKind {
  if (typeof state === "string") return state;
  // v0.6.5: preserve the cancel reason so the orchestrator can
  // surface federation-side rejections immediately (canceled:rejected)
  // and distinguish invoice expiry (canceled:expired) from gateway
  // rejection. Without the reason every cancel collapsed to a
  // generic "canceled" and the modal had no way to render an
  // accurate error.
  if ("canceled" in state) {
    return { canceled: { reason: state.canceled.reason } };
  }
  if ("waiting_for_payment" in state) return "waiting_for_payment";
  // Defensive default — any unknown object shape gets bucketed as
  // claimed terminal so the orchestrator doesn't hang waiting.
  return "claimed";
}

function formatPayState(state: RealLnPayState): string {
  if (typeof state === "string") return state;
  if ("waiting_for_refund" in state) {
    return `waiting_for_refund:${state.waiting_for_refund.error_reason}`;
  }
  if ("refunded" in state) return `refunded:${state.refunded.gateway_error}`;
  if ("unexpected_error" in state) {
    return `unexpected_error:${state.unexpected_error.error_message}`;
  }
  return Object.keys(state)[0] ?? "unknown";
}

// ── 3.5.1 payout double-pay guard: outcome classification ──────────────────
// These codes ride on the Error thrown by payInvoice so the claim
// orchestrator can tell "submitted, outcome UNKNOWN" (refuse re-pay, re-attach
// to the operationId) from "definitely failed" (safe to retry with a fresh
// invoice). See payments/payout-journal.ts and payments/claim-and-payout.ts.
//
// Bias: unknown ⇒ INFLIGHT. Only a CONFIRMED refund/cancel — the sats
// demonstrably came back — is classified REFUNDED (retry-safe).
// The LN-pay outcome codes + `codedPayError`/`CodedPayError` now live in the
// dependency-free `../payments/ln-pay-codes.js` so the native bridge adapter can
// reuse the exact same contract. Re-exported here for existing importers.
export { LN_PAY_INFLIGHT, LN_PAY_REFUNDED, LN_PAY_SUBMIT_FAILED, codedPayError };
export type { CodedPayError };

/** Classify a terminal LN-pay state into a coded error, or null when the
 *  state is non-terminal (keep watching). CONFIRMED refunded/canceled ⇒
 *  REFUNDED; ambiguous (unexpected_error) ⇒ INFLIGHT (unknown ⇒ refuse). */
function payStateCodedError(
  state: RealLnPayState,
  operationId: string,
): CodedPayError | null {
  if (state === "canceled") {
    return codedPayError("Lightning payment canceled", LN_PAY_REFUNDED, operationId);
  }
  if (typeof state !== "object" || state === null) return null;
  if ("refunded" in state) {
    return codedPayError(
      state.refunded.gateway_error || "Lightning payment refunded",
      LN_PAY_REFUNDED,
      operationId,
    );
  }
  if ("unexpected_error" in state) {
    return codedPayError(
      state.unexpected_error.error_message || "Lightning payment outcome unconfirmed",
      LN_PAY_INFLIGHT,
      operationId,
    );
  }
  return null;
}

// ── R3-1b: operation-log settlement check ──────────────────────────────────
// subscribeLnPay does not reliably RE-EMIT a terminal state when we re-attach
// to an already-settled payout after the fact, so the refund payout could land
// (sats in wallet) while the re-attach watch timed out to "unknown" — leaving
// the trade stuck on CLAIMED on both sides. The operation LOG (getOperation)
// persists the terminal outcome, so it's the reliable signal for a re-attach.

/** Classify a Lightning-pay operation's terminal outcome value (from the
 *  operation log) into settled / refunded / pending / unknown. Mirrors
 *  RealLnPayState but tolerant of string-or-object shapes across SDK builds. */
export function classifyPayOutcome(outcome: unknown): "settled" | "refunded" | "pending" | "unknown" {
  if (outcome == null) return "pending";
  if (typeof outcome === "string") {
    if (outcome === "success") return "settled";
    if (outcome === "canceled" || outcome === "refunded") return "refunded";
    return "pending"; // created / funded / awaiting_change / …
  }
  const rec = recordOf(outcome);
  if (!rec) return "unknown";
  if ("success" in rec || "preimage" in rec) return "settled";
  if ("refunded" in rec || "canceled" in rec) return "refunded";
  if ("funded" in rec || "waiting_for_refund" in rec || "awaiting_change" in rec) return "pending";
  return "unknown";
}

/** Read a pay operation's terminal outcome from the operation log. Returns
 *  "unknown" when the log is unavailable so callers fall back to the stream. */
async function getPayOperationOutcome(
  real: RealFedimintWallet,
  operationId: string,
): Promise<"settled" | "refunded" | "pending" | "unknown"> {
  const getOperation = real.federation.getOperation;
  if (typeof getOperation !== "function") return "unknown";
  try {
    const log = await getOperation.call(real.federation, operationId);
    const operation = recordOf(log);
    const outcomeBox = recordOf(operation?.outcome);
    // Fedimint wraps the terminal state as operation.outcome.outcome; fall
    // back to operation.outcome itself for adapters that flatten it.
    const outcome = outcomeBox && "outcome" in outcomeBox
      ? outcomeBox.outcome
      : (outcomeBox ?? operation?.outcome);
    return classifyPayOutcome(outcome);
  } catch (e) {
    console.debug(`[chama] LN pay ${operationId}: getPayOperationOutcome failed`, e);
    return "unknown";
  }
}

function formatInternalPayState(state: RealLnInternalPayState): string {
  if (typeof state === "string") return state;
  if ("preimage" in state) return "preimage";
  if ("refund_success" in state) {
    return `refund_success:${state.refund_success.error ?? ""}`;
  }
  if ("refund_error" in state) {
    return `refund_error:${state.refund_error.error_message ?? state.refund_error.error ?? ""}`;
  }
  if ("funding_failed" in state) {
    return `funding_failed:${state.funding_failed.error ?? ""}`;
  }
  if ("unexpected_error" in state) return `unexpected_error:${state.unexpected_error}`;
  return Object.keys(state)[0] ?? "unknown";
}

function internalPayStateError(state: RealLnInternalPayState): Error | null {
  if (typeof state !== "object" || state === null) return null;
  if ("refund_error" in state) {
    return new Error(
      state.refund_error.error_message ||
        state.refund_error.error ||
        "Internal Lightning payment refund failed",
    );
  }
  if ("funding_failed" in state) {
    return new Error(state.funding_failed.error || "Internal Lightning payment funding failed");
  }
  if ("unexpected_error" in state) {
    return new Error(state.unexpected_error || "Internal Lightning payment failed");
  }
  return null;
}

function isInternalPaySuccess(state: RealLnInternalPayState): boolean {
  return typeof state === "object" && state !== null && "preimage" in state;
}

function extractPaymentTypeOperation(
  paymentType: unknown,
): Pick<RealPayOperation, "kind" | "operationId" | "source"> | null {
  if (!paymentType || typeof paymentType !== "object") return null;
  const record = paymentType as Record<string, unknown>;
  if (typeof record.lightning === "string") {
    return {
      kind: "lightning",
      operationId: record.lightning,
      source: "payment_type.lightning",
    };
  }
  if (typeof record.internal === "string") {
    return {
      kind: "internal",
      operationId: record.internal,
      source: "payment_type.internal",
    };
  }
  return null;
}

function extractPayOperation(result: unknown): RealPayOperation | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const contractId = typeof record.contract_id === "string"
    ? record.contract_id
    : undefined;
  const paymentTypeOperation = extractPaymentTypeOperation(record.payment_type);
  if (paymentTypeOperation) return { ...paymentTypeOperation, contractId };

  const explicitOperationId = record.operation_id ?? record.operationId;
  if (typeof explicitOperationId === "string") {
    return {
      kind: "lightning",
      operationId: explicitOperationId,
      source: "operation_id",
      contractId,
    };
  }

  if (contractId) {
    return {
      kind: "lightning",
      operationId: contractId,
      source: "contract_id",
      contractId,
    };
  }
  return null;
}

function summarizePaySubmitResult(result: unknown): string {
  if (result === null) return "null";
  if (result === undefined) return "undefined";
  if (typeof result !== "object") return `${typeof result}:${String(result).slice(0, 120)}`;
  try {
    const record = result as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const operation = extractPayOperation(record);
    const fee = record.fee ?? record.fee_msats ?? record.feeMsats;
    return JSON.stringify({
      keys,
      operationId: operation?.operationId,
      operationKind: operation?.kind,
      operationSource: operation?.source,
      contractId: record.contract_id,
      fee,
      payment_type: record.payment_type,
    }).slice(0, 400);
  } catch {
    return "[unserializable pay result]";
  }
}

function shouldResumeReceive(tx: RealLightningTransaction): boolean {
  if (tx.kind !== "ln" || tx.type !== "receive" || !tx.operationId) return false;
  return tx.outcome !== "claimed" &&
    tx.outcome !== "canceled" &&
    tx.outcome !== "unexpected_error";
}

function isMintReissueTransaction(tx: RealTransaction): tx is RealMintTransaction {
  const record = recordOf(tx);
  return record?.kind === "mint" &&
    record.type === "reissue" &&
    typeof record.operationId === "string";
}

function shouldResumeMintReissue(tx: RealMintTransaction): boolean {
  return !isMintReissueDoneOutcome(tx.outcome) &&
    !isMintReissueFailedOutcome(tx.outcome);
}

function normalizeMsats(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAlreadyReissuedError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("already reissued") ||
    msg.includes("already spent") ||
    msg.includes("already redeemed") ||
    msg.includes("already used") ||
    msg.includes("double spend") ||
    msg.includes("double-spend") ||
    msg.includes("note already");
}

function compactJson(value: unknown, max = 360): string {
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function hasVariant(value: unknown, terms: string[]): boolean {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    return terms.some((term) => lower.includes(term));
  }
  const record = recordOf(value);
  if (!record) return false;
  for (const [key, nested] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    if (terms.some((term) => lowerKey.includes(term))) return true;
    if (typeof nested === "string") {
      const lowerNested = nested.toLowerCase();
      if (terms.some((term) => lowerNested.includes(term))) return true;
    }
  }
  return false;
}

function formatMintReissueState(state: RealReissueExternalNotesState): string {
  if (typeof state === "string") return state;
  const record = recordOf(state);
  if (!record) return String(state);
  const [key, value] = Object.entries(record)[0] ?? ["object", state];
  return `${key}:${compactJson(value)}`;
}

function isMintReissueDoneOutcome(outcome: unknown): boolean {
  return hasVariant(outcome, ["done", "success", "succeeded"]);
}

function isMintReissueFailedOutcome(outcome: unknown): boolean {
  return hasVariant(outcome, [
    "fail",
    "error",
    "canceled",
    "cancelled",
    "rejected",
    "unexpected",
  ]);
}

function isMintReissueDoneState(state: RealReissueExternalNotesState): boolean {
  return isMintReissueDoneOutcome(state);
}

function isMintReissueFailedState(state: RealReissueExternalNotesState): boolean {
  return isMintReissueFailedOutcome(state);
}

function mintReissueFailedError(tx: RealMintTransaction): Error {
  const err: any = new Error(
    `Mint reissue operation failed after federation consumed the notes (${summarizeMintReissueTx(tx)})`
  );
  err.code = "MINT_REISSUE_FAILED";
  err.operationId = tx.operationId;
  err.outcome = tx.outcome;
  return err;
}

function summarizeMintReissueTx(tx: RealMintTransaction): string {
  return [
    tx.operationId.slice(0, 16),
    `amount=${tx.amountMsats ?? "unknown"}`,
    `outcome=${tx.outcome ?? "unknown"}`,
    `ts=${tx.timestamp ?? "unknown"}`,
  ].join(" ");
}

function normalizeGatewayId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{66}$/.test(normalized) ? normalized : null;
}

function normalizeFederationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function addGatewayIds(value: unknown, out: Set<string>): void {
  addGatewayIdsInner(value, out, 0);
}

function addGatewayIdsInner(value: unknown, out: Set<string>, depth: number): void {
  if (!value || depth > 6) return;
  if (Array.isArray(value)) {
    const decoded = parseByteArrayEncodedJson(value);
    if (decoded !== null) {
      addGatewayIdsInner(decoded, out, depth + 1);
      return;
    }
    for (const item of value) {
      const id = normalizeGatewayId(item);
      if (id) out.add(id);
      else addGatewayIdsInner(item, out, depth + 1);
    }
    return;
  }

  if (typeof value === "string") {
    const direct = normalizeGatewayId(value);
    if (direct) {
      out.add(direct);
      return;
    }
    try {
      addGatewayIdsInner(JSON.parse(value), out, depth + 1);
    } catch {}
    const decoded = parseHexEncodedJson(value);
    if (decoded !== null) addGatewayIdsInner(decoded, out, depth + 1);
    return;
  }

  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      addGatewayIdsInner(child, out, depth + 1);
    }
  }
}

function parseByteArrayEncodedJson(value: unknown[]): unknown | null {
  if (
    value.length === 0 ||
    !value.every((byte) =>
      typeof byte === "number" &&
      Number.isInteger(byte) &&
      byte >= 0 &&
      byte <= 255
    )
  ) {
    return null;
  }
  const bytes = new Uint8Array(value as number[]);
  if (bytes[0] !== 0x7b && bytes[0] !== 0x5b) return null;
  try {
    const decoded = new TextDecoder().decode(bytes).trim();
    if (!decoded.startsWith("{") && !decoded.startsWith("[")) return null;
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isVettedGatewaysKey(value: unknown): boolean {
  return typeof value === "string" &&
    (value.trim() === "vetted_gateways" || value.trim() === "vettedGateways");
}

function parseHexEncodedJson(value: string): unknown | null {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  // MetaValue serializes as bytes on some SDK paths. JSON objects/arrays begin
  // with "{" / "[" (0x7b / 0x5b), so avoid treating ordinary gateway ids as
  // encoded meta.
  if (!hex.startsWith("7b") && !hex.startsWith("5b")) return null;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const decoded = new TextDecoder().decode(bytes).trim();
    if (!decoded.startsWith("{") && !decoded.startsWith("[")) return null;
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function collectVettedGatewayIds(value: unknown, out: Set<string>, depth = 0): void {
  if (!value || depth > 8) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectVettedGatewayIds(JSON.parse(trimmed), out, depth + 1);
      } catch {}
    }
    const decoded = parseHexEncodedJson(trimmed);
    if (decoded !== null) collectVettedGatewayIds(decoded, out, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    const decoded = parseByteArrayEncodedJson(value);
    if (decoded !== null) {
      collectVettedGatewayIds(decoded, out, depth + 1);
      return;
    }
    if (value.length >= 2 && isVettedGatewaysKey(value[0])) {
      addGatewayIds(value[1], out);
    }
    for (const item of value) collectVettedGatewayIds(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const metaKey = record.key ?? record.name ?? record.field ??
    record.meta_key ?? record.metaKey;
  if (isVettedGatewaysKey(metaKey)) {
    addGatewayIds(
      record.value ?? record.values ?? record.meta_value ??
        record.metaValue ?? record.content ?? record.data,
      out,
    );
  }

  for (const [key, child] of Object.entries(record)) {
    if (isVettedGatewaysKey(key)) addGatewayIds(child, out);
    collectVettedGatewayIds(child, out, depth + 1);
  }
}

function configHasModuleKind(value: unknown, moduleKind: string, depth = 0): boolean {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) {
    return value.some((item) => configHasModuleKind(item, moduleKind, depth + 1));
  }
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (
    record.kind === moduleKind ||
    record.module_kind === moduleKind ||
    record.moduleKind === moduleKind
  ) {
    return true;
  }
  return Object.values(record).some((child) =>
    configHasModuleKind(child, moduleKind, depth + 1)
  );
}

function moduleKindOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind ?? record.module_kind ?? record.moduleKind;
  return typeof kind === "string" ? kind : null;
}

function addModuleRef(value: unknown, out: Set<string>): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    out.add(String(value));
    return;
  }
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) out.add(trimmed);
}

function collectModuleRefs(
  value: unknown,
  moduleKind: string,
  out: Set<string>,
  depth = 0,
): void {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectModuleRefs(item, moduleKind, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (moduleKindOf(record) === moduleKind) {
    addModuleRef(
      record.id ?? record.module_id ?? record.moduleId ??
        record.instance_id ?? record.instanceId,
      out,
    );
  }

  for (const [key, child] of Object.entries(record)) {
    if (moduleKindOf(child) === moduleKind) addModuleRef(key, out);
    collectModuleRefs(child, moduleKind, out, depth + 1);
  }
}

type LowLevelRpcClient = {
  rpcSingle<Response = unknown>(
    module: string,
    method: string,
    body: unknown,
    clientName: string,
  ): Promise<Response>;
};

// Fedimint's meta module stores the full Manage Meta JSON object under
// DEFAULT_META_KEY = MetaKey(0). Fields like `vetted_gateways` live inside
// that JSON value; they are not themselves meta-module keys.
const META_DEFAULT_KEY = 0;
const FEDIMINT_SDK_DIAGNOSTICS = {
  "@fedimint/core": "0.0.0-canary-c65cc1396f26b1b6593c3fae6ac0e820d96a4a10",
  "@fedimint/transport-web": "0.0.0-canary-c65cc1396f26b1b6593c3fae6ac0e820d96a4a10",
  "@fedimint/fedimint-client-wasm-bundler": "0.0.0-canary-c65cc1396f26b1b6593c3fae6ac0e820d96a4a10",
};

type GatewayTrustProbeSummary = {
  purpose: "receive" | "pay";
  configContainsMetaModule: boolean;
  metaModuleRefs: string[];
  metaRpcFailures: string[];
  metaVettedGatewayIds: string[];
  curatedGatewayIds: string[];
  curatedFallbackAllowed: boolean;
  curatedFallbackApplied: boolean;
};

function summarizeMetaProbeResult(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return value.length > 64 ? `${value.slice(0, 64)}...` : value;
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).join(",");
    const inner = record.value;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return `object(${keys}; valueKeys=${Object.keys(inner as Record<string, unknown>).join(",")})`;
    }
    if (Array.isArray(inner)) {
      return `object(${keys}; value=array(${inner.length}))`;
    }
    if (typeof inner === "string") {
      return `object(${keys}; value=${inner.length > 48 ? `${inner.slice(0, 48)}...` : inner})`;
    }
    return `object(${keys})`;
  }
  return typeof value;
}

function summarizeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { message?: unknown }).message === "string"
  ) {
    return (value as { message: string }).message;
  }
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value);
  }
}

function isFederationTransactionTooLarge(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("generated transaction") &&
    normalized.includes("rejected by the federation") &&
    normalized.includes("too large");
}

function normalizePaySubmitError(value: unknown): Error {
  const message = summarizeError(value) || "Lightning payment failed";
  if (isFederationTransactionTooLarge(message)) {
    const error = new Error(
      "Federation rejected this payout transaction as too large before Lightning submit. " +
      "Your sats are still in your Chama; retry recovery in a moment.",
    );
    (error as Error & { rawMessage?: string }).rawMessage = message;
    return error;
  }
  return value instanceof Error ? value : new Error(message);
}

function getLowLevelRpc(real: RealFedimintWallet): {
  client: LowLevelRpcClient;
  clientName: string;
} | null {
  const federation = real.federation as Record<string, unknown>;
  const wallet = real as unknown as Record<string, unknown>;
  const client = federation.client ?? federation._client ?? wallet._client;
  const clientName = federation.clientName ?? federation._clientName ?? wallet._clientName;
  if (!client || typeof (client as LowLevelRpcClient).rpcSingle !== "function") {
    return null;
  }
  return {
    client: client as LowLevelRpcClient,
    clientName: typeof clientName === "string"
      ? clientName
      : "dd5135b2-c228-41b7-a4f9-3b6e7afe3088",
  };
}

async function getMetaModuleConsensus(
  real: RealFedimintWallet,
  moduleRefs: Set<string>,
  failures?: string[],
): Promise<unknown[]> {
  const helper = real.federation.getMetaConsensusValue;
  if (typeof helper === "function") {
    try {
      const result = await helper.call(real.federation, META_DEFAULT_KEY);
      console.info(
        `[chama] federation.getMetaConsensusValue key=${META_DEFAULT_KEY}(default) -> ${summarizeMetaProbeResult(result)}`,
      );
      if (result !== null && result !== undefined) return [result];
    } catch (e) {
      const message = summarizeError(e);
      failures?.push(`helper key=${META_DEFAULT_KEY}: ${message}`);
      console.info(
        `[chama] federation.getMetaConsensusValue failed key=${META_DEFAULT_KEY}(default): ${message}`,
      );
    }
  }

  const lowLevel = getLowLevelRpc(real);
  if (!lowLevel) return [];

  const modules = [...new Set(["meta", ...moduleRefs])];
  if (modules.length === 0) return [];
  const payloads: unknown[] = [META_DEFAULT_KEY];
  const values: unknown[] = [];
  console.info(
    `[chama] LN meta module probe: modules=${modules.join(", ")} keys=${payloads.join(", ")}`,
  );
  for (const moduleRef of modules) {
    for (const payload of payloads) {
      try {
        const result = await lowLevel.client.rpcSingle(
          moduleRef,
          "get_consensus_value",
          { key: payload },
          lowLevel.clientName,
        );
        console.info(
          `[chama] meta.get_consensus_value module=${moduleRef} key=${String(payload)}(default) -> ${summarizeMetaProbeResult(result)}`,
        );
        if (result !== null && result !== undefined) {
          values.push(result);
        }
      } catch (e) {
        const message = summarizeError(e);
        failures?.push(`module=${moduleRef} key=${String(payload)}: ${message}`);
        console.info(
          `[chama] meta.get_consensus_value failed module=${moduleRef} key=${String(payload)}(default): ${message}`,
        );
      }
    }
    if (values.length > 0) return values;
  }
  return values;
}

async function getCuratedGatewayIds(real: RealFedimintWallet): Promise<string[]> {
  try {
    const federationId = normalizeFederationId(await real.federation.getFederationId());
    if (!federationId) return [];
    return CURATED_LIGHTNING_GATEWAY_TRUST[federationId] ?? [];
  } catch (e) {
    console.debug("[chama] Could not read federation ID for curated gateway trust:", e);
    return [];
  }
}

async function addCuratedGatewayTrust(
  real: RealFedimintWallet,
  trusted: Set<string>,
  purpose: "receive" | "pay",
): Promise<string[]> {
  const curated = await getCuratedGatewayIds(real);
  if (curated.length === 0) return [];
  for (const gatewayId of curated) trusted.add(gatewayId);
  try {
    const federationId = normalizeFederationId(await real.federation.getFederationId());
    console.info(
      `[chama] LN ${purpose} curated-vetted gateway IDs for ${federationId}: ${curated.join(", ")}`,
    );
  } catch (e) {
    console.debug("[chama] Could not read federation ID for curated gateway trust:", e);
  }
  return curated;
}

async function getMetaVettedGatewayIds(
  real: RealFedimintWallet,
  purpose: "receive" | "pay",
): Promise<{ ids: Set<string>; probe: GatewayTrustProbeSummary }> {
  const trusted = new Set<string>();
  let configContainsMetaModule = false;
  const metaModuleRefs = new Set<string>();
  const metaRpcFailures: string[] = [];
  let curatedGatewayIds: string[] = [];
  let curatedFallbackApplied = false;

  if (typeof real.federation.getConfig === "function") {
    try {
      const config = await real.federation.getConfig();
      collectVettedGatewayIds(config, trusted);
      configContainsMetaModule = configHasModuleKind(config, "meta");
      collectModuleRefs(config, "meta", metaModuleRefs);
      console.info(
        `[chama] LN ${purpose} federation config meta probe: metaModule=${configContainsMetaModule} refs=${[...metaModuleRefs].join(", ") || "none"} ids=${[...trusted].join(", ") || "none"}`,
      );
    } catch (e) {
      console.debug("[chama] Could not read federation config meta for gateway vetting:", e);
    }
  }

  if (configContainsMetaModule) {
    const consensusValues = await getMetaModuleConsensus(real, metaModuleRefs, metaRpcFailures);
    for (const value of consensusValues) collectVettedGatewayIds(value, trusted);
  }

  curatedGatewayIds = await getCuratedGatewayIds(real);

  // ⭐ The curated fallback now applies to RECEIVE as well as PAY. It used to be
  // pay-only, which meant a federation whose guardians publish their trusted
  // gateways could still never produce a receive invoice here. See the trusted-
  // gateway selection below for the full reasoning.
  if (trusted.size === 0) {
    curatedGatewayIds = await addCuratedGatewayTrust(real, trusted, purpose);
    curatedFallbackApplied = curatedGatewayIds.length > 0;
  }

  if (trusted.size > 0) {
    console.info(
      `[chama] LN ${purpose} meta-vetted gateway IDs: ${[...trusted].join(", ")}`,
    );
  } else {
    console.info(`[chama] LN ${purpose} found no meta-vetted gateway IDs`);
  }
  return {
    ids: trusted,
    probe: {
      purpose,
      configContainsMetaModule,
      metaModuleRefs: [...metaModuleRefs],
      metaRpcFailures,
      metaVettedGatewayIds: [...trusted],
      curatedGatewayIds,
      curatedFallbackAllowed: true,
      curatedFallbackApplied,
    },
  };
}

async function buildGatewayTrustDiagnostics(args: {
  real: RealFedimintWallet;
  purpose: "receive" | "pay";
  gateways: RealLightningGateway[];
  probe: GatewayTrustProbeSummary;
}): Promise<Record<string, unknown>> {
  let federationId: string | null = null;
  try {
    federationId = normalizeFederationId(await args.real.federation.getFederationId());
  } catch {}
  return {
    issue: args.purpose === "receive"
      ? "no_sdk_vetted_lightning_receive_gateway"
      : "no_trusted_lightning_pay_gateway",
    adapter: "browser-wasm-sdk",
    federationId,
    sdkPackages: FEDIMINT_SDK_DIAGNOSTICS,
    jsSdkModuleKinds: ["", "ln", "meta", "mint", "wallet"],
    gateways: args.gateways.map((gateway) => ({
      gatewayId: gateway.info?.gateway_id ?? null,
      alias: gateway.info?.lightning_alias ?? null,
      api: gateway.info?.api ?? null,
      vetted: gateway.vetted,
      supportsPrivatePayments: gateway.info?.supports_private_payments ?? null,
    })),
    metaProbe: args.probe,
    nativeBridge: {
      active: false,
      reason:
        "This diagnostic is emitted by the browser WASM SDK adapter. " +
        "If nativeFedimint=1 was expected, the app did not initialize the Rust sidecar wallet.",
    },
    demoSafeFallback: args.purpose === "receive"
      ? {
          kind: "sim_mode",
          invoiceCreated: false,
          reason: "No Lightning invoice was created because receive gateway trust could not be wallet-verified.",
          activation: "?sim=1",
        }
      : {
          kind: "retry_payout",
          invoiceCreated: null,
          reason: "Outbound payout can be retried because claimed sats remain in the Chama wallet.",
        },
    interpretation: args.purpose === "receive"
      ? "The browser WASM SDK route cannot prove any receive gateway is SDK-vetted. This is not the Rust native bridge path. Metadata-only or curated receive trust can still produce claim_rejected after the payer sends sats, so no QR is created."
      : "The federation advertises gateways, but the browser wallet could not prove any pay gateway is trusted.",
  };
}

export function adaptRealWallet(
  real: RealFedimintWallet,
  onCleanup?: () => void,
  parseOobNotes?: (notes: string) => Promise<{
    total_amount: number;
    federation_id?: string | null;
    invite_code?: string | null;
  }>,
  forceRecoverOnJoin = false,
  recoveryContext?: {
    storageScope?: string | null;
    incident?: BrowserWalletRecoveryRequest | null;
    rollbackFilename?: string | null;
  },
  allowRecoveryOnJoin = false,
): IFedimintWallet {
  const activeReceiveWatches = new Set<() => void>();
  const armedReceiveOperationIds = new Set<string>();
  const armedMintReissueOperationIds = new Set<string>();
  // v1.2.2 claim-hang fix: coalesce concurrent redeems of the same OOB
  // notes string. drainPendingRedemptions (useEscrow init) fires
  // fire-and-forget, and the user can press RETRY CLAIM before the
  // drain finishes. Without this guard, two `reissueExternalNotes`
  // calls for the same notes can both hit the WASM mint state machine
  // in parallel — and at best the second is rejected as a double-spend,
  // at worst both hang waiting for guardian replies. We key on the
  // full notes string (already unique per token; long string keys are
  // fine for a Map). The first caller wins; later callers await the
  // same Promise.
  const inFlightMintReissuesByNotes = new Map<string, Promise<string>>();

  const scheduleFailedMintReissueRecovery = async (
    operationId: string,
  ): Promise<boolean> => {
    const storageScope = recoveryContext?.storageScope;
    if (!storageScope || !operationId) return false;

    let federationId = "";
    try {
      federationId = normalizeFederationId(
        await real.federation.getFederationId(),
      ) ?? "";
    } catch {}
    if (!federationId) {
      console.warn(
        `[chama] Could not arm wallet recovery for failed mint reissue ${operationId}: federation id unavailable`,
      );
      return false;
    }

    const request: BrowserWalletRecoveryRequest = {
      operationId,
      federationId,
      requestedAt: Date.now(),
      trigger: "mint-reissue-failed",
    };
    if (!requestBrowserWalletRecovery(storageScope, request)) {
      console.warn(
        `[chama] Could not persist wallet recovery request for failed mint reissue ${operationId}`,
      );
      return false;
    }
    if (!writeBrowserWalletRecoveryJournal(storageScope, {
      version: 1,
      stage: "requested",
      operationId,
      federationId,
      trigger: "mint-reissue-failed",
      requestedAt: request.requestedAt,
      updatedAt: Date.now(),
    })) {
      console.warn(
        `[chama] Recovery request for ${operationId} is durable, but its display receipt could not be written`,
      );
    }
    console.warn(
      `[chama] Failed mint reissue ${operationId} armed an identity-scoped forced recovery for the next wallet start`,
    );
    return true;
  };

  const summarizeGateway = (
    gateway: RealLightningGateway,
    index: number,
    total: number
  ): string => {
    const info = gateway.info;
    const alias = info?.lightning_alias || "unknown alias";
    const id = info?.gateway_id || "unknown id";
    const api = info?.api || "unknown api";
    const vetted = typeof gateway.vetted === "boolean"
      ? `vetted=${gateway.vetted}`
      : "vetted=?";
    const privatePayments = typeof info?.supports_private_payments === "boolean"
      ? `private=${info.supports_private_payments}`
      : "private=?";

    return `${index + 1}/${total} ${alias} ${id} ${vetted} ${privatePayments} ${api}`;
  };

  const getTrustedLightningGateway = async (
    purpose: "receive" | "pay",
    amountMsats?: number,
  ): Promise<RealGatewayInfo | undefined> => {
    let oneShotReceiveProbe = false;
    if (purpose === "receive") {
      let federationId: string | null = null;
      try {
        federationId = normalizeFederationId(await real.federation.getFederationId()) || null;
      } catch {
        // The ordinary reachability and gateway gates below still fail closed.
      }
      if (browserLightningReceiveIsBlocked(federationId)) {
        oneShotReceiveProbe = consumeBrowserLightningReceiveProbe(
          federationId,
          amountMsats ?? 0,
        );
      }
      if (browserLightningReceiveIsBlocked(federationId) && !oneShotReceiveProbe) {
        const diagnostic = {
          issue: "browser_lightning_receive_disabled",
          adapter: "browser-wasm-sdk",
          federationId,
          invoiceCreated: false,
          sdkPackages: FEDIMINT_SDK_DIAGNOSTICS,
          interpretation:
            "Chama disabled browser Lightning and NWC receives for this federation after repeated paid invoices reached claim_rejected before ecash minted. Browser gateway and balance probes cannot pre-validate the later claim transaction. Use exact-value Fedi ecash or a native Chama wallet; no BOLT11 was created.",
        };
        const error = new Error(
          "Browser Lightning funding is disabled for Bitcoin Life Federation after repeated paid invoices failed before ecash minted. " +
            "Chama did not create a QR. Export the exact trade amount as ecash from Fedi and paste it here, or use a native Chama wallet.\n\n" +
            `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
        );
        (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
          diagnostic;
        throw error;
      }
    }
    if (typeof real.lightning.listGateways !== "function") {
      if (purpose === "receive") {
        const diagnostic = {
          issue: "gateway_list_unavailable",
          purpose,
          sdkPackages: FEDIMINT_SDK_DIAGNOSTICS,
          interpretation: "This browser Fedimint SDK cannot list Lightning gateways, so Chama cannot verify receive gateway trust. No QR is created.",
        };
        const error = new Error(
          `No wallet-verifiable Lightning receive gateway is available for this federation. ` +
            `Refusing to show a QR code that may take payment and reject before ecash mints.\n\n` +
            `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
        );
        (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
          diagnostic;
        throw error;
      }
      console.warn(
        "[chama] LN pay gateway selection unavailable; falling back to SDK default gateway",
      );
      return undefined;
    }

    try {
      if (purpose === "receive") {
        const paused = await quarantinedReceiveRoute(real);
        if (paused && !oneShotReceiveProbe) {
          const diagnostic = {
            issue: "receive_federation_route_paused",
            federationId: paused.federationId,
            priorOperationId: paused.operationId,
            priorReason: paused.reason,
            retryAfter: new Date(paused.until).toISOString(),
            interpretation:
              "Chama paused browser Lightning receives for this federation after a paid invoice failed to mint. This does not assign fault to its gateway; same-federation payments may use Fedimint's internal-payment path.",
          };
          throw new Error(
            "Lightning funding is temporarily paused for this federation after a paid invoice failed to mint. " +
            "Do not pay another invoice from this browser route until the safety window ends; use a different funding path or federation.\n\n" +
            `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
          );
        }
      }
      if (typeof real.lightning.updateGatewayCache === "function") {
        await real.lightning.updateGatewayCache();
      }

      const gateways = await real.lightning.listGateways();
      for (const [index, candidate] of gateways.entries()) {
        console.info(
          `[chama] LN ${purpose} gateway candidate: ${summarizeGateway(
            candidate,
            index,
            gateways.length,
          )}`,
        );
      }

      const selectableGateways = gateways.filter((candidate) => candidate.info);
      const metaTrust = await getMetaVettedGatewayIds(real, purpose);
      const metaVettedGatewayIds = metaTrust.ids;
      const vettedGateway = selectableGateways.find((candidate) =>
        candidate.vetted === true && candidate.info
      );
      const metaVettedGateway = selectableGateways.find((candidate) =>
        candidate.info &&
        metaVettedGatewayIds.has(candidate.info.gateway_id?.toLowerCase() ?? "")
      );
      // ⭐⭐ RECEIVE NOW ACCEPTS THE FEDERATION'S OWN PUBLISHED TRUST.
      //
      // This line used to read `purpose === "receive" ? vettedGateway : …`,
      // which required the JS SDK's `gateway.vetted === true` on every receive.
      // That flag is not populated on browser SDK paths — our own comments say
      // so — while the signal that IS available, the federation's `vetted_gateways`
      // meta key, was computed and then explicitly discarded here. A gate
      // demanding a flag nobody sets never opens: browser Lightning funding was
      // impossible on EVERY federation, and presented as an unexplained failure
      // rather than a refusal.
      //
      // It was also inconsistent by RUNTIME rather than by risk — the native
      // Rust bridge permits exactly what this refused, on the same federation
      // and the same gateway. Fedi, whose federations these are, treats vetting
      // as a preference and never declines to make an invoice
      // (`ln_gateway_service.rs`: `if !vetted.is_empty() { vetted } else { unvetted }`).
      //
      // ⚠ We deliberately do NOT take Fedi's final fallback to fully unvetted
      // gateways. Chama's funding amounts are trade-sized, so one bad gateway
      // costs materially more than a chat wallet's top-up. Meta-published or
      // curated trust is the floor; no trust signal at all is still a refusal.
      const trustedGateway = vettedGateway ?? metaVettedGateway;
      if (!trustedGateway?.info) {
        if (selectableGateways.length > 0) {
          const diagnostic = await buildGatewayTrustDiagnostics({
            real,
            purpose,
            gateways: selectableGateways,
            probe: metaTrust.probe,
          });
          const message =
            purpose === "receive"
              ? "Browser SDK route: No wallet-verifiable Lightning receive gateway is available for this federation. " +
                "Refusing to show a QR code that may take payment and reject before ecash mints."
              : "No trusted Lightning pay gateway is available for this federation. " +
                "Your claimed sats are still in your Chama wallet; payout can be retried.";
          const error = new Error(
            `${message}\n\nChama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
          );
          (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
            diagnostic;
          throw error;
        }
        console.warn(`[chama] LN ${purpose} gateway selection found no gateways`);
        return undefined;
      }

      const trustTier = vettedGateway ? "SDK-vetted" : "meta-vetted";
      console.info(
        `[chama] LN ${purpose} using ${trustTier} gateway: ${summarizeGateway(
          trustedGateway,
          gateways.indexOf(trustedGateway),
          gateways.length,
        )}`,
      );

      if (purpose === "receive") {
        const selectAvailable = real.lightning.getAvailableGateway;
        if (typeof selectAvailable !== "function") {
          const diagnostic = {
            issue: "receive_gateway_availability_unverifiable",
            gatewayId: trustedGateway.info.gateway_id ?? null,
            sdkPackages: FEDIMINT_SDK_DIAGNOSTICS,
            interpretation:
              "This SDK cannot run select_available_gateway. Chama will not create a payable invoice from listGateways data alone.",
          };
          throw new Error(
            "The federation's trusted Lightning gateway could not be checked for current availability. " +
            "No invoice was created.\n\n" +
            `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
          );
        }
        const available = await selectAvailable.call(real.lightning, {
          gateway: trustedGateway.info,
        });
        if (!available?.gateway_id) {
          const diagnostic = {
            issue: "trusted_receive_gateway_unavailable",
            gatewayId: trustedGateway.info.gateway_id ?? null,
            sdkPackages: FEDIMINT_SDK_DIAGNOSTICS,
            interpretation:
              "The gateway is trusted but the Fedimint client's select_available_gateway RPC did not consider it currently usable. No invoice was created.",
          };
          throw new Error(
            "The federation's trusted Lightning gateway is not currently available. " +
            "No invoice was created.\n\n" +
            `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
          );
        }
        const availableId = available.gateway_id.toLowerCase();
        const trustedIds = new Set([
          ...(vettedGateway?.info?.gateway_id
            ? [vettedGateway.info.gateway_id.toLowerCase()]
            : []),
          ...metaVettedGatewayIds,
        ]);
        if (!trustedIds.has(availableId)) {
          throw new Error(
            "Fedimint selected a Lightning receive gateway that this federation has not marked trusted. " +
            "No invoice was created.",
          );
        }
        console.info(
          `[chama] LN receive availability confirmed by select_available_gateway: ${available.gateway_id}`,
        );
        return available;
      }

      return trustedGateway.info;
    } catch (e) {
      console.warn(`[chama] LN ${purpose} gateway selection failed:`, e);
      throw e;
    }
  };

  const waitForPay = async (
    operation: RealPayOperation,
    timeoutMs: number = PAY_WATCH_TIMEOUT_MS,
  ): Promise<void> => {
    const operationId = operation.operationId;
    const subscribe =
      operation.kind === "internal"
        ? real.lightning.subscribeInternalPayment?.bind(real.lightning)
        : real.lightning.subscribeLnPay?.bind(real.lightning);
    if (typeof subscribe !== "function") {
      // Submitted but unwatchable ⇒ outcome UNKNOWN. Tag INFLIGHT so the
      // claim guard refuses to re-pay (a refund would otherwise be re-sent).
      throw codedPayError(
        operation.kind === "internal"
          ? "Lightning payment was submitted as an internal federation payment, but this browser Fedimint SDK cannot watch internal pay status."
          : "Lightning payment was submitted, but this browser Fedimint SDK cannot watch pay status. Your sats are still in your Chama wallet if the payment refunds.",
        LN_PAY_INFLIGHT,
        operationId,
      );
    }

    console.info(
      `[chama] LN pay ${operationId}: watching ${operation.kind} status via ${operation.source}`,
    );
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let unsubscribeAfterAssign = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = null;
        if (unsubscribe) {
          try { unsubscribe(); }
          catch (e) { console.debug("[chama] LN pay unsubscribe threw:", e); }
        } else {
          unsubscribeAfterAssign = true;
        }
      };

      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };

      timeoutId = setTimeout(() => {
        // The watch window expired with no terminal state — the HTLC may
        // STILL be in flight. unknown ⇒ INFLIGHT: never let this become a
        // re-payable failure; the orchestrator re-attaches to operationId.
        finish(codedPayError(
          "Lightning payment is taking longer than expected to confirm",
          LN_PAY_INFLIGHT,
          operationId,
        ));
      }, timeoutMs);
      (timeoutId as { unref?: () => void }).unref?.();

      try {
        unsubscribe = subscribe(
          operationId,
          (state: RealLnPayState | RealLnInternalPayState) => {
            console.info(
              `[chama] LN pay ${operationId}: ${
                operation.kind === "internal"
                  ? formatInternalPayState(state as RealLnInternalPayState)
                  : formatPayState(state as RealLnPayState)
              }`,
              state,
            );
            const error = operation.kind === "internal"
              ? internalPayStateError(state as RealLnInternalPayState)
              : payStateCodedError(state as RealLnPayState, operationId);
            if (error) {
              finish(error);
            } else if (
              operation.kind === "internal"
                ? isInternalPaySuccess(state as RealLnInternalPayState)
                : typeof state === "object" && state !== null && "success" in state
            ) {
              finish();
            }
          },
          (error) => {
            // A broken status stream does NOT mean the payment failed — the
            // HTLC may still settle. unknown ⇒ INFLIGHT (refuse re-pay).
            console.warn(`[chama] LN pay ${operationId}: stream error`, error);
            finish(codedPayError(
              error || "Lightning payment status unavailable",
              LN_PAY_INFLIGHT,
              operationId,
            ));
          },
        );
        if (unsubscribeAfterAssign) {
          try { unsubscribe(); }
          catch (e) { console.debug("[chama] LN pay unsubscribe threw:", e); }
        }
      } catch (e) {
        console.warn(`[chama] LN pay ${operationId}: subscribe failed`, e);
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };

  const waitForMintReissue = async (operationId: string): Promise<void> => {
    const subscribeReissue = real.mint.subscribeReissueExternalNotes?.bind(real.mint);
    if (typeof subscribeReissue !== "function") {
      console.warn(
        `[chama] mint redeem ${operationId}: SDK has no reissue subscription; falling back to balance polling`,
      );
      return;
    }

    console.info(`[chama] mint redeem ${operationId}: watching reissue status`);
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let unsubscribeAfterAssign = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = null;
        if (unsubscribe) {
          try { unsubscribe(); }
          catch (e) { console.debug("[chama] mint redeem unsubscribe threw:", e); }
        } else {
          unsubscribeAfterAssign = true;
        }
      };

      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };

      timeoutId = setTimeout(() => {
        finish(new Error(`Mint reissue timed out for operation ${operationId}`));
      }, REISSUE_WATCH_TIMEOUT_MS);
      (timeoutId as { unref?: () => void }).unref?.();

	      try {
	        unsubscribe = subscribeReissue(
	          operationId,
	          (state) => {
	            const stateLabel = formatMintReissueState(state);
	            console.info(`[chama] mint redeem ${operationId}: ${stateLabel}`, state);
	            if (isMintReissueDoneState(state)) {
	              finish();
	            } else if (isMintReissueFailedState(state)) {
	              const err: any = new Error(
	                `Mint reissue operation failed after federation consumed the notes (${operationId}: ${stateLabel})`
	              );
	              err.code = "MINT_REISSUE_FAILED";
	              err.operationId = operationId;
	              err.state = state;
	              finish(err);
	            }
	          },
	          (error) => {
	            console.warn(`[chama] mint redeem ${operationId}: stream error`, error);
	            const err: any = new Error(error || "Mint reissue failed");
	            err.code = "MINT_REISSUE_FAILED";
	            err.operationId = operationId;
	            finish(err);
	          },
	        );
        if (unsubscribeAfterAssign) {
          try { unsubscribe(); }
          catch (e) { console.debug("[chama] mint redeem unsubscribe threw:", e); }
        }
      } catch (e) {
        console.warn(`[chama] mint redeem ${operationId}: subscribe failed`, e);
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };

  const listTransactions = async (limit = 100): Promise<RealTransaction[]> => {
    if (typeof real.federation.listTransactions !== "function") return [];
    return await real.federation.listTransactions(limit) as RealTransaction[];
  };

  const listMintReissueTransactions = async (
    limit = 100,
    transactions?: RealTransaction[],
  ): Promise<RealMintTransaction[]> => {
    const txs = transactions ?? await listTransactions(limit);
    return txs.filter(isMintReissueTransaction);
  };

  const resumeMintReissueFromHistory = async (
    expectedMsats: number | null,
    source: "already-reissued" | "open" | "join",
    /** When this redeem attempt began (epoch ms). Transactions older than this
     *  belong to some OTHER redeem and must never decide this one's outcome. */
    startedAtMs?: number,
  ): Promise<string | null> => {
    let txs: RealMintTransaction[] = [];
    try {
      txs = await listMintReissueTransactions(100);
    } catch (e) {
      console.warn(`[chama] mint reissue history scan failed (${source})`, e);
      return null;
    }

    const candidates = txs
      .filter((tx) => expectedMsats === null || normalizeMsats(tx.amountMsats) === expectedMsats)
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    // ⚠ AMOUNT IS NOT AN IDENTITY. `listTransactions` carries no note linkage,
    // so amount is the only join key available here — and on a wallet that has
    // traded the same round number before, the newest same-amount reissue is
    // very often a DIFFERENT operation. Reporting its outcome as this claim's
    // is how a claim that credited correctly was shown to a user as
    // "CLAIM FAILED · needs recovery" on 2026-08-19 (the buyer's wallet held
    // the full 100 sats the whole time). Bound the match by time so a stale
    // failure from an earlier trade cannot be adopted as this one's verdict.
    const windowFloorMs = startedAtMs !== undefined
      ? startedAtMs - MINT_REISSUE_HISTORY_SKEW_MS
      : null;
    const inWindow = windowFloorMs === null
      ? candidates
      : candidates.filter((tx) => (tx.timestamp ?? 0) >= windowFloorMs);

    console.info(
      `[chama] mint reissue history (${source}) expected=${expectedMsats ?? "unknown"} ` +
        `since=${windowFloorMs ?? "any"} ` +
        `inWindow=${inWindow.map(summarizeMintReissueTx).join(" | ") || "none"} ` +
        `(scanned=${candidates.length})`,
    );

	    // A completed reissue in the window means the money landed — prefer it
	    // over any failure, in either sort order. A Failed record sorted newest
	    // does not outrank a Done one when both are plausibly ours.
	    const done = inWindow.find((tx) => isMintReissueDoneOutcome(tx.outcome));
	    if (done) {
	      console.info(
	        `[chama] mint redeem ${done.operationId}: reissue in this attempt's window is ${done.outcome}`,
	      );
	      return done.operationId;
	    }

	    const latest = inWindow[0] ?? null;
	    // Only a failure INSIDE the window may be reported as this claim's
	    // failure. Outside it we return null and the caller raises
	    // MINT_REISSUE_UNKNOWN — "we cannot confirm" keeps the stash and keeps
	    // looking, where "it failed" tells the user their sats are gone.
	    if (latest && isMintReissueFailedOutcome(latest.outcome)) {
	      throw mintReissueFailedError(latest);
	    }
	    if (windowFloorMs !== null && inWindow.length === 0 && candidates.length > 0) {
	      console.warn(
	        `[chama] mint reissue history (${source}): ${candidates.length} same-amount ` +
	          `reissue(s) found but all predate this attempt — refusing to adopt one as ` +
	          `this claim's outcome (newest: ${summarizeMintReissueTx(candidates[0])})`,
	      );
	      return null;
	    }

	    // Still in flight — resume watching it. Scoped to the window for the same
	    // reason: an unrelated pending reissue is not this claim either.
	    const match = inWindow.find(shouldResumeMintReissue) ?? latest;
	    if (!match) return null;

	    if (isMintReissueDoneOutcome(match.outcome)) {
	      console.info(
	        `[chama] mint redeem ${match.operationId}: matching reissue is already ${match.outcome}`,
	      );
	      return match.operationId;
	    }

	    if (isMintReissueFailedOutcome(match.outcome)) {
	      throw mintReissueFailedError(match);
	    }

    if (armedMintReissueOperationIds.has(match.operationId)) {
      console.info(`[chama] mint redeem ${match.operationId}: reissue watch already armed`);
      return match.operationId;
    }

    armedMintReissueOperationIds.add(match.operationId);
    try {
      console.info(`[chama] mint redeem ${match.operationId}: resuming historical reissue (${source})`);
      await waitForMintReissue(match.operationId);
      return match.operationId;
    } finally {
      armedMintReissueOperationIds.delete(match.operationId);
    }
  };

  const armReceiveWatch = (
    operationId: string,
    strict = true,
    onState?: (kind: LnReceiveStateKind) => void,
    gateway?: RealGatewayInfo,
  ): void => {
    if (armedReceiveOperationIds.has(operationId)) return;
    armedReceiveOperationIds.add(operationId);

    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (unsubscribe) {
        try { unsubscribe(); }
        catch (e) { console.debug("[chama] LN receive unsubscribe threw:", e); }
      }
      activeReceiveWatches.delete(stop);
    };

    try {
      timeoutId = setTimeout(() => {
        console.warn(
          `[chama] LN receive watch timed out before claimed: ${operationId}`,
        );
        stop();
      }, RECEIVE_WATCH_TIMEOUT_MS);
      (timeoutId as { unref?: () => void }).unref?.();

      unsubscribe = real.lightning.subscribeLnReceive(
        operationId,
        (state) => {
          const stateLabel = formatReceiveState(state);
          console.info(
            `[chama] LN receive ${operationId}: ${stateLabel}`,
            state,
          );
          const canceled = typeof state === "object" && state !== null && "canceled" in state
            ? state.canceled
            : null;
          if (canceled) {
            void quarantineReceiveRoute(real, operationId, canceled.reason);
          } else {
            void traceReceiveOperation(real, operationId, `state:${stateLabel}`);
          }
          // v0.6.5: forward the classified state to an external
          // listener (the orchestrator) so it can advance UI phases
          // without waiting for the 5s balance poll. Defensive
          // try/catch — a listener throwing should never destabilize
          // the SDK subscription itself.
          if (onState) {
            if (canceled) {
              void buildReceiveFailureDiagnostic(
                real,
                operationId,
                canceled.reason,
                gateway,
              ).then((diagnostic) => {
                try {
                  onState({ canceled: { reason: canceled.reason, diagnostic } });
                } catch (e) {
                  console.debug("[chama] LN receive onState listener threw:", e);
                }
              });
            } else {
              try { onState(classifyReceiveState(state)); }
              catch (e) {
                console.debug("[chama] LN receive onState listener threw:", e);
              }
            }
          }
          if (isReceiveTerminal(state)) stop();
        },
        (error) => {
          console.warn(`[chama] LN receive watch failed for ${operationId}:`, error);
          void traceReceiveOperation(real, operationId, "stream-error", { error });
          stop();
        },
      );
      if (!stopped) activeReceiveWatches.add(stop);
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      activeReceiveWatches.delete(stop);
      armedReceiveOperationIds.delete(operationId);
      const error = new Error(
        "Couldn't watch Lightning receive operation; refusing to show an invoice " +
        "that Chama may not be able to claim. " +
        (e instanceof Error ? e.message : String(e)),
      );
      if (strict) throw error;
      console.warn(`[chama] Couldn't resume LN receive ${operationId}:`, error);
    }
  };

  const armPendingReceiveWatches = async (
    source: "open" | "join",
    transactions?: RealTransaction[],
  ): Promise<void> => {
    if (typeof real.federation.listTransactions !== "function") return;
    try {
      const txs = transactions ?? await listTransactions(100);
      for (const tx of txs) {
        const record = recordOf(tx);
        if (record?.kind === "ln" && record.type === "receive" && shouldResumeReceive(tx as RealLightningTransaction)) {
          console.info(
            `[chama] Resuming pending LN receive from ${source}: ${(tx as RealLightningTransaction).operationId}`,
          );
          armReceiveWatch((tx as RealLightningTransaction).operationId, false);
        }
      }
    } catch (e) {
      console.debug(`[chama] Pending LN receive scan failed on ${source}:`, e);
    }
  };

  const armPendingMintReissueWatches = async (
    source: "open" | "join",
    transactions?: RealTransaction[],
  ): Promise<void> => {
    try {
      const txs = await listMintReissueTransactions(100, transactions);
      const pending = txs.filter(shouldResumeMintReissue);
      if (pending.length > 0) {
        console.info(
          `[chama] Pending mint reissue scan (${source}): ` +
            pending.map(summarizeMintReissueTx).join(" | "),
        );
      }
      for (const tx of pending) {
        if (armedMintReissueOperationIds.has(tx.operationId)) continue;
        armedMintReissueOperationIds.add(tx.operationId);
        void waitForMintReissue(tx.operationId)
          .catch((e) => {
            console.warn(`[chama] Couldn't resume mint reissue ${tx.operationId}:`, e);
          })
          .finally(() => {
            armedMintReissueOperationIds.delete(tx.operationId);
          });
      }
    } catch (e) {
      console.debug(`[chama] Pending mint reissue scan failed on ${source}:`, e);
    }
  };

  return {
    async open() {
      const walletOpenStartedAt = Date.now();
      await real.open();
      console.info(
        `[chama/startup] wallet database open: ${Date.now() - walletOpenStartedAt}ms`,
      );

      // listTransactions is an OPFS/WASM RPC and can take several seconds on
      // a mature wallet, especially in Safari. Startup previously performed
      // this exact 100-operation scan three times in series: once for failed
      // payout recovery, once for pending Lightning receives, and once for
      // pending mint reissues. Take one custody-complete snapshot and reuse it
      // for all three checks so no safety or resume coverage is deferred.
      const historyScanStartedAt = Date.now();
      let startupTransactions: RealTransaction[] | undefined;
      try {
        startupTransactions = await listTransactions(100);
        console.info(
          `[chama/startup] wallet history snapshot: ${Date.now() - historyScanStartedAt}ms ` +
            `(${startupTransactions.length} operations)`,
        );
      } catch (error) {
        // The identity-scoped failed-reissue audit is custody-sensitive. Its
        // old behavior was fail-closed, so preserve that contract. Wallets
        // without a recovery scope may still open; their resume helpers have
        // always been fail-soft.
        if (recoveryContext?.storageScope) throw error;
        console.debug("[chama] Startup transaction scan failed:", error);
      }

      // A claim_rejected record alone is origin-wide and cannot identify the
      // affected Chama identity. Prove ownership by finding that exact receive
      // operation in this opened wallet before scheduling a recovery rotation.
      // This prevents one BLF user's failure from rotating another user's DB.
      if (recoveryContext?.storageScope && real.federation.getOperation) {
        // Include expired route pauses here: the six-hour safety window and
        // durable wallet repair are separate concerns.
        for (const entry of readReceiveRouteQuarantines(Date.now(), true)) {
          if (entry.reason !== "claim_rejected") continue;
          try {
            const operation = await real.federation.getOperation(entry.operationId);
            if (!operation) continue;
            const recoveryRecorded = requestBrowserWalletRecovery(
              recoveryContext.storageScope,
              {
              operationId: entry.operationId,
              federationId: entry.federationId,
              requestedAt: Date.now(),
              trigger: "operation-proof",
              },
            );
            if (!recoveryRecorded) {
              const error = new Error(
                "This wallet owns a rejected paid receive, but the browser refused durable recovery state. Chama left the wallet file untouched and will not continue unsafely.",
              );
              (error as Error & { code?: string }).code =
                BROWSER_WALLET_RECOVERY_PERSIST_FAILED_CODE;
              throw error;
            }
            const error = new Error(
              "This browser wallet owns a paid receive whose mint claim was rejected. " +
              "Chama will preserve the current wallet file and force a federation recovery in a fresh file before it can receive again.",
            );
            (error as Error & { code?: string }).code =
              BROWSER_WALLET_RECOVERY_REQUIRED_CODE;
            throw error;
          } catch (error) {
            const code = (error as Error & { code?: string }).code;
            if (
              code === BROWSER_WALLET_RECOVERY_REQUIRED_CODE ||
              code === BROWSER_WALLET_RECOVERY_PERSIST_FAILED_CODE
            ) throw error;
            // An unreadable operation is not proof that this identity owns it.
          }
        }
      }

      // A payout reissue failure is already identity-proven: it appears only
      // in the wallet that submitted and lost that exact operation. Recover a
      // failure that predated Chama's live arming hook without asking the user
      // to consume/retry the bearer notes. Fail closed if this wallet currently
      // holds any readable ecash; its preserved OPFS file must remain selected
      // until recovery is independently proven not to hide that balance.
      if (recoveryContext?.storageScope) {
        const failedReissues = (await listMintReissueTransactions(100, startupTransactions ?? []))
          .filter((tx) => isMintReissueFailedOutcome(tx.outcome))
          .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        const latestFailure = failedReissues[0] ?? null;
        const journal = readBrowserWalletRecoveryJournal(
          recoveryContext.storageScope,
        );
        if (
          latestFailure &&
          journal?.operationId !== latestFailure.operationId
        ) {
          let currentBalanceMsats: number | null = null;
          try {
            currentBalanceMsats = await real.balance.getBalance();
          } catch {}
          if (currentBalanceMsats === 0) {
            const armed = await scheduleFailedMintReissueRecovery(
              latestFailure.operationId,
            );
            if (armed) {
              const error = new Error(
                "This browser wallet owns a failed payout reissue. Chama preserved its current wallet file and will force federation recovery in a fresh file before further wallet use.",
              );
              (error as Error & { code?: string }).code =
                BROWSER_WALLET_RECOVERY_REQUIRED_CODE;
              throw error;
            }
          } else {
            console.warn(
              `[chama] Failed mint reissue ${latestFailure.operationId} needs recovery, but the current wallet balance is ${currentBalanceMsats ?? "unreadable"} msats; preserving the active file and refusing automatic rotation`,
            );
          }
        }
      }
      await armPendingReceiveWatches("open", startupTransactions);
      await armPendingMintReissueWatches("open", startupTransactions);
    },

    isOpen() {
      return real.isOpen();
    },

    async joinFederation(inviteCode: string) {
      if (forceRecoverOnJoin) {
        if (!allowRecoveryOnJoin) {
          const error = new Error(
            "This wallet seed has prior federation state. Chama did not run recovery during boot; tap Reconnect to start the explicit recovery attempt.",
          ) as Error & { code?: string };
          error.code = "FEDIMINT_RECOVERY_REQUIRES_USER_ACTION";
          throw error;
        }
        // Chama supplies one Nostr-backed mnemonic on every device. A fresh or
        // rotated OPFS file therefore does NOT imply a fresh Fedimint wallet.
        // Joining normally under an already-used seed restarts the mint's
        // deterministic nonce counters at zero. Reused blind nonces are a
        // separate, documented Fedimint safety failure and can make later mint
        // outputs fail. This repair is important, but it does not by itself
        // explain a particular claim_rejected receive.
        //
        // Chama now pins to the first upstream SDK canary that exposes this
        // operation publicly. Do not reach through private `_client` fields:
        // recovery is part of the supported wallet lifecycle and upgrades can
        // no longer silently remove it from beneath us.
        console.info(
          "[chama] Fresh browser client + Nostr-backed seed: forcing federation recovery before wallet use",
        );
        let joined: boolean;
        try {
          joined = await real.joinFederation(inviteCode, {
            forceRecover: true,
          });
        } catch (error) {
          updateBrowserWalletRecoveryJournal(recoveryContext?.storageScope, {
            stage: "inconclusive",
            error: error instanceof Error ? error.message : String(error),
          });
          if (recoveryContext?.incident && recoveryContext.rollbackFilename) {
            rememberFilename(
              recoveryContext.storageScope,
              recoveryContext.rollbackFilename,
            );
            requestBrowserWalletRecovery(
              recoveryContext.storageScope,
              recoveryContext.incident,
            );
          }
          throw error;
        }
        if (joined === false) {
          updateBrowserWalletRecoveryJournal(recoveryContext?.storageScope, {
            stage: "inconclusive",
            error: "Fedimint SDK did not start forced wallet recovery",
          });
          if (recoveryContext?.incident && recoveryContext.rollbackFilename) {
            rememberFilename(
              recoveryContext.storageScope,
              recoveryContext.rollbackFilename,
            );
            requestBrowserWalletRecovery(
              recoveryContext.storageScope,
              recoveryContext.incident,
            );
          }
          throw new Error("Fedimint SDK did not start forced wallet recovery");
        }
        updateBrowserWalletRecoveryJournal(recoveryContext?.storageScope, {
          stage: "recovering",
          error: undefined,
        });
      } else {
        const joined = await real.joinFederation(inviteCode);
        if (joined === false) {
          throw new Error("Fedimint SDK did not join the federation");
        }
      }
      const historyScanStartedAt = Date.now();
      let startupTransactions: RealTransaction[] | undefined;
      try {
        startupTransactions = await listTransactions(100);
        console.info(
          `[chama/startup] joined-wallet history snapshot: ${Date.now() - historyScanStartedAt}ms ` +
            `(${startupTransactions.length} operations)`,
        );
      } catch (error) {
        console.debug("[chama] Joined-wallet transaction scan failed:", error);
      }
      await armPendingReceiveWatches("join", startupTransactions);
      await armPendingMintReissueWatches("join", startupTransactions);
    },

    recovery: {
      async hasPendingRecoveries(): Promise<boolean> {
        try {
          return await real.recovery.hasPendingRecoveries();
        } catch { return false; }
      },
      async waitForAllRecoveries(): Promise<void> {
        // Propagate terminal module failures. Swallowing this error made the
        // caller record a false successful recovery with a zero/unknown
        // balance; the recovery journal must remain fail-closed instead.
        await real.recovery.waitForAllRecoveries();
      },
    },

    balance: {
      getBalance() {
        return real.balance.getBalance();
      },
      subscribeBalance(callback: (balance: number) => void) {
        return real.balance.subscribeBalance(callback);
      },
    },

    mint: {
      async spendNotes(
        amountMsats: number,
        meta?: ChamaOperationMeta,
        includeInvite = false,
      ) {
        const result = await real.mint.spendNotes(
          amountMsats,
          undefined,
          includeInvite,
          meta ?? {},
        );
        return result.notes;
      },
      // #37 lock crash-safety: lock spends pass an explicit long
      // tryCancelAfter (the SDK default is 1 DAY — shorter than a disputed
      // trade's life, so the spender's own client would auto-refund and
      // hollow out a live escrow) and surface the operation id for the
      // pending-native-locks stash.
      async spendNotesDetailed(
        amountMsats: number,
        opts: { tryCancelAfterSecs?: number; includeInvite?: boolean },
        meta?: ChamaOperationMeta,
      ) {
        const tryCancelAfter = typeof opts.tryCancelAfterSecs === "number"
          ? assertBrowserSafeOobTimeoutSecs(opts.tryCancelAfterSecs)
          : undefined;
        const result = await real.mint.spendNotes(
          amountMsats,
          tryCancelAfter,
          opts.includeInvite ?? false,
          meta ?? {},
        );
        return {
          notes: result.notes,
          operationId: result.operation_id ? String(result.operation_id) : undefined,
        };
      },
      async redeemEcash(oobNotes: string, meta?: ChamaOperationMeta) {
        // v1.2.2 claim-hang fix: coalesce concurrent redeems for the
        // same notes. See comment on inFlightMintReissuesByNotes above.
        const existing = inFlightMintReissuesByNotes.get(oobNotes);
        if (existing) {
          console.info(
            `[chama] mint redeem: coalescing with in-flight reissue (notes prefix=${oobNotes.slice(0, 12)}…)`,
          );
          return existing;
        }
        const promise = (async (): Promise<string> => {
          // Stamped BEFORE the submit so the history scan below can tell this
          // attempt's reissue from an older one for the same sat amount.
          const startedAtMs = Date.now();
          let expectedMsats: number | null = null;
          try { expectedMsats = await real.mint.parseNotes(oobNotes); } catch {}

          let operationId: string;
          try {
            // v1.2.2 claim-hang fix: bound the submit step in a
            // Promise.race so a stuck WASM `reissueExternalNotes`
            // surfaces as a transient error instead of hanging the
            // claim modal forever. If the WASM call eventually does
            // land after we time out here, the next retry's
            // `isAlreadyReissuedError` branch will pick it up via
            // `resumeMintReissueFromHistory`.
            const submitPromise: Promise<string> = real.mint.reissueExternalNotes
              ? real.mint.reissueExternalNotes(oobNotes, meta ?? {})
              : real.mint.redeemEcash(oobNotes);
            operationId = await Promise.race<string>([
              submitPromise,
              new Promise<string>((_, reject) => {
                const t = setTimeout(() => {
                  reject(
                    new Error(
                      `Mint reissue submit timed out after ${REISSUE_SUBMIT_TIMEOUT_MS / 1000}s ` +
                        `— federation may be unreachable. Will retry.`,
                    ),
                  );
                }, REISSUE_SUBMIT_TIMEOUT_MS);
                (t as { unref?: () => void }).unref?.();
              }),
            ]);
            console.info(`[chama] mint redeem ${operationId}: submitted`);
            await waitForMintReissue(operationId);
          } catch (e) {
            const failedOperationId = String(
              (e as Error & { operationId?: string })?.operationId ?? "",
            );
            if (
              (e as Error & { code?: string })?.code === "MINT_REISSUE_FAILED" &&
              failedOperationId
            ) {
              await scheduleFailedMintReissueRecovery(failedOperationId);
            }
            if (!isAlreadyReissuedError(e)) throw e;
            console.warn(
              `[chama] mint redeem: notes already reissued; searching local operation history ` +
                `expected=${expectedMsats ?? "unknown"}`,
              e,
            );
            let historicalOperationId: string | null;
            try {
              historicalOperationId = await resumeMintReissueFromHistory(
                expectedMsats,
                "already-reissued",
                startedAtMs,
              );
            } catch (historyError) {
              const failedHistoryOperationId = String(
                (historyError as Error & { operationId?: string })?.operationId ?? "",
              );
              if (
                (historyError as Error & { code?: string })?.code === "MINT_REISSUE_FAILED" &&
                failedHistoryOperationId
              ) {
                await scheduleFailedMintReissueRecovery(failedHistoryOperationId);
              }
              throw historyError;
            }
            if (!historicalOperationId) {
              const err: any = new Error(
                "Mint notes were consumed by the federation, but no local reissue operation was found to confirm wallet credit."
              );
              err.code = "MINT_REISSUE_UNKNOWN";
              err.cause = e;
              throw err;
            }
            operationId = historicalOperationId;
          }

          try {
            await real.recovery.waitForAllRecoveries();
          } catch (e) {
            console.debug(`[chama] mint redeem ${operationId}: recovery wait after reissue failed`, e);
          }

          let balanceAfter: number | undefined;
          try { balanceAfter = await real.balance.getBalance(); } catch {}
          console.info(
            `[chama] mint redeem ${operationId}: confirmed balance=${balanceAfter ?? "unknown"}`,
          );
          return operationId;
        })();
        inFlightMintReissuesByNotes.set(oobNotes, promise);
        try {
          return await promise;
        } finally {
          inFlightMintReissuesByNotes.delete(oobNotes);
        }
      },
      async parseNotes(oobNotes: string) {
        if (parseOobNotes) {
          const parsed = await parseOobNotes(oobNotes);
          return {
            total_amount: parsed.total_amount,
            federation_id: parsed.federation_id ?? undefined,
            federation_invite: parsed.invite_code ?? undefined,
          };
        }
        const total = await real.mint.parseNotes(oobNotes);
        return { total_amount: total };
      },
    },

    lightning: {
      async createInvoice(
        amountMsats: number,
        description: string,
        onReceiveState?: (kind: LnReceiveStateKind) => void,
        meta?: ChamaOperationMeta,
      ) {
        const gateway = await getTrustedLightningGateway("receive", amountMsats);
        const result = await real.lightning.createInvoice(
          amountMsats,
          description,
          undefined,
          gateway,
          meta ?? {},
        );
        void traceReceiveOperation(real, result.operation_id, "invoice-created", {
          amountMsats,
          gatewayId: gateway?.gateway_id ?? null,
          gatewayAlias: gateway?.lightning_alias ?? null,
          invoiceLen: result.invoice.length,
          invoicePrefix: result.invoice.slice(0, 24),
        });
        // v0.6.5: pass the listener through to the watch so the
        // orchestrator can react to `funded` etc. in real time.
        armReceiveWatch(result.operation_id, true, onReceiveState, gateway);
        return {
          invoice: result.invoice,
          operationId: result.operation_id,
          gateway: gateway?.gateway_id
            ? {
                id: gateway.gateway_id,
                alias: gateway.lightning_alias,
                api: gateway.api,
                // Browser SDK trust metadata says the route is approved, not
                // that this client has observed a successful receive through it.
                provenPayable: false,
                operationId: result.operation_id,
              }
            : undefined,
        };
      },
      async payInvoice(bolt11: string, meta?: ChamaOperationMeta) {
        const gateway = await getTrustedLightningGateway("pay");
        let result: unknown;
        const startedAt = Date.now();
        console.info(
          `[chama] LN pay submit-in gateway=${gateway?.gateway_id ?? "default"} invoiceLen=${bolt11.length}`,
        );
        try {
          result = await real.lightning.payInvoice(bolt11, gateway, meta ?? {});
        } catch (e: any) {
          // Submit rejected BEFORE an operationId exists ⇒ no payment was
          // created. SUBMIT_FAILED = safe to retry with a fresh invoice.
          const error = normalizePaySubmitError(e) as CodedPayError;
          if (!error.code) error.code = LN_PAY_SUBMIT_FAILED;
          console.warn(
            `[chama] LN pay submit failed via ${gateway?.gateway_id ?? "default gateway"}: ${error.message}`,
            e,
          );
          throw error;
        }
        console.info(
          `[chama] LN pay submit-out gateway=${gateway?.gateway_id ?? "default"} durationMs=${Date.now() - startedAt} result=${summarizePaySubmitResult(result)}`,
        );
        const operation = extractPayOperation(result);
        if (!operation) {
          // No operationId means we can neither watch nor re-attach. There is
          // no evidence a payment was created, so treat as submit-failed
          // (retry-safe) rather than strand the claim forever.
          throw codedPayError(
            `Lightning payment submission did not return a payment operation id: ${summarizePaySubmitResult(result)}`,
            LN_PAY_SUBMIT_FAILED,
          );
        }
        try {
          await waitForPay(operation);
        } catch (e: any) {
          console.warn(
            `[chama] LN pay ${operation.operationId}: failed after submit: ${e?.message || e}`,
            e,
          );
          throw e;
        }
        return { operationId: operation.operationId };
      },
      // 3.5.1 double-pay guard: re-attach to a previously-submitted payout
      // and report its TRUE terminal outcome, without ever paying again.
      // Returns "settled" (success{preimage}), "refunded" (confirmed refund
      // ⇒ retry-safe), or "unknown" (still in flight / unresolved ⇒ keep the
      // submitted record, do not re-pay).
      async awaitPayOutcome(operationId: string) {
        // R3-1b: the operation LOG is the reliable signal for a payout that
        // already settled before we re-attached — subscribeLnPay won't always
        // re-emit its terminal state, which left refunds stuck on CLAIMED.
        const fromLog = await getPayOperationOutcome(real, operationId);
        if (fromLog === "settled") return "settled" as const;
        if (fromLog === "refunded") return "refunded" as const;
        // Still in flight (or log unavailable) → watch the live stream.
        try {
          await waitForPay(
            { kind: "lightning", operationId, source: "reattach" },
            REATTACH_PAY_WATCH_TIMEOUT_MS,
          );
          return "settled" as const;
        } catch (e: any) {
          // Final log re-check — it may have landed while we waited / timed out.
          const after = await getPayOperationOutcome(real, operationId);
          if (after === "settled") return "settled" as const;
          if (after === "refunded" || e?.code === LN_PAY_REFUNDED) return "refunded" as const;
          return "unknown" as const;
        }
      },

      // V7 reconcile-by-escrow, browser lane. payInvoice above stamps our
      // ChamaOperationMeta (incl. chama_escrow_id) as the pay op's
      // extra_meta, which fedimint persists in the operation log — the
      // durable op↔escrow map. Scan recent LN sends, match on the stamp,
      // classify each match from the log. Fund-safety: "none" is returned
      // ONLY when the scan provably saw the complete window and every op in
      // it was readable — anything less is "unknown" (refuse re-pay).
      async payOutcomeByEscrow(escrowId: string, _sinceMs?: number) {
        const listTransactions = real.federation.listTransactions;
        const getOperation = real.federation.getOperation;
        if (typeof listTransactions !== "function" || typeof getOperation !== "function") {
          return { outcome: "unknown" as const };
        }
        let txs: RealTransaction[];
        try {
          txs = await listTransactions.call(real.federation, PAY_RECONCILE_SCAN_LIMIT);
        } catch (e) {
          console.warn("[chama] payOutcomeByEscrow: listTransactions failed", e);
          return { outcome: "unknown" as const };
        }
        // A full page means older ops exist beyond the window — an empty
        // match can't prove "no payment ever existed" then.
        const windowComplete = txs.length < PAY_RECONCILE_SCAN_LIMIT;
        let scanBlind = false;
        const matches: string[] = [];
        for (const tx of txs) {
          const rec = recordOf(tx);
          if (rec?.kind !== "ln" || rec?.type !== "send") continue;
          const operationId = typeof rec.operationId === "string" ? rec.operationId : null;
          if (!operationId) { scanBlind = true; continue; }
          try {
            const log = await getOperation.call(real.federation, operationId);
            const operation = recordOf(log);
            const extra = recordOf(recordOf(operation?.meta)?.extra_meta);
            if (extra?.chama_escrow_id === escrowId) matches.push(operationId);
          } catch {
            // An unreadable op COULD be the match — the scan is blind.
            scanBlind = true;
          }
        }
        if (matches.length === 0) {
          return windowComplete && !scanBlind
            ? { outcome: "none" as const }
            : { outcome: "unknown" as const };
        }
        // Classify every match; aggregate fund-safest-first: any settled ⇒
        // settled (a payment for this escrow WAS paid); else any
        // non-terminal/unreadable ⇒ inflight (a payment exists — refuse
        // re-pay, carry its id for re-attach); else all refunded ⇒ refunded.
        let inflightOp: string | undefined;
        let refundedOp: string | undefined;
        for (const operationId of matches) {
          const outcome = await getPayOperationOutcome(real, operationId);
          if (outcome === "settled") return { outcome: "settled" as const, operationId };
          if (outcome === "refunded") refundedOp = operationId;
          else inflightOp = operationId; // pending or unreadable ⇒ live payment
        }
        if (inflightOp) return { outcome: "inflight" as const, operationId: inflightOp };
        return { outcome: "refunded" as const, operationId: refundedOp };
      },
    },

    federation: {
      getFederationId() {
        return real.federation.getFederationId();
      },
      async getInviteCode() {
        const code = await real.federation.getInviteCode();
        if (!code) {
          throw new Error(
            "Federation invite code unavailable — wallet may not be joined yet"
          );
        }
        return code;
      },
    },

    async cleanup() {
      try {
        for (const stop of [...activeReceiveWatches]) stop();
        await real.cleanup();
      } finally {
        onCleanup?.();
      }
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// LOCAL WALLET RESET — OPFS-based
//
// IMPORTANT: Fedimint's WASM worker (@fedimint/transport-web) does NOT use
// IndexedDB for persistence. It uses the Origin Private File System (OPFS)
// via `navigator.storage.getDirectory()` + `createSyncAccessHandle()`.
// The string "fedimint.db" in the worker source is the OPFS filename.
//
// This matters for two reasons:
//
//   1. Deleting an IndexedDB database called "fedimint.db" is a no-op —
//      no such database exists. Earlier Chama versions (v0.1.11) did exactly
//      this and it didn't help.
//
//   2. The "NoModificationAllowedError" that users hit on re-init is NOT
//      about stale data. It's OPFS refusing to open a second sync access
//      handle on a file that's still locked by another handle — i.e. a
//      PREVIOUS Web Worker is still alive and holding the file. In Vite
//      dev with HMR this is extremely common: the old module gets replaced
//      but its worker keeps running.
//
// Fixes:
//   (a) Track the worker we spawn in a module-level ref, terminate it
//       before spawning a new one AND on cleanup(). This handles the
//       HMR / multi-init case end-to-end.
//   (b) The reset helper terminates the worker first (releasing the OPFS
//       handle) and then deletes the OPFS file so the next init starts
//       from a blank slate.
// ══════════════════════════════════════════════════════════════════════════

/** OPFS filename used by @fedimint/transport-web worker */
const FEDIMINT_OPFS_FILE = "fedimint.db";

/**
 * Module-level reference to the currently-live transport (for its worker).
 * We terminate this worker before creating a new one so the OPFS sync
 * access handle is released and the next init() doesn't throw
 * NoModificationAllowedError. HMR-safe: `import.meta.hot?.dispose` also
 * terminates it to be doubly sure during dev.
 */
type AnyTransport = { worker?: Worker };
let currentTransport: AnyTransport | null = null;

function terminateCurrentWorker(): void {
  const t = currentTransport;
  currentTransport = null;
  if (t && t.worker && typeof t.worker.terminate === "function") {
    try {
      t.worker.terminate();
      console.info("[chama] Previous Fedimint worker terminated");
    } catch (e) {
      console.debug("[chama] worker terminate threw:", e);
    }
  }
}

// Vite HMR: tear the worker down when the module is disposed so the next
// hot-replaced instance starts fresh. No-op in production.
// @ts-ignore — import.meta.hot is a dev-only Vite API
if (typeof import.meta !== "undefined" && (import.meta as any).hot) {
  // @ts-ignore
  (import.meta as any).hot.dispose(() => {
    terminateCurrentWorker();
  });
}

/**
 * Wipe the Fedimint WASM wallet's local state.
 *
 * Steps:
 *   1. Terminate any live worker so its OPFS sync access handle is released.
 *   2. `removeEntry("fedimint.db")` on the OPFS root directory.
 *   3. Fall back to a brute-force clear of the OPFS root if step 2 throws
 *      (e.g. file is held by a worker in another tab). Returns a warning
 *      rather than throwing so the UI can still recover.
 *
 * Destructive to *local* state only. The Nostr-backed mnemonic lives on
 * relays and will be reinstalled on the next init().
 */
export async function resetLocalFedimintWallet(
  opts: { storageScope?: string | null } = {},
): Promise<void> {
  // v0.4.2 sim mode: sim wallets live in localStorage, not OPFS. Calling
  // navigator.storage.getDirectory() in sim mode is both unnecessary and
  // can throw "Security error" in restricted browser contexts (the
  // community-pill crash reported during 0.4.2 smoke). Short-circuit
  // here so every caller that "wipes local state" — switchFederation,
  // listing-tap fed switch, manual reset — Just Works in sim mode. We
  // also clear the per-npub sim wallet entry so reset still has its
  // intended semantic (clean slate for the next init).
  const { isSimModeOn } = await import("../sim/simMode.js");
  if (isSimModeOn()) {
    try {
      if (typeof localStorage !== "undefined") {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("chama_sim_wallet_")) {
            localStorage.removeItem(key);
          }
        }
      }
    } catch (e) {
      console.debug("[chama] sim wallet localStorage clear threw (non-fatal):", e);
    }
    console.info("[chama] resetLocalFedimintWallet: sim mode — cleared localStorage, skipped OPFS");
    return;
  }

  const { isNativeBridgeModeOn, resetNativeBridgeWallet } =
    await import("./native-bridge-adapter.js");
  if (isNativeBridgeModeOn()) {
    await resetNativeBridgeWallet();
    console.info("[chama] resetLocalFedimintWallet: native bridge DB reset");
    return;
  }

  // 1. Release any live sync handle by killing the worker that owns it.
  terminateCurrentWorker();

  // 2. OPFS entry removal + filename rotation so the next init() uses a
  //    guaranteed-fresh OPFS file, sidestepping any orphaned sync handle.
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== "function"
  ) {
    throw new Error(
      "This browser does not support OPFS (navigator.storage.getDirectory). " +
      "Try a recent Chrome, Edge, or Safari build."
    );
  }

  const root = await navigator.storage.getDirectory();

  // Best-effort delete of the currently-configured file AND the legacy
  // default name. Failures on a locked file are non-fatal because we're
  // about to rotate anyway.
  const activeName = getStoredFilename(opts.storageScope);
  const namesToDelete = new Set<string>([activeName]);
  if (!opts.storageScope || activeName === FEDIMINT_OPFS_FILE) {
    namesToDelete.add(FEDIMINT_OPFS_FILE);
  }
  for (const name of namesToDelete) {
    try {
      // @ts-ignore — options arg lacks TS lib coverage on some releases
      await root.removeEntry(name, { recursive: true });
      console.info(`[chama] OPFS '${name}' removed`);
    } catch (e: any) {
      if (e?.name === "NotFoundError") continue;
      console.warn(
        `[chama] couldn't remove OPFS '${name}' (${e?.name}) — rotating filename instead`
      );
    }
  }

  // 3. Rotate to a fresh filename. Even if the old file couldn't be
  //    deleted, the next init() will use a brand-new name and skip
  //    whatever stale handle was orphaned.
  const newName = rotateFilename(opts.storageScope);
  console.info(`[chama] Next init will use OPFS file: ${newName}`);
}

/** @internal — used by createRealWallet to stash the transport for termination */
function registerTransport(t: AnyTransport): void {
  // Terminate any prior one first — catches the HMR and double-init cases.
  terminateCurrentWorker();
  currentTransport = t;
}

/** @internal — used by the adapted wallet's cleanup() to release the worker */
function clearRegisteredTransport(): void {
  terminateCurrentWorker();
}

// ══════════════════════════════════════════════════════════════════════════
// FACTORY — Used by FedimintClient.defaultWalletFactory in production.
//
// Dynamically imports @fedimint/core and @fedimint/transport-web so that
// the heavy WASM bundle is only loaded when the user actually needs ecash
// operations. Unit tests can still run without the SDK installed.
// ══════════════════════════════════════════════════════════════════════════

export interface CreateRealWalletOptions {
  /**
   * Optional BIP-39 mnemonic (as a word array) to seed the wallet with.
   * If omitted, the director will generate a fresh mnemonic via
   * `generateMnemonic()`. Chama supplies this from the Nostr-backed
   * seed-manager so the wallet is deterministic across devices.
   */
  mnemonic?: string[];
  /**
   * Browser OPFS storage scope, normally the user's Nostr pubkey. This
   * prevents one browser profile with multiple identities from opening the
   * wrong local Fedimint file and hitting seed-mismatch safety.
   */
  storageScope?: string | null;
  /** Whether a fresh database must recover prior mint state for this seed.
   * Defaults conservatively to true when a mnemonic is supplied. */
  forceRecoverOnJoin?: boolean;
  /** Whether this invocation was explicitly authorized to start recovery. */
  allowRecoveryOnJoin?: boolean;
}

// ── OPFS filename rotation ───────────────────────────────────────────────
//
// Browsers can leak OPFS sync access handles across page reloads. When that
// happens, the worker's attempt to createSyncAccessHandle() on the wallet file
// throws. Ordinary startup retries only the SAME file and then fails closed;
// it must never rotate merely to escape a lock because the preserved file may
// contain bearer ecash.
//
// Chama historically treated filename rotation as harmless because the
// Nostr-backed mnemonic recreates the same keys. That was incomplete: the
// OPFS database also carries mint state, including deterministic nonce
// progress, and bearer ecash is not restored merely by reinstalling a seed.
// A fresh/rotated database under an already-used seed must force federation
// recovery before wallet use. The old file is preserved whenever a money
// incident is the only path that triggers rotation, and it retains a durable
// journal plus rollback pointer if the recovery-capable join cannot complete.

const FILENAME_STORAGE_KEY = "chama_fedimint_opfs_file_v1";
const DEFAULT_FILENAME = "fedimint.db";

type FilenameSource = "scoped" | "legacy";

function isDedicatedArbiterFederationScope(scope?: string | null): boolean {
  return scope?.trim().toLowerCase().includes(":arbiter-fed:") === true;
}

function scopedFilenameKey(scope: string | null | undefined): string | null {
  const clean = scope?.trim().toLowerCase();
  if (!clean) return null;
  return `${FILENAME_STORAGE_KEY}:${clean}`;
}

export function getStoredFilenameEntry(scope?: string | null): { filename: string; source: FilenameSource } {
  try {
    const scopedKey = scopedFilenameKey(scope);
    if (scopedKey) {
      const scoped = localStorage.getItem(scopedKey);
      if (scoped) {
        const legacy = localStorage.getItem(FILENAME_STORAGE_KEY) || DEFAULT_FILENAME;
        // Repair installs that already encountered the old fallthrough bug:
        // it could persist the legacy filename under the new federation's
        // dedicated key after observing the same mnemonic. Preserve that
        // legacy file and move only this poisoned route to a fresh file.
        if (isDedicatedArbiterFederationScope(scope) && scoped === legacy) {
          return { filename: rotateFilename(scope), source: "scoped" };
        }
        return { filename: scoped, source: "scoped" };
      }

      // A bonded arbiter may serve several federations. Each route is a
      // separate bearer-ecash wallet and therefore MUST start on a separate
      // OPFS file. Falling through to the legacy/global filename here opened
      // whichever federation the browser had used first; the subsequent
      // federation mismatch correctly refused to wipe it, leaving every old
      // trade behind an unrecoverable "re-select the federation" loop.
      //
      // Identity scopes intentionally retain the legacy fallback below: that
      // is the one-time migration path which preserves existing user wallets.
      if (isDedicatedArbiterFederationScope(scope)) {
        return { filename: rotateFilename(scope), source: "scoped" };
      }
    }
    return {
      filename: localStorage.getItem(FILENAME_STORAGE_KEY) || DEFAULT_FILENAME,
      source: "legacy",
    };
  } catch {
    return { filename: DEFAULT_FILENAME, source: "legacy" };
  }
}

function getStoredFilename(scope?: string | null): string {
  return getStoredFilenameEntry(scope).filename;
}

function rememberFilename(scope: string | null | undefined, name: string): void {
  try {
    const scopedKey = scopedFilenameKey(scope);
    if (scopedKey) {
      localStorage.setItem(scopedKey, name);
    } else {
      localStorage.setItem(FILENAME_STORAGE_KEY, name);
    }
  } catch {}
}

function rotateFilename(scope?: string | null): string {
  // SECURITY: OPFS filenames are origin-scoped; a same-origin script
  // (XSS) could iterate them if predictable. Crypto randomness raises
  // the cost of guessing the active wallet DB filename.
  const suffix = randomId(8);
  const name = `chama-fedimint-${suffix}.db`;
  rememberFilename(scope, name);
  return name;
}

/**
 * Check if an error is the OPFS "file is locked" error.
 *
 * The @fedimint/transport-web worker posts errors as a STRING in
 * `response.error` (not an Error object), so we have to sniff both
 * shapes: DOMException-like objects AND plain string messages.
 */
function isOpfsLockError(e: unknown): boolean {
  if (!e) return false;

  // Plain string (this is how the worker actually rejects)
  if (typeof e === "string") {
    return /no modification allowed|invalidstate/i.test(e);
  }

  // Error / DOMException
  const err = e as { name?: string; message?: string; toString?: () => string };
  if (err.name === "NoModificationAllowedError") return true;
  if (err.name === "InvalidStateError") return true;

  const msg = err.message || (typeof err.toString === "function" ? err.toString() : "");
  return /no modification allowed|invalidstate/i.test(msg);
}

/**
 * WebKit uses this deliberately vague DOMException when an embedded/private
 * browser cannot create the synchronous OPFS handle the Fedimint database
 * requires. The transport currently posts only `e.message`, so production
 * may receive the sentence without the original `UnknownError` name.
 *
 * This is not evidence that the phone itself ran out of RAM. It is a failure
 * of the browser storage operation and must fail closed: selecting another
 * OPFS filename could hide an existing bearer-ecash wallet.
 */
export function isOpfsTransientStorageError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === "string") {
    return /unknown transient reason|out of memory/i.test(e);
  }
  const err = e as { name?: string; message?: string; toString?: () => string };
  if (err.name === "UnknownError" || err.name === "QuotaExceededError") return true;
  const msg = err.message || (typeof err.toString === "function" ? err.toString() : "");
  return /unknown transient reason|out of memory/i.test(msg);
}

export const BROWSER_WALLET_STORAGE_UNAVAILABLE_CODE =
  "FEDIMINT_BROWSER_STORAGE_UNAVAILABLE";

function browserWalletStorageUnavailableError(cause: unknown): Error {
  const error = new Error(
    "Chama could not open its secure local wallet storage. This is a browser " +
      "storage failure—not evidence that your iPhone ran out of memory—and " +
      "Reconnect cannot repair it in this browser. On iPhone, open " +
      "getchama.app in standard Safari (not an iPhone third-party or private " +
      "browser), " +
      "then sign in again. If Safari reports the same failure, check free " +
      "device storage and install the latest iOS update. No wallet file was replaced.",
  ) as Error & { code?: string; cause?: unknown };
  error.code = BROWSER_WALLET_STORAGE_UNAVAILABLE_CODE;
  error.cause = cause;
  return error;
}

function browserWalletFileBusyError(cause: unknown): Error {
  const error = new Error(
    "Chama's secure local wallet file is still open in another browser " +
      "process. Close every other Chama tab or window, fully close the " +
      "browser, then reopen Chama. No wallet file was replaced.",
  ) as Error & { code?: string; cause?: unknown };
  error.code = "FEDIMINT_BROWSER_STORAGE_BUSY";
  error.cause = cause;
  return error;
}

/**
 * Start loading the heavy browser Fedimint runtime without creating a wallet.
 * initFedimint uses this while the Nostr seed recovery is in flight, so the
 * WASM/transport chunks do not sit serially in front of the federation join.
 */
export async function preloadRealWalletRuntime(): Promise<{
  WalletDirector: typeof import("@fedimint/core")["WalletDirector"];
  WasmWorkerTransport: typeof import("@fedimint/transport-web")["WasmWorkerTransport"];
}> {
  const [core, transport] = await Promise.all([
    import("@fedimint/core"),
    import("@fedimint/transport-web"),
  ]);
  return {
    WalletDirector: core.WalletDirector,
    WasmWorkerTransport: transport.WasmWorkerTransport,
  };
}

export async function createRealWallet(
  opts: CreateRealWalletOptions = {}
): Promise<IFedimintWallet> {
  const { acquireBrowserRuntimeLease } = await import("./browser-runtime-lease.js");
  // Keyed by storageScope — the SAME value that picks the OPFS wallet file
  // below — so the lease refuses exactly the runtimes that would fight over
  // one seed, and no longer refuses an unrelated identity or a second dev
  // server that merely shares the hostname the cookie is stored under.
  // onLost tears this tab's worker down if another tab takes the runtime
  // over, so a takeover can never leave two WASM runtimes on one seed.
  const releaseRuntimeLease = await acquireBrowserRuntimeLease(opts.storageScope, {
    onLost: () => {
      terminateCurrentWorker();
      clearRegisteredTransport();
    },
  });
  let walletReady = false;
  let incidentRecovery: BrowserWalletRecoveryRequest | null = null;
  let recoveryRollbackFilename: string | null = null;
  try {
    const { WalletDirector, WasmWorkerTransport } = await preloadRealWalletRuntime();

  // Terminate any worker left over from a previous init in this session.
  // Handles HMR, double-init, and retry-after-failed-join. A cross-reload
  // leaked handle is retried against the same file below and then fails
  // closed; it is never an excuse to replace the selected wallet database.
  terminateCurrentWorker();

  // Always open the stored filename. A failed OPFS handle may be transient,
  // so we can tear down the worker and retry that SAME file once. Never rotate
  // merely to make startup succeed: this file can contain bearer ecash that a
  // fresh database cannot reconstruct.
  let filenameEntry = getStoredFilenameEntry(opts.storageScope);
  let filename = filenameEntry.filename;
  let filenameSource = filenameEntry.source;
  // A durable incident receipt is a recovery lead, not permission to spend
  // boot time rotating files and contacting guardians. Ordinary startup opens
  // the preserved wallet only; explicit Reconnect opts into the repair.
  incidentRecovery = opts.mnemonic?.length && opts.allowRecoveryOnJoin === true
    ? consumeBrowserWalletRecoveryRequest(opts.storageScope)
    : null;
  recoveryRollbackFilename = incidentRecovery ? filename : null;
  if (incidentRecovery) {
    filename = rotateFilename(opts.storageScope);
    filenameSource = opts.storageScope ? "scoped" : "legacy";
    console.warn(
      `[chama] Preserving '${recoveryRollbackFilename}' and opening '${filename}' ` +
      `for forced recovery of receive ${incidentRecovery.operationId}`,
    );
    const existingJournalTrigger = incidentRecovery.trigger ?? "operation-proof";
    if (!writeBrowserWalletRecoveryJournal(opts.storageScope, {
      version: 1,
      stage: "rotating",
      operationId: incidentRecovery.operationId,
      federationId: incidentRecovery.federationId,
      trigger: existingJournalTrigger,
      requestedAt: incidentRecovery.requestedAt,
      updatedAt: Date.now(),
      oldFilename: recoveryRollbackFilename ?? undefined,
      newFilename: filename,
    })) {
      rememberFilename(opts.storageScope, recoveryRollbackFilename!);
      requestBrowserWalletRecovery(opts.storageScope, incidentRecovery);
      throw new Error(
        "The browser refused to persist the recovery receipt; the old wallet file remains selected",
      );
    }
  }
  let director: any;
  let transport: any;

  const attemptInit = async (fname: string) => {
    const t = new WasmWorkerTransport();
    registerTransport(t as unknown as AnyTransport);
    const d = new WalletDirector(t, fname, /* lazy */ true);
    await (d as unknown as {
      initialize(dbPath?: string): Promise<unknown>;
    }).initialize(fname);
    return { d, t };
  };

  try {
    ({ d: director, t: transport } = await attemptInit(filename));
    console.info(`[chama] Fedimint OPFS file: ${filename}`);
  } catch (e) {
    const storageHandleFailure =
      isOpfsLockError(e) || isOpfsTransientStorageError(e);
    console.warn(
      `[chama] init failed on '${filename}' —`,
      e,
      "isOpfsLockError:",
      isOpfsLockError(e),
      "isOpfsTransientStorageError:",
      isOpfsTransientStorageError(e),
    );
    if (storageHandleFailure) {
      console.warn(
        `[chama] OPFS '${filename}' handle failed; retrying the same wallet file once.`,
      );
      terminateCurrentWorker();
      // WebKit can need more than one event-loop turn to dispose a failed
      // worker and release its file-system operation.
      await new Promise((r) => setTimeout(r, 250));
      try {
        ({ d: director, t: transport } = await attemptInit(filename));
        console.info(`[chama] Fedimint OPFS file (same-file retry): ${filename}`);
      } catch (e2) {
        console.error(`[chama] same-file retry for '${filename}' also failed:`, e2);
        if (isOpfsLockError(e2)) {
          throw browserWalletFileBusyError(e2);
        }
        if (isOpfsTransientStorageError(e2)) {
          throw browserWalletStorageUnavailableError(e2);
        }
        throw e2;
      }
    } else {
      throw e;
    }
  }
  void transport; // retained reference via registerTransport

  // Install the seed BEFORE creating the wallet so the wallet's derived
  // keys come from our Nostr-backed mnemonic rather than a fresh random.
  //
  // The WASM wallet persists its seed in an IndexedDB database named
  // "fedimint.db". If a previous Chama session already wrote a seed
  // there, setMnemonic() will throw a "No modification allowed" error —
  // the Rust SDK refuses to overwrite an existing seed because doing so
  // would orphan any ecash associated with the old seed. We handle
  // three cases:
  //
  //   1. No existing seed  → install ours.
  //   2. Existing seed matches ours  → no-op, proceed.
  //   3. Existing seed differs  → throw an actionable error asking the
  //      user to reset their local wallet (which we also provide a
  //      one-click button for in the UI).
  let directorTyped = director as unknown as {
    setMnemonic(words: string[]): Promise<boolean>;
    getMnemonic(): Promise<string[]>;
    generateMnemonic(): Promise<string[]>;
  };

  const installMnemonicInFreshFile = async (deleteCurrentFile: boolean, reason: string) => {
    console.warn(`[chama] ${reason}`);
    terminateCurrentWorker();

    if (deleteCurrentFile) {
      try {
        const root = await navigator.storage.getDirectory();
        const oldName = getStoredFilename(opts.storageScope);
        try { await (root as any).removeEntry(oldName, { recursive: true }); } catch {}
        try { await (root as any).removeEntry("fedimint.db", { recursive: true }); } catch {}
      } catch {}
    }

    const freshName = rotateFilename(opts.storageScope);
    console.info("[chama] OPFS fresh file selected:", freshName);

    const { WalletDirector: WD2 } = await import("@fedimint/core");
    const { WasmWorkerTransport: WT2 } = await import("@fedimint/transport-web");
    const t2 = new WT2();
    registerTransport(t2 as unknown as AnyTransport);
    const d2 = new WD2(t2, freshName, /* lazy */ true);
    await (d2 as unknown as {
      initialize(dbPath?: string): Promise<unknown>;
    }).initialize(freshName);

    const dt2 = d2 as unknown as {
      setMnemonic(words: string[]): Promise<boolean>;
      getMnemonic(): Promise<string[]>;
      generateMnemonic(): Promise<string[]>;
    };
    await dt2.setMnemonic(opts.mnemonic!);
    console.info("[chama] Nostr-backed seed installed in fresh OPFS file");

    director = d2;
    directorTyped = dt2;
    filename = freshName;
    filenameSource = opts.storageScope ? "scoped" : "legacy";
  };

  if (opts.mnemonic && opts.mnemonic.length > 0) {
    let existing: string[] | null = null;
    try {
      existing = await directorTyped.getMnemonic();
    } catch {
      // getMnemonic throws when no seed is set yet — that's fine
      existing = null;
    }

    if (existing && existing.length > 0) {
      // Compare word-by-word. Arrays from the SDK are canonical lowercase.
      const sameLength = existing.length === opts.mnemonic.length;
      const allMatch = sameLength && existing.every(
        (w, i) => w.toLowerCase().trim() === opts.mnemonic![i].toLowerCase().trim()
      );

      if (!allMatch) {
        // Local seed differs from the identity's Nostr-backed seed. Do not
        // describe OPFS as a disposable cache: it may contain bearer ecash and
        // mint nonce progress that the identity phrase alone does not restore.
        // setMnemonic is attempted only before the balance-proven preservation
        // policy below decides whether a new identity-scoped file is safe.
        console.warn(
          "[chama] Seed mismatch — local OPFS has a different seed than Nostr.",
          "Overwriting local seed with Nostr-backed seed (source of truth)."
        );
        try {
          await directorTyped.setMnemonic(opts.mnemonic!);
          console.info("[chama] Local seed overwritten with Nostr-backed seed");
        } catch (setErr: any) {
          // v0.1.76 fund-loss protection, hardened in v3.4.0 (C14):
          // before the auto-reset path destroys the orphan OPFS, peek
          // at its balance. Fedimint ecash is bearer cash and lives
          // ONLY in this file — wiping it without checking has
          // destroyed real user sats in the past.
          //
          // INVARIANT(no-wipe-unknown-balance): the wipe requires a
          // POSITIVE confirmed zero (balance read = 0, or provably no
          // federation client in the file). A thrown/uncertain peek —
          // federation momentarily unreachable, worker flake — must
          // refuse or park, never reset. Decision table lives in
          // orphan-wipe-policy.ts (pure, unit-tested).
          let peek: OrphanPeek = {
            kind: "unknown",
            reason: "balance peek did not run",
          };
          try {
            const orphanWallet = await (director as unknown as {
              createWallet(): Promise<{
                open(): Promise<void>;
                isOpen(): boolean;
                balance: { getBalance(): Promise<number> };
                cleanup(): Promise<void>;
              }>;
            }).createWallet();
            try {
              await orphanWallet.open();
              if (orphanWallet.isOpen()) {
                peek = {
                  kind: "balance",
                  balanceMsats: await orphanWallet.balance.getBalance(),
                };
              } else {
                peek = { kind: "unknown", reason: "wallet did not open" };
              }
            } catch (openErr) {
              const openMsg = typeof openErr === "string"
                ? openErr
                : (openErr as Error)?.message || String(openErr);
              peek = NO_CLIENT_OPEN_ERROR_RE.test(openMsg)
                // First-run taxonomy: no federation client in this DB →
                // ecash structurally impossible. Positive confirmation.
                ? { kind: "no-client" }
                : { kind: "unknown", reason: openMsg.slice(0, 200) };
            }
            try { await orphanWallet.cleanup(); } catch {}
          } catch (peekErr) {
            peek = {
              kind: "unknown",
              reason: (peekErr instanceof Error ? peekErr.message : String(peekErr)).slice(0, 200),
            };
            console.warn("[chama] orphan-balance peek threw — wipe will be refused:", peekErr);
          }

          const decision = decideOrphanWipe({
            peek,
            storageScope: opts.storageScope,
            filenameSource,
          });

          if (decision.action === "preserve-and-rescope") {
            const satsNote = decision.balanceMsats === null
              ? "an UNCONFIRMABLE balance"
              : `${Math.floor(decision.balanceMsats / 1000)} sats`;
            await installMnemonicInFreshFile(
              false,
              `Legacy OPFS file '${filename}' holds ${satsNote} under a different seed. ` +
              "Preserving it untouched and starting a scoped Fedimint file for this Nostr key."
            );
          } else if (decision.action === "refuse-balance") {
            const orphanFingerprint = (existing ?? []).slice(0, 4).join(" ");
            const nostrFingerprint = (opts.mnemonic ?? []).slice(0, 4).join(" ");
            const sats = Math.floor(decision.balanceMsats / 1000);
            const refuseErr = new Error(
              `Refusing to reset local Fedimint wallet: ${sats} sats are ` +
              `held under a seed that differs from your Nostr backup. ` +
              `Resetting destroys them permanently because Fedimint ecash ` +
              `is bearer cash and is not recoverable from the federation. ` +
              `Local seed: "${orphanFingerprint}…". ` +
              `Nostr seed: "${nostrFingerprint}…".`,
            );
            (refuseErr as Error & {
              code?: string;
              orphanBalanceMsats?: number;
            }).code = "ORPHAN_BALANCE_REFUSED";
            (refuseErr as Error & {
              code?: string;
              orphanBalanceMsats?: number;
            }).orphanBalanceMsats = decision.balanceMsats;
            throw refuseErr;
          } else if (decision.action === "refuse-unknown") {
            const refuseErr = new Error(
              "Refusing to reset the local Fedimint wallet: its balance " +
              "couldn't be confirmed right now (" + decision.reason + "). " +
              "If it holds ecash, resetting would destroy those sats " +
              "permanently — bearer cash is not recoverable from the " +
              "federation. Nothing was deleted. Check your connection and " +
              "reload to retry; if you're certain this wallet is empty, " +
              "reset it explicitly from Me → Advanced."
            );
            (refuseErr as Error & { code?: string }).code = "ORPHAN_BALANCE_UNKNOWN";
            (refuseErr as Error & { cause?: unknown }).cause = setErr;
            throw refuseErr;
          } else {
            // decision.action === "wipe" — positively confirmed empty.
            await installMnemonicInFreshFile(
              true,
              "setMnemonic rejected overwrite — auto-resetting OPFS " +
              `(orphan balance confirmed ${peek.kind === "no-client" ? "no-client" : "zero"}): ${setErr?.message}`
            );
          }
        }
      }
	      // Same seed already installed — nothing to do
	      if (allMatch && opts.storageScope && filenameSource === "legacy") {
	        rememberFilename(opts.storageScope, filename);
	      }
	      if (allMatch) {
	        console.info("[chama] Fedimint seed already matches Nostr backup — reusing");
	      }
    } else {
      // No existing seed → install ours
      await directorTyped.setMnemonic(opts.mnemonic);
      if (opts.storageScope && filenameSource === "legacy") {
        rememberFilename(opts.storageScope, filename);
      }
    }
  } else {
    // No seed supplied — let the director generate one, unless it already
    // has one persisted (testnet / CI path).
    try {
      const existing = await directorTyped.getMnemonic();
      if (!existing || existing.length === 0) {
        await directorTyped.generateMnemonic();
      }
    } catch {
      await directorTyped.generateMnemonic();
    }
  }

    const wallet = await director.createWallet();

  // C12 (v3.4.0): register the settled OPFS filename as the mint-lock
  // scope, so every mint op in every tab of this origin serializes on
  // the same Web Lock for THIS wallet file (and only this one — other
  // identities' wallet files get their own lock).
    setMintLockScope(filename);

    const adapted = adaptRealWallet(
      wallet as unknown as RealFedimintWallet,
      () => {
        clearRegisteredTransport();
        releaseRuntimeLease();
      },
      (notes) => (director as unknown as {
        parseOobNotes(notes: string): Promise<{
          total_amount: number;
          federation_id?: string | null;
          invite_code?: string | null;
        }>;
      }).parseOobNotes(notes),
      opts.forceRecoverOnJoin ?? Boolean(opts.mnemonic?.length),
      {
        storageScope: opts.storageScope,
        incident: incidentRecovery,
        rollbackFilename: recoveryRollbackFilename,
      },
      opts.allowRecoveryOnJoin === true,
    );
    walletReady = true;
    return adapted;
  } finally {
    if (!walletReady) {
      // If the fresh recovery database could not even initialize, return the
      // identity to its preserved file and retain the recovery request. A
      // transient worker/OPFS failure must never silently strand the pointer
      // on a half-created replacement.
      if (incidentRecovery && recoveryRollbackFilename) {
        updateBrowserWalletRecoveryJournal(opts.storageScope, {
          stage: "inconclusive",
          error: "Fresh recovery wallet initialization failed; restored the prior file pointer",
        });
        rememberFilename(opts.storageScope, recoveryRollbackFilename);
        requestBrowserWalletRecovery(opts.storageScope, incidentRecovery);
      }
      terminateCurrentWorker();
      releaseRuntimeLease();
    }
  }
}
