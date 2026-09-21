import { OverlaySheet } from "../components/OverlaySheet.js";
import { canOfferClaim, needsTradeHistory } from "../decisions.js";
import { CopyButton } from "../components/CopyButton.js";
import { ReplayNotes } from "../components/ReplayNotes.js";
import { TradeArbiterRecord } from "../components/TradeArbiterRecord.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { ListingBody } from "../components/ListingBody.js";
import { useRef, useState } from "react";
import { EscrowStatus, Outcome, Role, selectedMenuItemsTotalMsats, getEffectiveParticipantsAt, type EscrowState, type SelectedMenuItem } from "../../escrow-engine/types.js";
import { decideVotePrompt, preLockDeadline, tradeRoomPresence, type RoomPresence } from "../decisions.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { BitcoinPricePill } from "../components/BitcoinPricePill.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { ROLE_COLOR, TRINITY_RING_ORDER } from "../theme.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { expectedLockerRole } from "../../escrow-engine/lock-custody.js";
import { GUIDED_SLICE_CHOICE_ENABLED } from "../../escrow-engine/experimental-escrow-features.js";
import { T, CAT_LABEL, fmtSats } from "../theme.js";
import { ChatPanel } from "../panels/ChatPanel.js";
import { CountdownTimer } from "../components/CountdownTimer.js";
import type { RatingThumb } from "../../reputation/ratings.js";
import { translate, getCurrentLang } from "../../i18n/index.js";
import { shareTradeLink } from "../share-link.js";
import { listSavedHandles } from "../../payments/saved-handles.js";
import { getRailByKey, toRailKey } from "../../payments/rail-registry.js";
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
  knownTrades = [], fetchCommunityBonds,
  pubkey,
  onBack,
  backLabel,
  onOpenFullView,
  onVote,
  onClaim,
  onLock,
  onConfirmPayout,
  onJoin,
  onSendChat,
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
  knownTrades?: readonly EscrowState[];
  fetchCommunityBonds?: (community: string) => Promise<VerifiedBond[]>;
  pubkey: string;
  onBack: () => void;
  /** v6.3: the back button names its destination (Browse / Me / Dashboard) so
   *  the user always knows where "back" lands. Falls back to "Trades". */
  backLabel?: string;
  /** Opens the full TradeDetail (unchanged) for everything past the happy path. */
  onOpenFullView: () => void;
  onVote: (outcome: Outcome) => Promise<void>;
  /** Modal-driven money paths. Optional: when a caller hasn't wired them yet,
   *  the Fund / Claim surfaces defer to the full view via onOpenFullView. */
  onClaim?: () => Promise<void>;
  onLock?: (opts?: { savedHandleId?: string; selectedItems?: SelectedMenuItem[]; amountMsats?: number }) => Promise<void>;
  /** Seat the viewer into the trade's open slot (guided join). A range
   *  (exchange-bracket) listing passes the chosen order along. */
  onJoin?: (role: Role, joinOpts?: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean }) => void | Promise<void>;
  onConfirmPayout?: (escrowId: string) => void;
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
  const participants = state.participants;
  const myRole: Role | null =
    samePubkey(participants[Role.BUYER], pubkey) ? Role.BUYER
    : samePubkey(participants[Role.SELLER], pubkey) ? Role.SELLER
    : samePubkey(participants[Role.ARBITER], pubkey) ? Role.ARBITER
    : null;

  const [busy, setBusy] = useState(false);
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
  const [party, setParty] = useState<RoomPresence | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; }
    setArmed(null);
  };
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
      if (outcome === Outcome.RELEASE) { disarm(); void run(() => onVote(outcome)); }
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
  const preLock = preLockDeadline(state);
  const buyerHold = state.joinHolds?.[Role.BUYER];
  const orderItems = buyerHold?.selectedItems;
  const orderMsats = buyerHold?.amountMsats
    ?? (orderItems?.length ? selectedMenuItemsTotalMsats(orderItems) : undefined);
  const effectiveMsats = state.status === EscrowStatus.CREATED && orderMsats ? orderMsats : state.amountMsats;
  const amountLabel = tr("lts.satsAmount", { amount: fmtSats(effectiveMsats) });
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

  const REFUND_REASONS = [tr("lts.reasonNotArrived"), tr("lts.reasonWrongAmount"), tr("lts.reasonChangedMind")];

  // ── The single decision, per state × role ──────────────────────────────
  function renderDecision() {
    if (needsTradeHistory(state)) return <Decision q={tr("trade.historyUnverified")} sub={tr("app.archivedIncomplete")}>
      <CopyButton value={state.id} label={state.id} />
      <MoreOptions onClick={onOpenFullView} label={tr("trade.resendHeal")} />
    </Decision>;

    const status = state.status;

    if (status === EscrowStatus.CREATED) {
      // Who funds is category-dependent and reducer-enforced (WRONG_LOCKER):
      // marketplace → buyer; p2p-trade / bill-pay / lending → seller; null → raw
      // (anyone). This is the OPPOSITE asymmetry from who votes first.
      const funderRole = expectedLockerRole(state.category);
      const iAmFunder = funderRole ? myRole === funderRole : myRole != null;
      if (iAmFunder) {
        // Fiat trades reveal the locker's payment details inside the LOCK
        // payload (NIP-44, participants only) — where the fiat lands on
        // Exchange, the account the volunteer pays on Bill Pay. The full view
        // has a picker; here we auto-attach the newest saved handle matching
        // the trade's advertised methods, and say so under the button.
        const revealHandle = (state.category === "p2p-trade" || state.category === "bill-pay")
          ? (() => {
              try {
                const rails = new Set((state.paymentMethods ?? []).map(toRailKey));
                return listSavedHandles().find(h =>
                  rails.has(toRailKey(h.rail))
                  || (h.networks ?? []).some(n => rails.has(toRailKey(n)))) ?? null;
              } catch { return null; }
            })()
          : null;
        return (
          <Decision
            q={tr("lts.lockQ", { amount: amountLabel })}
            sub={tr("lts.lockSub")}
          >
            {onLock ? (
              <>
                <PrimaryButton
                  disabled={busy || fundingInProgress || bootProbeFailed}
                  onClick={() => run(() => onLock({
                    amountMsats: effectiveMsats,
                    ...(orderItems?.length ? { selectedItems: orderItems } : {}),
                    ...(revealHandle ? { savedHandleId: revealHandle.id } : {}),
                  }))}
                  label={fundingInProgress ? tr("lts.locking") : tr("lts.fundLock", { amount: amountLabel })}
                />
                {revealHandle ? (
                  <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono }}>
                    {tr("lts.revealsHandle", { rail: getRailByKey(revealHandle.rail)?.displayName ?? revealHandle.rail })}
                  </div>
                ) : (state.category === "p2p-trade" || state.category === "bill-pay") ? (
                  <Hint>{tr("lts.noHandleHint")}</Hint>
                ) : null}
                {bootProbeFailed && <Hint>{tr("lts.fedUnreachable")}</Hint>}
              </>
            ) : (
              <MoreOptions onClick={onOpenFullView} label={tr("lts.fundFullView", { amount: amountLabel })} />
            )}
            {preLock && !preLock.lapsed && (
              <div style={{ marginTop: 4 }}>
                <CountdownTimer
                  expiresAt={preLock.at}
                  label={tr(preLock.kind === "hold" ? "lts.toLockSeat" : "lts.toLockExpires")}
                />
              </div>
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
        return (
          <Waiting message={tr("lts.waitingLock", { role: roleLabel(funderRole) })}>
            {preLock && (
              <CountdownTimer expiresAt={preLock.at} label={tr("lts.forRoleLock", { role: roleLabel(funderRole) })} />
            )}
          </Waiting>
        );
      }
      // Unseated viewer (opened from a match): seat inline into the open slot,
      // then the surface re-renders to the waiting/lock state — no full-view bounce.
      const seats = getEffectiveParticipantsAt(state);
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
        <Decision q={tr("lts.joinQ")} sub={tr("lts.joinSub")}>
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
                    label={tr("lts.agreeJoin")}
                  />
                  <MoreOptions onClick={onOpenFullView} label={tr("lts.reviewTermsFirst")} />
                </>
              );
            }
            return (
              <>
                <PrimaryButton disabled={busy} onClick={() => run(() => onJoin(openRole))} label={tr("lts.agreeJoin")} />
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
      // vp.kind === "buttons"
      const outcomes = vp.outcomes;
      // First happy-path voter: one real task (attest the deed) + a demoted
      // back-out. Render a single primary + a quiet cancel, not two co-equal.
      if (vp.firstVote) {
        return (
          <Decision q={deedQuestion(state, myRole)} sub={tr("lts.confirmReleases", { amount: amountLabel })}>
            <PrimaryButton
              disabled={busy}
              tone="release"
              onClick={() => run(() => onVote(Outcome.RELEASE))}
              label={tr("lts.yesConfirm")}
            />
            {cancelOpen ? (
              <div>
                <div style={{ fontSize: 12, color: T.muted, margin: "8px 0" }}>{tr("lts.whyCancel")}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {REFUND_REASONS.map(reason => (
                    <button
                      key={reason}
                      type="button"
                      disabled={busy}
                      onClick={() => { setCancelOpen(false); onSendChat(reason); void run(() => onVote(Outcome.REFUND)); }}
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
            <PrimaryButton
              disabled={busy}
              onClick={() => run(() => onVote(Outcome.REFUND))}
              label={tr("lts.agreeRefund")}
            />
            {outcomes.includes(Outcome.RELEASE) && (
              <VoteButton
                tone="release"
                armed={armed === Outcome.RELEASE}
                disabled={busy}
                onClick={() => armOrVote(Outcome.RELEASE)}
                label={armed === Outcome.RELEASE ? tr("lts.tapAgainRelease") : tr("lts.releaseAnyway")}
                sats={tr("lts.toCounterparty")}
              />
            )}
          </Decision>
        );
      }
      // Genuine confirm-or-deny (vote #2, or a dispute).
      const showRelease = outcomes.includes(Outcome.RELEASE);
      const showRefund = outcomes.includes(Outcome.REFUND);
      return (
        <Decision q={receiptQuestion(state, myRole)} sub={tr("lts.whereGo", { amount: amountLabel })}>
          {showRelease && (
            <VoteButton
              tone="release"
              armed={armed === Outcome.RELEASE}
              disabled={busy}
              onClick={() => armOrVote(Outcome.RELEASE)}
              label={armed === Outcome.RELEASE ? tr("lts.tapAgainRelease") : tr("lts.release")}
              sats={tr("lts.toCounterparty")}
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
                  onClick={() => { disarm(); onSendChat(reason); void run(() => onVote(Outcome.REFUND)); }}
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

    if (status === EscrowStatus.APPROVED) {
      if (iAmWinner) {
        return (
          <Decision q={tr("lts.readyQ", { amount: amountLabel })} sub={tr("lts.claimSub")}>
            {onClaim ? (
              <>
                <PrimaryButton disabled={busy || bootProbeFailed} onClick={() => run(() => onClaim())} label={tr("lts.claim")} />
                {bootProbeFailed && <Hint>{tr("lts.fedUnreachable")}</Hint>}
              </>
            ) : (
              <MoreOptions onClick={onOpenFullView} label={tr("lts.claimFullView")} />
            )}
          </Decision>
        );
      }
      return <Waiting message={state.resolvedOutcome === Outcome.RELEASE ? tr("lts.resolvedReleased") : tr("trade.nsRefundedBackTo", { party: tr(winner?.role === Role.SELLER ? "trade.sellerNoun" : "trade.buyerNoun") })} />;
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
    return <Waiting message={tr("lts.tradeClosed")} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: T.bg, paddingBottom: 12 }}>
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
          .lts-votes{max-height:52dvh}
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
        .lts-room{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
          padding:8px 16px;border-bottom:1px solid ${T.border};background:${T.bg}}
        .lts-room-people{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
        @keyframes ltsHere{0%,100%{opacity:1}50%{opacity:.35}}
        @media (prefers-reduced-motion:reduce){.lts-here-dot{animation:none!important}}
        @keyframes ltsPulse{0%,100%{box-shadow:0 0 0 0 ${T.amber}00}50%{box-shadow:0 0 0 4px ${T.amber}33}}
      `}</style>

      {/* The price, HERO-sized and FIRST (Jet, 6.3.4 review): the same big
          banner that anchors Browse rides through the whole trade — Browse,
          Convert, and the trade room all speak the one number, no squinting.
          The header (and its back button) sits BELOW it, closer to the thumb:
          nobody stretches to the top-left corner just to go back. */}
      <div className="lts-price-hero">
        <div className="lts-hero-full">
          <BitcoinPricePill
            hero
            amountMode={amountDisplayMode}
            onAmountModeChange={onAmountDisplayModeChange}
            quoteCurrency={communityCurrency}
          />
        </div>
        <div className="lts-hero-slim">
          <BitcoinPricePill
            hero
            slim
            amountMode={amountDisplayMode}
            onAmountModeChange={onAmountDisplayModeChange}
            quoteCurrency={communityCurrency}
          />
        </div>
      </div>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        borderBottom: `1px solid ${T.border}`, background: T.surface,
      }}>
        <button
          type="button"
          onClick={onBack}
          style={{ background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, padding: 0 }}
        >
          {backLabel ? `‹ ${backLabel}` : tr("lts.backTrades")}
        </button>
        <div
          title={catLabel}
          aria-label={catLabel}
          style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: 13.5, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}
        >
          <VerticalIcon vertical={verticalIconId} size={20} fallback={catLabel} />
          {/* The word rides along where there's room (desktop) and yields to
              the mark alone where there isn't (phones) — real estate first. */}
          <span className="lts-cat-word">{catLabel.replace(/^[^ ]* /, m => /[a-z]/i.test(m) ? m : "")}</span>
          <span style={{ fontFamily: T.mono, color: T.accent, overflow: "hidden", textOverflow: "ellipsis" }}>{amountLabel}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            void shareTradeLink(state.id).then(result => {
              if (result === "copied") { setShareCopied(true); setTimeout(() => setShareCopied(false), 2500); }
            });
          }}
          style={{
            marginLeft: "auto", fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            color: shareCopied ? T.green : T.muted, background: "transparent",
            border: `1px solid ${T.border}`, padding: "3px 9px", borderRadius: 999, cursor: "pointer",
          }}
        >
          {shareCopied ? tr("lts.linkCopied") : tr("lts.share")}
        </button>
        <span style={{
          fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          color: T.muted, background: T.surface, border: `1px solid ${T.border}`,
          padding: "3px 9px", borderRadius: 999,
        }}>
          {needsTradeHistory(state) ? tr("trade.savedSummary") : state.status}
        </span>
      </div>

      {party?.pubkey && <OverlaySheet title={profileNameFor(profileNames, party.pubkey, kind0Enabled) ?? tr("trade.participants")} subtitle={party.pubkey} onClose={() => setParty(null)}>
        <CopyButton value={party.pubkey} />
        {party.role === Role.ARBITER ? <TradeArbiterRecord state={state} trades={knownTrades} fetchBonds={fetchCommunityBonds} />
          : <p>{tr("trade.partyObserved", { count: knownTrades.filter(trade => trade.eventChain.some(event => event.pubkey === party.pubkey)).length })}</p>}
        <p>{tr("trade.arbiterConduct")}</p>
      </OverlaySheet>}
      {/* The room strip. PHILOSOPHY.md rule 1 — "trade with people, not
          platforms": you should always be able to see WHO is across from you
          and whether they are actually there, and (Jet, 6.3) the price you
          are trading against should never disappear the moment a trade opens.
          Presence is evidence-derived only (see tradeRoomPresence). */}
      <div className="lts-room">
        <div className="lts-room-people">
          {tradeRoomPresence(state, pubkey, undefined, TRINITY_RING_ORDER).map(person => (
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

      {/* Decision left · chat right (decision on top on phones; an unseated
          phone viewer sees only the join question — chat appears once seated) */}
      <div className={`lts-grid${myRole === null && state.status === EscrowStatus.CREATED ? " lts-prejoin" : ""}`}>
        <div className="lts-pane lts-votes">
          {/* The decision floats to the vertical CENTER of the pane on
              desktop (Jet, 6.3.4 review): vote in the middle-left, talk on
              the right. margin:auto both centers and degrades safely — a
              tall phase (reason chips, slice chooser) scrolls instead of
              clipping at the top the way justify-content:center would. */}
          <div className="lts-decision-well">
            {state.status === EscrowStatus.CREATED && <>
              <TradeArbiterRecord state={state} trades={knownTrades} fetchBonds={fetchCommunityBonds} />
              {state.body && <ListingBody body={state.body} />}
            </>}
            <ReplayNotes notes={state.replayNotes} />
            {renderDecision()}
            {state.status !== EscrowStatus.CREATED && state.body && <details style={{ marginTop: 16 }}>
              <summary>{state.description}</summary>
              <ListingBody body={state.body} />
            </details>}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
              <MoreOptions onClick={onOpenFullView} label={tr("lts.moreOptions")} />
            </div>
          </div>
        </div>
        <div className="lts-pane lts-chat">
          <ChatPanel state={state} myRole={myRole} onSend={onSendChat} embedded fill hideHeader />
        </div>
      </div>
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────

/** One person in the room. The dot carries the sacred role colour; it only
 *  breathes when we have real evidence they are here right now. */
function PersonChip({ person, name, onClick }: { person: RoomPresence; name: string | null; onClick: () => void }) {
  const color = ROLE_COLOR[person.role as keyof typeof ROLE_COLOR] ?? T.muted;
  if (!person.pubkey) {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontFamily: T.mono, fontSize: 11, color: T.muted,
        border: `1px dashed ${T.border}`, borderRadius: 999, padding: "4px 10px",
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          border: `1px solid ${T.border}`,
        }} />
        {tr("lts.seatOpen")}
      </span>
    );
  }
  const here = person.signal === "active";
  const sub =
    person.signal === "active" ? tr("lts.hereNow")
    : person.signal === "recent" ? tr("lts.justHere")
    : tr("lts.roomQuiet");
  return (
    <button type="button" onClick={onClick} style={{ minHeight: 44, cursor: "pointer",
      display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0,
      fontFamily: T.mono, fontSize: 11,
      background: T.surface, border: `1px solid ${person.ready ? `${T.green}44` : T.border}`,
      borderRadius: 999, padding: "4px 10px",
    }}>
      <span
        className={here ? "lts-here-dot" : undefined}
        style={{
          width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0,
          opacity: here ? 1 : 0.5,
          animation: here ? "ltsHere 2s ease-in-out infinite" : undefined,
        }}
      />
      <span style={{
        color: T.text, fontWeight: 700, maxWidth: 116,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {name ?? tr("lts.roomSomeone")}
      </span>
      <span style={{ color: person.ready ? T.green : T.muted, flexShrink: 0 }}>
        · {person.ready ? tr("lts.roomReady") : sub}
      </span>
    </button>
  );
}

function Decision({ q, sub, children }: { q: string; sub?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em", color: T.text, marginBottom: 4 }}>{q}</div>
      {sub && <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 16 }}>{sub}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>{children}</div>
    </div>
  );
}

function Waiting({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8, fontFamily: T.mono, fontSize: 12.5,
        color: T.muted, background: T.surface, border: `1px solid ${T.border}`,
        padding: "9px 14px", borderRadius: 999,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.muted, opacity: 0.7 }} />
        {message}
      </div>
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

function PrimaryButton({ label, onClick, disabled, tone }: {
  label: string; onClick: () => void; disabled?: boolean; tone?: "release";
}) {
  const bg = tone === "release" ? T.green : T.accent;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "13px 16px", borderRadius: T.rs, fontWeight: 700, fontSize: 14.5,
        border: "none", background: bg, color: "#fff",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1,
      }}
    >
      {label}
    </button>
  );
}

function VoteButton({ label, sats, tone, armed, onClick, disabled }: {
  label: string; sats?: string; tone: "release" | "refund"; armed?: boolean; onClick: () => void; disabled?: boolean;
}) {
  const rel = tone === "release";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        padding: "13px 15px", borderRadius: T.rs, fontWeight: 700, fontSize: 14.5,
        border: `1px solid ${armed ? T.amber : rel ? T.green : T.border}`,
        background: armed ? T.amberDim : rel ? T.green : T.surface,
        color: armed ? T.amber : rel ? "#fff" : T.amber,
        cursor: disabled ? "default" : "pointer",
        animation: armed ? "ltsPulse 1s ease-in-out infinite" : undefined,
      }}
    >
      <span>{label}</span>
      {sats && <span style={{ fontFamily: T.mono, fontSize: 11.5, opacity: 0.9 }}>{sats}</span>}
    </button>
  );
}

function MoreOptions({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 11.5,
        textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer", padding: "6px 2px",
      }}
    >
      {label}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: T.amber, fontFamily: T.mono, marginTop: 6 }}>{children}</div>;
}

// ── Copy helpers (localized via the lts.* namespace) ──
function roleLabel(role: Role | null): string {
  if (role === Role.SELLER) return tr("lts.roleSeller");
  if (role === Role.BUYER) return tr("lts.roleBuyer");
  return tr("lts.roleOther");
}
function deedQuestion(state: EscrowState, _role: Role | null): string {
  switch (state.category) {
    case "marketplace": return tr("lts.deedMarket");
    case "bill-pay": return tr("lts.deedBill");
    default: return tr("lts.deedDefault");
  }
}
function receiptQuestion(state: EscrowState, _role: Role | null): string {
  switch (state.category) {
    case "marketplace": return tr("lts.receiptMarket");
    case "bill-pay": return tr("lts.receiptBill");
    default: return tr("lts.receiptDefault");
  }
}
