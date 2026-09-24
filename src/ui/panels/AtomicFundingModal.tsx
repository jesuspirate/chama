import { fundingPremiumMsats } from "../../payments/funding-premium.js";
import { errorText } from "../../payments/error-text.js";
import { simOnchainMode } from "../../sim/simMode.js";
import { PaymentCard, PaymentButton, PaymentRails, type PaymentRail } from "../components/PaymentCard.js";
import { fundingStorageFailure, type FundingStorageKey } from "../../payments/abandoned-invoices.js";
import { TradeAmount } from "../components/TradeAmount.js";
// ══════════════════════════════════════════════════════════════════════════
// Chama — AtomicFundingModal (v0.3.0 receive-side atomic flow)
// ══════════════════════════════════════════════════════════════════════════
//
// Listing-tap → exact-amount BOLT11 → ecash mints → LOCK fires, all in
// one user motion. Replaces the prior two-step "open FundWalletModal,
// generate invoice, pay, then tap Fund again to LOCK from balance" flow.
//
// Pillar 2.1 Option B: the user never sees an intermediate balance
// surface. The BOLT11 is the centerpiece of this modal — that IS the
// user's funding moment. Once payment lands and the federation credits,
// LOCK fires automatically and the modal auto-closes.
//
// Phase orchestration lives in src/payments/fund-and-lock.ts. This file
// is the React shell that renders phase transitions.

import { useEffect, useRef, useState } from "react";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { CopyButton } from "../components/CopyButton.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { isSimModeOn, setSimMode } from "../../sim/simMode.js";
import { makeLightningInvoiceQrPayload } from "../../payments/lightning-qr.js";
import {
  MIN_REAL_LIGHTNING_FUNDING_SATS,
  minimumLightningFundingMessage,
} from "../../payments/funding-limits.js";
import { isNwcConnectionString } from "../../payments/nwc.js";
import {
  addOrTouchSavedNwcConnection,
  listSavedNwcConnections,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import {
  MAX_LN_FUNDING_SATS,
  type FundAndLockPhase,
  type FundAndLockTerminal,
  type FundingGatewayInfo,
} from "../../payments/fund-and-lock.js";
import {
  isChapsmartOnrampEnabled,
  isChapsmartOnrampContext,
  ensureChapsmartAccount,
  getBuyQuoteForSats,
  lookupMpesaTransaction,
  sendBuySats,
  normalizeMpesaConfirmationCode,
  formatTzs,
  friendlyChapsmartError,
  ChapsmartApiError,
  CHAPSMART_MPESA_AGENT_NUMBER,
  CHAPSMART_MPESA_AGENT_NAME,
  CHAPSMART_MPESA_USSD,
  type ChapsmartBuyQuote,
} from "../../payments/chapsmart-onramp.js";
import type { OnchainDepositProgress, OnchainInfo } from "../../fedimint/fedimint-client.js";
import type { EscrowState, SelectedMenuItem } from "../../escrow-engine/types.js";


export interface AtomicFundingModalProps {
  /** Trade ID being funded. Passed through to fundAndLock. */
  escrowId: string;
  custodyNotice?: EscrowState["custodyNotice"];
  /** Exact trade amount in millisatoshis. */
  amountMsats: number;
  /** E1.1 arbiter insurance: extra msats folded into the funding invoice
   *  on top of the trade amount (the funder's 0.25% premium). The lock
   *  only ever spends the trade amount; this stays behind as the wallet
   *  residue the settle-time premium sweep pays to the arbiter. */
  premiumMsats?: number;
  /** Category-aware label ("Fund Escrow", "Pay for Item", etc.). */
  ctaLabel: string;
  /** Optional handle to reveal in the LOCK payload. */
  savedHandleId?: string;
  /** Optional menu basket snapshot to attach to LOCK. */
  selectedItems?: SelectedMenuItem[];
  /** User's home community (e.g. "sn-cfa"). Trade-context metadata kept
   *  on the funding modal; the pre-LOCK external-swap CTA was removed in
   *  the 2026-06-24 fiat-ramps pass (all swaps are offramp-only, post-
   *  CLAIM), so these are presently informational only. */
  homeCommunity?: string | null;
  /** Active trade community (most specific context). */
  tradeCommunity?: string | null;
  /** Active trade fiat currency. */
  fiatCurrency?: string | null;
  /** Trade category ("marketplace" | "p2p-trade" | "bill-pay" | …). Gates
   *  the ChapSmart M-Pesa on-ramp: Exchange ("p2p-trade") is excluded —
   *  there the seller funds and Exchange IS the P2P on-ramp. */
  tradeCategory?: string | null;
  /** Bound to actions.fundAndLock from useEscrow. */
  fundAndLock: (
    escrowId: string,
    opts: {
      amountMsats: number;
      premiumMsats?: number;
      description: string;
      fundingMethod?: "lightning" | "onchain" | "nwc" | "ecash" | "balance";
      ecashNotes?: string;
      nwcConnectionString?: string;
      rememberNwc?: boolean;
      savedHandleId?: string;
      selectedItems?: SelectedMenuItem[];
      onPhase: (phase: FundAndLockPhase) => void;
      signal?: AbortSignal;
    },
  ) => Promise<FundAndLockTerminal>;
  /** Reads federation wallet-module onchain fees before showing the slow path. */
  getOnchainInfo: () => Promise<OnchainInfo>;
  subscribeDeposit?: (operationId: string, cb: (progress: OnchainDepositProgress) => void) => () => void;
  supportsOnchain?: boolean;
  spendableMsats?: number;
  /** Bound to actions.lockAndPublish — used for the "Try LOCK now"
   *  retry path on mint-timeout (balance landed, but watchdog gave up
   *  on the mint settling within 60s). */
  lockAndPublish: (escrowId: string, opts: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
  }) => Promise<unknown>;
  /** Hide NWC in environments where funding must stay on an internal
   *  wallet route, e.g. Fedi Mini-App. */
  disableNwc?: boolean;
  /** Fail-closed product gate for a browser receive route with confirmed
   *  paid-invoice claim failures. The data layer independently enforces it. */
  browserLightningBlocked?: boolean;
  /** Localhost-only, one-invoice diagnostic permission. This opens manual
   *  Lightning only; NWC remains behind the product circuit breaker. */
  browserLightningProbeArmed?: boolean;
  /** Closed when the modal terminates (success or user cancel). The
   *  consumer can read the terminal kind to decide post-modal navigation
   *  (e.g. show success toast on locked, error toast on lock-failed). */
  onClose: (terminal: FundAndLockTerminal) => void;
}

type ModalPhase =
  | { kind: "choose-method" }
  | { kind: "creating-invoice" }
  | { kind: "creating-invoice-slow" }
  | { kind: "creating-onchain-address" }
  | {
      kind: "awaiting-onchain-confirmations";
      address: string;
      operationId: string;
      finalityDelay: number;
      pegInFeeSats: number;
      depositAmountSats: number;
      minimumDepositSats: number;
    }
  | { kind: "requesting-fedi-ecash" }
  | { kind: "fedi-ecash-created" }
  | {
      kind: "awaiting-payment";
      bolt11: string;
      expiresAt: number;
      /** Gateway that minted this invoice, when the wallet can say. */
      gateway?: FundingGatewayInfo;
    }
  | { kind: "paying-with-nwc" }
  | { kind: "mint-confirming"; bolt11: string; expiresAt: number }
  | { kind: "mint-confirming-slow"; bolt11: string; expiresAt: number }
  | { kind: "receive-rejected"; reason: string }
  | { kind: "payment-confirmed" }
  | { kind: "locking" }
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "mint-timeout" }
  | { kind: "aborted" }
  | { kind: "funding-not-started"; reason: FundingStorageKey }
  | { kind: "lock-failed"; error: string; errorKey?: FundingStorageKey; invoiceFailed?: boolean };

