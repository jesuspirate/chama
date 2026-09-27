import { payoutStatusText } from "../../escrow-engine/onchain-payout-text.js";
import { stalledPayoutEligibility } from "../../escrow-engine/onchain-stalled.js";
import { onchainAttention, type OnchainObservation } from '../../escrow-engine/onchain-attention.js';
import { EsploraUnavailableError } from '../../bond-multisig/fund-watcher.js';
import { EXPLORER_RETRY_MESSAGE, explorerRetryDelay, retryExplorerRead } from '../../bond-multisig/explorer-retry.js';
import { settlementUnsignedId } from "../../escrow-engine/onchain-settlement-transport.js";
import { payoutUsesTradeKey, settlementWinner, winnerSettlementChoice } from "../../escrow-engine/onchain-settlement-choice.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { useEffect, useRef, useState } from "react";
import { EscrowStatus, Outcome, Role, getEffectiveParticipantsAt, type EscrowState } from "../../escrow-engine/types.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { fundingArbiter } from "../../escrow-engine/onchain-funding-terms.js";
import { deriveOnchainView } from "../../escrow-engine/onchain-escrow-view.js";
import type { SettlementCheck } from "../../bond-multisig/onchain-escrow-settle.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { ESCROW_NETWORK_LABEL } from "../../bond-multisig/onchain-escrow.js";
import { effectiveViewerRole } from "../decisions.js";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { defaultCreditObserver } from "../../payments/claim-credit-ledger.js";
import { OnchainPayoutRecoveryCard } from "./OnchainPayoutRecoveryCard.js";
import type { ComponentProps } from "react";
import { OnchainEscrowPanel } from "./OnchainEscrowPanel.js";

export interface OnchainTradeActions {
  onRequestStalledPayout?: (id: string) => Promise<void>;
  onReleaseWithPayout?: (address?: string) => Promise<void>;
  onchainObservation?: OnchainObservation;
  onOpenExplorerSettings?: () => void;
  fetchCommunityBonds?: (community: string) => Promise<VerifiedBond[]>;
  onchainFundingPlan?: (id: string) => { ready: boolean; address?: string; blockers?: readonly string[] };
  onPrepareOnchainFunding?: (id: string) => Promise<void>;
  onCheckOnchainFunding?: (id: string) => Promise<{ depositStatus: "waiting" | "seen" | "confirmed";
    verdict: { funded: boolean; reason?: string; amountSats?: bigint; expectedSats?: bigint } | null;
    refundVerified?: boolean; refundPending?: boolean }>;
  onPublishOnchainLock?: (id: string) => Promise<unknown>;
  onOnchainRefundAvailable?: (id: string) => Promise<boolean>;
  onRefundOnchainEscrow?: (id: string) => Promise<{ txid: string }>;
  onCheckOnchainSettlement?: (id: string) => Promise<{ psbt: string; check: SettlementCheck; signedByMe: boolean }>;
  onPrepareOnchainSettlement?: (id: string, address?: string) => Promise<{ psbt: string; check: SettlementCheck; signedByMe: boolean }>;
  onSignOnchainSettlement?: (id: string) => Promise<{ psbt: string; check: SettlementCheck }>;
  onFinalizeOnchainSettlement?: (id: string) => Promise<{ status: "waiting" | "broadcast" | "adopted"; txid?: string }>;
  onScanMyOnchainPayouts?: ComponentProps<typeof OnchainPayoutRecoveryCard>["scan"];
  onSweepOnchainPayout?: ComponentProps<typeof OnchainPayoutRecoveryCard>["sweep"];
  onPublishArbiterKey?: () => void | Promise<unknown>;
}

const preparingFunding = new Map<string, Promise<void>>();
export function prepareFundingOnce(key: string, prepare: () => Promise<void>): Promise<void> {
  const pending = preparingFunding.get(key);
  if (pending) return pending;
  const promise = Promise.resolve().then(prepare).finally(() => { preparingFunding.delete(key); });
  preparingFunding.set(key, promise);
  return promise;
}

/** Shared funding/settlement controller for the guided overlay and full room.
 * Every money action uses the same independently verifying escrow actions. */
