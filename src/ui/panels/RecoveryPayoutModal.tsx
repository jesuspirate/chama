import { CardBack } from "../components/CardBack.js";
// ══════════════════════════════════════════════════════════════════════════
// Chama — RecoveryPayoutModal (v0.3.0 Phase 4)
// ══════════════════════════════════════════════════════════════════════════
//
// User-controlled balance drain to a Lightning destination. Used by:
//   - RecoveryBanner: stranded balance from prior failed trade
//   - DestroyEcashConfirmModal: forced recover-first before fed switch
//
// Compositional contract (per Phase 3+4 reminder #1): mounts
// <DestinationPicker /> as the canonical consumer surface for Tier
// 1/2/3 destination input. Picker internals are NOT reached here —
// the shell stays the entry point.
//
// Phase orchestration lives in src/payments/balance-recovery.ts.

import { useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { DestinationPicker } from "../components/DestinationPicker.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import type { PayoutDestination } from "../../payments/payout-destinations.js";
import {
  addOrTouchSavedNwcConnection,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
  retrySmallerLightningPayoutSats,
} from "../../payments/lightning-fees.js";
import type {
  RecoveryPayoutPhase,
  RecoveryPayoutTerminal,
} from "../../payments/balance-recovery.js";
import {
  getPayoutRecord,
  recordPayoutSubmitted,
  markPayoutSettled,
  clearPayoutRecord,
  assertPayoutJournalWritable,
} from "../../payments/payout-journal.js";

export interface RecoveryPayoutModalProps {
  /** Stranded balance in millisatoshis. */
  balanceMsats: number;
  /** Saved Lightning Address payout destinations for the picker's Tier 1 list. */
  savedDestinations: PayoutDestination[];
  /** Saved NWC payout/funding wallets for the picker. */
  savedNwcConnections?: SavedNwcConnection[];
  /** Title shown in the modal header. Caller customizes per surface
   *  (e.g. "Recover sats", "Recover & switch Chama"). */
  title: string;
  /** Optional subtitle below the amount. */
  subtitle?: string;
  /** Bound to actions.payInvoice. Resolves with the LN-pay operationId. */
  payInvoice: (bolt11: string) => Promise<string | undefined | void>;
  /** R3-1: bound to actions.awaitPayoutOutcome — re-attach to a submitted
   *  recovery payout without re-paying (double-pay guard). */
  awaitPayoutOutcome?: (operationId: string) => Promise<"settled" | "refunded" | "unknown">;
  /** Optional balance reader for trace cleanup after payout. */
  getBalance?: () => Promise<number>;
  /** Optional provenance for tagging the recovery send. */
  traceContext?: {
    escrowId?: string;
    amountMsats?: number;
  };
  /** Bound to addOrTouchPayoutDestination from payout-destinations.ts. */
  addOrTouchPayoutDestination: (address: string) => void;
  /** Closed when the modal terminates (success, cancel, or error).
   *  terminal=undefined means the user dismissed the picker before
   *  resolving — nothing happened, no orphan was created. */
  onClose: (terminal?: RecoveryPayoutTerminal) => void;
}

type Stage =
  | { kind: "picking" }
  | { kind: "running"; phase: RecoveryPayoutPhase }
  | { kind: "terminal"; terminal: RecoveryPayoutTerminal };

export function RecoveryPayoutModal({
  balanceMsats,
  savedDestinations,
  savedNwcConnections = [],
  title,
  subtitle,
  payInvoice,
  awaitPayoutOutcome,
  getBalance,
  traceContext,
  addOrTouchPayoutDestination,
  onClose,
}: RecoveryPayoutModalProps) {
  const { t } = useT();
  const maxPayoutSats = maxLightningPayoutSats(balanceMsats);
  const [manualPayoutSats, setManualPayoutSats] = useState<number | null>(null);
  const payoutSats = manualPayoutSats === null
    ? maxPayoutSats
    : Math.max(0, Math.min(manualPayoutSats, maxPayoutSats));
  const reserveSats = manualPayoutSats === null
    ? lightningPayoutReserveSats(balanceMsats)
    : Math.max(0, Math.ceil((Math.max(0, balanceMsats) - payoutSats * 1000) / 1000));
  const feeReserveNote = reserveSats > 0 ? (
    <>
      {t("claim.feeReserveBefore")} <BitcoinAmount sats={reserveSats} size={T.fs.secondary} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("claim.feeReserveAfter")}
    </>
  ) : null;
  const pickerSubtitle =
    subtitle
      ? <>{subtitle}{feeReserveNote && <> {feeReserveNote}</>}</>
      : (
          <>
            {t("claim.sendToAddressBefore")} <BitcoinAmount sats={payoutSats} size={T.fs.secondary} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("claim.sendToAddressAfter")}
            {feeReserveNote && <>. {feeReserveNote}</>}
          </>
        );
  const [stage, setStage] = useState<Stage>({ kind: "picking" });

  if (stage.kind === "picking") {
    // v7 redesign (Jet, 2026-10-05: "hold too"): every recovery payout route
    // is a hold, the same as the claim sheet. The retry buttons below only
    // return to this picker, so they stay plain taps.
    return (
      <DestinationPicker
        holdToSend
        amountSats={payoutSats}
        savedDestinations={savedDestinations}
        savedNwcConnections={savedNwcConnections}
        title={title}
        subtitle={pickerSubtitle}
        onResolve={async (bolt11, opts) => {
          setStage({ kind: "running", phase: { kind: "paying-invoice" } });
          // Lazy-import the orchestrator so the modal stays light
          // when not mounted (consistent with Phase 2/3 hooks).
          const { runRecoveryPayout } = await import("../../payments/balance-recovery.js");
          const terminal = await runRecoveryPayout({
            bolt11,
            saveAfter: opts.saveAfter,
            addressUsed: opts.addressUsed,
            payInvoice,
            getBalance,
            traceContext,
            addOrTouchLightningHandle: addOrTouchPayoutDestination,
            onPhase: (phase) => setStage({ kind: "running", phase }),
            // R3-1 double-pay guard — shares the claim path's escrow-keyed journal.
            getPayoutRecord,
            recordPayoutSubmitted,
            markPayoutSettled,
            clearPayoutRecord,
            assertPayoutJournalWritable,
            awaitPayoutOutcome,
          });
          setStage({ kind: "terminal", terminal });
          if (terminal.kind === "done" || terminal.kind === "payout-confirming") {
            if (opts.saveNwcAfter && opts.nwcConnectionString) {
              try { addOrTouchSavedNwcConnection(opts.nwcConnectionString); } catch {}
            }
            // R3-1: on payout-confirming, re-attach once in the background to
            // flip the journal to settled when the slow payment lands (this
            // NEVER re-pays). Then close after a beat — a re-tap hits the guard.
            if (terminal.kind === "payout-confirming" && awaitPayoutOutcome && traceContext?.escrowId) {
              const escrowId = traceContext.escrowId;
              const rec = getPayoutRecord(escrowId);
              if (rec?.status === "submitted" && rec.operationId) {
                void awaitPayoutOutcome(rec.operationId)
                  .then((outcome) => {
                    if (outcome === "settled") markPayoutSettled(escrowId, rec.operationId);
                    else if (outcome === "refunded") clearPayoutRecord(escrowId);
                  })
                  .catch(() => {});
              }
            }
            setTimeout(() => onClose(terminal), terminal.kind === "done" ? 1500 : 2500);
          }
        }}
        onCancel={() => onClose(undefined)}
      />
    );
  }

  // Stage 2/3: post-picker frame.
  return (
    <div
      onClick={() => {
        if (stage.kind === "terminal") onClose(stage.terminal);
      }}
      style={{
        position: "fixed", inset: 0, background: "#000c", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
          padding: 24, maxWidth: 420, width: "100%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginBottom: 4 }}>
              {title}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: T.text, fontFamily: T.sans,}}>
              <BitcoinAmount sats={payoutSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          {stage.kind === "terminal" && (
            <CardBack onClick={() => onClose(stage.terminal)} />
          )}
        </div>

        {stage.kind === "running" && <RunningPanel />}

        {stage.kind === "terminal" && (
          <TerminalPanel
            terminal={stage.terminal}
            onRetry={() => setStage({ kind: "picking" })}
            onRetrySmaller={() => {
              const smaller = retrySmallerLightningPayoutSats(payoutSats);
              if (smaller <= 0) return;
              setManualPayoutSats(smaller);
              setStage({ kind: "picking" });
            }}
            retrySmallerSats={retrySmallerLightningPayoutSats(payoutSats)}
            onClose={() => onClose(stage.terminal)}
          />
        )}
      </div>
    </div>
  );
}