export function AtomicFundingModal({
  escrowId,
  amountMsats,
  premiumMsats: requestedPremiumMsats = 0,
  ctaLabel,
  savedHandleId,
  selectedItems,
  homeCommunity,
  tradeCommunity,
  fiatCurrency,
  tradeCategory,
  fundAndLock,
  getOnchainInfo,
  subscribeDeposit,
  spendableMsats = 0,
  supportsOnchain = false,
  lockAndPublish,
  disableNwc = false,
  browserLightningBlocked = false,
  browserLightningProbeArmed = false,
  onClose, custodyNotice,
}: AtomicFundingModalProps) {
  const { t } = useT();
  const premiumMsats = fundingPremiumMsats(requestedPremiumMsats);
  const requiredMsats = amountMsats + premiumMsats;
  const hasBalance = Number.isSafeInteger(requiredMsats) && amountMsats > 0 && spendableMsats >= requiredMsats;
  const amountSats = Math.floor(amountMsats / 1000);
  // E1.1: the invoice/deposit ask = trade + insurance; the header shows
  // the total the payer will actually see in their wallet.
  const insuranceSats = Math.floor(Math.max(0, premiumMsats) / 1000);
  const totalSats = amountSats + insuranceSats;
  const [request, setRequest] = useState<{ rail: "lightning" | "onchain"; data: string; value: string; sats: number; expiresAt?: number; fee?: number; finality?: number; gateway?: FundingGatewayInfo } | null>(null);
  const [initialRail, setInitialRail] = useState<PaymentRail>("lightning");
  const [switchRequested, setSwitchRequested] = useState<PaymentRail | null>(null);
  const autoLightning = !disableNwc && !hasBalance
    && (!browserLightningBlocked || browserLightningProbeArmed)
    && (isSimModeOn() || amountSats >= MIN_REAL_LIGHTNING_FUNDING_SATS);
  const [phase, setPhase] = useState<ModalPhase>({ kind: autoLightning ? "creating-invoice" : "choose-method" });
  const [fundingMethod, setFundingMethod] = useState<"lightning" | "onchain" | "nwc" | "ecash" | "balance" | null>(autoLightning ? "lightning" : null);
  const [ecashInput, setEcashInput] = useState("");
  const [savedNwcConnections, setSavedNwcConnections] = useState<SavedNwcConnection[]>(
    () => disableNwc ? [] : listSavedNwcConnections(),
  );
  const [nwcInput, setNwcInput] = useState("");
  const [rememberNwc, setRememberNwc] = useState(true);
  const [selectedNwcConnection, setSelectedNwcConnection] = useState<string | null>(null);
  const [onchainInfoState, setOnchainInfoState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; info: OnchainInfo }
    | { kind: "error"; error: string }
  >({ kind: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  const [tryLockBusy, setTryLockBusy] = useState(false);
  const [depositProgress, setDepositProgress] = useState<OnchainDepositProgress | null>(null);
  const depositOperation = phase.kind === "awaiting-onchain-confirmations" ? phase.operationId : null;
  const subscribeDepositRef = useRef(subscribeDeposit);
  subscribeDepositRef.current = subscribeDeposit;
  useEffect(() => {
    setDepositProgress(null);
    if (depositOperation && subscribeDepositRef.current) return subscribeDepositRef.current(depositOperation, setDepositProgress);
  }, [depositOperation]);
  // ChapSmart M-Pesa on-ramp sub-flow (TZ only, non-Exchange, off in sim).
  // ChapSmart pays the SAME displayed BOLT11 — the receive-watcher and LOCK
  // flow underneath are untouched; this is purely an alternate payer UX.
  const [mpesaOpen, setMpesaOpen] = useState(false);
  const mpesaAvailable =
    isChapsmartOnrampEnabled() &&
    !isSimModeOn() &&
    isChapsmartOnrampContext({ homeCommunity, tradeCommunity, fiatCurrency, tradeCategory });
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setOnchainInfoState({ kind: "loading" });
    if (!supportsOnchain) return;
    getOnchainInfo()
      .then((info) => {
        if (!cancelled) setOnchainInfoState({ kind: "ready", info });
      })
      .catch((e: any) => {
        if (!cancelled) {
          setOnchainInfoState({
            kind: "error",
            error: errorText(e, "Onchain funding unavailable"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Read once per capability change. The funding action re-checks this before
    // allocating an address, so this surface is only the UX gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsOnchain]);

  // Phase-driven main loop. Re-runs when the user taps "Generate new
  // invoice" (retryToken increments). Aborts on unmount.
  useEffect(() => {
    if (!fundingMethod) return;
    settledRef.current = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let lastBolt11: string | null = null;
    let lastExpiresAt: number | null = null;
    let lastGateway: FundingGatewayInfo | undefined;

    const run = async () => {
      const terminal = await fundAndLock(escrowId, {
        amountMsats,
        premiumMsats,
        description: `Chama trade · ${ctaLabel}`,
        fundingMethod,
        ecashNotes: fundingMethod === "ecash" ? ecashInput.trim() : undefined,
        nwcConnectionString: selectedNwcConnection ?? undefined,
        rememberNwc,
        savedHandleId,
        selectedItems,
        signal: ctrl.signal,
        onPhase: (p) => {
          // v0.6.5: drop emits from an aborted run. React StrictMode
          // double-mounts effects in dev — first mount → cleanup
          // (ctrl.abort) → second mount → new run. Without this
          // guard, the FIRST run's late `aborted` emit (and any
          // other phase events it produces post-abort) leaks into
          // the modal's setPhase and silently flips state to
          // `aborted`, which has no render branch — modal goes
          // black. The fix scopes phase events to the live run
          // strictly via the closed-over ctrl.signal.
          if (ctrl.signal.aborted) return;
          if (p.kind === "invoice-created") {
            setRequest({ rail: "lightning", data: makeLightningInvoiceQrPayload(p.bolt11), value: p.bolt11, sats: totalSats, expiresAt: p.expiresAt, gateway: p.gateway });
            lastBolt11 = p.bolt11;
            lastExpiresAt = p.expiresAt;
            lastGateway = p.gateway;
            setPhase({
              kind: "awaiting-payment",
              bolt11: p.bolt11,
              expiresAt: p.expiresAt,
              gateway: p.gateway,
            });
            return;
          }
          if (p.kind === "creating-invoice") {
            setPhase({ kind: "creating-invoice" });
            return;
          }
          if (p.kind === "creating-invoice-slow") {
            // v0.6.5: flip to the honest "still trying, federation
            // is slow" surface. The orchestrator keeps racing the
            // createFundingInvoice call against the hard timeout
            // underneath; this just keeps the user informed.
            setPhase({ kind: "creating-invoice-slow" });
            return;
          }
          if (p.kind === "creating-onchain-address") {
            setPhase({ kind: "creating-onchain-address" });
            return;
          }
          if (p.kind === "onchain-address-created" || p.kind === "awaiting-onchain-confirmations") {
            setRequest({ rail: "onchain", data: makeBitcoinUri(p.address, p.depositAmountSats), value: p.address, sats: p.depositAmountSats, fee: p.pegInFeeSats, finality: p.finalityDelay });
            setPhase({
              kind: "awaiting-onchain-confirmations",
              address: p.address,
              operationId: p.operationId,
              finalityDelay: p.finalityDelay,
              pegInFeeSats: p.pegInFeeSats,
              depositAmountSats: p.depositAmountSats,
              minimumDepositSats: p.minimumDepositSats,
            });
            return;
          }
          if (p.kind === "onchain-deposit-confirmed") {
            setPhase({ kind: "payment-confirmed" });
            return;
          }
          if (p.kind === "requesting-fedi-ecash" || p.kind === "fedi-ecash-created") {
            setPhase(p);
            return;
          }
          if (p.kind === "receive-watch-ready") {
            return;
          }
          if (p.kind === "awaiting-payment") {
            // pollForFunding emits this on entry; we need the BOLT11
            // already resolved from the prior "invoice-created" phase.
            if (lastBolt11 && lastExpiresAt) {
              setPhase({
                kind: "awaiting-payment",
                bolt11: lastBolt11,
                expiresAt: lastExpiresAt,
                gateway: lastGateway,
              });
            }
            return;
          }
          if (p.kind === "mint-confirming") {
            setMpesaOpen(false);
            if (lastBolt11 && lastExpiresAt) {
              setPhase({
                kind: "mint-confirming",
                bolt11: lastBolt11,
                expiresAt: lastExpiresAt,
              });
            }
            return;
          }
          if (p.kind === "mint-confirming-slow") {
            // v0.5.1: federation has been crediting for a while without
            // finishing. Flip the UI to the explicit wait-vs-cancel
            // surface; the poll loop keeps running underneath.
            if (lastBolt11 && lastExpiresAt) {
              setPhase({
                kind: "mint-confirming-slow",
                bolt11: lastBolt11,
                expiresAt: lastExpiresAt,
              });
            }
            return;
          }
          if (p.kind === "receive-rejected") {
            setPhase({ kind: "receive-rejected", reason: p.reason });
            return;
          }
          // payment-confirmed / locking / locked / expired / mint-timeout
          // / aborted / lock-failed all map directly.
          setPhase(p as ModalPhase);
        },
      });
      // After loop terminates: if it's a TERMINAL state that should
      // dismiss the modal automatically (locked → success), do it after
      // a brief delay so the user sees the success state.
      if (settledRef.current) return; // Try-LOCK retry path took over
      if (terminal.kind === "locked") {
        if (fundingMethod === "nwc" && rememberNwc && selectedNwcConnection) {
          try {
            addOrTouchSavedNwcConnection(selectedNwcConnection);
            setSavedNwcConnections(listSavedNwcConnections());
          } catch {}
        }
        setTimeout(() => onClose(terminal), 1200);
      } else if (terminal.kind === "aborted") {
        // No callback — user already triggered close.
      }
      // expired / mint-timeout / lock-failed leave the modal open with
      // a retry/cancel surface; user dismisses explicitly.
    };

    run().catch((e) => {
      if (ctrl.signal.aborted) return;
      const storageFailure = fundingStorageFailure(e);
      if (storageFailure) { setPhase(storageFailure); return; }
      // runFundAndLock catches its own errors; this is defensive.
      setPhase({ kind: "lock-failed", error: errorText(e, t("fund.unexpectedError")) });
    });

    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken, fundingMethod]);

  // 1Hz tick for the countdown timer when an invoice is live.
  useEffect(() => {
    if (
      phase.kind !== "awaiting-payment" &&
      phase.kind !== "mint-confirming" &&
      phase.kind !== "mint-confirming-slow"
    ) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase.kind]);

  const handleCancel = () => {
    abortRef.current?.abort();
    settledRef.current = true;
    onClose({ kind: "aborted" });
  };

  const handleRegenerate = () => {
    setRequest(null);
    setFundingMethod(autoLightning ? "lightning" : null);
    setSelectedNwcConnection(null);
    setPhase({ kind: autoLightning ? "creating-invoice" : "choose-method" });
    setRetryToken((t) => t + 1);
  };

  const manualLightningBlocked = browserLightningBlocked && !browserLightningProbeArmed;

  const handleSelectMethod = (method: "lightning" | "onchain") => {
    if (method === "lightning" && manualLightningBlocked) return;
    if (
      method === "lightning" &&
      !isSimModeOn() &&
      amountSats < MIN_REAL_LIGHTNING_FUNDING_SATS
    ) return;
    if (method === "onchain" && onchainInfoState.kind !== "ready") {
      setInitialRail("onchain"); setFundingMethod(null); setPhase({ kind: "choose-method" }); return;
    }
    if (method === "onchain" && onchainInfoState.kind === "ready") {
      const minimumDepositSats = Math.max(
        1,
        Math.trunc(onchainInfoState.info.minimumDepositSats || onchainInfoState.info.pegInFeeSats + 1),
      );
      if (amountSats < minimumDepositSats) {
        setInitialRail("onchain"); setFundingMethod(null); setPhase({ kind: "choose-method" }); return;
      }
    }
    setFundingMethod(method);
    setPhase(
      method === "lightning"
        ? { kind: "creating-invoice" }
        : { kind: "creating-onchain-address" },
    );
  };

  const handleSelectNwc = (connectionString: string, remember: boolean) => {
    if (browserLightningBlocked) return;
    if (!isSimModeOn() && amountSats < MIN_REAL_LIGHTNING_FUNDING_SATS) return;
    if (!isNwcConnectionString(connectionString)) return;
    setSelectedNwcConnection(connectionString.trim());
    setRememberNwc(remember);
    setFundingMethod("nwc");
    setPhase({ kind: "creating-invoice" });
  };

  const handleSelectEcash = () => {
    if (!ecashInput.trim()) return;
    setFundingMethod("ecash");
    setPhase({ kind: "locking" });
  };

  const handleTryLockNow = async () => {
    settledRef.current = true;
    abortRef.current?.abort();
    setTryLockBusy(true);
    try {
      await lockAndPublish(escrowId, { savedHandleId, selectedItems });
      setPhase({ kind: "locked" });
      setTimeout(() => onClose({ kind: "locked" }), 1200);
    } catch (e: any) {
      setPhase({ kind: "lock-failed", error: errorText(e, t("fund.lockFailedFallback")) });
    } finally {
      setTryLockBusy(false);
    }
  };


  return (
    <div onClick={handleCancel} style={{
      // v0.6.5: 0xee alpha (≈93%) instead of 0xcc (80%). On first-fire
      // the modal can sit on the CreatingInvoice spinner for a few
      // seconds while the WASM client and federation warm up; with
      // the looser backdrop the TradeDetail page behind it (including
      // the Fund button's transient "Funding…" label) was visually
      // bleeding through and reading like a glitch.
      position: "fixed", inset: 0, background: "#000e", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16, animation: "fadeIn 0.2s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
        padding: "20px 16px", maxWidth: 420, width: "100%", maxHeight: "92dvh", overflowY: "auto", boxSizing: "border-box",
      }}>
        {/* Header — amount is the eyebrow, label is the title */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              {ctaLabel.toUpperCase()}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
              {!request && <TradeAmount msats={totalSats * 1000} size={22} interactive />}
            </div>
            {insuranceSats > 0 && (
              <div style={{ fontSize: 9.5, color: T.muted, fontFamily: T.mono, marginTop: 4, display: "flex", alignItems: "baseline", gap: 4 }}>
                {t("fund.insuranceBefore")} <BitcoinAmount sats={insuranceSats} size={9.5} gap={3} glyphScale={1.15} color={T.muted} glyphColor={T.muted} /> {t("fund.insuranceAfter")}
              </div>
            )}
          </div>
          <button type="button" onClick={handleCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1, minWidth: 44, minHeight: 44,
          }}>×</button>
        </div>

        {phase.kind === "choose-method" && hasBalance && <div style={{ marginBottom: 16 }}>
          <p>{t(premiumMsats > 0 ? "fund.useBalanceWithInsurance" : "fund.useBalance", { amount: totalSats.toLocaleString(), trade: amountSats.toLocaleString(), insurance: insuranceSats.toLocaleString(), balance: Math.floor(spendableMsats / 1000).toLocaleString() })}</p>
          <PaymentButton tier="primary" onClick={() => { setPhase({ kind: "locking" }); setFundingMethod("balance"); }}>{t("fund.lockBalance")}</PaymentButton>
        </div>}
        {phase.kind === "choose-method" && (
          <FundingMethodChooser
            initialRail={initialRail}
            amountSats={amountSats}
            supportsOnchain={supportsOnchain}
            onchainInfoState={onchainInfoState}
            onSelect={handleSelectMethod}
            savedNwcConnections={disableNwc ? [] : savedNwcConnections}
            nwcInput={nwcInput}
            rememberNwc={rememberNwc}
            onNwcInputChange={setNwcInput}
            onRememberNwcChange={setRememberNwc}
            onSelectNwc={handleSelectNwc}
            ecashInput={ecashInput}
            onEcashInputChange={setEcashInput}
            onSelectEcash={handleSelectEcash}
            disableNwc={disableNwc}
            browserLightningBlocked={manualLightningBlocked}
            browserNwcBlocked={browserLightningBlocked}
          />
        )}

        {request && !mpesaOpen ? <>
          <PaymentCard amountMsats={request.sats * 1000} rail={request.rail}
            rails={phase.kind === "awaiting-payment" || phase.kind === "expired" ? (supportsOnchain ? ["lightning", "onchain", "ecash"] : ["lightning", "ecash"]) : [request.rail]}
            onRail={rail => { if (rail !== request.rail) setSwitchRequested(rail); }}
            data={request.data} copyValue={request.value}
            motion={["mint-confirming", "mint-confirming-slow", "payment-confirmed", "locking"].includes(phase.kind)}
            status={custodyNotice ? <>{t(custodyNotice.status === "expired-unacked" ? "trade.custodyExpiredTitle" : custodyNotice.status === "acknowledged-with-rejection" ? "trade.custodyRejectionTitle" : "trade.custodyPendingTitle")}<br />{custodyNotice.message || t("trade.custodyPendingBody")}</>
              : phase.kind === "receive-rejected" ? phase.reason
              : phase.kind === "lock-failed" ? (phase.errorKey ? t(phase.errorKey) : phase.error)
              : phase.kind === "expired" ? t("fund.invoiceExpired")
              : phase.kind === "locking" ? t("fund.locking")
              : phase.kind === "locked" ? t("fund.paymentReceived")
              : phase.kind === "awaiting-onchain-confirmations" ? (depositProgress ? <DepositProgressLine progress={depositProgress} finality={request.finality ?? 0} /> : t("fund.waitingConfirmations", { count: request.finality ?? 0 }))
              : phase.kind === "awaiting-payment" ? t("fund.waitingForPayment", { time: `${Math.floor(Math.max(0, (request.expiresAt ?? now) - now) / 60000)}:${Math.floor(Math.max(0, (request.expiresAt ?? now) - now) / 1000 % 60).toString().padStart(2, "0")}` })
              : t("fund.confirmingFederation")}
            helper={isSimModeOn() ? <>{t(request.rail === "onchain" ? (simOnchainMode() === "stuck" ? "fund.simOnchainStuck" : "fund.simOnchainDeposit") : "fund.simAutoCredit")} {t("fund.simDoNotFund")}</> : request.rail === "onchain" ? t("fund.onchainSlowPath") : t("fund.staleInvoice")}
            details={<><FundingCheckout tradeSats={amountSats} feeSats={(request.fee ?? 0) + premiumMsats / 1000} />
              {request.gateway && <div>{t("fund.viaGateway")} {request.gateway.alias || request.gateway.id}{!request.gateway.provenPayable && <div>{t("fund.gatewayUnproven")}</div>}</div>}
            </>}
            actions={<>{phase.kind === "expired" && <PaymentButton onClick={handleRegenerate}>{t("fund.newInvoice")}</PaymentButton>}
              {phase.kind === "mint-timeout" && <MintTimeoutState busy={tryLockBusy} onTryLockNow={handleTryLockNow} onCancel={handleCancel} />}
              {mpesaAvailable && phase.kind === "awaiting-payment" && <PaymentButton onClick={() => setMpesaOpen(true)}>{t("fund.fundWithMpesa")}</PaymentButton>}</>} />
          {switchRequested && <div role="dialog" aria-label={t("payment.switchTitle")} style={{ padding: 14, border: `1px solid ${T.borderHi}`, borderRadius: 16 }}>
            <p>{t("payment.switchPending")}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <PaymentButton tier="quiet" onClick={() => setSwitchRequested(null)}>{t("payment.keepLightning")}</PaymentButton>
              <PaymentButton tier="primary" disabled={phase.kind !== "expired"} onClick={() => {
                const rail = switchRequested; setSwitchRequested(null); setRequest(null); abortRef.current?.abort();
                if (rail === "ecash") { setInitialRail("ecash"); setFundingMethod(null); setPhase({ kind: "choose-method" }); }
                else handleSelectMethod(rail);
              }}>{t("payment.switch")}</PaymentButton>
            </div>
          </div>}
        </> : <>
        {phase.kind === "creating-invoice" && <CreatingInvoice slow={false} />}

        {phase.kind === "creating-invoice-slow" && (
          <CreatingInvoice slow={true} onCancel={handleCancel} />
        )}

        {phase.kind === "requesting-fedi-ecash" && (
          <RequestingFediEcash amountSats={amountSats} onCancel={handleCancel} />
        )}

        {phase.kind === "creating-onchain-address" && <CreatingOnchainAddress />}

        {phase.kind === "awaiting-onchain-confirmations" && (
          <OnchainAddressDisplay
            address={phase.address}
            amountSats={amountSats}
            depositAmountSats={phase.depositAmountSats}
            pegInFeeSats={phase.pegInFeeSats}
            finalityDelay={phase.finalityDelay}
          />
        )}

        {phase.kind === "fedi-ecash-created" && <PaymentConfirmed amountSats={amountSats} />}

        {phase.kind === "paying-with-nwc" && <PayingWithNwc amountSats={amountSats} />}

        {(phase.kind === "awaiting-payment" || phase.kind === "mint-confirming") && (
          mpesaOpen && phase.kind === "awaiting-payment" ? (
            <ChapsmartMpesaPanel
              amountSats={amountSats}
              bolt11={phase.bolt11}
              expiresAt={phase.expiresAt}
              now={now}
              onBack={() => setMpesaOpen(false)}
            />
          ) : (
            <InvoiceDisplay
              amountSats={totalSats}
              bolt11={phase.bolt11}
              expiresAt={phase.expiresAt}
              now={now}
              phaseKind={phase.kind}
              gateway={phase.kind === "awaiting-payment" ? phase.gateway : undefined}
              onFundWithMpesa={
                mpesaAvailable && phase.kind === "awaiting-payment"
                  ? () => setMpesaOpen(true)
                  : undefined
              }
            />
          )
        )}

        {phase.kind === "mint-confirming-slow" && (
          <MintConfirmingSlowState
            amountSats={amountSats}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "receive-rejected" && (
          <ReceiveRejectedState
            amountSats={amountSats}
            reason={phase.reason}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "payment-confirmed" && <PaymentConfirmed amountSats={amountSats} />}

        {phase.kind === "locking" && <Locking />}

        {phase.kind === "locked" && <LockedSuccess amountSats={amountSats} />}

        {phase.kind === "expired" && (
          <ExpiredState
            onRegenerate={handleRegenerate}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "mint-timeout" && (
          <MintTimeoutState
            busy={tryLockBusy}
            onTryLockNow={handleTryLockNow}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "funding-not-started" && (
          <div data-funding-preflight role="alert" style={{ padding: 20, fontFamily: T.sans, fontSize: 14, lineHeight: 1.5, color: T.text, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r }}>
            <h3 style={{ marginTop: 0 }}>{t("fund.notStartedTitle")}</h3>
            <p>{t("fund.notStartedBody")}</p>
            <p>{t(phase.reason)}</p>
            <div style={{ display: "flex", gap: 12 }}>
              <PaymentButton onClick={handleRegenerate}>{t("fund.tryAgain")}</PaymentButton>
              <PaymentButton onClick={handleCancel}>{t("common.cancel")}</PaymentButton>
            </div>
          </div>
        )}
        {phase.kind === "lock-failed" && (
          <LockFailedState
            error={phase.errorKey ? t(phase.errorKey) : phase.error}
            invoiceFailed={phase.invoiceFailed}
            onRetry={handleRegenerate}
            onCancel={() => onClose(phase)}
          />
        )}

        </>}
        {/* v0.6.5: explicit no-op for the `aborted` phase. Pre-this-fix
            phase=aborted had no render branch, so any stray aborted
            event from a torn-down StrictMode first-mount left the modal
            stuck with header + empty body. The closure-scoped emit
            guard above is the real fix; this branch is defense in
            depth so a future emit path can't black-hole the modal
            silently. Renders an explicit "Cancelled" surface so the
            state is at least visible and the user knows to tap × to
            close — though in practice the parent onClose dismissal
            should mean we never paint this. */}
        {phase.kind === "aborted" && (
          <div style={{
            padding: "24px 16px", textAlign: "center",
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.r,
          }}>
            <div style={{
              fontSize: 12, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1,
            }}>
              {t("fund.cancelled")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function FundingMethodChooser({
  supportsOnchain = false,
  initialRail = "lightning",
  amountSats,
  onchainInfoState,
  onSelect,
  savedNwcConnections,
  nwcInput,
  rememberNwc,
  onNwcInputChange,
  onRememberNwcChange,
  onSelectNwc,
  ecashInput,
  onEcashInputChange,
  onSelectEcash,
  disableNwc,
  browserLightningBlocked,
  browserNwcBlocked,
}: {
  supportsOnchain?: boolean;
  initialRail?: PaymentRail;
  amountSats: number;
  onchainInfoState:
    | { kind: "loading" }
    | { kind: "ready"; info: OnchainInfo }
    | { kind: "error"; error: string };
  onSelect: (method: "lightning" | "onchain") => void;
  savedNwcConnections: SavedNwcConnection[];
  nwcInput: string;
  rememberNwc: boolean;
  onNwcInputChange: (value: string) => void;
  onRememberNwcChange: (value: boolean) => void;
  onSelectNwc: (connectionString: string, remember: boolean) => void;
  ecashInput: string;
  onEcashInputChange: (value: string) => void;
  onSelectEcash: () => void;
  disableNwc?: boolean;
  browserLightningBlocked?: boolean;
  browserNwcBlocked?: boolean;
}) {
  const { t } = useT();
  const [rail, setRail] = useState<PaymentRail>(initialRail);
  const onchainGate = (() => {
    if (onchainInfoState.kind === "loading") {
      return {
        disabled: true,
        detail: t("fund.checkingOnchainFee"),
        pegInFeeSats: undefined,
        depositAmountSats: undefined,
      };
    }
    if (onchainInfoState.kind === "error") {
      return {
        disabled: true,
        detail: t("fund.onchainUnavailable"),
        pegInFeeSats: undefined,
        depositAmountSats: undefined,
      };
    }

    const pegInFeeSats = Math.max(0, Math.trunc(onchainInfoState.info.pegInFeeSats));
    const minimumDepositSats = Math.max(
      1,
      Math.trunc(onchainInfoState.info.minimumDepositSats || pegInFeeSats + 1),
    );
    if (amountSats < minimumDepositSats) {
      return {
        disabled: true,
        detail: <FundingCheckout tradeSats={amountSats} feeSats={pegInFeeSats} minimumSats={minimumDepositSats} />,
        pegInFeeSats,
        depositAmountSats: undefined,
      };
    }
    return {
      disabled: false,
      detail: <FundingCheckout tradeSats={amountSats} feeSats={pegInFeeSats} />,
      pegInFeeSats,
      depositAmountSats: amountSats + pegInFeeSats,
    };
  })();
  const nwcReady = isNwcConnectionString(nwcInput);
  const lightningTooSmall =
    !isSimModeOn() && amountSats < MIN_REAL_LIGHTNING_FUNDING_SATS;
  const lightningDisabled = lightningTooSmall || browserLightningBlocked;
  const nwcDisabled = lightningTooSmall || browserNwcBlocked;
  // #65: above the LN routing ceiling, a single Lightning payment likely won't
  // route through the federation's gateway. Warn + steer to on-chain (which is
  // available here whenever onchainGate is not disabled). Never hard-blocks.
  const largeAmount = amountSats > MAX_LN_FUNDING_SATS;

  if (disableNwc) {
    return (
      <div>
        <div style={{
          marginBottom: 12, padding: 14, borderRadius: T.r,
          background: T.tealDim, border: `1px solid ${T.teal}66`,
        }}>
          <div style={{
            fontSize: 9, color: T.teal, fontFamily: T.mono,
            letterSpacing: 1, fontWeight: 900, marginBottom: 8,
          }}>
            {t("fund.fediWalletFunding")}
          </div>
          <div style={{
            fontSize: 11, color: T.text, fontFamily: T.mono,
            lineHeight: 1.55,
          }}>
            {t("fund.fediEcashBody")}
          </div>
        </div>

        <div style={{
          marginBottom: 12, padding: "8px 10px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          lineHeight: 1.45, textAlign: "center",
        }}>
          {t("fund.tradeAmountBefore")} <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />
        </div>

        <button
          type="button"
          disabled={lightningDisabled}
          onClick={() => onSelect("lightning")}
          style={{
            width: "100%", minHeight: 64, padding: "14px 16px",
            borderRadius: T.r, background: T.accent,
            border: `1px solid ${T.accent}`, color: "#000",
            cursor: lightningDisabled ? "not-allowed" : "pointer",
            opacity: lightningDisabled ? 0.55 : 1,
            fontFamily: T.mono, fontSize: 13,
            fontWeight: 900, letterSpacing: 0.5,
          }}
        >
          {t("fund.useFediWalletBefore")} <BitcoinAmount sats={amountSats} size={13} gap={4} glyphScale={1.18} color="#000" glyphColor="#000" />
        </button>
        {browserLightningBlocked && (
          <div style={{ marginTop: 8, color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45 }}>
            {t("fund.browserLightningBlockedBody", { amount: amountSats.toLocaleString() })}
          </div>
        )}
        {!browserLightningBlocked && lightningTooSmall && (
          <div style={{ marginTop: 8, color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.45 }}>
            {minimumLightningFundingMessage()}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {browserLightningBlocked && (
        <div style={{
          marginBottom: 12, padding: "12px 14px", borderRadius: T.r,
          background: T.redDim, border: `1px solid ${T.red}66`,
          color: T.red, fontFamily: T.mono, fontSize: 10.5, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 900, letterSpacing: 0.7, marginBottom: 5 }}>
            {t("fund.browserLightningBlockedTitle")}
          </div>
          <div>{t("fund.browserLightningBlockedBody", { amount: amountSats.toLocaleString() })}</div>
        </div>
      )}
      {largeAmount && (
        <div style={{
          marginBottom: 12, padding: "10px 12px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}66`,
          fontFamily: T.mono, fontSize: 10.5, color: T.amber, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 900, letterSpacing: 0.5, marginBottom: 4 }}>
            {t("fund.largeAmountTitle")}
          </div>
          <div>
            {onchainGate.disabled
              ? t("fund.largeAmountBodyNoOnchain")
              : t("fund.largeAmountBody")}
          </div>
        </div>
      )}
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.5, marginBottom: 12,
      }}>
        {t("fund.chooseMethodIntro")}
      </div>

      {/* The 2026-06-24 fiat-ramps pass removed the pre-LOCK external-swap
          CTA: nobody onramps in-app, so funding surfaces no provider.
          External swaps are offramp-only and live post-CLAIM in
          ClaimPayoutModal. */}

      {/* NWC remains available to experienced users without visually
          outranking the ordinary lock mechanisms. */}
      {!disableNwc && savedNwcConnections.length > 0 && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ color: T.muted, fontFamily: T.mono, fontSize: 9, cursor: "pointer" }}>
            NWC · {savedNwcConnections.length}
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {savedNwcConnections.map((connection) => (
              <button
                type="button"
                key={connection.id}
                disabled={nwcDisabled}
                onClick={() => onSelectNwc(connection.connectionString, true)}
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: T.r,
                  background: T.accentDim, border: `1px solid ${T.accent}66`,
                  color: T.text, fontFamily: T.mono, fontSize: 12,
                  cursor: nwcDisabled ? "not-allowed" : "pointer",
                  opacity: nwcDisabled ? 0.55 : 1,
                  display: "flex",
                  justifyContent: "space-between", alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{
                  overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", fontWeight: 600,
                }}>
                  {connection.label}
                </span>
                <span style={{
                  color: T.accent, flexShrink: 0, fontSize: 9,
                  fontWeight: 800, letterSpacing: 1,
                }}>
                  {t("fund.autoPayArrow")}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}

      <PaymentRails rail={rail} rails={supportsOnchain ? ["lightning", "onchain", "ecash"] : ["lightning", "ecash"]} onSelect={setRail} />
      {rail === "ecash" && <details open style={{ marginBottom: 12 }}>
        <summary style={{
          padding: "10px 12px", borderRadius: T.rs, cursor: "pointer",
          background: T.tealDim, border: `1px solid ${T.teal}66`,
          color: T.teal, fontFamily: T.mono, fontSize: 11, fontWeight: 900,
          listStyle: "none",
        }}>
          ▦ {t("fund.ecashLockTitle")}
        </summary>
        <div style={{
          marginTop: 8, padding: 12, borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
        }}>
          <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5, marginBottom: 8 }}>
            {t("fund.ecashLockBody", { amount: amountSats.toLocaleString() })}
          </div>
          <textarea
            value={ecashInput}
            onChange={(event) => onEcashInputChange(event.target.value)}
            placeholder={t("fund.ecashPastePlaceholder")}
            rows={4}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ ...inputStyle, resize: "vertical", minHeight: 72, marginBottom: 8, fontSize: 10 }}
          />
          <PaymentButton tier="primary" tone="teal" disabled={!ecashInput.trim()} onClick={onSelectEcash} style={{ width: "100%" }}>{t("fund.lockWithEcash")}</PaymentButton>
        </div>
      </details>}

      {rail === "lightning" && <><p style={{ color: T.muted, fontSize: 12 }}>{browserLightningBlocked ? t("fund.browserLightningBlockedShort") : lightningTooSmall ? minimumLightningFundingMessage() : t("fund.bestForAlmostEveryone")}</p>
        <PaymentButton disabled={lightningDisabled} onClick={() => onSelect("lightning")}>{t("fund.lnFast")}</PaymentButton></>}
      {rail === "onchain" && <><div style={{ color: T.muted, fontSize: 12 }}>{onchainGate.detail}</div>
        {onchainInfoState.kind === "ready" && onchainGate.disabled
          ? <PaymentButton onClick={() => { setRail("lightning"); onSelect("lightning"); }}>{t("fund.useLightning")}</PaymentButton>
          : <PaymentButton disabled={onchainGate.disabled} onClick={() => onSelect("onchain")}>{t("fund.onchainSlow")}</PaymentButton>}</>}
      <div style={{
        marginTop: 12, padding: "8px 10px", borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.45, textAlign: "center",
      }}>
        {t("fund.tradeAmountBefore")} <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />
      </div>

      {!disableNwc && (
      <details style={{ marginTop: 12 }}>
        <summary style={{
          color: T.muted, fontFamily: T.mono, fontSize: 10,
          cursor: "pointer", listStyle: "none",
        }}>
          {savedNwcConnections.length > 0
            ? t("fund.addAnotherNwcWallet")
            : t("fund.moreOptionsNwc")}
        </summary>
        <div style={{
          marginTop: 10, padding: 12, borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
        }}>
          {/* v1.2.4: saved-wallet list moved up to top-level. This
              disclosure is now only for the paste-new-NWC setup
              path, which is uncommon enough to keep collapsed. */}
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 6,
          }}>
            {t("fund.pasteNwcConnection")}
          </div>
          <textarea
            value={nwcInput}
            onChange={(e) => onNwcInputChange(e.target.value)}
            placeholder="nostr+walletconnect://..."
            rows={3}
            style={{ ...inputStyle, resize: "vertical" as const, minHeight: 60, marginBottom: 8 }}
          />
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            marginBottom: 10, color: T.muted, fontFamily: T.mono,
            fontSize: 10, cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={rememberNwc}
              onChange={(e) => onRememberNwcChange(e.target.checked)}
            />
            {t("fund.rememberNwcWallet")}
          </label>
          <button
            disabled={!nwcReady || nwcDisabled}
            onClick={() => onSelectNwc(nwcInput, rememberNwc)}
            style={{
              width: "100%", padding: "11px 12px", borderRadius: T.rs,
              background: nwcReady && !nwcDisabled ? T.accent : T.card,
              border: `1px solid ${nwcReady && !nwcDisabled ? T.accent : T.border}`,
              color: nwcReady && !nwcDisabled ? "#000" : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: nwcReady && !nwcDisabled ? "pointer" : "not-allowed",
            }}
          >
            {t("fund.autoPayWithNwc")}
          </button>
        </div>
      </details>
      )}
    </div>
  );
}

function CreatingOnchainAddress() {
  const { t } = useT();
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.amberDim,
      border: `1px solid ${T.amber}44`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${T.amber}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{
        fontSize: 12, fontWeight: 700, color: T.amber,
        fontFamily: T.mono, letterSpacing: 0,
      }}>
        {t("fund.creatingOnchainAddress")}
      </div>
    </div>
  );
}

function makeBitcoinUri(address: string, amountSats: number): string {
  const btcAmount = (amountSats / 100_000_000)
    .toFixed(8)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return btcAmount ? `bitcoin:${address}?amount=${btcAmount}` : `bitcoin:${address}`;
}

function OnchainAddressDisplay({
  address,
  amountSats,
  depositAmountSats,
  pegInFeeSats,
  finalityDelay,
}: {
  address: string;
  amountSats: number;
  depositAmountSats: number;
  pegInFeeSats: number;
  finalityDelay: number;
}) {
  const { t } = useT();
  return <PaymentCard amountMsats={depositAmountSats * 1000} rail="onchain"
    data={makeBitcoinUri(address, depositAmountSats)} copyValue={address}
    status={t("fund.waitingConfirmations", { count: finalityDelay })}
    helper={t("fund.onchainSlowPath")}
    details={<><div>{t("payment.tradeAmount")}: <TradeAmount msats={amountSats * 1000} /></div>
      <div>{t("payment.fee")}: <TradeAmount msats={pegInFeeSats * 1000} /></div>
      <div>{t("payment.total")}: <TradeAmount msats={depositAmountSats * 1000} /></div>
      <div>{address}</div></>} />;
}

function RequestingFediEcash({
  amountSats,
  onCancel,
}: {
  amountSats: number;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div style={{
      padding: "24px 16px", textAlign: "center",
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${T.accent}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{
        fontSize: 12, fontWeight: 700, color: T.accent,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        {t("fund.requestingFediEcash")}
      </div>
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.5, marginBottom: 12,
      }}>
        {t("fund.approveInFediBefore")} <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("fund.approveInFediAfter")}
      </div>
      <button
        onClick={onCancel}
        style={{
          padding: "8px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10,
          fontWeight: 700, cursor: "pointer", letterSpacing: 0.3,
        }}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}

function CreatingInvoice({
  slow,
  onCancel,
}: {
  slow: boolean;
  onCancel?: () => void;
}) {
  const { t } = useT();
  // v0.6.5: pre-this-fix the tiny 8x8 dot + 9px text was hard to spot
  // at all, and at the modal scale read as "empty modal." Bumped to a
  // visible spinner + larger label so users know we're actively
  // working. The `slow` variant fires at DEFAULT_INVOICE_SLOW_WARN_MS
  // (10s) and surfaces an honest "federation is slow" message plus a
  // cancel affordance — the hard 45s timeout still fires underneath
  // and will flip to lock-failed if nothing comes back.
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: slow ? T.amberDim : T.surface,
      border: `1px solid ${slow ? T.amber + "44" : T.border}`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${slow ? T.amber : T.accent}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{
        fontSize: 12, fontWeight: 700,
        color: slow ? T.amber : T.accent,
        fontFamily: T.mono, letterSpacing: 1,
        marginBottom: slow ? 8 : 0,
      }}>
        {slow ? t("fund.federationIsSlow") : t("fund.generatingInvoice")}
      </div>
      {slow && (
        <>
          <div style={{
            fontSize: 11, color: T.text, fontFamily: T.sans,
            lineHeight: 1.5, marginTop: 6, marginBottom: 12,
          }}>
            {t("fund.federationSlowBody")}
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              style={{
                padding: "8px 16px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 10,
                fontWeight: 700, cursor: "pointer", letterSpacing: 0.3,
              }}
            >
              {t("common.cancel")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function PayingWithNwc({ amountSats }: { amountSats: number }) {
  const { t } = useT();
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${T.accent}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <div style={{
        fontSize: 12, fontWeight: 800, color: T.accent,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        {t("fund.requestingNwcPayment")}
      </div>
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.5,
      }}>
        {t("fund.askingWalletBefore")} <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />{t("fund.askingWalletAfter")}
      </div>
    </div>
  );
}

function InvoiceDisplay({
  bolt11, expiresAt, now, phaseKind, onFundWithMpesa, gateway, amountSats,
}: {
  bolt11: string;
  amountSats: number;
  expiresAt: number;
  now: number;
  phaseKind: "awaiting-payment" | "mint-confirming";
  /** Which Lightning gateway minted this invoice. Undefined when the wallet
   *  can't say (browser SDK, mock, sim, or an older bridge). */
  gateway?: FundingGatewayInfo;
  /** Present only when the ChapSmart M-Pesa on-ramp applies (TZ context,
   *  non-Exchange, enabled, not sim). Opens the pay-with-M-Pesa sub-flow. */
  onFundWithMpesa?: () => void;
}) {
  const { t } = useT();
  const remainingSec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const isMintConfirming = phaseKind === "mint-confirming";
  const qrPayload = makeLightningInvoiceQrPayload(bolt11);
  return <PaymentCard amountMsats={amountSats * 1000} rail="lightning" data={qrPayload} copyValue={bolt11}
    motion={isMintConfirming}
    status={isMintConfirming ? t("fund.confirmingFederation") : t("fund.waitingForPayment", { time: `${mins}:${secs.toString().padStart(2, "0")}` })}
    helper={isSimModeOn() ? <>{t("fund.simAutoCredit")} {t("fund.simDoNotFund")}</> : t("fund.staleInvoice")}
    details={gateway && <>{t("fund.viaGateway")} {gateway.alias || gateway.id.slice(0, 12)}{!gateway.provenPayable && <div>{t("fund.gatewayUnproven")}</div>}</>}
    actions={onFundWithMpesa && <PaymentButton onClick={onFundWithMpesa}>{t("fund.fundWithMpesa")}</PaymentButton>} />;
}

// ── ChapSmart M-Pesa on-ramp sub-flow ────────────────────────────────────
//
// ChapSmart pays the SAME funding BOLT11 the QR shows, in exchange for a
// TZS M-Pesa agent payment. Flow: exact-sats quote → the user pays the
// quoted TZS via the Kutoa-Pesa agent flow → pastes the SMS confirmation
// code → ChapSmart verifies + pays the invoice → the modal's existing
// receive-watcher detects the payment and the LOCK fires. Nothing below
// touches the escrow money-path.

type MpesaPanelState =
  | { kind: "quoting" }
  | { kind: "ready"; quote: ChapsmartBuyQuote; busy: boolean; inlineError: string | null }
  | { kind: "sent" }
  | { kind: "failed"; message: string; quoteExpired: boolean };

function ChapsmartMpesaPanel({
  amountSats, bolt11, expiresAt, now, onBack,
}: {
  amountSats: number;
  bolt11: string;
  expiresAt: number;
  now: number;
  onBack: () => void;
}) {
  const { t } = useT();
  const [state, setState] = useState<MpesaPanelState>({ kind: "quoting" });
  const [codeInput, setCodeInput] = useState("");
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const remainingSec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;

  const loadQuote = async () => {
    setState({ kind: "quoting" });
    try {
      const accountNumber = await ensureChapsmartAccount();
      const quote = await getBuyQuoteForSats({ targetSats: amountSats, accountNumber });
      if (aliveRef.current) setState({ kind: "ready", quote, busy: false, inlineError: null });
    } catch (e) {
      if (aliveRef.current) {
        setState({
          kind: "failed",
          message: friendlyChapsmartError(e),
          quoteExpired: e instanceof ChapsmartApiError && e.status === 410,
        });
      }
    }
  };
  useEffect(() => {
    void loadQuote();
    // Quote once per panel open; explicit retry buttons re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    if (state.kind !== "ready" || state.busy) return;
    const quote = state.quote;
    const mpesaId = normalizeMpesaConfirmationCode(codeInput);
    if (!mpesaId) {
      setState({ ...state, inlineError: t("fund.mpesaCodeInvalid") });
      return;
    }
    setState({ ...state, busy: true, inlineError: null });
    try {
      // Pre-validate via the read-only lookup — friendlier than a 409.
      // FAIL-SOFT on lookup errors (e.g. proxy route missing → 404):
      // send-sats is the authoritative validator either way.
      try {
        const seen = await lookupMpesaTransaction(mpesaId);
        if (!seen.found) {
          if (aliveRef.current) {
            setState({ ...state, busy: false, inlineError:
              t("fund.mpesaNotSeen") });
          }
          return;
        }
        if (typeof seen.amount === "number" && Math.round(seen.amount) !== Math.round(quote.amountTZS)) {
          if (aliveRef.current) {
            setState({ ...state, busy: false, inlineError:
              t("fund.mpesaAmountMismatch", { paid: formatTzs(seen.amount), needed: formatTzs(quote.amountTZS) }) });
          }
          return;
        }
      } catch { /* lookup unavailable — let send-sats decide */ }
      await sendBuySats({ quoteId: quote.quoteId, bolt11, mpesaId });
      if (aliveRef.current) setState({ kind: "sent" });
    } catch (e) {
      if (aliveRef.current) {
        if (e instanceof ChapsmartApiError && e.status === 410) {
          setState({ kind: "failed", message: friendlyChapsmartError(e), quoteExpired: true });
        } else {
          setState({ ...state, busy: false, inlineError: friendlyChapsmartError(e) });
        }
      }
    }
  };

  if (state.kind === "quoting") {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>🇹🇿</div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5 }}>
          {t("fund.gettingMpesaPrice")}
        </div>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div>
        <div style={{
          padding: "16px 14px", marginBottom: 12, borderRadius: T.r,
          background: T.amberDim, border: `1px solid ${T.amber}66`,
          fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.55,
        }}>
          {state.message}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button onClick={onBack} style={{
            padding: "10px 16px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}>
            {t("fund.backToInvoice")}
          </button>
          <button onClick={() => void loadQuote()} style={{
            padding: "10px 16px", borderRadius: T.rs,
            background: T.tealDim, border: `1px solid ${T.teal}66`,
            color: T.teal, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}>
            {state.quoteExpired ? t("fund.getNewQuote") : t("fund.tryAgain")}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "sent") {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>⚡</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.teal, fontFamily: T.sans, marginBottom: 6 }}>
          {t("fund.chapsmartPaying")}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.55 }}>
          {t("fund.chapsmartPayingBody")}
        </div>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 8, marginTop: 14, padding: "6px 12px", borderRadius: T.rs,
          background: T.tealDim, border: `1px solid ${T.teal}44`,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: T.teal, animation: "pulse 1.4s ease-in-out infinite",
          }} />
          <span style={{ fontSize: 10, fontFamily: T.mono, color: T.teal, letterSpacing: 0.5 }}>
            {t("fund.stillWaitingPayment")}
          </span>
        </div>
      </div>
    );
  }

  // ready
  const { quote, busy, inlineError } = state;
  // i18n: the Kutoa-Pesa agent steps render Swahili + English side by side.
  // The Sw keys are ALREADY localized content (they stay Swahili in every
  // language); fr/es adapt only the En half. Mirrors chapsmartMpesaPaySteps
  // (chapsmart-onramp.ts) — the exact TZS amount / agent number / USSD code
  // arrive as {params} so translations can never drift from the real rail.
  const tzsAmount = formatTzs(quote.amountTZS);
  const steps: { sw: string; en: string }[] = [
    {
      sw: t("fund.mpesaStep1Sw", { ussd: CHAPSMART_MPESA_USSD }),
      en: t("fund.mpesaStep1En", { ussd: CHAPSMART_MPESA_USSD }),
    },
    { sw: t("fund.mpesaStep2Sw"), en: t("fund.mpesaStep2En") },
    {
      sw: t("fund.mpesaStep3Sw", { agent: CHAPSMART_MPESA_AGENT_NUMBER }),
      en: t("fund.mpesaStep3En", { agent: CHAPSMART_MPESA_AGENT_NUMBER }),
    },
    {
      sw: t("fund.mpesaStep4Sw", { amount: tzsAmount }),
      en: t("fund.mpesaStep4En", { amount: tzsAmount }),
    },
    {
      sw: t("fund.mpesaStep5Sw", { name: CHAPSMART_MPESA_AGENT_NAME }),
      en: t("fund.mpesaStep5En", { name: CHAPSMART_MPESA_AGENT_NAME }),
    },
    { sw: t("fund.mpesaStep6Sw"), en: t("fund.mpesaStep6En") },
  ];
  return (
    <div>
      <div style={{
        padding: "12px 14px", marginBottom: 10, borderRadius: T.r,
        background: T.tealDim, border: `1px solid ${T.teal}66`, textAlign: "center",
      }}>
        <div style={{ fontSize: 9, color: T.teal, fontFamily: T.mono, letterSpacing: 1, fontWeight: 900, marginBottom: 4 }}>
          {t("fund.payExactly")}
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
          TZS {formatTzs(quote.amountTZS)}
        </div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
          {t("fund.quoteForBefore")} <BitcoinAmount sats={amountSats} size={9} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("fund.quoteForAfter")}
        </div>
      </div>

      <ol style={{ margin: "0 0 10px", padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
        {steps.map((step, i) => (
          <li key={i} style={{
            display: "flex", gap: 8, alignItems: "baseline",
            fontSize: 10.5, fontFamily: T.mono, color: T.text, lineHeight: 1.45,
          }}>
            <span style={{ color: T.teal, fontWeight: 800, flexShrink: 0 }}>{i + 1}.</span>
            <span>
              {step.sw}
              <span style={{ color: T.muted }}> · {step.en}</span>
            </span>
          </li>
        ))}
      </ol>

      <CopyButton
        value={CHAPSMART_MPESA_AGENT_NUMBER}
        label={t("fund.copyAgentNumber", { agent: CHAPSMART_MPESA_AGENT_NUMBER })}
        copiedLabel={t("common.copied")}
        style={{
          width: "100%", marginBottom: 10, padding: "8px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.mono, fontSize: 10.5, fontWeight: 700,
          cursor: "pointer",
        }}
      />

      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 6, lineHeight: 1.5 }}>
        {t("fund.mpesaPasteCode")}
      </div>
      <input
        value={codeInput}
        onChange={(e) => setCodeInput(e.target.value)}
        placeholder={t("fund.mpesaCodePlaceholder")}
        name="chama-mpesa-confirmation-code"
        autoComplete="off"
        data-bwignore="true"
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        style={{ ...inputStyle, marginBottom: 8, textTransform: "uppercase" }}
      />

      {inlineError && (
        <div style={{
          padding: "8px 12px", marginBottom: 8, borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          fontSize: 10, color: T.amber, fontFamily: T.mono, lineHeight: 1.5,
        }}>
          {inlineError}
        </div>
      )}

      <button
        onClick={() => void handleSubmit()}
        disabled={busy || !normalizeMpesaConfirmationCode(codeInput)}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: T.teal, border: `1px solid ${T.teal}`,
          color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 900,
          cursor: busy ? "wait" : "pointer",
          opacity: busy || !normalizeMpesaConfirmationCode(codeInput) ? 0.55 : 1,
        }}
      >
        {busy ? t("fund.verifyingChapsmart") : t("fund.iPaidSendSats")}
      </button>

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 10,
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", color: T.muted,
          fontFamily: T.mono, fontSize: 10, cursor: "pointer", padding: 0,
        }}>
          {t("fund.payWithLightningInstead")}
        </button>
        <span style={{ fontSize: 9, color: remainingSec < 300 ? T.amber : T.muted, fontFamily: T.mono }}>
          {t("fund.invoiceExpiresIn", { time: `${mins}:${secs.toString().padStart(2, "0")}` })}
        </span>
      </div>
    </div>
  );
}

function MintConfirmingSlowState({
  amountSats, onCancel,
}: { amountSats: number; onCancel: () => void }) {
  const { t } = useT();
  // v0.5.1: the federation has acknowledged the inbound payment but
  // hasn't finished crediting our wallet within mintSlowWarnMs (60s by
  // default). We flip from the optimistic "crediting…" surface to this
  // honest "keep waiting or cancel" state. The poll loop keeps running
  // underneath — no extra action needed to keep waiting.
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.amberDim, border: `1px solid ${T.amber}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.amber, fontFamily: T.sans, marginBottom: 4 }}>
          {t("fund.federationTakingItsTime")}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono, marginBottom: 6 }}>
          +<BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("fund.inbound")}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, wordBreak: "break-word" }}>
          {t("fund.mintConfirmingSlowBody")}
        </div>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs, background: T.amberDim,
        border: `1px solid ${T.amber}44`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: T.amber, animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.amber, letterSpacing: 0.5 }}>
          {t("fund.mintStillSettling")}
        </span>
      </div>
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("fund.cancelRecoverLater")}
      </button>
    </div>
  );
}

function ReceiveRejectedState({
  amountSats, reason, onCancel,
}: { amountSats: number; reason: string; onCancel: () => void }) {
  const { t } = useT();
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>✕</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          {t("fund.federationRejectedPayment")}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono, marginBottom: 6 }}>
          <BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("fund.notCredited")}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, wordBreak: "break-word" }}>
          {t("fund.gatewayCanceledBody", { reason })}
        </div>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs, background: T.redDim,
        border: `1px solid ${T.red}44`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: T.red, animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.red, letterSpacing: 0.5 }}>
          {t("fund.checkingBalanceBeforeStopping")}
        </span>
      </div>
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("fund.closeAndCheckLater")}
      </button>
    </div>
  );
}

function PaymentConfirmed({ amountSats }: { amountSats: number }) {
  const { t } = useT();
  return (
    <div style={{
      padding: "28px 16px", textAlign: "center",
      background: T.greenDim, border: `1px solid ${T.green}66`, borderRadius: T.r,
    }}>
      <div style={{ fontSize: 36, marginBottom: 8 }}>⚡</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 4 }}>
        {t("fund.paymentReceived")}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
        +<BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
      </div>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 10, letterSpacing: 1 }}>
        {t("fund.sealingTrade")}
      </div>
    </div>
  );
}

function Locking() {
  const { t } = useT();
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.purpleDim, border: `1px solid ${T.purple}44`, borderRadius: T.r,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: T.purple, animation: "pulse 1.4s ease-in-out infinite",
        margin: "0 auto 12px",
      }} />
      <div style={{ fontSize: 11, fontWeight: 600, color: T.purple, fontFamily: T.mono, letterSpacing: 1 }}>
        {t("fund.splittingShares")}
      </div>
    </div>
  );
}

function LockedSuccess({ amountSats }: { amountSats: number }) {
  const { t } = useT();
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.greenDim, border: `1px solid ${T.green}66`,
      borderRadius: T.r, animation: "fadeIn 0.3s ease",
    }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
        {t("fund.lockedInEscrow")}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
        <BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
      </div>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 12 }}>
        {t("fund.tradeLiveClosing")}
      </div>
    </div>
  );
}

function ExpiredState({
  onRegenerate, onCancel,
}: { onRegenerate: () => void; onCancel: () => void }) {
  const { t } = useT();
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⌛</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          {t("fund.invoiceExpired")}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          {t("fund.expiredBody")}
        </div>
      </div>
      <button
        onClick={onRegenerate}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: T.accent, border: `1px solid ${T.accent}`,
          color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
          cursor: "pointer", marginBottom: 8,
        }}
      >
        {t("fund.generateNewInvoice")}
      </button>
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}

function MintTimeoutState({
  busy, onTryLockNow, onCancel,
}: { busy: boolean; onTryLockNow: () => void; onCancel: () => void }) {
  const { t } = useT();
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.amberDim, border: `1px solid ${T.amber}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.amber, fontFamily: T.sans, marginBottom: 4 }}>
          {t("fund.mintTakingLonger")}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          {t("fund.mintSlowBody")}
        </div>
      </div>
      <button
        disabled={busy}
        onClick={onTryLockNow}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: busy ? T.surface : T.amber, border: `1px solid ${T.amber}`,
          color: busy ? T.muted : "#000",
          fontFamily: T.mono, fontSize: 12, fontWeight: 800,
          cursor: busy ? "not-allowed" : "pointer", marginBottom: 8,
        }}
      >
        {busy ? t("fund.locking") : t("fund.tryLockNow")}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: busy ? "not-allowed" : "pointer",
        }}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}

