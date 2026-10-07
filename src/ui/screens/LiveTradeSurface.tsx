import { TradePaymentDetailsChoice, BuyerPaymentDetails, CHAT_PAYMENT_CHOICE } from '../components/TradePaymentDetails.js';
import { matchingTradeHandles, needsTradePaymentDetails } from '../../payments/trade-payment-details.js';
import { TradeCustody } from "../components/MoneyCustody.js";
import { HoldToConfirm, buttonStyle } from "../components/Button.js";
import { Badge, LockGlyph } from "../components/Badge.js";
import { collectIsHold } from "../claim-hold.js";
import { rangeFiatText } from "../components/RangeFiat.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { guidedListingAmount } from "../guided-listing-amount.js";
import { CardBack } from "../components/CardBack.js";
import { marketDelivery } from "../../labels/market-delivery.js";
import { reabsorbedLockAmount } from "../../fedimint/pending-native-locks.js";
import { RejectedLockRefund } from "../components/RejectedLockRefund.js";
import { getEcashExport } from "../../payments/ecash-exports.js";
import { hasObservedOnchainDeposit } from "../../escrow-engine/types.js";
import { tradeClock, tradeClockText } from '../trade-clock.js';
import { FundingModalShell } from "../components/FundingModalShell.js";
import { PaymentRails } from "../components/PaymentCard.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { ConductFacts } from "../components/ConductFacts.js";
import { settlementWinner } from "../../escrow-engine/onchain-settlement-choice.js";
import { payoutRecipientFor } from "../../escrow-engine/recipients.js";
import { handleDisplayForViewer } from "../../payments/saved-handles.js";
import { RoleAvatar } from "../components/RoleAvatar.js";
import { Wordmark } from "../components/Wordmark.js";
import { OverlaySheet } from "../components/OverlaySheet.js";
import { OnchainTradeControls, type OnchainTradeActions } from "../panels/OnchainTradeControls.js";
import { canOfferClaim, needsTradeHistory } from "../decisions.js";
import { CopyButton } from "../components/CopyButton.js";
import { ReplayNotes } from "../components/ReplayNotes.js";
import { TradeArbiterRecord } from "../components/TradeArbiterRecord.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { ListingBody } from "../components/ListingBody.js";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { EscrowStatus, Outcome, Role, JOIN_HOLD_LOCK_GRACE_SECONDS, selectedMenuItemsTotalMsats, getEffectiveParticipantsAt, type EscrowState, type SelectedMenuItem } from "../../escrow-engine/types.js";
import { effectiveViewerRole, decideVotePrompt, preLockDeadline, tradeRoomPresence, type RoomPresence } from "../decisions.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { BitcoinPricePill } from "../components/BitcoinPricePill.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { TRINITY_RING_ORDER } from "../theme.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { expectedLockerRole } from "../../escrow-engine/lock-custody.js";
import { GUIDED_SLICE_CHOICE_ENABLED } from "../../escrow-engine/experimental-escrow-features.js";
import { T, CAT_LABEL, fmtSats, ROLE_COLOR_TEXT } from "../theme.js";
import { ChatPanel } from "../panels/ChatPanel.js";
import type { RatingThumb } from "../../reputation/ratings.js";
import { translate, getCurrentLang } from "../../i18n/index.js";
import { shareTradeLink } from "../share-link.js";
import { getRailByKey } from "../../payments/rail-registry.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import { isParentStorefront, isChildOrder } from "../../escrow-engine/storefront.js";

// Render-time translation (same pattern as decisions.ts): picked up per render,
// so a language switch re-reads the live language without prop threading.
const tr = (key: string, params?: Record<string, string | number>) =>
  translate(getCurrentLang(), key, params);

/**
 * LiveTradeSurface — the guided, question-based view of a LIVE trade (the
 * counterpart to AssistedCanvas for the create/browse half). Every escrow
 * state is one decision for one role; this renders that single question with a
 * suggested answer, on a chat-left / votes-right frame that stacks vertically
 * on a phone.
 *
 * SAFETY PRINCIPLE (mirrors direct-publish): this surface owns NO money-path
 * logic. It reads decideVotePrompt() — the same helper TradeDetail uses — and
 * dispatches the SAME handlers App passes to TradeDetail (onVote / onClaim /
 * onLock / onConfirmPayout). Anything richer than the happy path (seating a
 * menu order, on-chain settlement, arbiter provenance, tranche plans, dispute
 * with evidence) is one tap away behind "More options", which opens the
 * unchanged full TradeDetail via onOpenFullView.
 *
 * Flag-gated (LIVE_TRADE_SURFACE_ENABLED). Off by default; TradeDetail stays
 * the shipping view until this is eyeballed.
 */