function RunningPanel() {
  const { t } = useT();
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.amberDim, border: `1px solid ${T.amber}44`, borderRadius: T.r,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: T.amber, animation: "pulse 1.4s ease-in-out infinite",
        margin: "0 auto 12px",
      }} />
      <div style={{ fontSize: T.fs.secondary, fontWeight: 600, color: T.amber, fontFamily: T.sans,}}>
        {t("claim.sendingToWalletCaps")}
      </div>
    </div>
  );
}

function TerminalPanel({
  terminal, onRetry, onRetrySmaller, retrySmallerSats, onClose,
}: {
  terminal: RecoveryPayoutTerminal;
  onRetry: () => void;
  onRetrySmaller: () => void;
  retrySmallerSats: number;
  onClose: () => void;
}) {
  const { t } = useT();
  if (terminal.kind === "done") {
    return (
      <div style={{
        padding: "32px 16px", textAlign: "center",
        background: T.greenDim, border: `1px solid ${T.green}66`,
        borderRadius: T.r, animation: "fadeIn 0.3s ease",
      }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
          {t("claim.recoveredToWallet")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 12 }}>
          {t("claim.closing")}
        </div>
      </div>
    );
  }

  if (terminal.kind === "payout-confirming") {
    // R3-1: sent but unconfirmed — deliberately NO retry (re-paying is the
    // double-send this guards against). Chama re-attaches in the background.
    return (
      <div>
        <div style={{
          padding: "20px 16px", textAlign: "center",
          background: T.amberDim, border: `1px solid ${T.amber}66`, borderRadius: T.r,
          marginBottom: 12,
        }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.amber, fontFamily: T.sans, marginBottom: 4 }}>
            {t("claim.titlePayoutSentConfirming")}
          </div>
          <div style={{
            fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {terminal.error ?? t("claim.recoveryConfirmingBody")}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
    );
  }

  // payout-failed
  const canRetrySmaller =
    retrySmallerSats > 0 &&
    /too large|payout transaction as too large|generated transaction/i.test(terminal.error);

  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>✕</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          {t("claim.recoveryCouldntBeSent")}
        </div>
        <div style={{
          fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {terminal.error}{"\n\n"}{t("claim.recoverySatsStillSafe")}
        </div>
      </div>
      <button
        onClick={onRetry}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: T.accent, border: `1px solid ${T.accent}`,
          color: T.onInk, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
          cursor: "pointer", marginBottom: 8,
        }}
      >
        {t("claim.tryAgain")}
      </button>
      {canRetrySmaller && (
        <button
          onClick={onRetrySmaller}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: T.rs,
            background: T.amberDim, border: `1px solid ${T.amber}66`,
            color: T.amber, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
            cursor: "pointer", marginBottom: 8,
          }}
        >
          {t("claim.tryAmountBefore")} <BitcoinAmount sats={retrySmallerSats} size={T.fs.secondary} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
        </button>
      )}
      <button
        onClick={onClose}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("common.close")}
      </button>
    </div>
  );
}