function LockFailedState({
  error, onCancel, onRetry, invoiceFailed,
}: { error: string; onCancel: () => void; onRetry?: () => void; invoiceFailed?: boolean }) {
  const { t } = useT();
  const isNativeBridgeUnavailable =
    /native_fedimint_bridge_unavailable|Native Fedimint bridge is enabled but unreachable/i.test(error);
  const isWalletVerifiableGatewayError =
    /wallet-verifiable Lightning receive gateway/i.test(error);
  const isReceiveRoutePaused =
    /receive_federation_route_paused|Lightning funding is temporarily paused/i.test(error);
  const isReceiveRejection =
    /Federation didn't accept the payment|canceled:|claim_rejected|before Chama received ecash/i.test(error);
  const diagnostics = extractChamaDiagnostics(error);
  const showSimFallback = isWalletVerifiableGatewayError && !isNativeBridgeUnavailable && !isSimModeOn();
  const title = invoiceFailed ? t("fund.invoiceFailedPlain") : isNativeBridgeUnavailable
    ? t("fund.nativeBridgeUnavailableTitle")
    : isWalletVerifiableGatewayError || isReceiveRoutePaused
    ? t("fund.fundingUnavailableTitle")
    : isReceiveRejection
      ? t("fund.receiveRejectedTitle")
    : t("fund.lockFailedTitle");
  const detail = isNativeBridgeUnavailable
    ? t("fund.nativeBridgeUnavailableBody")
    : isWalletVerifiableGatewayError
    ? t("fund.sdkGatewayBody")
    : error;

  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>✕</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, wordBreak: "break-word" }}>
          {detail}
        </div>
      </div>
      {onRetry && <PaymentButton onClick={onRetry}>{t("fund.tryAgain")}</PaymentButton>}
      {diagnostics && (
        <CopyButton
          value={diagnostics}
          label={t("fund.copyDiagnostics")}
          copiedLabel={t("common.copied")}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer", marginBottom: 8,
          }}
        />
      )}
      {!diagnostics && isReceiveRejection && (
        <CopyButton
          value={error}
          label={t("fund.copyReceiveFailure")}
          copiedLabel={t("common.copied")}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer", marginBottom: 8,
          }}
        />
      )}
      {showSimFallback && (
        <button
          onClick={openSimDemo}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.amberDim, border: `1px solid ${T.amber}55`,
            color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            cursor: "pointer", marginBottom: 8,
          }}
        >
          {t("fund.openSimDemo")}
        </button>
      )}
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("common.close")}
      </button>
    </div>
  );
}

