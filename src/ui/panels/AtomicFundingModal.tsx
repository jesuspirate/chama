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

import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { CopyButton } from "../components/CopyButton.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { isSimModeOn, setSimMode } from "../../sim/simMode.js";
import { makeLightningInvoiceQrPayload } from "../../payments/lightning-qr.js";
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
import type { OnchainInfo } from "../../fedimint/fedimint-client.js";
import type { SelectedMenuItem } from "../../escrow-engine/types.js";

const QRCode = lazy(() => import("../QRCode.js"));

export interface AtomicFundingModalProps {
  /** Trade ID being funded. Passed through to fundAndLock. */
  escrowId: string;
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
      fundingMethod?: "lightning" | "onchain" | "nwc" | "ecash";
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
  | { kind: "lock-failed"; error: string };

export function AtomicFundingModal({
  escrowId,
  amountMsats,
  premiumMsats = 0,
  ctaLabel,
  savedHandleId,
  selectedItems,
  homeCommunity,
  tradeCommunity,
  fiatCurrency,
  tradeCategory,
  fundAndLock,
  getOnchainInfo,
  lockAndPublish,
  disableNwc = false,
  onClose,
}: AtomicFundingModalProps) {
  const { t } = useT();
  const amountSats = Math.floor(amountMsats / 1000);
  // E1.1: the invoice/deposit ask = trade + insurance; the header shows
  // the total the payer will actually see in their wallet.
  const insuranceSats = Math.floor(Math.max(0, premiumMsats) / 1000);
  const totalSats = amountSats + insuranceSats;
  const [phase, setPhase] = useState<ModalPhase>({ kind: "choose-method" });
  const [fundingMethod, setFundingMethod] = useState<"lightning" | "onchain" | "nwc" | "ecash" | null>(null);
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
    getOnchainInfo()
      .then((info) => {
        if (!cancelled) setOnchainInfoState({ kind: "ready", info });
      })
      .catch((e: any) => {
        if (!cancelled) {
          setOnchainInfoState({
            kind: "error",
            error: e?.message || "Onchain funding unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Read once per modal open. The funding action re-checks this before
    // allocating an address, so this surface is only the UX gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // runFundAndLock catches its own errors; this is defensive.
      setPhase({ kind: "lock-failed", error: (e as Error).message || t("fund.unexpectedError") });
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
    setFundingMethod(null);
    setSelectedNwcConnection(null);
    setPhase({ kind: "choose-method" });
    setRetryToken((t) => t + 1);
  };

  const handleSelectMethod = (method: "lightning" | "onchain") => {
    if (method === "onchain" && onchainInfoState.kind !== "ready") return;
    if (method === "onchain" && onchainInfoState.kind === "ready") {
      const minimumDepositSats = Math.max(
        1,
        Math.trunc(onchainInfoState.info.minimumDepositSats || onchainInfoState.info.pegInFeeSats + 1),
      );
      if (amountSats < minimumDepositSats) return;
    }
    setFundingMethod(method);
    setPhase(
      method === "lightning"
        ? { kind: "creating-invoice" }
        : { kind: "creating-onchain-address" },
    );
  };

  const handleSelectNwc = (connectionString: string, remember: boolean) => {
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
      setPhase({ kind: "lock-failed", error: e?.message || t("fund.lockFailedFallback") });
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
        padding: 24, maxWidth: 420, width: "100%",
      }}>
        {/* Header — amount is the eyebrow, label is the title */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              {ctaLabel.toUpperCase()}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
              <BitcoinAmount sats={totalSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
            {insuranceSats > 0 && (
              <div style={{ fontSize: 9.5, color: T.muted, fontFamily: T.mono, marginTop: 4, display: "flex", alignItems: "baseline", gap: 4 }}>
                {t("fund.insuranceBefore")} <BitcoinAmount sats={insuranceSats} size={9.5} gap={3} glyphScale={1.15} color={T.muted} glyphColor={T.muted} /> {t("fund.insuranceAfter")}
              </div>
            )}
          </div>
          <button type="button" onClick={handleCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        {phase.kind === "choose-method" && (
          <FundingMethodChooser
            amountSats={amountSats}
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
          />
        )}

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

        {phase.kind === "lock-failed" && (
          <LockFailedState
            error={phase.error}
            onCancel={() => onClose(phase)}
          />
        )}

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
}: {
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
}) {
  const { t } = useT();
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
        detail: <>{t("fund.onchainMinBefore")} <BitcoinAmount sats={minimumDepositSats} size={10} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />{t("fund.onchainMinAfter")}</>,
        pegInFeeSats,
        depositAmountSats: undefined,
      };
    }
    return {
      disabled: false,
      detail: <>{t("fund.onchainSendBefore")} <BitcoinAmount sats={amountSats + pegInFeeSats} size={10} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("fund.onchainSendAfter")}</>,
      pegInFeeSats,
      depositAmountSats: amountSats + pegInFeeSats,
    };
  })();
  const nwcReady = isNwcConnectionString(nwcInput);
  // #65: above the LN routing ceiling, a single Lightning payment likely won't
  // route through the federation's gateway. Warn + steer to on-chain (which is
  // available here whenever onchainGate is not disabled). Never hard-blocks.
  const largeAmount = amountSats > MAX_LN_FUNDING_SATS;
  const onchainSteerable = largeAmount && !onchainGate.disabled;

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
          onClick={() => onSelect("lightning")}
          style={{
            width: "100%", minHeight: 64, padding: "14px 16px",
            borderRadius: T.r, background: T.accent,
            border: `1px solid ${T.accent}`, color: "#000",
            cursor: "pointer", fontFamily: T.mono, fontSize: 13,
            fontWeight: 900, letterSpacing: 0.5,
          }}
        >
          {t("fund.useFediWalletBefore")} <BitcoinAmount sats={amountSats} size={13} gap={4} glyphScale={1.18} color="#000" glyphColor="#000" />
        </button>
      </div>
    );
  }

  return (
    <div>
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
                onClick={() => onSelectNwc(connection.connectionString, true)}
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: T.r,
                  background: T.accentDim, border: `1px solid ${T.accent}66`,
                  color: T.text, fontFamily: T.mono, fontSize: 12,
                  cursor: "pointer", display: "flex",
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

      <details style={{ marginBottom: 12 }}>
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
          <button
            type="button"
            disabled={!ecashInput.trim()}
            onClick={onSelectEcash}
            style={{
              width: "100%", padding: "11px 12px", borderRadius: T.rs,
              background: ecashInput.trim() ? T.teal : T.card,
              border: `1px solid ${ecashInput.trim() ? T.teal : T.border}`,
              color: ecashInput.trim() ? "#000" : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 900,
              cursor: ecashInput.trim() ? "pointer" : "not-allowed",
            }}
          >
            {t("fund.lockWithEcash")}
          </button>
        </div>
      </details>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <button
          type="button"
          onClick={() => onSelect("lightning")}
          style={{
            minHeight: 118, padding: 12, borderRadius: T.r,
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.text, cursor: "pointer", textAlign: "left",
            // #65: de-emphasize LN above the routing ceiling (still tappable —
            // never hard-blocked; the user may proceed at their own risk).
            opacity: onchainSteerable ? 0.6 : 1,
          }}
        >
          <div style={{ fontSize: 20, marginBottom: 8 }}>⚡</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: T.accent, fontFamily: T.mono, marginBottom: 6 }}>
            {t("fund.lnFast")}
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
            {t("fund.bestForAlmostEveryone")}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onSelect("onchain")}
          disabled={onchainGate.disabled}
          style={{
            minHeight: 118, padding: 12, borderRadius: T.r,
            background: T.amberDim,
            border: `${onchainSteerable ? 2 : 1}px solid ${T.amber}${onchainSteerable ? "" : "66"}`,
            color: T.text,
            cursor: onchainGate.disabled ? "not-allowed" : "pointer",
            opacity: onchainGate.disabled ? 0.55 : 1,
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 20, marginBottom: 8 }}>₿</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: T.amber, fontFamily: T.mono, marginBottom: 6 }}>
            {t("fund.onchainSlow")}
            {onchainSteerable && (
              <span style={{
                marginLeft: 6, padding: "1px 5px", borderRadius: T.rs,
                background: T.amber, color: "#000", fontSize: 8,
                fontWeight: 900, letterSpacing: 0.5,
              }}>
                {t("fund.recommended")}
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
            {onchainGate.detail}
          </div>
          {typeof onchainGate.pegInFeeSats === "number" && (
            <div style={{
              marginTop: 8, fontSize: 9, color: T.amber,
              fontFamily: T.mono, lineHeight: 1.35,
            }}>
              {t("fund.federationDepositFeeBefore")} <BitcoinAmount sats={onchainGate.pegInFeeSats} size={9} gap={3} glyphScale={1.18} color={T.amber} glyphColor={T.amber} />
            </div>
          )}
        </button>
      </div>
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
            disabled={!nwcReady}
            onClick={() => onSelectNwc(nwcInput, rememberNwc)}
            style={{
              width: "100%", padding: "11px 12px", borderRadius: T.rs,
              background: nwcReady ? T.accent : T.card,
              border: `1px solid ${nwcReady ? T.accent : T.border}`,
              color: nwcReady ? "#000" : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: nwcReady ? "pointer" : "not-allowed",
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

function formatBtcDecimal(sats: number): string {
  return `${(sats / 100_000_000).toFixed(8)} BTC`;
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
  const [amountUnit, setAmountUnit] = useState<"btc" | "sats">("btc");
  const qrPayload = makeBitcoinUri(address, depositAmountSats);
  const totalPrimary = amountUnit === "btc"
    ? formatBtcDecimal(depositAmountSats)
    : `${depositAmountSats.toLocaleString()} sats`;
  const totalSecondary = amountUnit === "btc"
    ? `${depositAmountSats.toLocaleString()} sats`
    : formatBtcDecimal(depositAmountSats);
  return (
    <>
      <div style={{
        fontSize: 9, color: T.amber, fontFamily: T.mono,
        letterSpacing: 0, marginBottom: 8, textAlign: "center",
      }}>
        {t("fund.onchainSlowPath")}
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <Suspense fallback={<div style={{ width: 280, height: 280, background: "#fff", borderRadius: T.rs }} />}>
          <QRCode
            data={qrPayload}
            size={280}
            fgColor="#050505"
            bgColor="#ffffff"
            margin={4}
            alt={t("fund.onchainQrAlt")}
          />
        </Suspense>
      </div>
      <div style={{
        padding: 12, marginBottom: 12, borderRadius: T.rs,
        background: T.amberDim, border: `1px solid ${T.amber}55`,
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 10, marginBottom: 8,
        }}>
          <div style={{
            fontSize: 9, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, fontWeight: 800,
          }}>
            {t("fund.qrIncludesFullTotal")}
          </div>
          <div style={{
            display: "inline-flex", padding: 2, borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            flexShrink: 0,
          }}>
            {(["btc", "sats"] as const).map((unit) => (
              <button
                key={unit}
                onClick={() => setAmountUnit(unit)}
                style={{
                  padding: "4px 8px", borderRadius: Math.max(4, T.rs - 2),
                  background: amountUnit === unit ? T.amber : "transparent",
                  border: "none",
                  color: amountUnit === unit ? "#000" : T.muted,
                  fontFamily: T.mono, fontSize: 9, fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                {unit === "btc" ? "BTC" : "sats"}
              </button>
            ))}
          </div>
        </div>
        <div style={{
          color: T.text, fontFamily: T.mono, fontSize: 20,
          fontWeight: 900, lineHeight: 1.1, marginBottom: 4,
          overflowWrap: "anywhere",
        }}>
          {totalPrimary}
        </div>
        <div style={{
          color: T.muted, fontFamily: T.mono, fontSize: 10,
          lineHeight: 1.45,
        }}>
          {totalSecondary} · trade {amountSats.toLocaleString()} sats + federation fee {pegInFeeSats.toLocaleString()} sats
        </div>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs,
        background: T.amberDim,
        border: `1px solid ${T.amber}44`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: T.amber,
          animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.amber, letterSpacing: 0 }}>
          {t("fund.waitingConfirmations", { count: finalityDelay })}
        </span>
      </div>
      <div style={{
        padding: 8, marginBottom: 12, borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
        fontFamily: T.mono, fontSize: 9, color: T.muted,
        wordBreak: "break-all", maxHeight: 72, overflowY: "auto", textAlign: "center",
      }}>
        {address}
      </div>
      <div style={{
        padding: "8px 10px", marginBottom: 12, borderRadius: T.rs,
        background: T.amberDim, border: `1px solid ${T.amber}44`,
        fontFamily: T.mono, fontSize: 10, color: T.amber,
        lineHeight: 1.45, textAlign: "center",
      }}>
        {t("fund.onchainScanBefore")} <BitcoinAmount sats={depositAmountSats} size={10} gap={4} glyphScale={1.18} color={T.amber} glyphColor={T.amber} /> {t("fund.onchainScanMid1")}{" "}
        <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.amber} glyphColor={T.amber} /> {t("fund.onchainScanMid2")}{" "}
        <BitcoinAmount sats={pegInFeeSats} size={10} gap={4} glyphScale={1.18} color={T.amber} glyphColor={T.amber} /> {t("fund.onchainScanAfter")}
      </div>
      <CopyButton
        value={address}
        label={t("fund.copyAddress")}
        copiedLabel={t("common.copied")}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      />
    </>
  );
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
  bolt11, expiresAt, now, phaseKind, onFundWithMpesa, gateway,
}: {
  bolt11: string;
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
  const [routeOpen, setRouteOpen] = useState(false);

  return (
    <>
      <div style={{
        fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1,
        marginBottom: 8, textAlign: "center",
      }}>
        {isMintConfirming ? t("fund.paymentDetected") : t("fund.scanOrCopyToPay")}
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <Suspense fallback={<div style={{ width: 280, height: 280, background: "#fff", borderRadius: T.rs }} />}>
          <QRCode
            data={qrPayload}
            size={280}
            fgColor="#050505"
            bgColor="#ffffff"
            margin={4}
            alt={t("fund.lightningQrAlt")}
          />
        </Suspense>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs,
        background: isMintConfirming ? T.amberDim : T.surface,
        border: `1px solid ${isMintConfirming ? T.amber + "44" : T.border}`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: isMintConfirming ? T.amber : T.accent,
          animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{
          fontSize: 10, fontFamily: T.mono,
          color: isMintConfirming ? T.amber : T.muted, letterSpacing: 0.5,
        }}>
          {isMintConfirming
            ? t("fund.confirmingFederation")
            : t("fund.waitingForPayment", { time: `${mins}:${secs.toString().padStart(2, "0")}` })}
        </span>
      </div>
      <div style={{
        padding: 8, marginBottom: 12, borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
        fontFamily: T.mono, fontSize: 8, color: T.muted,
        wordBreak: "break-all", maxHeight: 60, overflowY: "auto", textAlign: "center",
      }}>{bolt11}</div>
      {/* v0.4.2 sim mode hotfix round 3: honest auto-credit disclosure.
          This is the atomic-funding modal — the centerpiece of every
          listing-tap flow — so the notice is required here, not just
          on the manual-fund surface. Conditional ONLY on isSimModeOn();
          no other state gates the disclosure. Amber matches the
          SIM MODE pill warning palette (Pillar 2.7). */}
      {isSimModeOn() && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          fontFamily: T.mono, fontSize: 10, color: T.amber,
          lineHeight: 1.5, textAlign: "center",
        }}>
          {t("fund.simAutoCredit")}<br />
          {t("fund.simDoNotFund")}
        </div>
      )}
      <CopyButton
        value={bolt11}
        label={t("fund.copyInvoice")}
        copiedLabel={t("common.copied")}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.accentDim, border: `1px solid ${T.accent}44`,
          color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      />
      {gateway && !isMintConfirming && (
        // Which Lightning gateway minted this invoice — the single route a payer
        // may use. Almost nobody needs it, so it stays collapsed; it earns its
        // place only when a payment isn't arriving, and then it's the first
        // useful fact (a gateway can serve its API perfectly while being
        // unroutable, which reads to the payer as "no route"). One tap away
        // beats buried in Settings, which is far from the moment of need.
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => setRouteOpen(open => !open)}
            style={{
              width: "100%", padding: "4px 0", background: "transparent",
              border: "none", color: T.muted, fontFamily: T.mono,
              fontSize: 8.5, letterSpacing: 0.8, cursor: "pointer",
              textAlign: "center", opacity: 0.75,
            }}
            aria-expanded={routeOpen}
          >
            {routeOpen ? "▾" : "▸"} {t("fund.paymentRoute")}
          </button>
          {routeOpen && (
            <div style={{
              fontSize: 9, fontFamily: T.mono, letterSpacing: 0.5,
              textAlign: "center", lineHeight: 1.6, paddingTop: 2,
              color: gateway.provenPayable ? T.muted : T.amber,
            }}>
              {t("fund.viaGateway")} {gateway.alias || gateway.id.slice(0, 12)}
              {!gateway.provenPayable && (
                <><br />{t("fund.gatewayUnproven")}</>
              )}
            </div>
          )}
        </div>
      )}
      {onFundWithMpesa && (
        <button
          onClick={onFundWithMpesa}
          style={{
            width: "100%", marginTop: 8, padding: "10px 16px",
            borderRadius: T.rs, background: T.tealDim,
            border: `1px solid ${T.teal}66`, color: T.teal,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t("fund.fundWithMpesa")}
        </button>
      )}
    </>
  );
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
  error, onCancel,
}: { error: string; onCancel: () => void }) {
  const { t } = useT();
  const isNativeBridgeUnavailable =
    /native_fedimint_bridge_unavailable|Native Fedimint bridge is enabled but unreachable/i.test(error);
  const isWalletVerifiableGatewayError =
    /wallet-verifiable Lightning receive gateway/i.test(error);
  const isReceiveRejection =
    /Federation didn't accept the payment|canceled:|claim_rejected|before Chama received ecash/i.test(error);
  const diagnostics = extractChamaDiagnostics(error);
  const showSimFallback = isWalletVerifiableGatewayError && !isNativeBridgeUnavailable && !isSimModeOn();
  const title = isNativeBridgeUnavailable
    ? t("fund.nativeBridgeUnavailableTitle")
    : isWalletVerifiableGatewayError
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