const samePubkey = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function LiveTradeSurface({
  state,
  historyReloading = false,
  knownTrades = [], fetchCommunityBonds,
  pubkey,
  onBack,
  backLabel,
  onOpenFullView,
  onCheckOnchainFunding,
  onchainActions,
  onVote,
  onClaim,
  onLock,
  onReclaimRejectedLock,
  onRepost,
  onHome,
  onConfirmPayout,
  onJoin,
  onSendChat, preferredRelayConnected = false,
  onRateCounterparty,
  myGivenRatings = [],
  fundingInProgress = false,
  bootProbeFailed = false,
  profileNames,
  kind0Enabled = false,
  amountDisplayMode,
  onAmountDisplayModeChange,
}: {
  state: EscrowState;
  historyReloading?: boolean;
  knownTrades?: readonly EscrowState[];
  fetchCommunityBonds?: (community: string) => Promise<VerifiedBond[]>;
  pubkey: string;
  onBack: () => void;
  /** v6.3: the back button names its destination (Browse / Me / Dashboard) so
   *  the user always knows where "back" lands. Falls back to "Trades". */
  backLabel?: string;
  /** Opens the full TradeDetail (unchanged) for everything past the happy path. */
  onOpenFullView: (section?: "onchain-funding") => void;
  onCheckOnchainFunding?: (id: string) => Promise<{ depositStatus: "waiting" | "seen" | "confirmed"; verdict: { funded: boolean } | null; refundVerified?: boolean; refundPending?: boolean }>;
  onchainActions?: OnchainTradeActions;
  onVote: (outcome: Outcome, payoutAddress?: string) => Promise<void>;
  /** Modal-driven money paths. Optional: when a caller hasn't wired them yet,
   *  the Fund / Claim surfaces defer to the full view via onOpenFullView. */
  onClaim?: () => Promise<void>;
  onReclaimRejectedLock?: (id: string) => Promise<void>;
  onLock?: (opts?: { savedHandleId?: string; paymentDetailsInChat?: boolean; selectedItems?: SelectedMenuItem[]; amountMsats?: number }) => Promise<void>;
  /** Seat the viewer into the trade's open slot (guided join). A range
   *  (exchange-bracket) listing passes the chosen order along. */
  onHome?: () => void;
  onRepost?: () => Promise<void>;
  onJoin?: (role: Role, joinOpts?: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean }) => void | Promise<void>;
  onConfirmPayout?: (escrowId: string) => void;
  preferredRelayConnected?: boolean;
  onSendChat: Parameters<typeof ChatPanel>[0]["onSend"];
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
  fundingInProgress?: boolean;
  bootProbeFailed?: boolean;
  /** Counterparty names for the room strip (PHILOSOPHY rule 1: people, not
   *  platforms). Same map + toggle TradeDetail already receives. */
  profileNames?: NostrProfileNameMap;
  kind0Enabled?: boolean;
  /** Same sats⇄fiat rocker state Browse's hero uses — the banner is the SAME
   *  banner, all the way from Browse into the trade room. */
  amountDisplayMode?: Parameters<typeof BitcoinPricePill>[0]["amountMode"];
  onAmountDisplayModeChange?: (mode: NonNullable<Parameters<typeof BitcoinPricePill>[0]["amountMode"]>) => void;
}) {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [verifiedRefund, setVerifiedRefund] = useState<string | null>(null);
  const [verifiedDeposit, setVerifiedDeposit] = useState<string | null>(null);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositStatus, setDepositStatus] = useState<"waiting" | "seen" | "confirmed">("waiting");
  const depositIdentity = JSON.stringify([state.id, state.lock.onchain, state.onchainFundingTerms, state.onchainRefundClaimed]);
  const requiresDepositCheck = state.escrowMode === "onchain" && (!!state.onchainFundingTerms || !!state.lock.onchain || !!state.onchainRefundClaimed) && state.status !== EscrowStatus.COMPLETED;
  useEffect(() => {
    if (!requiresDepositCheck) return;
    let cancelled = false;
    const check = async () => {
      try {
        const result = await onCheckOnchainFunding?.(state.id);
        if (!cancelled) { setDepositStatus(result?.depositStatus ?? "waiting"); setVerifiedDeposit(result?.verdict?.funded ? depositIdentity : null); setVerifiedRefund(result?.refundVerified ? depositIdentity : null); setDepositError(result?.refundPending ? "Refund broadcast; waiting for blockchain confirmation." : null); }
      } catch (error) {
        if (!cancelled) { setDepositStatus("waiting"); setVerifiedDeposit(null); setVerifiedRefund(null); setDepositError(error instanceof Error ? error.message : String(error)); }
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [requiresDepositCheck, state.id, depositIdentity, onCheckOnchainFunding]);
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    setNowSec(now);
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state.id]);
  const participants = getEffectiveParticipantsAt(state, nowSec, onchainActions?.onchainObservation);
  const myRole = effectiveViewerRole(state, pubkey, nowSec, onchainActions?.onchainObservation);

  const [busy, setBusy] = useState(false);
  const [paymentChoice, setPaymentChoice] = useState(() => matchingTradeHandles(state)[0]?.id ?? '');
  useEffect(() => setPaymentChoice(matchingTradeHandles(state)[0]?.id ?? ''), [state.id]);

  const [onchainOpen, setOnchainOpen] = useState(false);
  useEffect(() => { setOnchainOpen(false); }, [state.id, state.status]);
  const onchainControls = <OnchainTradeControls onReleaseWithPayout={address => onVote(Outcome.RELEASE, address)} state={state} pubkey={pubkey} profileNames={profileNames} kind0Enabled={kind0Enabled} {...onchainActions} />;
  useEffect(() => {
    if (state.escrowMode === "onchain" && state.status === EscrowStatus.CREATED && participants.buyer && participants.seller
      && myRole === (state.onchainFundingTerms?.funder ?? expectedLockerRole(state.category))) setOnchainOpen(true);
  }, [state.id, state.status, participants.buyer, participants.seller, myRole]);
  const onchainOverlay = onchainOpen ? state.status === EscrowStatus.CREATED
    ? <FundingModalShell label={state.title || state.description || "Fund trade"} onClose={() => setOnchainOpen(false)}>
        <PaymentRails rail="onchain" rails={["onchain"]} onchainContext={{kind:"bitcoin"}} disabledReasons={{ lightning: tr("payment.bitcoinOnly"), ecash: tr("payment.bitcoinOnly") }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 0" }}>
          <div><BitcoinAmount msats={state.joinHolds?.buyer?.amountMsats ?? state.amountMsats} size={14} />
            <h2 style={{ color: T.text, fontSize: 20, margin: "6px 0", overflowWrap: "anywhere" }}>{state.title || state.description || "Fund trade"}</h2></div>
          <CardBack onClick={() => setOnchainOpen(false)} />
        </div>
        {onchainControls}
      </FundingModalShell>
    : <OverlaySheet title={tr("payment.bitcoin")} onClose={() => setOnchainOpen(false)}>{onchainControls}</OverlaySheet> : null;
  const [armed, setArmed] = useState<Outcome | null>(null);
  // Cancel-with-reason (Jet 2026-09-05): a cancel/refund vote NEVER fires
  // without a reason chip — the reason lands in the trade chat so the other
  // side knows whether to simply agree (changed mind) or to talk it out.
  const [cancelOpen, setCancelOpen] = useState(false);
  // Guided slice choice (visible step): the fiat-sender's preferred number of
  // protected payout slices. Captured here; phase 3 threads it to plan_start.
  const [sliceChoice, setSliceChoice] = useState(1);
  // Range (exchange-bracket) join: the buyer's chosen sats amount, as typed.
  // Empty ⇒ the bracket minimum.
  const [joinSats, setJoinSats] = useState("");
  useEffect(() => { setJoinSats(""); }, [state.id]);
  const [party, setParty] = useState<RoomPresence | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; }
    setArmed(null);
  };
  // Sending feedback comes from the signed pendingVote preview. It never
  // changes eligibility; ACK/rejection restores the committed engine state.
  const castVote = async (outcome: Outcome) => { await onVote(outcome); };
  const run = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  // Arm-to-confirm money gate (mirrors TradeDetail.armOrVote): first tap arms,
  // second tap on the same outcome fires. RELEASE auto-disarms after 3s; REFUND
  // stays armed so its reason chips remain pickable.
  const armOrVote = (outcome: Outcome) => {
    if (busy) return;
    if (armed === outcome) {
      // RELEASE fires on the confirming second tap. REFUND never fires here —
      // its reason chips (mandatory) are the only trigger.
      if (outcome === Outcome.RELEASE) { disarm(); void run(() => castVote(outcome)); }
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(outcome);
    if (outcome === Outcome.RELEASE) {
      armTimer.current = setTimeout(() => { setArmed(null); armTimer.current = null; }, 3000);
    }
  };

  // A joined range (bracket) order carries its own amount on the buyer hold;
  // the room and the lock must speak THAT number, not the bracket minimum.
  const communityCurrency = getCommunityBySlug(state.community)?.currency ?? null;
  // The honest pre-lock clock: a CREATED trade dies when a seat lapses, not
  // when the listing expires. See preLockDeadline().
  const preLock = preLockDeadline(state, nowSec);
  const clock = tradeClock(state, nowSec, onchainActions?.onchainObservation);
  const clockText = clock && tradeClockText(clock, nowSec, role =>
    profileNameFor(profileNames, state.participants[role], kind0Enabled) ?? roleLabel(role));
  const buyerHold = state.joinHolds?.[Role.BUYER];
  const orderItems = buyerHold?.selectedItems;
  const orderMsats = buyerHold?.amountMsats
    ?? (orderItems?.length ? selectedMenuItemsTotalMsats(orderItems) : undefined);
  const effectiveMsats = !state.lock.notesHash && buyerHold?.orderFinalizedAt && orderMsats ? orderMsats : state.amountMsats;
  const price = useBitcoinPrice(), rates = useFiatRates();
  const summaryAmount = guidedListingAmount(state, joinSats);
  const amountLabel = summaryAmount.maxMsats !== undefined
    ? `${fmtSats(summaryAmount.minMsats)}–${fmtSats(summaryAmount.maxMsats)} sats`
    : tr("lts.satsAmount", { amount: fmtSats(summaryAmount.minMsats) });
  const catLabel = CAT_LABEL[state.category] ?? state.category;
  // The vertical speaks through its MARK, not a word (Jet, 6.3.4 review):
  // same id mapping TradeDetail's kicker uses, so every surface shows the
  // same new-generation logo for the same trade type.
  const verticalIconId = state.listingKind === "work"
    ? "work"
    : (isParentStorefront(state) || isChildOrder(state) || state.category === "marketplace")
    ? "marketplace"
    : state.category;
  const winner = getWinner(state);
  const iAmWinner = canOfferClaim(state) && !!winner && samePubkey(winner.pubkey, pubkey);
  const counterparty =
    myRole === Role.BUYER ? participants[Role.SELLER]
    : myRole === Role.SELLER ? participants[Role.BUYER]
    : null;
  const alreadyRated = !!counterparty
    && myGivenRatings.some(r => r.tradeId === state.id && samePubkey(r.ratee, counterparty));

  const releaseRecipient = payoutRecipientFor(state, Outcome.RELEASE);
  const releaseToMe = samePubkey(releaseRecipient?.pubkey, pubkey);
  const releaseName = profileNameFor(profileNames, releaseToMe ? counterparty : releaseRecipient?.pubkey, kind0Enabled) ?? tr("trade.participants");
  const releaseSub = tr(releaseToMe ? "lts.releaseToYou" : "lts.releaseToName", { name: releaseName, amount: amountLabel });
  const lockerName = profileNameFor(profileNames, payoutRecipientFor(state, Outcome.REFUND)?.pubkey, kind0Enabled) ?? tr("trade.participants");

  const REFUND_REASONS = [tr("lts.reasonNotArrived"), tr("lts.reasonWrongAmount"), tr("lts.reasonChangedMind")];

  // ── The single decision, per state × role ──────────────────────────────
  function renderDecision() {
    if (state.pendingVote) return <Waiting message={tr("trade.voteSending")} />;
    if (needsTradeHistory(state)) return <Decision q={tr("trade.historyUnverified")} sub={tr("app.archivedIncomplete")}>
      <CopyButton value={state.id} label={state.id} />
      <MoreOptions onClick={onOpenFullView} label={tr("trade.resendHeal")} />
    </Decision>;

    if (state.status === EscrowStatus.EXPIRED && state.onchainFundingTerms && hasObservedOnchainDeposit(onchainActions?.onchainObservation)) return onchainControls;
    if (state.status === EscrowStatus.EXPIRED && !state.lock?.notesHash && state.lock?.lockedAt == null && state.initiator.pubkey === pubkey && onRepost) {
      return <Decision q={tr("lts.listingExpired")}><PrimaryButton disabled={busy} onClick={() => run(onRepost)} label={tr("lts.postAgain")} /></Decision>;
    }
    const status = state.status;

    if (status === EscrowStatus.CREATED) {
      // A funded address always keeps its recovery/deposit controls reachable.
      if (state.onchainFundingTerms && hasObservedOnchainDeposit(onchainActions?.onchainObservation)) return onchainControls;
      // Who funds is category-dependent and reducer-enforced (WRONG_LOCKER):
      // marketplace → buyer; p2p-trade / bill-pay / lending → seller; null → raw
      // (anyone). This is the OPPOSITE asymmetry from who votes first.
      const funderRole = expectedLockerRole(state.category);
      const iAmFunder = funderRole ? myRole === funderRole : myRole != null;
      if (preLock?.lapsed && samePubkey(state.participants[funderRole ?? Role.SELLER], pubkey)) {
        return <Decision q={tr("lts.funderLapsed")}>
          {onRepost && state.initiator.pubkey === pubkey
            ? <PrimaryButton disabled={busy} onClick={() => run(onRepost)} label={tr("lts.postAgain")} />
            : <PrimaryButton disabled={busy} onClick={() => run(() => onJoin?.(funderRole ?? Role.SELLER))} label={tr("lts.joinAgain")} />}
          <MoreOptions onClick={onBack} label={tr("lts.otherOffers")} />
        </Decision>;
      }
      if (iAmFunder && !preLock?.lapsed) {
        if (state.escrowMode === "onchain") return (
          <Decision q="Fund this trade on Bitcoin" sub="Prepare the deposit address and send the exact amount from an on-chain wallet.">
            <TradeCustody state={state} />
            <PrimaryButton onClick={() => setOnchainOpen(true)} label="Open on-chain funding" />
          </Decision>
        );
        // Fiat trades reveal the locker's payment details inside the LOCK
        // Payment details ride in the existing private LOCK envelope. Confirm
        // a matching saved handle, add one here, or explicitly choose chat.
        return (
          <Decision
            q={tr("lts.lockQ", { amount: amountLabel })}
            sub={tr("lts.lockSub")}
          >
            <TradeCustody state={state} warn />
            {needsTradePaymentDetails(state) && <TradePaymentDetailsChoice state={state} value={paymentChoice} onChange={setPaymentChoice} />}
            {onLock ? (
              <>
                <MoneyHold
                  disabled={busy || fundingInProgress || bootProbeFailed || (needsTradePaymentDetails(state) && !paymentChoice)}
                  busy={busy}
                  icon={<LockGlyph size={18} />}
                  resetKey={`${state.id}:lock`}
                  onConfirm={() => run(() => onLock({
                    amountMsats: effectiveMsats,
                    ...(orderItems?.length ? { selectedItems: orderItems } : {}),
                    ...(paymentChoice && paymentChoice !== CHAT_PAYMENT_CHOICE ? { savedHandleId: paymentChoice } : {}),
                    paymentDetailsInChat: paymentChoice === CHAT_PAYMENT_CHOICE,
                  }))}
                  label={fundingInProgress ? tr("lts.locking") : tr("lts.fundLock", { amount: amountLabel })}
                />
                {bootProbeFailed && <Hint>{tr("lts.fedUnreachable")}</Hint>}
              </>
            ) : (
              <MoreOptions onClick={onOpenFullView} label={tr("lts.fundFullView", { amount: amountLabel })} />
            )}
            {preLock?.lapsed && (
              <Hint>{tr(preLock.kind === "hold" ? "lts.seatLapsed" : "lts.listingExpired")}</Hint>
            )}
          </Decision>
        );
      }
      if (myRole != null) {
        // Lapsed: say so. The seat is gone and the listing is back in Browse —
        // leaving a countdown running here is how someone waits an entire
        // listing lifetime for a lock that can no longer happen.
        if (preLock?.lapsed) {
          return (
            <Waiting
              message={tr(
                preLock.kind === "hold" ? "lts.lockMissed" : "lts.listingExpired",
                { role: roleLabel(funderRole) },
              )}
            />
          );
        }
        const funderName = profileNameFor(profileNames, participants[funderRole ?? Role.SELLER], kind0Enabled) ?? roleLabel(funderRole);
        const onchainWaiting = state.escrowMode === "onchain" && state.onchainFundingTerms
          ? depositStatus === "confirmed" && verifiedDeposit === depositIdentity
            ? `${funderName}'s deposit is confirmed on Bitcoin. It becomes the lock the next time ${funderName} opens Chama.`
            : depositStatus === "seen"
              ? `${funderName}'s deposit is on Bitcoin, waiting for confirmation.`
              : depositError ? `Could not check the Bitcoin deposit: ${depositError}`
                : `Waiting for ${funderName}'s deposit on Bitcoin…`
          : null;
        return (
          <Waiting message={onchainWaiting ?? tr("lts.waitingLock", { role: roleLabel(funderRole) })}>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "12px 20px" }}>
              {state.escrowMode === "onchain" && <MoreOptions onClick={() => setOnchainOpen(true)} label="Open on-chain deposit details" />}

            </div>
          </Waiting>
        );
      }
      if (preLock?.kind === "listing" && preLock.lapsed) {
        return <Waiting message={tr("lts.listingExpired")}><MoreOptions onClick={onBack} label={tr("lts.otherOffers")} /></Waiting>;
      }
      // Unseated viewer (opened from a match): seat inline into the open slot,
      // then the surface re-renders to the waiting/lock state — no full-view bounce.
      const seats = getEffectiveParticipantsAt(state, nowSec, onchainActions?.onchainObservation);
      const openRole = !seats[Role.BUYER] ? Role.BUYER
        : !seats[Role.SELLER] ? Role.SELLER : null;
      // Slicing chunks the UNSECURED, irreversible leg so only 1/N is ever at
      // risk at a step. The buyer picks the granularity here: fiat (Exchange/CBP)
      // is divisible, and Market services/digital deliver per milestone — but a
      // single physical good can't be sliced, so no chooser there.
      const sliceEligible = GUIDED_SLICE_CHOICE_ENABLED && openRole === Role.BUYER
        && (state.category === "p2p-trade" || state.category === "bill-pay"
          // Market slices only when delivery is DIVISIBLE (services / digital,
          // released per milestone) — a single physical good can't be sliced.
          || (state.category === "marketplace" && state.fulfillment !== "physical"));
      return (
        <Decision q={tr("lts.joinQ")} sub={tr(preLock?.lapsed ? "lts.joinerLapsed" : "lts.joinSub")} >
          {preLock?.lapsed && <MoreOptions onClick={onBack} label={tr("lts.otherOffers")} />}
          {sliceEligible && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 8 }}>
                {tr("lts.howPayOut")}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {[{ n: 1, l: tr("lts.allAtOnce") }, { n: 2, l: tr("lts.inN", { count: 2 }) }, { n: 4, l: tr("lts.inN", { count: 4 }) }].map(o => {
                  const on = sliceChoice === o.n;
                  return (
                    <button key={o.n} type="button" onClick={() => setSliceChoice(o.n)}
                      aria-pressed={on}
                      style={{
                        flex: 1, padding: "9px 6px", borderRadius: T.rs, fontFamily: T.sans,
                        fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                        border: `1px solid ${on ? T.accent : T.border}`,
                        background: on ? T.accentDim : T.surface,
                        color: on ? T.accent : T.muted,
                      }}>
                      {o.l}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10.5, color: T.muted, marginTop: 7, lineHeight: 1.45 }}>
                {sliceChoice > 1 ? tr("lts.sliceHintMany", { count: sliceChoice }) : tr("lts.sliceHintOne")}
              </div>
            </div>
          )}
          {(() => {
            if (!openRole || !onJoin) {
              return <MoreOptions onClick={onOpenFullView} label={tr("lts.reviewJoinFull")} />;
            }
            // A range listing (one exchange-bracket item) asks the ONE question
            // that matters before the seat: how many sats? The chosen amount
            // rides the JOIN as a finalized order, so the seller locks exactly
            // that. Multi-item menus stay a full-view job (a real cart).
            const items = state.items ?? [];
            const bracket = openRole === Role.BUYER && items.length === 1 && items[0]!.kind === "exchange-bracket"
              ? items[0]! : null;
            if (!bracket && items.length > 0 && openRole === Role.BUYER) {
              return <MoreOptions onClick={onOpenFullView} label={tr("lts.reviewJoinFull")} />;
            }
            if (bracket) {
              const minMsats = bracket.minAmountMsats ?? bracket.amountMsats;
              const maxMsats = bracket.maxAmountMsats ?? bracket.amountMsats;
              const chosenSats = joinSats ? Number(joinSats) : Math.floor(minMsats / 1000);
              const chosenMsats = chosenSats * 1000;
              const joinValid = Number.isFinite(chosenSats) && chosenSats > 0
                && chosenMsats >= minMsats && chosenMsats <= maxMsats;
              return (
                <>
                  <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 6 }}>{tr("lts.howManySats")}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <input
                      inputMode="numeric"
                      value={joinSats}
                      onChange={e => setJoinSats(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder={fmtSats(minMsats)}
                      aria-label={tr("lts.howManySats")}
                      style={{
                        flex: "0 1 auto", width: `${Math.max(joinSats.length, 7) + 1}ch`, minWidth: "7ch",
                        border: 0, borderBottom: `3px dashed ${T.accent}88`, outline: 0, background: "transparent",
                        color: T.text, fontFamily: T.mono, fontSize: 22, fontWeight: 700, textAlign: "center", paddingBottom: 2,
                      }}
                    />
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>sats</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: joinValid ? T.muted : T.amber, margin: "6px 0 8px" }}>
                    {tr("lts.rangeHint", { min: fmtSats(minMsats), max: fmtSats(maxMsats) })}
                  </div>
                  <PrimaryButton
                    disabled={busy || !joinValid}
                    onClick={() => run(() => onJoin(openRole, {
                      selectedItems: [{
                        itemId: bracket.id,
                        label: bracket.label,
                        amountMsats: chosenMsats,
                        quantity: 1,
                        ...(bracket.kind ? { kind: bracket.kind } : {}),
                        ...(bracket.minAmountMsats !== undefined ? { minAmountMsats: bracket.minAmountMsats } : {}),
                        ...(bracket.maxAmountMsats !== undefined ? { maxAmountMsats: bracket.maxAmountMsats } : {}),
                        ...(bracket.description ? { description: bracket.description } : {}),
                      }],
                      amountMsats: chosenMsats,
                      orderFinalized: true,
                    }))}
                    label={tr(preLock?.lapsed ? "lts.joinAgain" : "lts.agreeJoin")}
                  />
                  <MoreOptions onClick={onOpenFullView} label={tr("lts.reviewTermsFirst")} />
                </>
              );
            }
            return (
              <>
                <PrimaryButton disabled={busy} onClick={() => run(() => onJoin(openRole))} label={tr(preLock?.lapsed ? "lts.joinAgain" : "lts.agreeJoin")} />
                <MoreOptions onClick={onOpenFullView} label={tr("lts.reviewTermsFirst")} />
              </>
            );
          })()}
        </Decision>
      );
    }

    if (status === EscrowStatus.LOCKED || status === EscrowStatus.EXPIRED) {
      const vp = decideVotePrompt(state, pubkey);
      if (vp.kind === "waiting") {
        return <Waiting message={vp.message} />;
      }
      if (vp.kind === "none") {
        return <Waiting message={tr("lts.nothingNeeded")} />;
      }
      if (state.lock.onchain && settlementWinner(state)?.pubkey === pubkey && vp.outcomes.includes(Outcome.RELEASE)) {
        return <Decision q={deedQuestion(state, myRole)} sub={releaseSub}>{onchainControls}</Decision>;
      }
      // vp.kind === "buttons"
      const outcomes = vp.outcomes;
      // First happy-path voter: one real task (attest the deed) + a demoted
      // back-out. Render a single primary + a quiet cancel, not two co-equal.
      if (vp.firstVote) {
        return (
          <Decision q={deedQuestion(state, myRole)} sub={releaseSub}>
            <MoneyHold
              disabled={busy}
              busy={busy}
              resetKey={`${state.id}:release1`}
              onConfirm={() => run(() => castVote(Outcome.RELEASE))}
              label={tr(state.category === "marketplace" ? `lts.mark${marketDelivery(state)}` : "lts.yesConfirm")}
            />
            {cancelOpen ? (
              <div>
                <CardBack disabled={busy} onClick={() => setCancelOpen(false)} />
                <div style={{ fontSize: 12, color: T.muted, margin: "8px 0" }}>{tr("lts.whyCancel")}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {REFUND_REASONS.map(reason => (
                    <button
                      key={reason}
                      type="button"
                      disabled={busy}
                      onClick={() => { setCancelOpen(false); onSendChat(reason); void run(() => castVote(Outcome.REFUND)); }}
                      style={{
                        padding: "8px 13px", borderRadius: 999, background: T.surface,
                        border: `1px solid ${T.amber}55`, color: T.text, fontFamily: T.sans,
                        fontSize: 12.5, fontWeight: 600, cursor: busy ? "default" : "pointer",
                      }}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <MoreOptions onClick={() => setCancelOpen(true)} label={tr("lts.cancelTrade")} />
            )}
          </Decision>
        );
      }
      // Counterparty already voted REFUND: they asked to cancel. Their reason
      // is in the chat beside this. Agreeing is one tap (the sats come back to
      // the funder — you); releasing anyway keeps the armed double-tap guard.
      const counterRole = myRole === Role.BUYER ? Role.SELLER : myRole === Role.SELLER ? Role.BUYER : null;
      const counterVote = counterRole ? state.votes[counterRole] : undefined;
      if (counterVote === Outcome.REFUND && outcomes.includes(Outcome.REFUND)) {
        return (
          <Decision q={tr("lts.cancelAskedQ")} sub={tr("lts.cancelAskedSub", { amount: amountLabel })}>
            <MoneyHold
              disabled={busy}
              busy={busy}
              resetKey={`${state.id}:agree-refund`}
              onConfirm={() => run(() => castVote(Outcome.REFUND))}
              label={tr("lts.agreeRefund")}
            />
            {outcomes.includes(Outcome.RELEASE) && (
              <MoneyHold
                variant="secondary"
                disabled={busy}
                busy={busy}
                resetKey={`${state.id}:release-anyway`}
                onConfirm={() => run(() => castVote(Outcome.RELEASE))}
                label={`${tr("lts.releaseAnyway")} · ${tr("lts.toCounterparty")}`}
              />
            )}
          </Decision>
        );
      }
      // Genuine confirm-or-deny (vote #2, or a dispute).
      const showRelease = outcomes.includes(Outcome.RELEASE);
      const showRefund = outcomes.includes(Outcome.REFUND);
      return (
        <Decision q={receiptQuestion(state, myRole)} sub={releaseSub}>
          {showRelease && (
            <MoneyHold
              disabled={busy}
              busy={busy}
              resetKey={`${state.id}:release`}
              onConfirm={() => { disarm(); void run(() => castVote(Outcome.RELEASE)); }}
              label={`${tr("lts.release")} · ${tr("lts.toCounterparty")}`}
            />
          )}
          {showRefund && (
            <VoteButton
              tone="refund"
              armed={armed === Outcome.REFUND}
              disabled={busy}
              onClick={() => armOrVote(Outcome.REFUND)}
              label={armed === Outcome.REFUND ? tr("lts.pickReason") : tr("lts.refundDispute")}
              sats={tr("lts.backToSender")}
            />
          )}
          {armed === Outcome.REFUND && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              {REFUND_REASONS.map(reason => (
                <button
                  key={reason}
                  type="button"
                  disabled={busy}
                  onClick={() => { disarm(); onSendChat(reason); void run(() => castVote(Outcome.REFUND)); }}
                  style={{
                    padding: "8px 13px", borderRadius: 999, background: T.surface,
                    border: `1px solid ${T.amber}55`, color: T.text, fontFamily: T.sans,
                    fontSize: 12.5, fontWeight: 600, cursor: busy ? "default" : "pointer",
                  }}
                >
                  {reason}
                </button>
              ))}
            </div>
          )}
        </Decision>
      );
    }

    if (state.escrowMode === "onchain" && (status === EscrowStatus.APPROVED || status === EscrowStatus.CLAIMED)) {
      return <Decision q="Finish the Bitcoin settlement" sub="Review and sign the agreed payout.">{onchainControls}</Decision>;
    }
    const pendingNote = getEcashExport();
    if (iAmWinner && (status === EscrowStatus.APPROVED || status === EscrowStatus.CLAIMED)
      && pendingNote?.source === "claim" && pendingNote.escrowId === state.id) {
      return <Decision q="An ecash note is waiting — open Claim to show it again" sub="Confirm only after importing it into your wallet.">
        <PrimaryButton disabled={busy} onClick={() => onClaim ? run(() => onClaim()) : onOpenFullView()} label={tr("lts.claim")} />
      </Decision>;
    }
    if (status === EscrowStatus.APPROVED) {
      if (iAmWinner) {
        return (
          <Decision q={tr("lts.readyQ", { amount: amountLabel })} sub={tr("lts.claimSub")}>
            {onClaim ? (
              <>
                {collectIsHold() ? (
                  <MoneyHold
                    disabled={busy || bootProbeFailed}
                    busy={busy}
                    resetKey={`${state.id}:claim`}
                    onConfirm={() => run(() => onClaim())}
                    label={tr("lts.claim")}
                  />
                ) : (
                  <PrimaryButton disabled={busy || bootProbeFailed} onClick={() => run(() => onClaim())} label={tr("lts.claim")} />
                )}
                {bootProbeFailed && <Hint>{tr("lts.fedUnreachable")}</Hint>}
              </>
            ) : (
              <MoreOptions onClick={onOpenFullView} label={tr("lts.claimFullView")} />
            )}
          </Decision>
        );
      }
      const recipient = payoutRecipientFor(state, state.resolvedOutcome ?? Outcome.RELEASE);
      const recipientName = samePubkey(recipient?.pubkey, pubkey) ? tr("trade.you")
        : profileNameFor(profileNames, recipient?.pubkey, kind0Enabled) ?? roleLabel(recipient?.role ?? null);
      return <Waiting message={tr("lts.resolvedTo", {amount:fmtSats(effectiveMsats), name:recipientName})} />;
    }

    if (status === EscrowStatus.CLAIMED) {
      if (iAmWinner) {
        return (
          <Decision q={tr("lts.payoutReachedQ")} sub={tr("lts.confirmClose")}>
            <PrimaryButton disabled={busy} onClick={() => { onConfirmPayout?.(state.id); }} label={tr("lts.confirmReceived")} />
            <MoreOptions onClick={onOpenFullView} label={tr("lts.payoutMissing")} />
          </Decision>
        );
      }
      return <Waiting message={tr("lts.payoutInFlight")} />;
    }

    if (status === EscrowStatus.COMPLETED) {
      return (
        <Decision q={tr("lts.howWasTrading")} sub={tr("lts.ratingFeeds")}>
          {state.escrowMode === "onchain" && onchainControls}
          {counterparty && onRateCounterparty && !alreadyRated ? (
            <div style={{ display: "flex", gap: 10 }}>
              {(["up", "down"] as RatingThumb[]).map(thumb => (
                <button
                  key={thumb}
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => onRateCounterparty(state.id, counterparty, thumb))}
                  style={{
                    fontSize: 20, padding: "10px 18px", borderRadius: T.rs,
                    background: T.surface, border: `1px solid ${T.border}`,
                    cursor: busy ? "default" : "pointer",
                  }}
                >
                  {thumb === "up" ? "👍" : "👎"}
                </button>
              ))}
            </div>
          ) : (
            <Hint>{alreadyRated ? tr("lts.thanksRated") : tr("lts.tradeComplete")}</Hint>
          )}
        </Decision>
      );
    }

    // CANCELLED / anything terminal-else
    return <Waiting message={state.rejectedLocks?.length ? "Trade closed. The refused lock was not committed to escrow." : tr("lts.tradeClosed")} />;
  }

  if (verifiedRefund === depositIdentity) return (
    <div style={{ padding: 24 }}>
      {historyReloading && <p role="status">Refreshing this trade's history…</p>}
      <ReplayNotes notes={state.replayNotes} />
      <p role="status">Refund confirmed on the blockchain.</p>
      <button onClick={onHome ?? onBack}>Home</button>
      <button onClick={() => setOnchainOpen(true)}>Open on-chain controls</button>
      {onchainOverlay}
    </div>
  );
  if (requiresDepositCheck && (state.lock.onchain || state.onchainRefundClaimed) && verifiedDeposit !== depositIdentity) return (
    <div style={{ padding: 24 }}>
      <button onClick={onBack}>{backLabel ?? "Back"}</button>
      {historyReloading && <p role="status">Refreshing this trade's history…</p>}
      <ReplayNotes notes={state.replayNotes} />
      <p role="status">Checking the deposit on the blockchain…</p>
      {depositError && <p>{depositError}</p>}
      {(state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED) ? onchainControls
        : <button onClick={() => setOnchainOpen(true)}>Open on-chain controls</button>}
      {onchainOverlay}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: T.bg, paddingBottom: 12 }}>
      {state.rejectedLockRecovery?.pubkey === pubkey && onReclaimRejectedLock &&
        <RejectedLockRefund amountMsats={state.rejectedLockRecovery.amountMsats} onReclaim={() => onReclaimRejectedLock(state.id)} />}
      {reabsorbedLockAmount(state.id) && <p>{tr("trade.lockReabsorbed", {amount:Math.floor(reabsorbedLockAmount(state.id)! / 1000).toLocaleString()})}</p>}
      {!reabsorbedLockAmount(state.id) && !state.rejectedLockRecovery && state.rejectedLocks?.some(row => row.event.pubkey === pubkey) &&
        <p>Chama can't find the note for this lock on this device.</p>}
      {onchainOverlay}
      <style>{`
        .lts-grid{display:grid;grid-template-columns:.95fr 1.12fr;gap:1px;background:${T.border};flex:1;min-height:0}
        .lts-pane{background:${T.surface};min-height:0;display:flex;flex-direction:column;overflow:hidden}
        .lts-votes{padding:18px;overflow-y:auto;display:flex;flex-direction:column}
        .lts-decision-well{width:100%}
        @media (min-width:721px){.lts-decision-well{margin:auto 0;padding:12px 0}}
        @media (max-width:720px){
          .lts-grid{grid-template-columns:1fr;grid-template-rows:minmax(0,auto) minmax(0,1fr)}
          /* dvh, never %: a percentage max-height on an item in an auto grid
             row is cyclic — Chrome ignores it, iOS Safari resolves it
             mid-layout and clamps the pane SHORTER than its own row, which
             clipped the decision text and exposed the grid's border-colored
             background as a dead band between the panes (Jet's 6.3 phone
             screenshot). 52dvh is definite everywhere. */
          .lts-votes{max-height:calc(var(--chama-viewport-height, 100dvh) * .52)}
          [data-chat-focused] .lts-header{max-height:35%;overflow-y:auto;flex-shrink:1}
          [data-chat-focused] .lts-grid{grid-template-rows:minmax(0, .3fr) minmax(100px, 1fr)}
          [data-chat-focused] .lts-votes{max-height:none;padding:8px 12px}
          .lts-grid.lts-prejoin .lts-chat{display:none}
          .lts-grid.lts-prejoin{grid-template-rows:1fr}
        }
        .lts-price-hero{padding:10px 16px;border-bottom:1px solid ${T.border};background:${T.bg}}
        .lts-hero-slim{display:none}
        .lts-cat-word{overflow:hidden;text-overflow:ellipsis}
        @media (max-width:720px){.lts-cat-word{display:none}}
        @media (max-width:720px){
          .lts-price-hero{padding:8px 12px}
          .lts-hero-full{display:none}
          .lts-hero-slim{display:block}
        }
        .lts-room{padding:12px 16px;background:${T.bg}}
        .lts-summary{background:${T.bg}}
        @media (min-width:900px){
          .lts-summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:12px;padding:12px 16px}
          .lts-summary>.lts-money,.lts-summary>.lts-room{padding:0!important}
          .lts-room-people{height:100%;box-sizing:border-box}
        }
        .lts-room-people{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;align-items:start;
          padding:12px 6px;border-radius:20px;background:${T.surface};border:1px solid ${T.line}}
        @keyframes ltsPulse{0%,100%{box-shadow:0 0 0 0 ${T.amber}00}50%{box-shadow:0 0 0 4px ${T.amber}33}}
      `}</style>

      {/* The price, HERO-sized and FIRST (Jet, 6.3.4 review): the same big
          banner that anchors Browse rides through the whole trade — Browse,
          Convert, and the trade room all speak the one number, no squinting.
          The header (and its back button) sits BELOW it, closer to the thumb:
          nobody stretches to the top-left corner just to go back. */}
      <div className="lts-header" style={{ flexShrink: 0 }}>
      <div className="lts-price-hero">
        <div className="lts-hero-full">
          <BitcoinPricePill
            hero
            amountMode={amountDisplayMode}
            onAmountModeChange={onAmountDisplayModeChange}
            quoteCurrency={communityCurrency}
            converterCommunity={state.community}
          />
        </div>
        <div className="lts-hero-slim">
          <BitcoinPricePill
            hero
            slim
            amountMode={amountDisplayMode}
            onAmountModeChange={onAmountDisplayModeChange}
            quoteCurrency={communityCurrency}
            converterCommunity={state.community}
          />
        </div>
      </div>

      {onHome && <button type="button" onClick={onHome} aria-label={tr("lts.backHome")} style={{ background: "none", border: 0, padding: "8px 16px", cursor: "pointer", alignSelf: "flex-start" }}><Wordmark /></button>}
      {/* Header (v7 redesign): back with a drawn chevron, the trade's mark,
          share and the status badge. Sentence-case DM Sans throughout. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "4px 12px 4px 4px",
        borderBottom: `1px solid ${T.line}`, background: T.bg, minHeight: 56,
      }}>
        <button
          type="button"
          onClick={onBack}
          aria-label={tr("lts.back")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 2, minHeight: T.size.touch, padding: "0 8px 0 4px",
            background: "none", border: "none", color: T.ink, fontFamily: T.sans, fontSize: T.fs.body,
            cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          {backLabel ?? tr("lts.backTrades")}
        </button>
        <div
          title={catLabel}
          aria-label={catLabel}
          style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: T.fs.headline, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", color: T.ink }}
        >
          <VerticalIcon vertical={verticalIconId} size={22} fallback={catLabel} />
          {/* The word rides along where there's room (desktop) and yields to
              the mark alone where there isn't (phones) — real estate first. */}
          <span className="lts-cat-word">{catLabel.replace(/^[^ ]* /, m => /[a-z]/i.test(m) ? m : "")}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            void shareTradeLink(state.id, state.initiator.pubkey).then(result => {
              if (result === "copied") { setShareCopied(true); setTimeout(() => setShareCopied(false), 2500); }
            });
          }}
          style={{
            marginLeft: "auto", minHeight: T.size.touch, padding: "0 10px",
            fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
            color: shareCopied ? T.pos : T.ink, background: "transparent", border: "none", cursor: "pointer",
          }}
        >
          {shareCopied ? tr("lts.linkCopied") : tr("lts.share")}
        </button>
        {needsTradeHistory(state)
          ? <span style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600, color: T.ink2, border: `1px solid ${T.line}`, padding: "3px 10px", borderRadius: 999 }}>{tr("trade.savedSummary")}</span>
          : <Badge status={state.status} />}
      </div>

      {/* Money card (v7 redesign): the trade's amount at amount size (40px+
          on phones), its live fiat estimate beside it. Same numbers the
          header used to carry — guidedListingAmount + rangeFiatText. */}
      <div className="lts-summary">
      <div className="lts-money" style={{ padding: "12px 16px 0", background: T.bg }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", height: "100%", boxSizing: "border-box",
          padding: "14px 16px", borderRadius: T.rCard, background: T.surface, border: `1px solid ${T.line}`,
        }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: T.raised, color: T.ink, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <LockGlyph size={20} />
          </div>
          <div style={{ flex: "1 1 160px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans }}>
              {state.status === EscrowStatus.CREATED ? tr("lts.tradeAmount") : tr("lts.lockedInEscrow")}
            </div>
            <div style={{ fontSize: T.fs.amount, fontWeight: 700, fontFamily: T.sans, color: T.ink, lineHeight: 1.1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>
              {amountLabel}
            </div>
          </div>
          {(() => {
            const fiat = rangeFiatText({ min: summaryAmount.minMsats / 1000, max: summaryAmount.maxMsats === undefined ? undefined : summaryAmount.maxMsats / 1000,
              currency: state.fiatCurrency ?? communityCurrency ?? "USD", usdPerBtc: price.usd, usdFiatRates: rates.rates });
            return fiat ? <div style={{ fontSize: T.fs.fiat, color: T.ink2, fontFamily: T.sans }}>{fiat}</div> : null;
          })()}
        </div>
      </div>

      {party?.pubkey && <OverlaySheet title={profileNameFor(profileNames, party.pubkey, kind0Enabled) ?? tr("trade.participants")} subtitle={party.pubkey} onClose={() => setParty(null)}>
        <ConductFacts pubkey={party.pubkey} />
        <CopyButton value={party.pubkey} />
        {party.role === Role.ARBITER ? <TradeArbiterRecord profileNames={profileNames} kind0Enabled={kind0Enabled} state={state} trades={knownTrades} fetchBonds={fetchCommunityBonds} />
          : null}
        <p>{tr("trade.arbiterConduct")}</p>
      </OverlaySheet>}
      {/* The room strip. PHILOSOPHY.md rule 1 — "trade with people, not
          platforms": you should always be able to see WHO is across from you
          and whether they are actually there, and (Jet, 6.3) the price you
          are trading against should never disappear the moment a trade opens.
          Presence is evidence-derived only (see tradeRoomPresence). */}
      <div className="lts-room">
        <div className="lts-room-people">
          {tradeRoomPresence(state, pubkey, nowSec, TRINITY_RING_ORDER, onchainActions?.onchainObservation).map(person => (
            <PersonChip
              key={person.role}
              person={person}
              onClick={() => setParty(person)}
              name={person.isYou
                ? tr("lts.roomYou")
                : profileNameFor(profileNames, person.pubkey, kind0Enabled)}
            />
          ))}
        </div>
      </div>
      </div>
      {clockText && <div className="lts-clock" style={{ padding: '0 16px 8px', fontSize: T.fs.secondary, color: T.ink2, textAlign: 'center', fontFamily: T.sans }}>{clockText}</div>}

      </div>
      {/* Decision left · chat right (decision on top on phones; an unseated
          phone viewer sees only the join question — chat appears once seated) */}
      <div className={`lts-grid${myRole === null && state.status === EscrowStatus.CREATED ? " lts-prejoin" : ""}`}>
        <div className="lts-pane lts-votes">
          {/* The decision floats to the vertical CENTER of the pane on
              desktop (Jet, 6.3.4 review): vote in the middle-left, talk on
              the right. margin:auto both centers and degrades safely — a
              tall phase (reason chips, slice chooser) scrolls instead of
              clipping at the top the way justify-content:center would. */}
          <div className="lts-decision-well"><DecisionClock.Provider value={clockText ?? null}>
            {state.status === EscrowStatus.CREATED && <>
              <TradeArbiterRecord profileNames={profileNames} kind0Enabled={kind0Enabled} state={state} trades={knownTrades} fetchBonds={fetchCommunityBonds} />
              {state.body && <ListingBody body={state.body} />}
            </>}
            <ReplayNotes notes={state.replayNotes} />
            {historyReloading && <p role="status">Refreshing this trade's history…</p>}
            {!state.pendingVote && myRole && myRole !== Role.ARBITER && state.status === EscrowStatus.LOCKED
              && state.votes[Role.BUYER] && state.votes[Role.SELLER]
              && state.votes[Role.BUYER] !== state.votes[Role.SELLER] && (
              <DisputeCard state={state} pubkey={pubkey} amountLabel={amountLabel}
                nameFor={pk => profileNameFor(profileNames, pk, kind0Enabled)} />
            )}
            {state.status === EscrowStatus.LOCKED && myRole === Role.BUYER && needsTradePaymentDetails(state) && <BuyerPaymentDetails state={state} />}
            {renderDecision()}
            {state.escrowMode === "onchain" && state.status === EscrowStatus.LOCKED && <MoreOptions onClick={() => setOnchainOpen(true)} label="Open on-chain deposit details" />}
            {/* v7 redesign (Jet): where to send the fiat must be visible exactly
                when it's needed. With a handle on the lock, the panel opens by
                default; without one, the agreed methods still show. */}
            {state.status === EscrowStatus.LOCKED && myRole && !state.lock.handle && !!state.paymentMethods?.length
              && (state.category === "p2p-trade" || state.category === "bill-pay")
              && !(myRole === Role.BUYER && needsTradePaymentDetails(state)) && (
              <div data-agreed-methods style={{ marginTop: 16, padding: "12px 14px", borderRadius: 12, background: T.raised, fontFamily: T.sans }}>
                <div style={{ fontSize: T.fs.secondary, color: T.ink2, marginBottom: 4 }}>{tr("lts.agreedMethods")}</div>
                <div style={{ fontSize: T.fs.headline, fontWeight: 600, color: T.ink }}>
                  {state.paymentMethods.map(key => getRailByKey(key)?.displayName ?? key).join(" · ")}
                </div>
                <div style={{ fontSize: T.fs.secondary, color: T.ink2, marginTop: 6 }}>{tr("lts.detailsInChat", { name: lockerName })}</div>
              </div>
            )}
            {state.status === EscrowStatus.LOCKED && myRole && state.lock.handle && !(myRole === Role.BUYER && needsTradePaymentDetails(state)) && <details open style={{ marginTop: 16, fontFamily: T.sans }}>
              <summary style={{ minHeight: T.size.touch, display: "flex", alignItems: "center", cursor: "pointer", color: T.ink, fontSize: T.fs.body, fontWeight: 600 }}>{tr("lts.howToPay", { name: lockerName })}</summary>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", overflowWrap: "anywhere", background: T.raised, borderRadius: 12 }}>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: T.fs.secondary, color: T.ink2 }}>{getRailByKey(state.lock.handle.rail)?.displayName ?? state.lock.handle.rail}</div>
                  <div style={{ fontSize: T.fs.headline, fontWeight: 600, color: T.ink }}>{handleDisplayForViewer(state.lock.handle.value, true)}</div>
                  {!!state.lock.handle.networks?.length && <div style={{ fontSize: T.fs.secondary, color: T.ink2 }}>{state.lock.handle.networks.map(key => getRailByKey(key)?.displayName ?? key).join(" · ")}</div>}
                </div>
                <CopyButton value={state.lock.handle.value} />
              </div>
            </details>}
            {state.status !== EscrowStatus.CREATED && state.body && <details style={{ marginTop: 16 }}>
              <summary>{state.description}</summary>
              <ListingBody body={state.body} />
            </details>}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
              <MoreOptions onClick={onOpenFullView} label={tr("lts.moreOptions")} />
            </div>
          </DecisionClock.Provider></div>
        </div>
        <div className="lts-pane lts-chat">
          <ChatPanel preferredRelayConnected={preferredRelayConnected} state={state} myRole={myRole} onSend={onSendChat} embedded fill hideHeader />
        </div>
      </div>
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────

/** The ring identifies the seat; presence stays in the text beneath it.
 *  v7 redesign: one column per seat (buyer · arbiter · seller), a 52px
 *  role-ring avatar, the name, the role word in its role colour, then what
 *  that person is doing. Conduct facts stay — verifiable record only. */
function PersonChip({ person, name, onClick }: { person: RoomPresence; name: string | null; onClick: () => void }) {
  const roleWord = person.role === Role.BUYER ? tr("trade.buyer")
    : person.role === Role.SELLER ? tr("trade.seller") : tr("trade.arbiter");
  const roleKey = (person.role === Role.BUYER ? "buyer" : person.role === Role.SELLER ? "seller" : "arbiter") as keyof typeof ROLE_COLOR_TEXT;
  const column: React.CSSProperties = {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0,
    textAlign: "center", fontFamily: T.sans, padding: "4px 2px",
  };
  if (!person.pubkey) {
    return (
      <span style={column}>
        <span style={{ width: 52, height: 52, borderRadius: 26, border: `2px dashed ${T.line}`, boxSizing: "border-box" }} />
        <span style={{ fontSize: T.fs.secondary, fontWeight: 600, color: T.ink2 }}>{tr("lts.seatOpen")}</span>
        <span style={{ fontSize: T.fs.secondary, fontWeight: 600, color: ROLE_COLOR_TEXT[roleKey] }}>{roleWord}</span>
      </span>
    );
  }
  const sub =
    person.signal === "assigned" ? tr("lts.assigned")
    : person.signal === "active" ? tr("lts.hereNow")
    : person.signal === "recent" ? tr("lts.justHere")
    : tr("lts.roomQuiet");
  return (
    <button type="button" onClick={onClick} style={{ ...column, minHeight: T.size.touch, cursor: "pointer", background: "none", border: "none", color: T.ink }}>
      <RoleAvatar role={person.role} pubkey={person.pubkey} size={52} />
      <span style={{ fontSize: T.fs.secondary, fontWeight: 600, overflowWrap: "anywhere", maxWidth: "100%", color: person.signal === "assigned" ? T.ink2 : T.ink }}>
        {name ?? tr("lts.roomSomeone")}
      </span>
      <span style={{ fontSize: T.fs.secondary, fontWeight: 600, color: ROLE_COLOR_TEXT[roleKey] }}>{roleWord}</span>
      <span style={{ fontSize: T.fs.secondary, color: person.ready ? T.pos : T.ink2 }}>
        {person.ready ? tr("lts.roomReady") : sub}
      </span>
      <ConductFacts pubkey={person.pubkey} />
    </button>
  );
}

/** v7 redesign (canvas "Dispute"): buyer and seller voted differently, so
 *  the arbiter's vote settles it. Display only — every line is read from the
 *  committed votes; nothing here can vote. */
function DisputeCard({ state, pubkey, amountLabel, nameFor }: {
  state: EscrowState; pubkey: string; amountLabel: string; nameFor: (pk: string | null | undefined) => string | null;
}) {
  const arbiterPk = state.participants[Role.ARBITER] ?? null;
  const arbiterName = nameFor(arbiterPk) ?? tr("trade.arbiter");
  const label = (role: Role) => {
    const pk = state.participants[role] ?? null;
    return samePubkey(pk, pubkey) ? tr("lts.roomYou") : nameFor(pk) ?? (role === Role.BUYER ? tr("trade.buyer") : role === Role.SELLER ? tr("trade.seller") : tr("trade.arbiter"));
  };
  const line = (role: Role) => {
    const vote = state.votes[role];
    if (!vote) return tr("lts.arbiterReviewing", { name: label(role) });
    return tr(vote === Outcome.RELEASE ? "lts.votedRelease" : "lts.votedRefund", { name: label(role) });
  };
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16, fontFamily: T.sans }}>
      <div style={{ fontSize: T.fs.title2, fontWeight: 700, lineHeight: 1.25, color: T.ink }}>{tr("lts.disputeTitle")}</div>
      <div style={{ fontSize: T.fs.body, lineHeight: 1.45, color: T.ink2 }}>{tr("lts.disputeBody", { amount: amountLabel, arbiter: arbiterName })}</div>
      <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.rCard, overflow: "hidden" }}>
        {TRINITY_RING_ORDER.map((role, i) => (
          <div key={role} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: i ? `1px solid ${T.line}` : "none" }}>
            <RoleAvatar role={role} pubkey={state.participants[role] ?? null} size={40} />
            <span style={{ fontSize: T.fs.body, fontWeight: 600, color: T.ink, overflowWrap: "anywhere" }}>{line(role)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A question that needs this person: the "Your turn" card (attention ring). */
/** The trade's live clock line, shared with every "Your turn" card. */
const DecisionClock = createContext<string | null>(null);

function Decision({ q, sub, children }: { q: string; sub?: string; children: React.ReactNode }) {
  const clock = useContext(DecisionClock);
  return (
    <section style={{
      border: `2px solid ${T.attn}`, borderRadius: T.rCard, background: T.surface,
      padding: 16, display: "flex", flexDirection: "column", gap: 10, fontFamily: T.sans,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: T.fs.secondary, fontWeight: 700, color: T.attnInk }}>{tr("lts.yourTurn")}</div>
        {clock && <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: T.fs.secondary, fontWeight: 600, color: T.ink2 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          {clock}
        </div>}
      </div>
      <div style={{ fontSize: T.fs.title2, lineHeight: 1.25, fontWeight: 700, letterSpacing: "-0.01em", color: T.ink, overflowWrap: "anywhere" }}>{q}</div>
      {sub && <div style={{ fontSize: T.fs.body, lineHeight: 1.45, color: T.ink2 }}>{sub}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>{children}</div>
    </section>
  );
}

/** Nothing needed from this person right now — a calm line, not a card. */
function Waiting({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, fontFamily: T.sans, fontSize: T.fs.body,
        color: T.ink2, background: T.surface, border: `1px solid ${T.line}`,
        padding: "12px 16px", borderRadius: T.rCard, lineHeight: 1.4,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.ink3, flexShrink: 0 }} />
        {message}
      </div>
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

function PrimaryButton({ label, onClick, disabled, tone }: {
  label: string; onClick: () => void; disabled?: boolean; tone?: "release";
}) {
  // v7 redesign: buttons are ink in both themes (tone kept for callers).
  void tone;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={buttonStyle("primary", { disabled })}
    >
      {label}
    </button>
  );
}

/** v7 redesign: every money move (lock, release, refund, collect) is a hold.
 *  The handler is exactly what the old tap / tap-again fired — HoldToConfirm
 *  only replaces the confirmation gesture. "secondary" renders as a quiet
 *  ink-outlined hold for the less-likely choice. */
function MoneyHold({ label, onConfirm, disabled, busy, resetKey, icon, variant = "primary" }: {
  label: string; onConfirm: () => void; disabled?: boolean; busy?: boolean;
  resetKey?: unknown; icon?: React.ReactNode; variant?: "primary" | "secondary";
}) {
  return (
    <HoldToConfirm
      label={label}
      icon={icon}
      onConfirm={onConfirm}
      disabled={disabled}
      busy={busy}
      resetKey={resetKey}
      variant={variant}
      hint={tr("common.holdToConfirm")}
      armedLabel={tr("common.holdArmed")}
    />
  );
}

function VoteButton({ label, sats, tone, armed, onClick, disabled }: {
  label: string; sats?: string; tone: "release" | "refund"; armed?: boolean; onClick: () => void; disabled?: boolean;
}) {
  // v7 redesign: release votes are holds (MoneyHold); this button remains for
  // the refund/cancel path, which opens the mandatory reason chips. It reads
  // as the destructive variant; armed = reason chips open (attention ring).
  void tone;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...buttonStyle("destructive", { disabled }),
        justifyContent: "space-between",
        border: `2px solid ${armed ? T.attn : "transparent"}`,
      }}
    >
      <span>{label}</span>
      {sats && <span style={{ fontSize: T.fs.secondary, fontWeight: 500, opacity: 0.9 }}>{sats}</span>}
    </button>
  );
}

function MoreOptions({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none", border: "none", color: T.ink, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
        textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer", padding: "0 2px", minHeight: T.size.touch,
        alignSelf: "flex-start", textAlign: "left",
      }}
    >
      {label}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: T.fs.warn, color: T.attnInk, fontFamily: T.sans, fontWeight: 600, marginTop: 6, lineHeight: 1.35 }}>{children}</div>;
}

// ── Copy helpers (localized via the lts.* namespace) ──
function roleLabel(role: Role | null): string {
  if (role === Role.SELLER) return tr("lts.roleSeller");
  if (role === Role.BUYER) return tr("lts.roleBuyer");
  return tr("lts.roleOther");
}
function deedQuestion(state: EscrowState, _role: Role | null): string {
  switch (state.category) {
    case "marketplace": return tr(`lts.deed${marketDelivery(state)}`);
    case "bill-pay": return tr("lts.deedBill");
    default: return tr("lts.deedDefault");
  }
}
function receiptQuestion(state: EscrowState, _role: Role | null): string {
  switch (state.category) {
    case "marketplace": return tr(`lts.receipt${marketDelivery(state)}`);
    case "bill-pay": return tr("lts.receiptBill");
    default: return tr("lts.receiptDefault");
  }
}