function extractChamaDiagnostics(error: string): string | null {
  const marker = "Chama diagnostics:";
  const index = error.indexOf(marker);
  if (index === -1) return null;
  return error.slice(index + marker.length).trim() || null;
}

function openSimDemo(): void {
  setSimMode(true);
  try {
    const next = new URL(window.location.href);
    next.searchParams.set("sim", "1");
    window.location.assign(next.toString());
  } catch {
    window.location.reload();
  }
}

export function DepositProgressLine({ progress, finality }: { progress: OnchainDepositProgress; finality: number }) {
  const { t } = useT();
  const message = progress.status === "waiting" ? t("fund.depositWaiting")
    : progress.status === "seen" ? t("fund.depositSeen", { amount: progress.btcDeposited?.toLocaleString() ?? "—", count: finality, minutes: finality * 10 })
    : progress.status === "failed" ? `${progress.error ?? t("fund.unexpectedError")} ${t("fund.depositFailedNext")}`
    : t("fund.depositConfirmed");
  return <span data-deposit-status={progress.status} style={{ display: "block", minHeight: 54 }}>{message}</span>;
}

export function FundingCheckout({ tradeSats, feeSats, minimumSats }: { tradeSats: number; feeSats: number; minimumSats?: number }) {
  const { t } = useT();
  const short = minimumSats !== undefined && tradeSats < minimumSats;
  return <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 24px", padding: "12px 0", fontSize: 12 }}>
    <span style={{ color: short ? T.red : T.text }}>{t("payment.tradeAmount")}</span><span style={{ color: short ? T.red : T.text, textAlign: "right" }}>{tradeSats.toLocaleString()}</span>
    <span>{t(short ? "fund.onchainMinimum" : "payment.fee")}</span><span style={{ textAlign: "right" }}>{(short ? minimumSats! : feeSats).toLocaleString()}</span>
    <span style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, color: short ? T.red : T.text }}>{t(short ? "fund.short" : "payment.total")}</span>
    <span style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, textAlign: "right", color: short ? T.red : T.text }}>{short ? `−${(minimumSats! - tradeSats).toLocaleString()}` : (tradeSats + feeSats).toLocaleString()}</span>
  </div>;
}