export function OnchainTradeControls({ state, pubkey, profileNames, kind0Enabled = false, ...actions }: OnchainTradeActions & { state: EscrowState; pubkey: string; profileNames?: NostrProfileNameMap; kind0Enabled?: boolean }) {
  const { t } = useT();
  const attemptedFunding = useRef<string | null>(null);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now()/1000));
  useEffect(() => { if (state.status !== EscrowStatus.APPROVED) return; const timer = setInterval(() => setNow(Math.floor(Date.now()/1000)), 60_000); return () => clearInterval(timer); }, [state.status]);
  const [note, setNote] = useState<string | null>(null);
  const [depositStatus, setDepositStatus] = useState<"waiting" | "seen" | "confirmed">("waiting");
  const [verified, setVerified] = useState<string | null>(null);
  const [refunded, setRefunded] = useState(false);
  const [refundAvailable, setRefundAvailable] = useState(false);
  const [check, setCheck] = useState<SettlementCheck | null>(null);
  const [checkedChoice, setCheckedChoice] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);
  const [address, setAddress] = useState("");
  const [, refreshBonds] = useState(0);
  const busyRef = useRef(false);
  const prepareGeneration = useRef(0);
  const [finalizeNonce, retryFinalize] = useState(0);
  const [explorerFailures, setExplorerFailures] = useState<Record<string, boolean>>({});
  const markExplorer = (source: string, failed: boolean) => setExplorerFailures(current => current[source] === failed ? current : {...current, [source]:failed});
  const unavailable = Object.values(explorerFailures).some(Boolean);
  useEffect(() => { setExplorerFailures({}); setNote(null); setAddress(""); }, [state.id]);
  const latest = useRef(actions); latest.current = actions;
  const participants = getEffectiveParticipantsAt(state, Math.floor(Date.now()/1000));
  const role = effectiveViewerRole(state, pubkey);
  const identity = JSON.stringify([state.id, state.lock.onchain, state.onchainFundingTerms, state.onchainRefundClaimed]);
  const pendingArbiter = fundingArbiter(state) === pubkey && !state.escrowKeys?.[Role.ARBITER];
  let plan: ReturnType<NonNullable<OnchainTradeActions["onchainFundingPlan"]>> | null = null;
  try { plan = actions.onchainFundingPlan?.(state.id) ?? null; } catch { /* no address until locally ready */ }
  const view = deriveOnchainView({ state, viewerRole: role, depositVerified: verified === identity,
    recomputedAddress: plan?.ready ? plan.address ?? null : null,
    blockers: plan?.ready ? [] : (plan?.blockers ?? ["not-ready"]).map(b => !state.onchainFundingTerms && b === "bad-refund-height" ? "funding-terms" : b),
    viewerIsPendingArbiter: pendingArbiter });
  if (actions.onchainObservation?.payout) {
    view.payoutTxid ??= actions.onchainObservation.payout.txid;
    view.payoutAddress ??= actions.onchainObservation.payout.destination;
  }
  const winner = settlementWinner(state);
  const choosingWithVote = state.status === EscrowStatus.LOCKED && role === winner?.role && state.votes[role] === undefined && !!actions.onReleaseWithPayout;
  const choice = winnerSettlementChoice(state);
  const stalled = stalledPayoutEligibility(state, now);
  const waitingName = profileNameFor(profileNames, stalled ? state.participants[stalled.other] : null, kind0Enabled) ?? "the other participant";
  const remaining = stalled ? Math.max(0, stalled.availableAt - now) : 0;
  const refundHeight = state.lock.onchain?.refundLockUntil;
  const tip = actions.onchainObservation?.tipHeight;
  const estimate = tip !== undefined && refundHeight !== undefined
    ? new Date(((actions.onchainObservation?.tipObservedAt ?? now) + (refundHeight - tip) * 600) * 1000).toLocaleDateString() : null;
  const winnerName = profileNameFor(profileNames, winner?.pubkey, kind0Enabled) ?? "the winner";
  const approved = state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED;
  const eligibleSigner = (state.settlementStalled || state.resolvedMajority?.includes(Role.ARBITER))
    ? role === Role.ARBITER || (!!role && role === winner?.role)
    : role === Role.BUYER || role === Role.SELLER;

  useEffect(() => {
    let cancelled = false;
    if (state.community) void latest.current.fetchCommunityBonds?.(state.community)
      .then(() => { if (!cancelled) refreshBonds(n => n + 1); }).catch(() => {});
    return () => { cancelled = true; };
  }, [state.community]);
  useEffect(() => {
    if (!state.onchainFundingTerms || state.status === EscrowStatus.COMPLETED) return;
    let cancelled = false, attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 30_000;
      try {
        const result = await latest.current.onCheckOnchainFunding?.(state.id);
        if (cancelled) return;
        markExplorer('funding', false); attempt = 0;
        setVerified(result?.verdict?.funded ? identity : null);
        setRefunded(result?.refundVerified === true);
        setDepositStatus(result?.verdict?.funded ? "confirmed" : result?.depositStatus === "seen" ? "seen" : "waiting");
        setNote(result?.refundPending ? "Refund broadcast; waiting for blockchain confirmation."
          : result?.verdict?.reason === "underfunded" ? `The escrow holds ${result.verdict.amountSats} sats, less than the trade's ${result.verdict.expectedSats}.` : null);
      } catch (error) { if (!cancelled) {
        setVerified(null); setRefunded(false); setDepositStatus("waiting");
        markExplorer('funding', error instanceof EsploraUnavailableError);
        if (error instanceof EsploraUnavailableError) delay = explorerRetryDelay(attempt++);
        else setNote(String(error instanceof Error ? error.message : error));
      } }
      try { const ready = await latest.current.onOnchainRefundAvailable?.(state.id); if (!cancelled) setRefundAvailable(ready === true); }
      catch { if (!cancelled) setRefundAvailable(false); }
      if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [state.id, identity, state.status]);
  useEffect(() => {
    const generation = ++prepareGeneration.current;
    setCheck(null); setCheckedChoice(null); setSigned(false);
    if (!view.canSettle || !eligibleSigner || !choice || !actions.onCheckOnchainSettlement) return;
    return retryExplorerRead({
      read: () => actions.onCheckOnchainSettlement!(state.id),
      success: result => {
        if (prepareGeneration.current !== generation) return;
        markExplorer('settlement', false); setCheck(result.check); setCheckedChoice(settlementUnsignedId(result.psbt)); setSigned(result.signedByMe);
      },
      failure: error => {
        if (prepareGeneration.current !== generation) return;
        setCheck(null); setCheckedChoice(null);
        markExplorer('settlement', error instanceof EsploraUnavailableError);
        if (!(error instanceof EsploraUnavailableError)) setNote(String(error instanceof Error ? error.message : error));
      },
    });
  }, [state.id, state.settlements?.length, view.canSettle, eligibleSigner, choice?.id, actions.onCheckOnchainSettlement]);
  useEffect(() => {
    if (!approved || !eligibleSigner || !state.settlements?.length || !actions.onFinalizeOnchainSettlement) return;
    // Finalization already verifies and adopts an existing spend before any
    // idempotent rebroadcast. Retrying never creates a choice or a signature.
    return retryExplorerRead({
      read: () => actions.onFinalizeOnchainSettlement!(state.id),
      success: result => { markExplorer('finalize', false); if (result.status !== 'waiting') setNote('Payout sent · waiting for confirmation'); },
      failure: error => {
        markExplorer('finalize', error instanceof EsploraUnavailableError);
        if (!(error instanceof EsploraUnavailableError)) setNote(String(error instanceof Error ? error.message : error));
      },
    });
  }, [state.id, state.settlements?.length, approved, eligibleSigner, actions.onFinalizeOnchainSettlement, finalizeNonce]);
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setNote(null); markExplorer("action", false);
    try { await action(); } catch (error) {
      markExplorer("action", error instanceof EsploraUnavailableError);
      setNote(error instanceof EsploraUnavailableError ? "The block explorer did not answer. Try the action again." : String(error instanceof Error ? error.message : error));
    }
    finally { busyRef.current = false; setBusy(false); }
  };
  const prepareFunding = async () => {
    setPrepareFailed(false);
    try { await prepareFundingOnce(`${pubkey}:${state.id}`, () => latest.current.onPrepareOnchainFunding!(state.id)); }
    catch (error) { setPrepareFailed(true); throw error; }
  };
  useEffect(() => {
    if (state.status !== EscrowStatus.CREATED || state.onchainFundingTerms || !view.viewerFunds
      || !participants.buyer || !participants.seller || !actions.onPrepareOnchainFunding) return;
    const key = JSON.stringify([state.id, participants.buyer, participants.seller, state.escrowKeys]);
    if (attemptedFunding.current === key) return;
    attemptedFunding.current = key;
    void run(prepareFunding);
  }, [state.id, state.status, state.onchainFundingTerms, view.viewerFunds, participants.buyer, participants.seller, state.escrowKeys]);
  const buttonStyle = { padding: "12px 14px", minHeight: 44, borderRadius: T.rs, border: `1px solid ${T.borderHi}`,
    background: T.surface, color: T.text, fontFamily: T.sans, fontWeight: 700, cursor: "pointer" };
  const recovery = actions.onScanMyOnchainPayouts && actions.onSweepOnchainPayout
    && ((refunded && view.viewerFunds) || (state.status === EscrowStatus.COMPLETED && winner?.pubkey === pubkey && payoutUsesTradeKey(state)))
    ? <OnchainPayoutRecoveryCard escrowId={state.id} credited={defaultCreditObserver()(state)} embedded
        completed={state.status === EscrowStatus.COMPLETED} payoutConfirmed={actions.onchainObservation?.payout?.confirmed}
        scan={actions.onScanMyOnchainPayouts} sweep={actions.onSweepOnchainPayout} /> : null;
  if (refunded) return <div><p role="status">Refund confirmed on Bitcoin.</p>{recovery}</div>;
  return <div>
    {recovery}
    {role === winner?.role && state.status !== EscrowStatus.COMPLETED && refundHeight && <p style={{color:T.muted}}>
      This must settle before {estimate ? `${estimate} (estimated; block ${refundHeight})` : `block ${refundHeight} (date estimate unavailable)`}; after that the sats can go back to the funder.
    </p>}
    {stalled && role === winner?.role && <div style={{color:T.muted}}>
      <p>If {waitingName} doesn't sign within 24 h you can ask the arbiter.
        {!stalled.ready && ` ${Math.floor(remaining/3600)} h ${Math.ceil((remaining%3600)/60)} min remaining.`}</p>
      {stalled.ready && actions.onRequestStalledPayout && <button type="button" style={buttonStyle} disabled={busy}
        onClick={() => void run(() => actions.onRequestStalledPayout!(state.id))}>Ask the arbiter to finish the payout</button>}
    </div>}
    {state.settlementStalled && <p style={{color:T.muted}}>The arbiter has been asked to finish the agreed payout.</p>}
    {(actions.onchainObservation?.payout || state.onchainPayoutTxid) && <p role="status" style={{color:T.muted}}>
      {actions.onchainObservation?.payout ? payoutStatusText(actions.onchainObservation.payout, false) : state.onchainPayoutTxid ? 'Payout sent · waiting for confirmation' : null}
    </p>}
    {unavailable && state.status !== EscrowStatus.CREATED && <div role="status" style={{color:T.muted, margin:'12px 0'}}>
      <p>{Object.entries(explorerFailures).some(([source,failed]) => source !== 'action' && failed) ? EXPLORER_RETRY_MESSAGE : "The block explorer did not answer. Try again."}</p>
      {actions.onOpenExplorerSettings && <button type="button" onClick={actions.onOpenExplorerSettings} style={buttonStyle}>Choose another block explorer</button>}
    </div>}
    {(choosingWithVote || (view.canSettle && role === winner?.role && !choice?.locked && actions.onPrepareOnchainSettlement)) && <div style={{ margin: "12px 0", display: "grid", gap: 8 }}>
      <label htmlFor={`payout-${state.id}`} style={{ color: T.text, fontSize: 13 }}>{t("onchain.directPayoutLabel")}</label>
      <input id={`payout-${state.id}`} value={address} onChange={event => setAddress(event.target.value)} placeholder={t("onchain.directPayoutPlaceholder")} style={{ ...inputStyle, width: "100%", minHeight: 44 }} />
      <button type="button" disabled={busy || !address.trim()} style={{ ...buttonStyle, opacity: busy || !address.trim() ? 0.5 : 1 }} onClick={() => void run(async () => {
        if (choosingWithVote) { await actions.onReleaseWithPayout!(address.trim()); return; }
        ++prepareGeneration.current; setCheck(null); setCheckedChoice(null); setSigned(false);
        const result = await actions.onPrepareOnchainSettlement!(state.id, address.trim()); setCheck(result.check); setCheckedChoice(settlementUnsignedId(result.psbt)); setSigned(result.signedByMe);
      })}>{choosingWithVote ? "Confirm · receive at this address" : t("onchain.directPayoutUse")}</button>
      <button type="button" disabled={busy} style={buttonStyle} onClick={() => void run(async () => {
        if (choosingWithVote) { await actions.onReleaseWithPayout!(""); return; }
        ++prepareGeneration.current; setCheck(null); setCheckedChoice(null); setSigned(false);
        const result = await actions.onPrepareOnchainSettlement!(state.id); setCheck(result.check); setCheckedChoice(settlementUnsignedId(result.psbt)); setSigned(result.signedByMe);
      })}>{choosingWithVote ? "Confirm · receive in Chama" : "Send to my Chama key instead"}</button>
    </div>}
    {view.canSettle && !choice && role !== winner?.role && <p role="status">Waiting for {winnerName} to choose where the sats go.</p>}
    {view.canSettle && choice && <p style={{ color: T.muted, overflowWrap: "anywhere" }}>Payout address: {choice.destination}
      {choice.locked && <><br />The other signer has signed. The destination is fixed.</>}</p>}
    {(!view.canSettle || choice) && <>
    <OnchainEscrowPanel settlementUnavailable={unavailable} view={view} network={ESCROW_NETWORK_LABEL} settlementCheck={unavailable ? null : checkedChoice === choice?.id ? check : check?.ok === false ? check : null} signing={busy} signedByViewer={signed}
      checking={busy} fundingNote={state.onchainFundingTerms && unavailable && state.status === EscrowStatus.CREATED ? "Couldn’t check the deposit yet — retrying" : note} depositStatus={depositStatus} publishing={busy} refunding={busy}
      onPrepareFunding={prepareFailed && !state.onchainFundingTerms && view.viewerFunds && participants.buyer && participants.seller && actions.onPrepareOnchainFunding
        ? () => void run(prepareFunding) : undefined}
      onCheckFunding={view.viewerFunds && participants.buyer && actions.onCheckOnchainFunding && actions.onPublishOnchainLock ? () => void run(async () => {
        const result = await actions.onCheckOnchainFunding!(state.id);
        setDepositStatus(result.verdict?.funded ? "confirmed" : result.depositStatus === "seen" ? "seen" : "waiting");
        if (result.verdict?.funded) await actions.onPublishOnchainLock!(state.id);
        else if (result.verdict?.reason === "underfunded") setNote(`The escrow holds ${result.verdict.amountSats} sats, less than the trade's ${result.verdict.expectedSats}.`);
      }) : undefined}
      onRefund={refundAvailable && view.viewerFunds && actions.onRefundOnchainEscrow ? () => void run(async () => {
        const result = await actions.onRefundOnchainEscrow!(state.id); setNote(`Refund broadcast: ${result.txid}`);
      }) : undefined}
      onSign={eligibleSigner && actions.onSignOnchainSettlement ? () => void run(async () => {
        const result = await actions.onSignOnchainSettlement!(state.id); setCheck(result.check); setCheckedChoice(settlementUnsignedId(result.psbt)); setSigned(result.check.ok);
      }) : undefined}
      onPublishKey={actions.onPublishArbiterKey ? () => void run(async () => actions.onPublishArbiterKey!()) : undefined} />
    </>}
    {approved && (choice || state.settlements?.some(message => message.payload.final)) && actions.onFinalizeOnchainSettlement && <button type="button" style={buttonStyle} disabled={busy} onClick={() => { markExplorer("finalize", false); retryFinalize(n => n + 1); }}>Check settlement</button>}
    {note && view.stage !== "awaiting-funding" && view.stage !== "awaiting-keys" && <p role="status" style={{ color: T.muted }}>{note}</p>}
  </div>;
}
