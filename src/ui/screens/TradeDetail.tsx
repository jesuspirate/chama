import { useEffect, useMemo, useRef, useState } from "react";
import {
  type EscrowState,
  type ChatImageAttachment,
  type JoinPayload,
  type SelectedMenuItem,
  EscrowEventKind,
  Role,
  Outcome,
  EscrowStatus,
  getEffectiveParticipantsAt,
  getJoinHoldRemainingSeconds,
  joinHoldExpiresAt,
  joinHoldExpiresAtFor,
  selectedMenuItemsTotalMsats,
} from "../../escrow-engine/types.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import type { SettlementCheck } from "../../bond-multisig/onchain-escrow-settle.js";
import { isParentStorefront, isChildOrder } from "../../escrow-engine/storefront.js";
import { payoutRecipientFor } from "../../escrow-engine/recipients.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getVoteLabel } from "../../labels/vote-labels.js";
import {
  listSavedHandles,
  maskHandle,
  handleDisplayForViewer,
} from "../../payments/saved-handles.js";
import { getRailByKey, matchRails, toRailKey, categoryUsesPaymentRails } from "../../payments/rail-registry.js";
import { listPendingRedemptions } from "../../fedimint/pending-redemptions.js";
import { computeArbiterPremium } from "../../arbiters/arbiter-premium.js";
import { getPremiumOutboxRecord, setPremiumDeclined } from "../../arbiters/arbiter-earnings.js";
import { getPayoutRecord } from "../../payments/payout-journal.js";
import {
  T, STATUS, ROLE_COLOR, ROLE_COLOR_TEXT, CAT_LABEL, TRINITY_RING_ORDER,
  fmtSats, refundRecipientFor, inputStyle,
} from "../theme.js";
import { listingPremiumLine } from "../listing-metrics.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { decideTradeDetailFraming, decideVotePrompt } from "../decisions.js";
import {
  pickArbiterFromPool,
  pickPreferredArbiter,
  classifyArbiterProvenance,
  classifyArbiterAssignment,
  classifySelfRoster,
  getTrustedArbiterPoolSources,
  requiresVerifiedRosterConsent,
  type ArbiterAssignment,
  type ArbiterProvenance,
} from "../../arbiters/pool.js";
import { isArbiterNoShow, isPerformanceContest } from "../../escrow-engine/arbiter-substitution.js";
import { bondedArbitersForCommunity } from "../../arbiters/live-chama.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { defaultEsploraBase, esploraFetcher, esploraTipHeight } from "../../bond-multisig/fund-watcher.js";
import { BOND_NETWORK } from "../../bond-multisig/bond-network.js";
import { counterpartyToRate, type RatingThumb, type AggregateRatings } from "../../reputation/ratings.js";
import { RatingTap } from "../components/RatingTap.js";
import { markChatRead, getLastReadChatAt, countUnreadChat, unreadChatForTrade } from "../../chat/unread.js";
import { pickDefaultPane } from "./trade-pane.js";
import { billTypeDisplay } from "../../communities/bill-types.js";
import {
  hasStateBExplained,
  markStateBExplained,
} from "./state-b-explainer.js";
import { Badge } from "../components/Badge.js";
import { CopyButton } from "../components/CopyButton.js";
import { Dot } from "../components/Dot.js";
import { ReputationReadout } from "../components/ReputationReadout.js";
import { CountdownTimer } from "../components/CountdownTimer.js";
import { SubscriptionTimeline } from "../components/SubscriptionTimeline.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { bondTenureBlocks, tenureDays, tenureTier, verifiedBondTenureBlocks, bondCohort } from "../../arbiters/live-chama.js";
import { viewerIsExposedByLock, lockerRoleOf } from "../../escrow-engine/lock-custody.js";
import { verifyBondedStamp, stampIsForged } from "../../arbiters/bonded-stamp.js";
import { OnchainEscrowPanel } from "../panels/OnchainEscrowPanel.js";
import { OnchainPayoutRecoveryCard } from "../panels/OnchainPayoutRecoveryCard.js";
import type { OnchainPayout } from "../../bond-multisig/onchain-payout-wallet.js";
import { deriveOnchainView } from "../../escrow-engine/onchain-escrow-view.js";
import { ESCROW_NETWORK_LABEL } from "../../bond-multisig/onchain-escrow.js";
import { TranchePlanStrip } from "../components/TranchePlanStrip.js";
import { autoAdvanceOnchainTrancheKey, trancheGate } from "../../escrow-engine/tranche.js";
import { defaultCreditObserver } from "../../payments/claim-credit-ledger.js";
import {
  arbiterRulingConcentration, concentrationWorthShowing, type RulingConcentration,
} from "../../arbiters/arbiter-pattern.js";

/** Mainnet block cadence — the tenure clock's unit. */
const BOND_BLOCKS_PER_DAY = 144;
import { BitcoinPricePill } from "../components/BitcoinPricePill.js";
import { SwipeImageGallery } from "../components/SwipeImageGallery.js";
import { NwcStatusBanner } from "../components/NwcStatusBanner.js";
import { nip99ListingUri } from "../../escrow-engine/nip99-listing.js";
import { DEFAULT_RELAYS } from "../../escrow-engine/default-relays.js";
import { ChatPanel } from "../panels/ChatPanel.js";
import { PagerPills } from "./tradedetail/PagerPills.js";
import {
  eventToSystemBubble,
  disputeBubble,
  timeoutBubble,
  markDoneVerb,
  refundReasons,
  type SystemBubble,
  type LivingChatCtx,
} from "../../labels/trade-progress.js";
import {
  listSavedNwcConnections,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import {
  estimateFiatForMsats,
  formatFiatAmount,
  normalizeFiatCurrency,
  resolveEstimatedFiatCurrency,
  shouldQuoteEstimatedFiat,
  type AmountDisplayMode,
} from "../amount-display.js";
import { useT, type TFunc } from "../../i18n/index.js";

const samePubkey = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function TradeDetail({
  state, pubkey, homeCommunity, bootProbeFailed, receiveUnavailable, fundingInProgress,
  claimBlockedReason, amountDisplayMode = "sats", onAmountDisplayModeChange, kind0Enabled = false, profileNames,
  disableNwc = false, onBack, onVote, onClaim, onJoin, onLock, onLockDirectNwc, onClaimDirectNwc, onConfirmPayout,
  onSendChat, onReleasePeriod, onOpenSettings, onOpenNwcSettings,
  onPrewarmFunding, onRebroadcast, onForget, onPurchase, onCancelDraftOrder, stockLeft, isOversoldOrder = false,
  onRateCounterparty, myGivenRatings, fetchRatingSummary, fetchCommunityBonds, knownTrades, onStartNextTranche, onchainFundingPlan, onPublishOnchainLock, onPrepareOnchainSettlement, onSignOnchainSettlement, onFinalizeOnchainSettlement, onScanMyOnchainPayouts, onSweepOnchainPayout,
  onStartEcashSlicePlan,
  liveChildOrders, pendingChildOrders, onOpenChild,
}: {
  state: EscrowState; pubkey: string;
  /** User's home community slug — drives State A vs State B subtitle
   *  on CREATED listings (item 1, listing-detail half). For LOCKED+
   *  trades the subtitle reflects trade status, not framing. */
  homeCommunity: string | null;
  /** v0.3.1 Phase 3: when true (bootProbeState === "failed"), Fund +
   *  Claim buttons render disabled with the "Federation unreachable —
   *  reconnect first" subtitle. The Reconnect CTA lives in ChamaBar
   *  per the Phase 3 directive (single source of truth for Reconnect);
   *  TradeDetail just gates its action buttons. The boolean is
   *  computed by App.tsx from fedimint.bootProbeState — passing the
   *  bool keeps TradeDetail's API minimal and explicit. */
  bootProbeFailed: boolean;
  /** Last Lightning receive attempt failed after the federation itself
   *  looked reachable. Funding is disabled until reconnect/preflight
   *  clears the receive-health cache; Claim remains governed by the
   *  boot probe because outbound payout can still be retry-safe. */
  receiveUnavailable: boolean;
  /** v0.6.5: true while another runFundAndLock flow is mid-flight on
   *  the shared OPFS wallet. Disables Fund and swaps its label to
   *  "{lockLabel} unavailable" + explanatory subtitle so users see
   *  why the button is greyed rather than just dead. */
  fundingInProgress: boolean;
  /** Terminal local claim settlement failure. When present, retrying
   *  the same CLAIM cannot help because the federation already consumed
   *  the ecash notes and the local mint reissue failed. */
  claimBlockedReason?: string | null;
  amountDisplayMode?: AmountDisplayMode;
  onAmountDisplayModeChange?: (mode: AmountDisplayMode) => void;
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  /** Fedi Mini-App must stay on internal ecash paths, not NWC shortcuts. */
  disableNwc?: boolean;
  onBack: () => void;
  // v1.2.2 vote-freeze fix: typed as Promise<void> so handleVote can
  // await the publish-and-toast chain wired in App. The previous `void`
  // return type encouraged a fire-and-forget call that re-enabled the
  // button on a 1 s setTimeout even though the real publish takes
  // 8–16 s, making the screen look frozen.
  onVote: (outcome: Outcome) => Promise<void>;
  onClaim: () => Promise<void>;
  /** Reputation (kind:38123): one-tap rate the counterparty on a settled trade. */
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
  /** v3.1.1 (#2): fetch a participant's verified rating aggregate on demand —
   *  drives the tap-a-participant reputation readout in the trinity ring. */
  fetchRatingSummary?: (ratee: string) => Promise<AggregateRatings>;
  /** Bond → arbiter enrollment (S3): fetch this community's chain-verified 38135
   *  bonds so a seated bonded arbiter is RECOGNIZED (green), not flagged
   *  "unrecognized". Optional + fail-soft. */
  fetchCommunityBonds?: (community: string) => Promise<VerifiedBond[]>;
  /** Tranching: publish the next slice of this trade's plan. */
  onStartNextTranche?: (fromEscrowId: string) => Promise<unknown>;
  /** v6.0: seller freezes the signed plan after buyer + arbiter are seated. */
  onStartEcashSlicePlan?: (parentId: string) => Promise<unknown>;
  /** Tier 2.1: recompute this trade's escrow address from published keys. */
  onchainFundingPlan?: (escrowId: string) => { ready: boolean; address?: string; blockers?: readonly string[] };
  /** Tier 2.1: publish the on-chain LOCK once the deposit confirms. */
  onPublishOnchainLock?: (escrowId: string) => Promise<unknown>;
  onPrepareOnchainSettlement?: (escrowId: string) => Promise<{ psbt: string; check: SettlementCheck; signedByMe: boolean }>;
  onSignOnchainSettlement?: (escrowId: string) => Promise<{ psbt: string; check: SettlementCheck }>;
  onFinalizeOnchainSettlement?: (escrowId: string) => Promise<{ status: "waiting" | "broadcast" | "adopted"; txid?: string }>;
  onScanMyOnchainPayouts?: () => Promise<{ payouts: OnchainPayout[]; balanceSats: bigint }>;
  onSweepOnchainPayout?: (escrowId: string, destination: string) => Promise<{
    txid: string; sentSats: bigint; feeSats: bigint;
  }>;
  /** A1b: every trade this device knows, for the seated arbiter's ruling
   *  concentration. Read-only and local — it describes what THIS client has
   *  seen, never a global claim, and the card says so by always showing the
   *  denominator. Optional: absent ⇒ the line is simply not drawn. */
  knownTrades?: readonly EscrowState[];
  onJoin: (
    role: Role,
    opts?: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean },
  ) => void | Promise<void>;
  onLock: (opts?: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
    amountMsats?: number;
  }) => Promise<void>;
  /**
   * v1.2.4: direct-NWC fund path. When a user has a saved NWC wallet,
   * the Fund button bypasses the AtomicFundingModal chooser and calls
   * this prop, which routes straight to actions.fundAndLock with
   * fundingMethod=nwc. Phase updates flow through onPhase so the
   * button can render inline progress ("Funding via Alby…",
   * "Locking…"). Returns the terminal so the button can show
   * success/failure copy after the action resolves.
   */
  onLockDirectNwc?: (opts: {
    nwcConnectionString: string;
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
    amountMsats: number;
    onPhase?: (label: string) => void;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * v1.2.4: direct-NWC claim path. Mirror of onLockDirectNwc — when
   * the winner has a saved NWC wallet, Claim resolves a destination
   * invoice via NWC make_invoice and dispatches the claim in one
   * shot, no modal.
   */
  onClaimDirectNwc?: (opts: {
    nwcConnectionString: string;
    onPhase?: (label: string) => void;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** R3-1b: re-attach to a submitted payout and complete the trade if it
   *  settled (no re-pay). Fired when a CLAIMED trade with a sent payout is
   *  opened, so a stuck refund/claim flips to done on view. */
  onConfirmPayout?: (escrowId: string) => void;
  onPrewarmFunding?: () => void | Promise<void>;
  onSendChat: (message: string | { message: string; attachments?: ChatImageAttachment[] }) => void;
  onReleasePeriod?: (periodIndex: number) => void | Promise<void>;
  onOpenSettings?: () => void;
  /** Opens Me › Advanced Settings focused on the NWC wallets section.
   *  Distinct from onOpenSettings (which opens saved Payment Handles). */
  onOpenNwcSettings?: () => void;
  /** Re-broadcast this trade's full event chain to today's relays — heals a
   *  "ghost" trade the counterparty can't see (events never reached their
   *  relays). Surfaced in the Advanced event-chain panel. Resolves with how
   *  many of the chain's events at least one relay accepted. */
  onRebroadcast?: (escrowId: string) => Promise<{ published: number; total: number }>;
  /** Forget this trade locally (drop saved pointer + hide from the list) for
   *  unrecoverable ghosts. Money stays in escrow; re-loadable by ID. App
   *  navigates back to the list after this resolves. */
  onForget?: (escrowId: string) => void;
  /** #7 multi-unit storefront: buy `quantity` units from THIS parent listing.
   *  Spawns a child purchase escrow and navigates to it (App handles that), so
   *  the buyer locks the child via the normal flow. */
  onPurchase?: (parentId: string, quantity: number) => void | Promise<void>;
  /** Buyer-created child orders contain no sats until LOCK. Cancelling one
   *  publishes CANCEL, releases its visible stock reservation, and removes the
   *  abandoned draft from this device's Me list. */
  onCancelDraftOrder?: (escrowId: string) => void | Promise<void>;
  /** #7 multi-unit storefront: derived units left on this parent listing (for
   *  the buy stepper's max + the "N left" line). */
  stockLeft?: number;
  /** #7 seller overcommit refund: this child order is OVERSOLD (locked beyond
   *  the parent's stock by lock order). Reliable only for the seller. Shows a
   *  refund banner. */
  isOversoldOrder?: boolean;
  /** #63 storefront routing: live (LOCKED, unsettled) child orders spawned from
   *  THIS parent storefront. Only meaningful when `state` is a parent storefront;
   *  drives the "N orders in progress" section. Derived in App from
   *  childrenByParent — undefined for non-storefront trades. */
  liveChildOrders?: EscrowState[];
  /** Pre-lock (CREATED, unfunded) child orders spawned from THIS parent
   *  storefront where the viewer is the seller — buyers who have RESERVED but
   *  not yet paid. Drives the "N reserving" section so a reservation informs
   *  the seller even before it funds. Derived in App from childrenByParent;
   *  undefined for non-storefront trades. */
  pendingChildOrders?: EscrowState[];
  /** #63 open a child order's detail (deep-link from the storefront's live-orders
   *  list). Wired to openEscrow in App. */
  onOpenChild?: (childId: string) => void;
}) {
  const { t } = useT();
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const homeQuoteCurrency = homeCommunity ? getCommunityBySlug(homeCommunity)?.currency ?? null : null;
  // v0.2.0 item 1: State A/B framing for CREATED listings. By the time
  // the detail screen renders, the silent re-init has already landed
  // the user on the listing's fed (the openEscrow dispatch in
  // App.tsx handles that). State B's narration is past-tense:
  // "Running on BLF · we switched you in for this trade."
  const framing = decideTradeDetailFraming({
    listingMintUrl: state.mintUrl,
    listingCommunity: state.community,
    homeCommunity,
  });
  const fundUnavailable = bootProbeFailed || receiveUnavailable;
  const [voting, setVoting] = useState(false);
  // Two-tap confirm for the vote-#1 "cancel this trade" hatch (a quiet link
  // shouldn't end a trade on one mis-tap). Reset per trade below.
  const [cancelArmed, setCancelArmed] = useState(false);
  // Two-tap arm-to-confirm for BOTH money buttons (release + refund/dispute) in
  // every vertical: one tap arms (amber), a second fires, auto-disarm ~3s. This
  // generalizes the v3.5 performer-release acknowledge (C1/C7: off-assignment /
  // self-rostered / fee-gated arbiter) to all adjacent money buttons, since they
  // now sit side by side in the action card. armedOutcome = which one is armed.
  const [armedOutcome, setArmedOutcome] = useState<Outcome | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Vestigial chat-row anchor (chat now lives in the pager's Chat pane); kept
  // harmless. The old mark-delivered debounce retired with the standalone
  // mark-done button — the performer's release vote now carries the verb.
  const chatRowRef = useRef<HTMLDivElement | null>(null);
  const [joining, setJoining] = useState(false);
  const [draftCancelArmed, setDraftCancelArmed] = useState(false);
  const [draftCancelling, setDraftCancelling] = useState(false);
  const [locking, setLocking] = useState(false);
  // Advanced "re-broadcast / heal" — idle → broadcasting → a result line.
  const [rebroadcasting, setRebroadcasting] = useState(false);
  const [rebroadcastResult, setRebroadcastResult] = useState<string | null>(null);
  // v3.1.1 (#2): which participant's reputation is currently revealed — tap a
  // trinity-ring avatar to toggle. null = none shown.
  const [repFor, setRepFor] = useState<string | null>(null);
  const [rebroadcastDone, setRebroadcastDone] = useState(false);
  // Inline two-tap forget confirm (no native confirm() — it's a no-op in the
  // Tauri/Capacitor webview, which made the button look frozen).
  const [forgetArmed, setForgetArmed] = useState(false);
  // v3.1 stage 2 — elastic deal slot collapse override (null = follow auto rule).
  const [dealSlotOpen, setDealSlotOpen] = useState<boolean | null>(null);
  const [votesRowOpen, setVotesRowOpen] = useState<boolean | null>(null);
  const [chatRowOpen, setChatRowOpen] = useState<boolean | null>(null);
  // #7 multi-unit storefront: buyer "Buy N units" quantity + in-flight flag.
  const [buyQty, setBuyQty] = useState(1);
  const [purchasing, setPurchasing] = useState(false);

  // v1.2.4: direct-NWC paths for Fund + Claim. When the user has a
  // saved NWC wallet, the action buttons skip the chooser modal and
  // route straight to actions.fundAndLock / claimAndPayout with NWC
  // auto-pay. The banner above each button surfaces connection state
  // and lets the user paste a wallet inline. directNwcFundPhase and
  // directNwcClaimPhase carry the current phase label for inline
  // progress on the button while the action is in flight; null means
  // the action is idle.
  const [savedNwcs, setSavedNwcs] = useState<SavedNwcConnection[]>(
    () => listSavedNwcConnections(),
  );
  const activeNwc = !disableNwc && savedNwcs.length > 0 ? savedNwcs[0] : null;
  const [directNwcFundPhase, setDirectNwcFundPhase] = useState<string | null>(null);
  const [directNwcClaimPhase, setDirectNwcClaimPhase] = useState<string | null>(null);
  const refreshSavedNwcs = () => setSavedNwcs(listSavedNwcConnections());
  // v0.3.0 Phase 3: claiming flag survives the ClaimPayoutModal lifetime
  // via the promise-based onClaim contract (mirrors Phase 2's onLock).
  // Disables the Claim button while the modal is open so re-taps can't
  // queue another flow.
  const [claiming, setClaiming] = useState(false);
  const [selectedHandleId, setSelectedHandleId] = useState<string>("");
  const [menuQuantities, setMenuQuantities] = useState<Record<string, number>>({});
  const [menuAmounts, setMenuAmounts] = useState<Record<string, string>>({});
  // v0.3.0 Phase 6: one-time educational card for State B (cross-fed
  // listing). Renders ONCE per pubkey, same gate-pattern as v0.2.0's
  // first-publish honesty card. Dismiss is sticky in localStorage.
  const [stateBDismissed, setStateBDismissed] = useState(() => hasStateBExplained(pubkey));
  const nowSec = Math.floor(Date.now() / 1000);
  const menuItems = state.items ?? [];
  const hasMenu = menuItems.length > 0;
  const hasExchangeMenu = hasMenu && state.category === "p2p-trade";
  const selectedMenuItems: SelectedMenuItem[] = hasMenu
    ? hasExchangeMenu
      ? menuItems.flatMap(item => {
          const exactSats = parsePositiveWholeSats(menuAmounts[item.id] ?? "");
          if (exactSats <= 0) return [];
          const exactMsats = exactSats * 1000;
          const minMsats = item.minAmountMsats ?? item.amountMsats;
          const maxMsats = item.maxAmountMsats ?? item.amountMsats;
          if (exactMsats < minMsats || exactMsats > maxMsats) return [];
          return [{
            itemId: item.id,
            label: item.label,
            kind: item.kind,
            amountMsats: exactMsats,
            quantity: 1,
            minAmountMsats: item.minAmountMsats,
            maxAmountMsats: item.maxAmountMsats,
            description: item.description,
            fiatAmount: item.fiatAmount,
            fiatCurrency: item.fiatCurrency,
            fulfillment: item.fulfillment,
            dueAt: item.dueAt,
            termDays: item.termDays,
            aprBps: item.aprBps,
            trustTier: item.trustTier,
          }];
        })
      : menuItems.flatMap(item => {
        const quantity = menuQuantities[item.id] ?? 0;
        if (quantity <= 0) return [];
        return [{
          itemId: item.id,
          label: item.label,
          kind: item.kind,
          amountMsats: item.amountMsats,
          quantity,
          minAmountMsats: item.minAmountMsats,
          maxAmountMsats: item.maxAmountMsats,
          description: item.description,
          fiatAmount: item.fiatAmount,
          fiatCurrency: item.fiatCurrency,
          fulfillment: item.fulfillment,
          dueAt: item.dueAt,
          termDays: item.termDays,
          aprBps: item.aprBps,
          trustTier: item.trustTier,
        }];
      })
    : [];
  const selectedMenuAmountMsats = selectedMenuItemsTotalMsats(selectedMenuItems);
  const menuSelectorRole = state.category === "lending" ? Role.SELLER : Role.BUYER;
  const savedOrderItems = state.joinHolds?.[menuSelectorRole]?.selectedItems ?? [];
  const savedOrderAmountMsats =
    selectedMenuItemsTotalMsats(savedOrderItems)
    || state.joinHolds?.[menuSelectorRole]?.amountMsats
    || 0;
  const savedOrderKey = savedOrderItems
    .map(item => `${item.itemId}:${item.amountMsats}:${item.quantity}`)
    .join("|");
  const selectedOrderKey = selectedMenuItems
    .map(item => `${item.itemId}:${item.amountMsats}:${item.quantity}`)
    .join("|");
  const acceptedPaymentMethods = (state.paymentMethods ?? [])
    .map(method => method.trim())
    .filter(Boolean);
  // #4: suggest + match a shared payment rail before lock. Intersect the
  // seller's accepted rails with the rails THIS viewer can pay on (their saved
  // handles), community-ranked. Surfaced to a prospective buyer (not the
  // seller, who set the rails). The seller's matched handle is revealed at lock.
  const viewerRailKeys = listSavedHandles().map(h => h.rail);
  const railMatch = matchRails(state.paymentMethods, viewerRailKeys, state.community);
  const sharedRailSet = new Set(railMatch.shared);
  const suggestedRail = railMatch.suggested ? getRailByKey(railMatch.suggested) : null;
  // #7 multi-unit storefront: a parent listing (stock set, no parent ref) is
  // bought by quantity — each purchase spawns its own child escrow rather than
  // locking the parent. The buy stepper clamps to the units left.
  const isMultiUnitParent = state.stock !== undefined && state.parent === undefined;
  // Units a buyer can still take. stockLeft is the derived remaining (0 when
  // sold out); fall back to the listing's stock only when remaining is unknown.
  // NOT floored at 1 — the old Math.max(1, …) let a buyer purchase a sold-out
  // listing (stockLeft 0 → still offered "Buy 1"), which is how 6 units sold
  // from a stock of 5. (The genuine concurrent last-unit race is still possible
  // on a coordinator-free relay backbone — Option A: the loser refunds — but no
  // one can buy a *visibly* sold-out listing.)
  const buyMax = stockLeft !== undefined ? Math.max(0, stockLeft) : (state.stock ?? 1);
  const soldOut = isMultiUnitParent && buyMax <= 0;
  const buyQtyClamped = Math.min(Math.max(1, buyQty), Math.max(1, buyMax));
  const premiumLine = listingPremiumLine(state, btcPrice.usd);
  const selectionMatchesSavedOrder = selectedOrderKey.length > 0 && selectedOrderKey === savedOrderKey;
  const savedOrderFinalizedAt = state.joinHolds?.[menuSelectorRole]?.orderFinalizedAt ?? null;
  const savedOrderFinalized = !!savedOrderFinalizedAt;
  const participants = getEffectiveParticipantsAt(state, nowSec);
  const myRole = samePubkey(participants.buyer, pubkey) ? Role.BUYER
    : samePubkey(participants.seller, pubkey) ? Role.SELLER
    : samePubkey(participants.arbiter, pubkey) ? Role.ARBITER : null;
  const participantPubkeys = [
    participants.buyer,
    participants.seller,
    participants.arbiter,
  ].filter((pk): pk is string => !!pk);
  const sellerPubkey = participants.seller
    ?? (state.initiator.role === Role.SELLER ? state.initiator.pubkey : null);
  const sellerProfileName = profileNameFor(profileNames, sellerPubkey, kind0Enabled);
  const participantPubkeySet = new Set(participantPubkeys.map(pk => pk.toLowerCase()));
  const hasDuplicateParticipant = participantPubkeys.length !== participantPubkeySet.size;
  const currentKeyAlreadyPresent =
    samePubkey(state.initiator.pubkey, pubkey) || participantPubkeys.some(pk => samePubkey(pk, pubkey));
  // v0.6.5: deterministic preview of which arbiter LOCK will pick from
  // the community pool, used purely for the Trinity-Ring "auto-assigned"
  // dot on CREATED listings that don't yet have a JOINed arbiter. Same
  // function escrow-bridge.ts uses at LOCK time, so the predicted
  // pubkey matches the eventual real assignment.
  const previewArbiterPk = state.status === EscrowStatus.CREATED
    && !participants[Role.ARBITER]
    && state.communityArbiters.length > 0
    ? (pickPreferredArbiter(state.communityArbiters, state.bondedArbiters, state.id, [
        participants[Role.BUYER],
        participants[Role.SELLER],
      ]) ?? null)
    : null;
  // Bond → arbiter enrollment (S3): fetch this community's chain-verified bonded
  // arbiters so provenance recognizes a seated bonded arbiter (green, not
  // "unrecognized"). Fetch-once per community, fail-soft (empty ⇒ roster+device
  // trust only). Keyed on the slug; the fetcher reads the live client internally.
  const [bondedNpubs, setBondedNpubs] = useState<string[]>([]);
  // null until a chain-verified read lands. Distinct from [] ("checked, and
  // this community has no bonded arbiters") — see arbiters/bonded-stamp.ts.
  const [verifiedBonded, setVerifiedBonded] = useState<string[] | null>(null);
  // The seated arbiter's own verified bond, kept for the arbiter card: tenure
  // (funding block height) and the funding outpoint, so a counterparty can
  // check the commitment in a block explorer instead of trusting this screen.
  const [seatedBond, setSeatedBond] = useState<VerifiedBond | null>(null);
  const [bondTipHeight, setBondTipHeight] = useState<number | null>(null);
  // A1b: how many OTHER bonds were announced in this community the same week as
  // the seated arbiter's. Derived from the bonds already fetched — no extra
  // read. Null when it cannot be computed (pre-A0 announcements carry no date),
  // which renders nothing rather than a misleading zero.
  const [cohortPeers, setCohortPeers] = useState<number | null>(null);
  // A1b: the seated arbiter's ruling concentration over the trades this device
  // knows. Pure and memoized — no fetch, no relay read; it only ever describes
  // the local view, which is why the card always shows the denominator.
  // Tranching: the plan's live gate. Recomputed from what this device knows,
  // and — critically — from OBSERVED CREDIT rather than any published status.
  const [advancingTranche, setAdvancingTranche] = useState(false);
  const [startingSlicePlan, setStartingSlicePlan] = useState(false);
  const [advanceTrancheError, setAdvanceTrancheError] = useState<string | null>(null);
  const [trancheCreditTick, setTrancheCreditTick] = useState(0);
  const autoAdvanceTrancheAttemptRef = useRef<string | null>(null);
  // On-chain funding: the funder taps "I've sent it", we re-read the chain and
  // LOCK. Any refusal (no deposit, still confirming, short) is surfaced VERBATIM
  // — those messages already say the one thing the user needs.
  const [checkingFunding, setCheckingFunding] = useState(false);
  const [fundingNote, setFundingNote] = useState<string | null>(null);
  /** The arbiter publishing their escrow key. Shares `fundingNote` for its
   *  refusals — one place the panel reports what went wrong. */
  const [publishingKey, setPublishingKey] = useState(false);
  const [settlementCheck, setSettlementCheck] = useState<SettlementCheck | null>(null);
  const [settlementSignedByMe, setSettlementSignedByMe] = useState(false);
  const settlementFinalizeAttemptRef = useRef<string | null>(null);
  const [settlementSigning, setSettlementSigning] = useState(false);
  const trancheGateNow = useMemo(() => {
    if (!state.tranche) return null;
    return trancheGate({
      planId: state.tranche.planId,
      total: state.tranche.total,
      states: knownTrades ?? [state],
      creditObserved: defaultCreditObserver(),
    });
  }, [state, knownTrades, trancheCreditTick]);
  const canAdvanceTranche = viewerIsExposedByLock(state, myRole) || state.lock.lockedAt === null;
  const autoAdvanceTrancheKey = trancheGateNow
    ? autoAdvanceOnchainTrancheKey({
        state,
        gate: trancheGateNow,
        viewerCanAdvance: canAdvanceTranche,
      })
    : null;

  // On-chain plans continue as soon as the fail-closed gate proves the last
  // slice settled. The ref makes React re-renders harmless: one plan/index gets
  // one publish attempt, while the manual button remains available if that
  // attempt reports a relay or signer error.
  useEffect(() => {
    if (!autoAdvanceTrancheKey || !onStartNextTranche) return;
    if (autoAdvanceTrancheAttemptRef.current === autoAdvanceTrancheKey) return;
    autoAdvanceTrancheAttemptRef.current = autoAdvanceTrancheKey;
    setAdvancingTranche(true);
    setAdvanceTrancheError(null);
    void Promise.resolve(onStartNextTranche(state.id))
      .catch((error) => {
        setAdvanceTrancheError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setAdvancingTranche(false));
  }, [autoAdvanceTrancheKey, onStartNextTranche, state.id]);

  const seatedArbiterPk = state.participants[Role.ARBITER];
  const seatedConcentration = useMemo(() => {
    if (!seatedArbiterPk || !knownTrades || knownTrades.length === 0) return null;
    return arbiterRulingConcentration(knownTrades, seatedArbiterPk);
  }, [knownTrades, seatedArbiterPk]);
  useEffect(() => {
    setBondedNpubs([]);
    setVerifiedBonded(null);
    setSeatedBond(null);
    setCohortPeers(null);
    if (!fetchCommunityBonds || !state.community) return;
    let cancelled = false;
    fetchCommunityBonds(state.community)
      .then((bonds) => {
        if (cancelled) return;
        const verified = bondedArbitersForCommunity(bonds);
        setBondedNpubs(verified);
        setVerifiedBonded(verified);
        const seated = state.participants[Role.ARBITER];
        const found = seated ? bonds.find((b) => b.npub === seated && b.funded) ?? null : null;
        setSeatedBond(found);
        if (found && typeof found.announcedAt === "number") {
          const dated = bonds
            .filter((b): b is VerifiedBond & { announcedAt: number } => typeof b.announcedAt === "number")
            .map((b) => ({ npub: b.npub, createdAt: b.announcedAt }));
          setCohortPeers(
            bondCohort({ npub: found.npub, createdAt: found.announcedAt }, dated).peerCount,
          );
        }
        // Tenure needs a tip to measure against. Only fetched when there is a
        // bond to measure, and fail-soft — no tip just means no age line.
        if (found) {
          esploraTipHeight(esploraFetcher(defaultEsploraBase(BOND_NETWORK), { network: BOND_NETWORK }))
            .then((tip) => { if (!cancelled) setBondTipHeight(tip); })
            .catch(() => { /* no tip → the card still shows the amount */ });
        }
      })
      .catch(() => { /* fail-soft — roster+device trust carries provenance */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.community, state.participants[Role.ARBITER]]);

  // v3.5 pool integrity (C1+C7) — consent-layer assessment, shared by the
  // provenance banner and the performer's vote gate. All client-side: a wrong
  // answer here warns (or under-warns), never strands. Memoized on the state
  // object (every reducer apply produces a fresh one) because the roster read
  // re-verifies a Schnorr signature — too heavy for timer-driven re-renders.
  const { arbiterProv, arbiterAssignment, selfRostered, feeGateUnmet, forgedBondedStamp } = useMemo(() => {
    // Bonded arbiters (S3) are a chain-verified trust source — fold them in so a
    // seated bonded arbiter reads green, not "unrecognized". bondedNpubs is
    // fetched below; empty until it arrives (fails soft to roster+device).
    // §0.3: the CREATE stamp is creator-written and unverified. Intersect it
    // with the chain-verified set before ANY consent decision reads it — a
    // stamp naming one confederate otherwise short-circuits the deterministic
    // pick and seats them via the honest counterparty's own client.
    const bondedStamp = verifyBondedStamp(state.bondedArbiters, verifiedBonded);
    const sources = getTrustedArbiterPoolSources({ community: state.community, bondedPool: bondedNpubs });
    const trusted = [...new Set([...sources.rosterArbiters, ...sources.deviceTrusted, ...sources.bondedArbiters])];
    const prov = classifyArbiterProvenance(state.communityArbiters, trusted);
    // Assignment is judged on the LOCK-committed arbiter only. Pre-LOCK there
    // is nothing committed (the preview above is computed honestly by THIS
    // device), and a JOIN-seated arbiter is already reducer-gated to the
    // assigned pick.
    const assignment: ArbiterAssignment = classifyArbiterAssignment({
      pool: state.communityArbiters ?? [],
      escrowId: state.id,
      committedArbiter: state.status !== EscrowStatus.CREATED
        ? state.participants[Role.ARBITER]
        : null,
      buyerPubkey: state.participants[Role.BUYER],
      sellerPubkey: state.participants[Role.SELLER],
      bondedArbiters: bondedStamp.effective,
    });
    // Stake-holding identities only — a steward who also arbitrates in their
    // own community is the trust anchor, not a conflict (see classifySelfRoster).
    const rostered = classifySelfRoster({
      communityArbiters: state.communityArbiters,
      sources,
      tradeParties: [
        state.initiator.pubkey,
        state.participants[Role.BUYER],
        state.participants[Role.SELLER],
      ],
    });
    return {
      arbiterProv: prov,
      arbiterAssignment: assignment,
      selfRostered: rostered,
      // The forged stamp is already neutralised by the intersection above, but
      // a counterparty deciding whether to send fiat deserves to know the
      // creator wrote something untrue into the trade.
      forgedBondedStamp: stampIsForged(bondedStamp),
      feeGateUnmet: requiresVerifiedRosterConsent({
        arbiterFeeMsats: state.fees.arbiterMsats,
        amountMsats: state.amountMsats,
        poolSize: (state.communityArbiters ?? []).length,
        distinctAuthorityVerified: prov.verified && !rostered,
      }),
    };
  }, [state, bondedNpubs, verifiedBonded]);
  const votePrompt = decideVotePrompt(state, pubkey, participants);
  const winner = getWinner(state);
  const iAmWinner = samePubkey(winner?.pubkey, pubkey);
  const claimRetryBlocked =
    state.status === EscrowStatus.CLAIMED &&
    !!claimBlockedReason &&
    /reissue|consumed|settle/i.test(claimBlockedReason);
  // R3-1b: a CLAIMED trade with a SENT payout record (submitted/settled)
  // means the payout already went out — the trade just hasn't flipped to
  // COMPLETED yet (the background re-attach is confirming it). Show a
  // "confirming" terminal instead of an active RETRY-CLAIM invite, and never
  // sit on a permanent "Claim already sent — retrying" line.
  // V7: an `intent` record is NOT evidence a payment exists (pre-send
  // breadcrumb) — RETRY CLAIM stays live; the retry's own top guard
  // reconciles by escrow before any re-pay.
  const payoutRecordStatus = getPayoutRecord(state.id)?.status;
  const payoutConfirming =
    state.status === EscrowStatus.CLAIMED && !claimRetryBlocked
    && (payoutRecordStatus === "submitted" || payoutRecordStatus === "settled");
  const statusKey = claimRetryBlocked ? "CLAIM_FAILED" : state.status;
  const s = STATUS[statusKey] || STATUS.CREATED;

  const expectedLocker = state.category === "marketplace" ? Role.BUYER
    : state.category === "lending" ? Role.SELLER
    : (state.category === "p2p-trade" || state.category === "bill-pay") ? Role.SELLER
    : null;
  const canILock = !expectedLocker || myRole === expectedLocker;
  const canSelectMenu =
    hasMenu &&
    state.status === EscrowStatus.CREATED &&
    myRole === menuSelectorRole &&
    !savedOrderFinalized;
  const selectorNeedsSaveOrder = canSelectMenu && !canILock;
  const lockMenuItems = hasMenu && canILock && myRole !== menuSelectorRole
    ? savedOrderItems
    : selectedMenuItems;
  const lockMenuAmountMsats = selectedMenuItemsTotalMsats(lockMenuItems);
  const lockAmountMsats = hasMenu && lockMenuAmountMsats > 0
    ? lockMenuAmountMsats
    : state.amountMsats;
  const lockRequiresFinalOrder = hasMenu && canILock && myRole !== menuSelectorRole;
  const menuOrderNotFinal = lockRequiresFinalOrder && lockMenuItems.length > 0 && !savedOrderFinalized;
  const createdMenuRows = canSelectMenu
    ? menuItems
    : savedOrderItems.length > 0
      ? savedOrderItems
      : [];
  const renderedMenuRows = state.status === EscrowStatus.CREATED
    ? createdMenuRows
    : (state.lock.selectedItems ?? []).map(selected => ({
        ...selected,
        // Order snapshots intentionally contain no media. Resolve the
        // thumbnail from the immutable CREATE listing for display only.
        imageDataUrl: menuItems.find(item => item.id === selected.itemId)?.imageDataUrl,
      }));
  const menuDisplayAmountMsats = canSelectMenu
    ? selectedMenuAmountMsats || savedOrderAmountMsats
    : lockMenuAmountMsats || savedOrderAmountMsats;
  const hasEligibleArbiter =
    !!participants[Role.ARBITER] || !!previewArbiterPk;
  const lockBlockedByNoArbiter =
    state.status === EscrowStatus.CREATED &&
    !!participants[Role.BUYER] &&
    !hasEligibleArbiter;
  const canJoinAsArbiter =
    !participants.arbiter &&
    !previewArbiterPk &&
    state.communityArbiters.includes(pubkey);

  // ⭐ Tier 2.1: an ON-CHAIN trade cannot be funded until the arbiter's escrow
  // key is published, and an AUTO-SEATED arbiter never publishes a JOIN — so
  // with auto-assignment on, the address could never be computed and the trade
  // would wait forever on a message that reads like patience rather than
  // deadlock. On-chain therefore needs the arbiter to act up front, and this is
  // the affordance that lets them. Shown only to the deterministic pick, only
  // while their key is missing.
  const onchainNeedsMyArbiterKey =
    (state.escrowMode ?? "ecash") === "onchain" &&
    !state.lock.lockedAt &&
    !(state.escrowKeys ?? {})[Role.ARBITER] &&
    !!pubkey &&
    (participants.arbiter === pubkey || previewArbiterPk === pubkey) &&
    state.communityArbiters.includes(pubkey);
  // Tier 2.1: the on-chain escrow surface. The address is RECOMPUTED here (via
  // the hook) and never read off the wire — the panel refuses to show one it
  // did not derive.
  //
  // Computed AFTER `onchainNeedsMyArbiterKey` on purpose: the view needs to know
  // whether the viewer is the party the trade is stalled on, and that answer
  // depends on the deterministic arbiter pick resolved just above.
  const onchainView = useMemo(() => {
    if ((state.escrowMode ?? "ecash") !== "onchain") return null;
    let plan: { ready: boolean; address?: string; blockers?: readonly string[] } | null = null;
    try { plan = onchainFundingPlan?.(state.id) ?? null; } catch { plan = null; }
    return deriveOnchainView({
      state,
      viewerRole: myRole,
      recomputedAddress: plan?.ready ? (plan.address ?? null) : null,
      blockers: plan?.ready ? [] : (plan?.blockers ?? ["not-ready"]),
      viewerIsPendingArbiter: onchainNeedsMyArbiterKey,
    });
    // ⚠ `verifiedBonded` is in the deps for a REASON that is not obvious.
    //
    // An auto-seated arbiter's escrow key comes from their bond, which
    // `onchainFundingPlan` reads out of the bonded-pool CACHE — a synchronous
    // read of data filled in asynchronously by the effect above. Without this
    // dep the memo runs once, before the fetch lands, caches "no arbiter key"
    // and never recomputes: the seller sits on "waiting for the arbiter" with a
    // bond that has been live and announced for minutes. Re-running when the
    // verified set arrives is what turns the blocker into an address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, myRole, onchainFundingPlan, onchainNeedsMyArbiterKey, verifiedBonded]);

  useEffect(() => {
    const arbitrated = !!state.resolvedMajority?.includes(Role.ARBITER);
    const winnerRole = getWinner(state)?.role;
    const eligibleSigner = arbitrated
      ? myRole === Role.ARBITER || myRole === winnerRole
      : myRole === Role.BUYER || myRole === Role.SELLER;
    if (!onchainView?.canSettle || !onPrepareOnchainSettlement || !eligibleSigner) {
      setSettlementCheck(null);
      setSettlementSignedByMe(false);
      return;
    }
    let cancelled = false;
    void onPrepareOnchainSettlement(state.id).then(
      ({ check, signedByMe }) => {
        if (!cancelled) {
          setSettlementCheck(check);
          setSettlementSignedByMe(signedByMe);
        }
      },
      (error) => {
        if (!cancelled) setSettlementCheck({
          ok: false,
          failures: [error instanceof Error ? error.message : String(error)],
        });
      },
    );
    return () => { cancelled = true; };
  }, [state.id, state.status, state.settlements?.length, myRole, onchainView?.canSettle, onPrepareOnchainSettlement]);

  // Relay arrival can complete a pair of independently signed revisions even
  // when neither signer currently holds the other's PSBT in their click path.
  // Attempt once per observed revision count; the action itself rechecks chain
  // outspends first and is therefore safe across tabs/reloads.
  useEffect(() => {
    const arbitrated = !!state.resolvedMajority?.includes(Role.ARBITER);
    const winnerRole = getWinner(state)?.role;
    const eligibleSigner = arbitrated
      ? myRole === Role.ARBITER || myRole === winnerRole
      : myRole === Role.BUYER || myRole === Role.SELLER;
    const count = state.settlements?.length ?? 0;
    if (!eligibleSigner || !onchainView?.canSettle || !onFinalizeOnchainSettlement || count === 0) return;
    const attempt = `${state.id}:${count}`;
    if (settlementFinalizeAttemptRef.current === attempt) return;
    settlementFinalizeAttemptRef.current = attempt;
    void onFinalizeOnchainSettlement(state.id).catch(error => {
      console.warn("[chama] automatic on-chain settlement finalization failed:", error);
    });
  }, [state.id, state.settlements?.length, myRole, onchainView?.canSettle, onFinalizeOnchainSettlement]);

  const canJoinAsBuyer = !participants.buyer;
  const canJoinAsSeller = !participants.seller;
  const canJoinTrade = canJoinAsBuyer || canJoinAsSeller || canJoinAsArbiter || onchainNeedsMyArbiterKey;
  const prewarmedEscrowRef = useRef<string | null>(null);

  // Disarm the cancel hatch whenever the viewed trade (or its vote state)
  // changes — an armed confirm must never carry across trades. (No `key` on
  // TradeDetail, so the component instance is reused between trades.)
  useEffect(() => {
    setCancelArmed(false);
    setArmedOutcome(null);
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
  }, [state.id, state.votes[Role.BUYER], state.votes[Role.SELLER]]);

  // R3-1b: opening a CLAIMED trade whose payout was already sent re-attaches
  // to confirm + complete it, so a refund/claim that landed while the app was
  // closed flips to done on view (and the counterparty's "settling" resolves).
  useEffect(() => {
    if (payoutConfirming && onConfirmPayout) onConfirmPayout(state.id);
  }, [state.id, payoutConfirming]);

  useEffect(() => {
    if (!onPrewarmFunding) return;
    if (state.status !== EscrowStatus.CREATED) return;
    if (!canILock || bootProbeFailed || receiveUnavailable || fundingInProgress || menuOrderNotFinal) return;
    if (prewarmedEscrowRef.current === state.id) return;
    prewarmedEscrowRef.current = state.id;
    void onPrewarmFunding();
  }, [
    state.id,
    state.status,
    canILock,
    bootProbeFailed,
    receiveUnavailable,
    fundingInProgress,
    menuOrderNotFinal,
    onPrewarmFunding,
  ]);

  useEffect(() => {
    if (!hasMenu || state.status !== EscrowStatus.CREATED) return;
    if (hasExchangeMenu) {
      setMenuAmounts(prev => {
        const next: Record<string, string> = {};
        for (const item of menuItems) {
          next[item.id] = prev[item.id] ?? "";
        }
        return next;
      });
      return;
    }
    setMenuQuantities(prev => {
      const next: Record<string, number> = {};
      for (const item of menuItems) {
        next[item.id] = Math.max(0, prev[item.id] ?? 0);
      }
      return next;
    });
  }, [hasExchangeMenu, hasMenu, state.id, state.status, menuItems]);

  useEffect(() => {
    if (!hasMenu || state.status !== EscrowStatus.CREATED || savedOrderItems.length === 0) return;
    if (hasExchangeMenu) {
      setMenuAmounts(prev => {
        const next = { ...prev };
        for (const item of savedOrderItems) {
          if (!next[item.itemId]) next[item.itemId] = satsInputValue(item.amountMsats);
        }
        return next;
      });
      return;
    }
    setMenuQuantities(prev => {
      const next = { ...prev };
      for (const item of savedOrderItems) {
        if (!next[item.itemId]) next[item.itemId] = item.quantity;
      }
      return next;
    });
  }, [savedOrderKey, hasExchangeMenu, hasMenu, state.id, state.status]);

  const lockLabel = state.category === "marketplace" ? t("trade.lockLabelMarketplace")
    : state.category === "lending" ? t("trade.lockLabelLending")
    : state.category === "bill-pay" ? t("trade.lockLabelBillPay")
    : state.category === "p2p-trade" ? t("trade.lockLabelP2p")
    : t("trade.lockLabelDefault");
  const liveJoinHold = state.status === EscrowStatus.CREATED
    ? [Role.BUYER, Role.SELLER]
        .filter(role => role !== state.initiator.role)
        .map(role => {
          const remaining = getJoinHoldRemainingSeconds(state, role, nowSec);
          const hold = state.joinHolds?.[role];
          return remaining && remaining > 0 && hold
            ? { role, expiresAt: hold.expiresAt, remaining }
            : null;
        })
        .filter((hold): hold is { role: Role; expiresAt: number; remaining: number } => !!hold)
        .sort((a, b) => a.expiresAt - b.expiresAt)[0] ?? null
    : null;
  const expiredJoinHold = state.status === EscrowStatus.CREATED
    ? [Role.BUYER, Role.SELLER]
        .filter(role => role !== state.initiator.role)
        .map(role => {
          const hold = state.joinHolds?.[role];
          if (!hold || state.participants[role] !== hold.pubkey || participants[role]) return null;
          return hold.expiresAt <= nowSec
            ? { role, pubkey: hold.pubkey, expiredAgo: nowSec - hold.expiresAt }
            : null;
        })
        .filter((hold): hold is { role: Role; pubkey: string; expiredAgo: number } => !!hold)
        .sort((a, b) => b.expiredAgo - a.expiredAgo)[0] ?? null
    : null;
  const liveLockWindowRole = liveJoinHold
    ? expectedLocker ?? liveJoinHold.role
    : null;
  // #7 Stage 0 — contention visibility. When the viewer is NOT a participant
  // (a would-be second buyer / observer) and the live hold belongs to someone
  // else, surface it honestly so they aren't stranded thinking they joined:
  // "reserved — being viewed by another buyer, Ns left." Frees on expiry,
  // taken on lock. The reducer already rejects their JOIN (ROLE_TAKEN); this
  // just makes that truth visible instead of a phantom lock window.
  const reservedByOther = (!myRole && liveJoinHold
    && state.joinHolds?.[liveJoinHold.role]
    && !samePubkey(state.joinHolds[liveJoinHold.role]!.pubkey, pubkey))
    ? liveJoinHold
    : null;
  const buyerJoinEvents = state.status === EscrowStatus.CREATED
    ? state.eventChain.filter(event => event.kind === EscrowEventKind.JOIN
        && (event.payload as JoinPayload).role === Role.BUYER)
    : [];
  const buyerAttemptRows = buyerJoinEvents
    .map((event, index) => {
      const payload = event.payload as JoinPayload;
      const selectedItems = payload.selectedItems ?? [];
      const amountMsats = payload.amountMsats
        ?? selectedMenuItemsTotalMsats(selectedItems)
        ?? 0;
      const expiresAt = payload.holdExpiresAt ?? joinHoldExpiresAtFor(payload.joinedAt, state.escrowMode);
      const isLatest = index === buyerJoinEvents.length - 1;
      const isLive = isLatest && expiresAt > nowSec;
      const finalized = !!payload.orderFinalizedAt;
      const statusLabel = isLive
        ? finalized ? t("trade.attemptReady") : t("trade.attemptHolding")
        : expiresAt <= nowSec ? t("trade.attemptExpired") : t("trade.attemptUpdated");
      return {
        id: event.raw.id,
        pubkey: event.pubkey,
        joinedAt: payload.joinedAt,
        expiresAt,
        amountMsats,
        selectedCount: selectedItems.length,
        statusLabel,
        isLive,
      };
    })
    .sort((a, b) => b.joinedAt - a.joinedAt);
  // A Store (marketplace) seller must see who reserved their listing exactly
  // like a p2p seller does — the panel was p2p-only, which is why a buyer
  // reserving a single-unit Store listing was invisible in trade detail. A
  // multi-unit PARENT has no direct buyer JOINs (reservations are child orders),
  // so buyerAttemptRows is empty there and this stays hidden — the pending-child
  // "reserving" panel covers that case instead.
  const showBuyerAttempts =
    (state.category === "p2p-trade" || state.category === "marketplace")
    && state.status === EscrowStatus.CREATED
    && buyerAttemptRows.length > 0
    && !!sellerPubkey
    && samePubkey(sellerPubkey, pubkey);
  const lockMenuSelectionMissing = hasMenu && lockMenuItems.length === 0;
  const nextStep = detailNextStep({
    t,
    state,
    myRole,
    canILock,
    hasMenu,
    menuSelectorRole,
    savedOrderFinalized,
    savedOrderAmountMsats,
    lockAmountMsats,
    menuSelectionMissing: lockMenuSelectionMissing,
    menuOrderNotFinal,
    participantsBuyer: participants.buyer ?? undefined,
    votePromptKind: votePrompt.kind,
    votePromptOutcomes: votePrompt.kind === "buttons" ? votePrompt.outcomes : undefined,
    votePromptRole: votePrompt.kind === "buttons" ? votePrompt.role : null,
    iAmWinner,
    claimRetryBlocked,
    canJoinTrade,
  });
  // On a parent storefront, quantity is a live checkout selection. Reflect it
  // in both the top-right next-step amount and the large Details amount before
  // an order exists, so Buy 2 never leaves stale Buy-1 pricing on screen.
  const storefrontSelectionAmountMsats = isMultiUnitParent && state.status === EscrowStatus.CREATED
    ? state.amountMsats * buyQtyClamped
    : null;
  const nextStepDisplayAmountMsats = storefrontSelectionAmountMsats ?? nextStep.amountMsats;
  const heroAmountMsats = nextStepDisplayAmountMsats ?? (menuDisplayAmountMsats || state.amountMsats);
  const exactHeroFiatBase = detailHeroFiatAmount({
    state,
    selectedMenuItems,
    savedOrderItems,
    menuItems,
  });
  const exactHeroFiat = exactHeroFiatBase && storefrontSelectionAmountMsats !== null
    ? { ...exactHeroFiatBase, amount: exactHeroFiatBase.amount * buyQtyClamped }
    : exactHeroFiatBase;
  const estimatedHeroFiat = detailEstimatedHeroFiatAmount({
    state,
    amountMsats: heroAmountMsats,
    quoteCurrency: homeQuoteCurrency,
    usdPerBtc: btcPrice.usd,
    usdFiatRates: fiatRates.rates,
  });
  const quoteViewerFiat = shouldQuoteEstimatedFiat({
    viewerCurrency: homeQuoteCurrency,
    listingCurrency: exactHeroFiat?.currency
      ?? state.fiatCurrency
      ?? (state.community ? getCommunityBySlug(state.community)?.currency : null),
  });
  // Always anchor the headline on the seller's NATIVE listing price. Never
  // swap it for the viewer's converted estimate — a cross-country buyer (e.g.
  // a KES Chama viewing a TZS listing, same fed) would otherwise see a number
  // in their own currency and assume that IS the price. The viewer-currency
  // estimate rides alongside as a secondary "≈" line whenever the viewer's
  // Chama currency differs from the listing's. (Browse/TradeCard does the same.)
  const heroFiat = exactHeroFiat ?? estimatedHeroFiat;
  const heroFiatLabel = heroFiat ? formatFiatAmount(heroFiat.amount, heroFiat.currency) : null;
  const viewerEstimate = quoteViewerFiat
    && estimatedHeroFiat
    && (!heroFiat || normalizeFiatCurrency(estimatedHeroFiat.currency) !== normalizeFiatCurrency(heroFiat.currency))
      ? estimatedHeroFiat
      : null;
  const viewerEstimateLabel = viewerEstimate
    ? `≈ ${formatFiatAmount(viewerEstimate.amount, viewerEstimate.currency)}`
    : null;
  const premiumCheckoutLine = detailPremiumCheckoutLine(state, heroFiat, t);
  // v4.1 lifecycle-aware pane + checkout headline: the party that owes fiat (the
  // buyer in a sats↔fiat exchange, the volunteer/payer in CBP) needs who-to-pay +
  // how-much front and centre. Nobody owes fiat in marketplace/lending here, so
  // the headline + Details-first focus only apply to these two verticals.
  const fiatPayerRole: Role | null =
    state.category === "p2p-trade" || state.category === "bill-pay" ? Role.BUYER : null;
  // The FINAL fiat the payer actually transfers: p2p-trade folds the premium into
  // the fiat; CBP takes the premium in sats, so its fiat due is the base amount.
  const checkoutFiatDue = heroFiat && heroFiat.amount > 0
    ? {
        amount: heroFiat.amount * (state.category === "p2p-trade" && state.premiumBps ? 1 + state.premiumBps / 10_000 : 1),
        currency: heroFiat.currency,
      }
    : null;
  const checkoutFiatLabel = checkoutFiatDue && Number.isFinite(checkoutFiatDue.amount) && checkoutFiatDue.amount > 0
    ? formatFiatAmount(checkoutFiatDue.amount, checkoutFiatDue.currency)
    : null;
  const billTypeChip = state.category === "bill-pay" ? billTypeDisplay(state.billType) : null;
  const showHeroFiat = amountDisplayMode === "fiat" && !!heroFiatLabel;
  const shortTradeId = state.id.length > 18 ? `${state.id.slice(0, 10)}…${state.id.slice(-6)}` : state.id;
  const publicStoreListingUri = state.category === "marketplace" && !isChildOrder(state)
    ? nip99ListingUri(state.initiator.pubkey, state.id, DEFAULT_RELAYS.slice(0, 3))
    : null;
  const releaseVoteCount = Object.values(state.votes).filter(v => v === Outcome.RELEASE).length;
  const refundVoteCount = Object.values(state.votes).filter(v => v === Outcome.REFUND).length;
  // v3.2: dispute is a first-class header state — "A call is needed" the
  // moment both outcomes are on record unresolved, for every seat.
  const titleDisputed = releaseVoteCount > 0 && refundVoteCount > 0 && !state.resolvedOutcome;
  const tradeRoomTitle = state.status === EscrowStatus.CREATED
    ? hasMenu ? t("trade.titleBuildOrder") : t("trade.titleNewOrder")
    : state.status === EscrowStatus.LOCKED
      ? titleDisputed ? t("trade.titleCallNeeded") : t("trade.titleTradeLive")
      : state.status === EscrowStatus.COMPLETED
        ? t("trade.titleTradeComplete")
        : state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED
          ? t("trade.titleReadyToSettle")
          : t("trade.titleTradeRoom");
  const decisionTone = state.resolvedOutcome === Outcome.RELEASE
    ? T.green
    : state.resolvedOutcome === Outcome.REFUND
      ? T.amber
      : ROLE_COLOR.arbiter; // pending: the "awaiting decision" chip wears the arbiter's #5AC8FA — it's the arbiter's call.
  const decisionLabel = state.resolvedOutcome ? t("trade.finalDecision") : t("trade.awaitingDecision");
  const decisionValue = state.resolvedOutcome ?? t("trade.pending");
  // v3.1 stage 2 — elastic deal slot: auto-open at fund (CREATED) & dispute.
  const dealAutoOpen = state.status === EscrowStatus.CREATED
    || (releaseVoteCount > 0 && refundVoteCount > 0 && !state.resolvedOutcome);
  const dealOpen = dealSlotOpen ?? dealAutoOpen;
  const dealBuyerName = profileNameFor(profileNames, participants[Role.BUYER], kind0Enabled);
  const dealSellerName = profileNameFor(profileNames, participants[Role.SELLER], kind0Enabled);
  // Votes are now narrated as living-chat bubbles (the cohesive surface), so the
  // Parties vote-tally collapses to an at-a-glance summary by default — it only
  // auto-opens when it actually adds value: an active dispute, or once resolved.
  // (Manual toggle via votesRowOpen still wins.)
  const votesOpen = votesRowOpen ?? (titleDisputed || !!state.resolvedOutcome);
  // v3.2: chat auto-opens at LOCKED for buyer/seller (the work surface). The
  // arbiter keeps the chat VISIBLE (they guard both sides throughout) but it
  // stays collapsed until a dispute actually summons them.
  const chatOpen = chatRowOpen ?? (state.status === EscrowStatus.LOCKED
    && (myRole !== Role.ARBITER || titleDisputed));
  const showStorefrontImages =
    state.category !== "marketplace" ||
    !homeCommunity ||
    !state.community ||
    state.community === homeCommunity;
  const heroImages = showStorefrontImages ? [
    ...(state.imageUrls?.length ? state.imageUrls : state.imageDataUrl ? [state.imageDataUrl] : []),
    ...menuItems.flatMap(item => item.imageUrls?.length ? item.imageUrls : item.imageDataUrl ? [item.imageDataUrl] : []),
  ] : [];
  // Trade detail follows the sketch: route education stays as a tiny
  // context note in the hero instead of a full pre-room card.
  const showVerboseRouteEducation = false;
  const routeNote = state.status === EscrowStatus.CREATED
    ? framing.kind === "state-b"
      ? t("trade.tradingOn", { flag: framing.listingFlagEmoji, name: framing.listingCommunityName })
      : framing.sameFedSameCommunity
        ? t("trade.sameCommunity")
        : t("trade.sameFederation")
    : null;

  const handleVote = async (outcome: Outcome) => {
    // v1.2.2 vote-freeze fix: await the wired publish-and-toast
    // chain so the button reflects the REAL flight duration
    // (8–16 s typical) instead of resetting after 1 s. With the
    // previous fire-and-forget pattern, sellers would tap, see no
    // visible change, tap again, and the second tap hit the
    // VOTE_SUPPRESSED swallow path with no UI feedback at all.
    // Now: button stays "publishing" until the toast fires.
    if (voting) return;
    setVoting(true);
    try {
      await onVote(outcome);
    } finally {
      setVoting(false);
    }
  };

  // Arm-to-confirm gate for a money button: first tap arms (records which
  // outcome), second tap on the SAME outcome fires the real vote. Auto-disarms
  // after ~3s; tapping the other button re-arms it. Routing is unchanged — this
  // is purely a misfire guard layered over handleVote/onVote.
  const disarmVote = () => {
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
    setArmedOutcome(null);
  };
  const armOrVote = (outcome: Outcome) => {
    if (voting) return;
    if (armedOutcome === outcome) { disarmVote(); void handleVote(outcome); return; }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmedOutcome(outcome);
    // Release auto-disarms after ~3s (a pure misfire guard). Refund instead opens
    // a reason picker with explicit pick / skip / cancel, so it stays put.
    if (outcome === Outcome.RELEASE) {
      armTimerRef.current = setTimeout(() => { setArmedOutcome(null); armTimerRef.current = null; }, 3000);
    }
  };

  // ── TradeView pager (Chat · Details · Parties) + living chat ───────────────
  // Presentation-only: the swipe pager state + living-chat bubble feed derived
  // from existing state. The reducer / event chain is never written.
  const PAGER_TABS = [t("trade.paneChat"), t("trade.paneDetails"), t("trade.paneParties")];
  const pagerRef = useRef<HTMLDivElement | null>(null);
  // v4.1: "a manual swipe wins forever" — lifecycle auto-focus must never yank a
  // user who has moved themselves. programmaticTargetRef lets onPagerScroll tell our
  // own smooth-scrolls apart from a real finger swipe (the pager only scrolls on the
  // X axis, so its onScroll firing == a pane move).
  const userMovedPaneRef = useRef(false);
  const programmaticTargetRef = useRef<number | null>(null);
  // Leading pane (0=Chat · 1=Details · 2=Parties), lifecycle- AND role-aware: open
  // to the pane that matches the viewer's NEXT obligation. Pre-lock everyone reads
  // the terms (Details). Once LOCKED, the party who owes fiat lands on Details (who
  // to pay + the "You owe" headline); the receiver waits in Chat for the "sent" ping.
  // From the vote/claim/settle phase on, it's all coordination → Chat.
  // #68 action-aware landing: land on the pane where the viewer's next action
  // lives (Details for pre-lock config + fund/claim money actions; Chat for
  // unread coordination) so nobody opens to a view with nothing to do. Pure
  // helper (trade-pane.ts) so the rules are testable. The unread signal is read
  // from device-local storage so it's stable at mount without depending on the
  // chatReadAt state defined below.
  const defaultPane = pickDefaultPane({
    status: state.status,
    myRole,
    fiatPayerRole,
    iAmWinner,
    titleDisputed,
    hasUnreadChat: unreadChatForTrade(state, myRole) > 0,
  });
  const [activePane, setActivePane] = useState(defaultPane);
  // Snap to the leading pane when the viewed trade OR the viewer's seat changes
  // (not every status tick), so a manual swipe within a stable trade isn't yanked
  // back. A successful join changes myRole from null to buyer/seller/arbiter while
  // keeping the same trade id; including myRole here is what makes every vertical
  // reliably land the new participant on Details for pre-lock configuration.
  useEffect(() => {
    setActivePane(defaultPane);
    // Fresh trade/seat → re-enable auto-focus, and mark the mount scroll as
    // programmatic so onPagerScroll doesn't mistake it for a user swipe.
    userMovedPaneRef.current = false;
    programmaticTargetRef.current = defaultPane;
    // #68 landing-race fix: on first mount the pager's clientWidth is frequently 0
    // (not laid out yet), so `scrollLeft = pane * 0` silently no-ops and the view
    // stays stuck on Chat — the exact "buyer joins a store/CBP and lands in an empty
    // chat instead of the cart" bug. Apply the snap AFTER layout via rAF, retrying
    // until the pager has a real width, so pre-lock config reliably lands on Details.
    let raf = 0;
    let tries = 0;
    const snap = () => {
      const el = pagerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      // Bounded retry: if the pager is still zero-width (hidden / not laid out),
      // retry for at most ~30 frames (~0.5s) then give up — NEVER an unbounded
      // per-frame loop (that would peg a CPU core on any mounted-but-hidden pager).
      if (w === 0) {
        if (tries++ < 30) raf = requestAnimationFrame(snap);
        return;
      }
      if (Math.round(el.scrollLeft / w) !== defaultPane) el.scrollLeft = defaultPane * w;
    };
    raf = requestAnimationFrame(snap);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [state.id, myRole]); // eslint-disable-line react-hooks/exhaustive-deps
  const goPane = (i: number) => {
    const clamped = Math.max(0, Math.min(PAGER_TABS.length - 1, i));
    programmaticTargetRef.current = clamped;
    const el = pagerRef.current;
    if (el) {
      // #19: a programmatic jump of more than one pane scrolls INSTANTLY — a smooth
      // animation would be trapped at an intermediate pane by scroll-snap-stop:always.
      const current = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
      el.scrollTo({ left: clamped * el.clientWidth, behavior: Math.abs(clamped - current) > 1 ? "auto" : "smooth" });
    }
    setActivePane(clamped);
  };
  // Joining is an async state transition. On StartOS the trade room can finish
  // laying itself out after the role update has already fired, which lets the
  // scroll container fall back to its physical first pane (Chat). Re-assert the
  // pre-lock Details destination after layout; this is tied to the explicit join
  // action, so it cannot yank somebody who later swipes on their own.
  const landOnDetailsAfterJoin = () => {
    userMovedPaneRef.current = false;
    goPane(1);
    requestAnimationFrame(() => requestAnimationFrame(() => goPane(1)));
  };
  // A pane move the USER initiated (pill tap / pills drag) — disables auto-focus.
  const userGoPane = (i: number) => { userMovedPaneRef.current = true; goPane(i); };
  const onPagerScroll = () => {
    const el = pagerRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    // Tell our own smooth-scroll apart from a finger swipe: while a programmatic
    // target is pending, IGNORE transient positions (a layout-settle scroll to 0
    // must not clobber activePane back to Chat — the #68 landing-race). Only clear
    // the target once we've actually arrived. A horizontal scroll with NO pending
    // target is the user swiping → they've taken control.
    if (programmaticTargetRef.current !== null) {
      if (i === programmaticTargetRef.current) {
        programmaticTargetRef.current = null;
        setActivePane(prev => (prev === i ? prev : i));
      }
      return;
    }
    setActivePane(prev => (prev === i ? prev : i));
    userMovedPaneRef.current = true;
  };
  // v4.1 lifecycle landing: when a trade goes LIVE (LOCKED), send the fiat payer to
  // Details (who to pay + the "You owe" headline) and the receiver to Chat (to catch
  // the "sent" ping + proof). When a vote is actually summoned (dispute), send that
  // voter to Chat, where the evidence + the action-card vote buttons live. Fires once
  // per transition, and NEVER once the user has taken control with a manual swipe.
  // NOTE: decideVotePrompt returns "buttons" for only the FIRST voter at a time, so
  // buyer/seller key off LOCKED directly; the responder's buttons just appear in the
  // already-on-top action card when their turn unlocks.
  const lockedLandingPane =
    state.status === EscrowStatus.LOCKED && (myRole === Role.BUYER || myRole === Role.SELLER)
      ? (!titleDisputed && myRole === fiatPayerRole) ? 1 : 0
      : null;
  const landing: { key: string; pane: number } | null =
    lockedLandingPane !== null
      // Include the role + destination pane in the transition key. A spectator can
      // open an already-LOCKED trade before accepting it; the old id-only key was
      // consumed while myRole was null, so becoming the buyer could not focus the
      // Details pane afterward and left them stranded in Chat.
      ? { key: `${state.id}:locked:${myRole}:${lockedLandingPane}`, pane: lockedLandingPane }
      : votePrompt.kind === "buttons"
        ? { key: `${state.id}:vote:${votePrompt.role}`, pane: 0 }
        : null;
  const lastLandingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!landing || lastLandingRef.current === landing.key) return;
    lastLandingRef.current = landing.key;
    if (userMovedPaneRef.current) return; // the user moved themselves — never yank
    goPane(landing.pane);
  }, [landing?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // v4.1 (#15) chat unread badge: the Chat pane is "read" whenever it's the live
  // pane (and stays read as new messages land while it's open). When the viewer is
  // on Details/Parties, the Chat pill carries a badge counting messages from the
  // other party since they last looked. Read state is device-local (localStorage),
  // never on EscrowState.
  const [chatReadAt, setChatReadAt] = useState(() => getLastReadChatAt(state.id));
  useEffect(() => { setChatReadAt(getLastReadChatAt(state.id)); }, [state.id]);
  useEffect(() => {
    if (activePane === 0) setChatReadAt(markChatRead(state.id));
  }, [activePane, state.chatMessages.length, state.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const chatUnread = activePane === 0 ? 0 : countUnreadChat(state.chatMessages, myRole, chatReadAt);
  const pagerBadges = [chatUnread, 0, 0];
  // The pager scrolls natively; this pages when the drag starts on the PILLS
  // row (not itself a scroll container). Touch + pointer so it's real on device.
  const pillsDrag = useRef<{ x: number; y: number } | null>(null);
  const pillsDown = (x: number, y: number) => { pillsDrag.current = { x, y }; };
  const pillsUp = (x: number, y: number) => {
    const s = pillsDrag.current; pillsDrag.current = null;
    if (!s) return;
    const dx = x - s.x, dy = y - s.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) userGoPane(activePane + (dx < 0 ? 1 : -1));
  };
  const onPillsPointerDown = (e: React.PointerEvent) => { if (e.pointerType !== "touch") pillsDown(e.clientX, e.clientY); };
  const onPillsPointerUp = (e: React.PointerEvent) => { if (e.pointerType !== "touch") pillsUp(e.clientX, e.clientY); };
  const onPillsTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; if (t) pillsDown(t.clientX, t.clientY); };
  const onPillsTouchEnd = (e: React.TouchEvent) => { const t = e.changedTouches[0]; if (t) pillsUp(t.clientX, t.clientY); };

  // Vertical kicker over the nav title + on the Details pane header, so the
  // trade's vertical is obvious without inferring it from vote labels.
  // #63 storefront-vs-order clarity: a multi-unit PARENT reads as a storefront,
  // a CHILD order reads as an order (with the buyer short-id) — so a seller can
  // tell the persistent shopfront apart from a live sale at a glance. These win
  // over the generic vertical kicker; everything else keeps its vertical.
  const verticalKicker = state.listingKind === "work"
    ? t("trade.kickerWork")
    : isParentStorefront(state)
    ? t("trade.kickerStorefront")
    : isChildOrder(state)
    ? (state.participants[Role.BUYER]
        ? t("trade.kickerOrder", { buyer: shortParticipantPubkey(state.participants[Role.BUYER]!) })
        : t("trade.kickerOrderNoBuyer"))
    : state.category === "marketplace"
    ? t("trade.kickerMarketplace", { kind: state.fulfillment === "service" ? t("trade.kickerService") : state.fulfillment === "digital" ? t("trade.kickerDigital") : t("trade.kickerGoods") })
    : state.category === "p2p-trade" ? t("trade.kickerP2p")
    : state.category === "bill-pay" ? t("trade.kickerBillPay")
    : state.category === "lending" ? t("trade.kickerLending")
    : t("trade.kickerEscrow");
  // Short deal title beside the back arrow (the item, not the phase narrative —
  // that lives in the action card). Menu listings summarise via the first item.
  const dealTitle = (state.items?.[0]?.label?.trim())
    || (state.description?.trim())
    || tradeRoomTitle;

  // Living chat: lifecycle event bubbles derived from the event chain (+ the
  // synthetic dispute / timeout markers), woven into the message feed by time.
  const livingChatBubbles = useMemo<SystemBubble[]>(() => {
    const nameFor = (r: Role) => r === myRole ? t("trade.you")
      : r === Role.BUYER ? (dealBuyerName ?? t("trade.buyer"))
      : r === Role.SELLER ? (dealSellerName ?? t("trade.seller"))
      : t("trade.arbiter");
    const ctx: LivingChatCtx = {
      category: state.category,
      shortId: shortTradeId,
      amountLabel: t("trade.amountSats", { amount: fmtSats(state.amountMsats) }),
      resolvedOutcome: state.resolvedOutcome,
      fulfillment: state.fulfillment,
      nameFor,
    };
    const bubbles = state.eventChain
      .map(e => eventToSystemBubble(e, ctx))
      .filter((b): b is SystemBubble => b !== null);
    if (titleDisputed) {
      const voteTimes = state.eventChain
        .filter(e => e.payload.type === "escrow:vote")
        .map(e => e.raw.created_at);
      bubbles.push(disputeBubble(voteTimes.length ? Math.max(...voteTimes) : nowSec));
    }
    if (state.status === EscrowStatus.EXPIRED) {
      const last = state.eventChain[state.eventChain.length - 1];
      bubbles.push(timeoutBubble(last ? last.raw.created_at : nowSec));
    }
    return bubbles;
  }, [state.eventChain, state.resolvedOutcome, state.status, titleDisputed, myRole, dealBuyerName, dealSellerName, shortTradeId, state.amountMsats, state.category, state.fulfillment, nowSec, t]);

  // v4.1 ratings-in-chat: the SAME RatingTap (kind:38123), surfaced at the end of
  // the Chat feed at settlement — that's where the user is when the trade closes,
  // not on the Parties pane. Mirrors the Parties + Me-history wiring verbatim; all
  // three read myGivenRatings, so a tap in any one collapses the rest.
  const chatRatingCta = state.status === EscrowStatus.COMPLETED && onRateCounterparty
    ? (() => {
        const ratee = counterpartyToRate(state, pubkey);
        if (!ratee) return null;
        const ratedThumb = (myGivenRatings ?? []).find(
          r => r.tradeId === state.id && r.ratee === ratee.toLowerCase(),
        )?.thumb;
        return { tradeId: state.id, ratee, ratedThumb, onRate: onRateCounterparty };
      })()
    : null;

  return (
    <div className="trade-detail-shell">
      <div className="trade-live-head" style={{
        display: "grid",
        gridTemplateColumns: "42px minmax(0,1fr) auto",
        alignItems: "center",
        gap: 12,
        marginBottom: 18,
      }}>
        <button onClick={onBack} aria-label={t("common.back")} style={{
          width: 38,
          height: 38,
          flex: "0 0 auto",
          borderRadius: 999,
          background: T.surface,
          border: `1px solid ${T.border}`,
          color: T.text,
          fontFamily: T.sans,
          fontSize: 20,
          fontWeight: 700,
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          lineHeight: 1,
          transition: "background .14s, border-color .14s",
        }}>
          ←
        </button>
        <div style={{ minWidth: 0 }}>
          {/* Vertical kicker — the trade's vertical, never inferred. */}
          <div style={{
            color: T.accent,
            fontFamily: T.mono,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: 1.1,
            textTransform: "uppercase",
            marginBottom: 3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {verticalKicker}
          </div>
          <div className="trade-detail-title" style={{
            color: T.text,
            fontFamily: T.sans,
            fontSize: 17,
            fontWeight: 800,
            lineHeight: 1.12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {dealTitle}
          </div>
        </div>
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
          minWidth: 0,
        }}>
          <BitcoinPricePill
            compact
            amountMode={amountDisplayMode}
            onAmountModeChange={onAmountDisplayModeChange}
            quoteCurrency={homeQuoteCurrency}
          />
          <Badge status={statusKey} />
        </div>
      </div>

      {trancheGateNow && (
        <TranchePlanStrip
          state={state}
          gate={trancheGateNow}
          canAdvance={canAdvanceTranche}
          advancing={advancingTranche}
          error={advanceTrancheError}
          onAdvance={() => {
            if (!onStartNextTranche) return;
            setAdvancingTranche(true);
            setAdvanceTrancheError(null);
            void Promise.resolve(onStartNextTranche(state.id))
              .catch((error) => setAdvanceTrancheError(error instanceof Error ? error.message : String(error)))
              .finally(() => setAdvancingTranche(false));
          }}
        />
      )}

      {state.escrowMode === "ecash" && (state.sliceCount ?? 1) > 1 && !state.tranchePlan && (
        <div style={{
          border: `1px solid ${T.accent}55`, background: T.accentDim,
          borderRadius: 12, padding: 12, marginBottom: 12,
        }}>
          <div style={{ fontFamily: T.mono, fontWeight: 800, fontSize: 11, color: T.accent }}>
            {t("tranche.ecashPlanTitle", { n: state.sliceCount ?? 1 })}
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 11, color: T.muted, lineHeight: 1.5, marginTop: 5 }}>
            {t("tranche.ecashPlanBody")}
          </div>
          {myRole === Role.SELLER && state.participants[Role.BUYER] && state.participants[Role.ARBITER] ? (
            <button
              type="button"
              disabled={startingSlicePlan || !onStartEcashSlicePlan}
              onClick={() => {
                if (!onStartEcashSlicePlan) return;
                setStartingSlicePlan(true);
                setAdvanceTrancheError(null);
                void Promise.resolve(onStartEcashSlicePlan(state.id))
                  .catch((error) => setAdvanceTrancheError(error instanceof Error ? error.message : String(error)))
                  .finally(() => setStartingSlicePlan(false));
              }}
              style={{ marginTop: 9, padding: "8px 12px", borderRadius: 999, border: `1px solid ${T.accent}`, background: T.accent, color: T.bg, fontFamily: T.mono, fontWeight: 800, cursor: "pointer" }}
            >
              {startingSlicePlan ? t("tranche.starting") : t("tranche.startProtected", { n: state.sliceCount ?? 1 })}
            </button>
          ) : (
            <div style={{ fontFamily: T.sans, fontSize: 10, color: T.muted, marginTop: 7 }}>
              {t("tranche.sellerStarts")}
            </div>
          )}
          {advanceTrancheError && <div style={{ fontSize: 10, color: T.red, marginTop: 7 }}>{advanceTrancheError}</div>}
        </div>
      )}

      {state.tranchePlan && state.settlementPolicy === "ecash-mutual-slices-v1" && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontFamily: T.mono, fontWeight: 800, fontSize: 11, color: T.text }}>
            {t("tranche.planTitle", { n: state.tranchePlan.total })}
          </div>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {state.tranchePlan.tranches.map((row) => {
              const child = knownTrades?.find((trade) => trade.trancheChild?.parent === state.id && trade.trancheChild.index === row.index);
              return (
                <button
                  key={row.index}
                  type="button"
                  disabled={!child || !onOpenChild}
                  onClick={() => child && onOpenChild?.(child.id)}
                  style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.surface, color: T.text, cursor: child ? "pointer" : "default", fontFamily: T.mono, fontSize: 10 }}
                >
                  <span>{t("tranche.sliceRow", { n: row.index + 1 })}</span>
                  <span>{Math.ceil(row.amountMsats / 1000).toLocaleString()} sats · {child?.status ?? t("tranche.publishing")}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* #63 storefront routing: on a PARENT storefront, surface the live child
          orders (funded, unsettled) so the seller can jump straight to the sale
          they need to fulfill — instead of hunting for a second same-titled
          trade. Only renders when we're on a storefront AND there are live
          orders. Reuses App-derived liveChildOrders (childrenByParent). */}
      {isParentStorefront(state) && (liveChildOrders?.length ?? 0) > 0 && (
        <div style={{
          border: `1px solid ${T.accent}33`,
          background: T.accentDim,
          borderRadius: 12,
          padding: "10px 12px",
          margin: "0 4px 16px",
        }}>
          <div style={{
            color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            letterSpacing: 0.5, marginBottom: 8,
          }}>
            {t("trade.storefrontOrdersTitle", { count: liveChildOrders!.length })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {liveChildOrders!.map((child) => {
              const buyer = child.participants[Role.BUYER];
              // #70 each order carries its OWN unread badge so the seller sees
              // which of several concurrent orders has a new message.
              const childUnread = unreadChatForTrade(child, Role.SELLER);
              return (
                <button
                  key={child.id}
                  onClick={() => onOpenChild?.(child.id)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 8, width: "100%", textAlign: "left",
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: 9, padding: "8px 10px", cursor: "pointer",
                    color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("trade.storefrontOrderRow", {
                      buyer: buyer ? shortParticipantPubkey(buyer) : t("trade.buyer"),
                    })}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                    {childUnread > 0 && (
                      <span aria-label={childUnread === 1 ? t("card.unreadMessageOne") : t("card.unreadMessageMany", { count: childUnread })} style={{
                        display: "inline-flex", alignItems: "center",
                        minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box",
                        borderRadius: 999, background: T.accent, color: "#fff",
                        fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, lineHeight: "18px",
                      }}>
                        💬 {childUnread > 9 ? "9+" : childUnread}
                      </span>
                    )}
                    <span aria-hidden="true" style={{ color: T.accent }}>→</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Pre-lock reservations: buyers who spawned a child order but haven't
          funded it yet. On a multi-unit storefront the reservation is a child
          escrow with no JOIN hold on the parent, so without this panel a
          "joined but unpaid" order was invisible to the seller until it locked.
          Amber (vs the accent live-orders panel) signals "reserved, not yet
          paid". Seller-only — App filters to children where I'm the seller. */}
      {isParentStorefront(state) && (pendingChildOrders?.length ?? 0) > 0 && (
        <div style={{
          border: `1px solid ${T.amber}44`,
          background: `${T.amber}11`,
          borderRadius: 12,
          padding: "10px 12px",
          margin: "0 4px 16px",
        }}>
          <div style={{
            color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            letterSpacing: 0.5, marginBottom: 8,
          }}>
            {t("trade.storefrontReservingTitle", { count: pendingChildOrders!.length })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pendingChildOrders!.map((child) => {
              const buyer = child.participants[Role.BUYER];
              const childUnread = unreadChatForTrade(child, Role.SELLER);
              return (
                <button
                  key={child.id}
                  onClick={() => onOpenChild?.(child.id)}
                  disabled={!onOpenChild}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 8, width: "100%", textAlign: "left",
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: 9, padding: "8px 10px", cursor: onOpenChild ? "pointer" : "default",
                    color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("trade.storefrontReservingRow", {
                      buyer: buyer ? shortParticipantPubkey(buyer) : t("trade.buyer"),
                    })}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                    {childUnread > 0 && (
                      <span aria-label={childUnread === 1 ? t("card.unreadMessageOne") : t("card.unreadMessageMany", { count: childUnread })} style={{
                        display: "inline-flex", alignItems: "center",
                        minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box",
                        borderRadius: 999, background: T.accent, color: "#fff",
                        fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, lineHeight: "18px",
                      }}>
                        💬 {childUnread > 9 ? "9+" : childUnread}
                      </span>
                    )}
                    <span aria-hidden="true" style={{ color: T.amber }}>→</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Zone 1 — progress spine: Reserved → Locked → Settled. Stable stations so
          it's learnable; the middle node carries the deal's health (amber when
          disputed, red when closed). Static here — motion lands in a later stage. */}
      {(() => {
        const spineAccent = myRole ? ROLE_COLOR[myRole as keyof typeof ROLE_COLOR] : T.accent;
        const isClosed = state.status === EscrowStatus.EXPIRED || state.status === EscrowStatus.CANCELLED;
        // Only "disputed" while UNRESOLVED — votes aren't cleared after an arbiter
        // decides, so without this gate a settled trade keeps flashing amber.
        const isDisputed = releaseVoteCount > 0 && refundVoteCount > 0 && !state.resolvedOutcome;
        const reached =
          state.status === EscrowStatus.APPROVED ||
          state.status === EscrowStatus.CLAIMED ||
          state.status === EscrowStatus.COMPLETED ? 2
          : state.status === EscrowStatus.LOCKED ? 1
          // A LOCKED→EXPIRED trade locked real sats before timing out — show it
          // reached Locked (then closes red), not reset to Reserved. notesHash is
          // how the heal path detects a post-lock expiry (see detailNextStep).
          : (isClosed && state.lock?.notesHash) ? 1
          : 0;
        const stations = [
          { key: "reserved", label: t("trade.spineReserved") },
          { key: "locked", label: isClosed ? t("trade.spineClosed") : isDisputed ? t("trade.spineDisputed") : t("trade.spineLocked") },
          { key: "settled", label: t("trade.spineSettled") },
        ];
        return (
          <div className="trade-progress-spine" style={{
            display: "flex", alignItems: "flex-start", margin: "0 4px 18px",
          }}>
            {stations.flatMap((st, i) => {
              const special = i === 1 ? (isClosed ? T.red : isDisputed ? T.amber : null) : null;
              const current = i === reached && !isClosed;
              const lit = !!special || i <= reached;
              const nodeColor = special ?? (lit ? spineAccent : T.border);
              // Stage 4 motion: the current node breathes a soft glow ring; the
              // connector toward the NEXT milestone flows rightward. (--spine-glow
              // carries the node's colour into the keyframe.)
              const pulses = current;
              const node = (
                <div key={st.key} style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  gap: 6, flex: "0 0 auto", width: 66,
                }}>
                  <div
                    className={pulses ? "spine-node-live" : undefined}
                    style={{
                      width: 12, height: 12, borderRadius: 999,
                      background: lit ? nodeColor : T.surface,
                      border: `2px solid ${lit ? nodeColor : T.border}`,
                      boxShadow: (current || special) ? `0 0 0 4px ${nodeColor}22` : "none",
                      transition: "box-shadow .2s, background .2s, border-color .2s",
                      ...(pulses ? { animation: "spine-pulse 1.7s ease-out infinite", "--spine-glow": `${nodeColor}66` } : {}),
                    } as React.CSSProperties}
                  />
                  <div style={{
                    color: lit ? nodeColor : T.muted,
                    fontFamily: T.mono, fontSize: 9, fontWeight: 800,
                    letterSpacing: 0.8, textTransform: "uppercase",
                  }}>
                    {st.label}
                  </div>
                </div>
              );
              if (i === 0) return [node];
              const traversed = i <= reached;
              const isActiveConn = i === reached + 1 && !isClosed;
              const conn = isActiveConn ? (
                // Active connector: a bright energy beam sweeps rightward (white-hot
                // core + role-colour glow) along a dim wire toward the next milestone.
                <div key={"conn" + i} style={{
                  flex: 1, height: 2, borderRadius: 2, marginTop: 6,
                  position: "relative", overflow: "hidden",
                  background: `${spineAccent}40`,
                }}>
                  <div className="spine-beam" style={{
                    position: "absolute", top: 0, bottom: 0, left: 0, width: "45%",
                    background: `linear-gradient(90deg, transparent, ${spineAccent}, #ffffff, ${spineAccent}, transparent)`,
                    filter: `drop-shadow(0 0 3px ${spineAccent})`,
                    animation: "spine-beam 1.5s linear infinite",
                    willChange: "transform",
                  }} />
                </div>
              ) : (
                <div key={"conn" + i} style={{
                  flex: 1, height: 2, borderRadius: 2, marginTop: 6,
                  background: special ?? (traversed ? spineAccent : T.border),
                  opacity: (traversed || special) ? 0.75 : 1,
                }} />
              );
              return [conn, node];
            })}
          </div>
        );
      })()}


      {/* Zone A — the one action card (situation + what you do), driven by
          detailNextStep + the real vote / fund / claim / mark-done buttons.
          Role-tinted to the viewer. v4.1 fixed-rectangle: the action card lives in
          an internal scroll zone (flex 0 1 auto) so a tall lock/claim phase scrolls
          HERE, not the shell — the outer frame stays a fixed rectangle and the
          timeline footer is never pushed off-screen. */}
        <div className="td-action-scroll" style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        <div style={{
          padding: 14,
          borderRadius: T.rs,
          // v3.2 prototype: the card wears the VIEWER's role colour — buyer
          // purple, seller orange, arbiter blue — "the screen knows who you
          // are". Red (error) stays semantic: that signal is sacred. Visitors
          // (no seat) keep the semantic tone palette.
          background: myRole && nextStep.tone !== "red"
            ? `${ROLE_COLOR[myRole as keyof typeof ROLE_COLOR]}14`
            : nextStep.tone === "green" ? T.greenDim
            : nextStep.tone === "red" ? T.redDim
            : nextStep.tone === "purple" ? T.purpleDim
            : nextStep.tone === "teal" ? T.tealDim
            : T.surface,
          border: `1px solid ${
            myRole && nextStep.tone !== "red"
            ? ROLE_COLOR[myRole as keyof typeof ROLE_COLOR] + "44"
            : nextStep.tone === "green" ? T.green + "44"
            : nextStep.tone === "red" ? T.red + "44"
            : nextStep.tone === "purple" ? T.purple + "44"
            : nextStep.tone === "teal" ? T.teal + "44"
            : T.accent + "33"
          }`,
          marginBottom: 16,
        }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 7,
          }}>
            <div style={{
              // Identity accent — v3.2: the kicker wears the viewer's role
              // colour in every state except error (red stays sacred). Money
              // colour now lives on the buttons inside the card, not the chrome.
              // ROLE_COLOR_TEXT = light-mode-legible variant of the role hexes.
              color: (myRole && nextStep.tone !== "red")
                ? ROLE_COLOR_TEXT[myRole as keyof typeof ROLE_COLOR_TEXT]
                : nextStep.color,
              fontFamily: T.mono,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: 1,
            }}>
              {nextStep.kicker}
            </div>
            {nextStepDisplayAmountMsats !== null && (
              <BitcoinAmount msats={nextStepDisplayAmountMsats} size={12} gap={4} style={{ whiteSpace: "nowrap" }} />
            )}
          </div>
          <div style={{
            color: T.text,
            fontFamily: T.sans,
            fontSize: 16,
            fontWeight: 800,
            lineHeight: 1.28,
          }}>
            {nextStep.title}
          </div>
          {nextStep.body && (
            <div style={{
              color: T.muted,
              fontFamily: T.sans,
              fontSize: 13,
              lineHeight: 1.5,
              marginTop: 8,
            }}>
              {nextStep.body}
            </div>
          )}

          {state.status === EscrowStatus.COMPLETED
            && getWinner(state)?.pubkey === pubkey
            && state.lock.onchain
            && onScanMyOnchainPayouts
            && onSweepOnchainPayout && (
              <OnchainPayoutRecoveryCard
                escrowId={state.id}
                credited={defaultCreditObserver()(state)}
                embedded
                scan={onScanMyOnchainPayouts}
                sweep={async (escrowId, destination) => {
                  const swept = await onSweepOnchainPayout(escrowId, destination);
                  setTrancheCreditTick((tick) => tick + 1);
                  return swept;
                }}
              />
          )}

          {/* The performer's mark-done IS their release vote — ONE button, not a
              separate chat-note button. It renders below as the release vote,
              re-labelled with the per-vertical verb (Mark delivered / completed /
              sent / paid / received / repaid). Marking done = casting release. */}

          {/* v3.2 prototype: the card owns the actions — fund / vote / claim /
              join render INSIDE the role-coloured action card, so one card is
              always "situation + what you do about it". Blocks moved intact
              from their old column positions; all gating logic unchanged. */}
          {/* CREATED — atomic lock surface for the locker. The locker can
              spend only after any cross-role menu order is finalized. */}
          {/* ⭐⭐ ON-CHAIN FUNDING LIVES HERE, where the funder actually acts.
              The panel used to render only in the PARTIES pane while the fund
              button sat in DETAILS — so the locker read "send it to the escrow
              address" directly above an ecash Fund button, with the address on a
              tab they were not looking at. Copy that points at something not on
              screen is worse than no copy.
              The ecash surface below is replaced ENTIRELY, not supplemented: a
              Lightning fund button on an on-chain trade spends the locker's
              balance into an escrow the reducer will refuse. */}
          {/* ⚠ NOT gated on `canILock`. The arbiter cannot lock, yet the trade
              cannot be funded until they publish a key — gating this on the
              locker hid the CTA from the only person who could act on it, on
              every screen they visit. Buyer sees the same panel read-only. */}
          {/* ⚠⚠ The lock CTA below requires `participants.buyer`, and that is
              LOAD-BEARING rather than cosmetic. The reducer refuses a LOCK that
              does not name a buyer, and a lapsed join hold un-seats one — so
              offering the button without a seated buyer invites the funder to
              send real sats to an address they then cannot lock, leaving the
              coins there until the CLTV refund. The ecash branch always carried
              this guard; it was dropped when the panel moved here. */}
          {onchainView
            && (myRole || onchainNeedsMyArbiterKey)
            && (
              <OnchainEscrowPanel
                view={onchainView}
                network={ESCROW_NETWORK_LABEL}
                settlementCheck={settlementCheck}
                signing={settlementSigning}
                signedByViewer={settlementSignedByMe}
                onSign={onSignOnchainSettlement && (
                  state.resolvedMajority?.includes(Role.ARBITER)
                    ? myRole === Role.ARBITER || myRole === getWinner(state)?.role
                    : myRole === Role.BUYER || myRole === Role.SELLER
                ) ? () => {
                  setSettlementSigning(true);
                  void onSignOnchainSettlement(state.id)
                    .then(({ check }) => {
                      setSettlementCheck(check);
                      setSettlementSignedByMe(true);
                    })
                    .catch((error) => setSettlementCheck({
                      ok: false,
                      failures: [error instanceof Error ? error.message : String(error)],
                    }))
                    .finally(() => setSettlementSigning(false));
                } : undefined}
                onCheckFunding={onPublishOnchainLock && onchainView.viewerFunds && participants.buyer ? () => {
                  setCheckingFunding(true);
                  setFundingNote(null);
                  void Promise.resolve(onPublishOnchainLock(state.id))
                    .catch((e: any) => setFundingNote(e?.message ?? String(e)))
                    .finally(() => setCheckingFunding(false));
                } : undefined}
                checking={checkingFunding}
                fundingNote={fundingNote}
                onPublishKey={() => {
                  setPublishingKey(true);
                  setFundingNote(null);
                  void Promise.resolve(onJoin(Role.ARBITER))
                    .catch((e: any) => setFundingNote(e?.message ?? String(e)))
                    .finally(() => setPublishingKey(false));
                }}
                publishing={publishingKey}
              />
          )}
          {state.status === EscrowStatus.CREATED
            && myRole
            && canILock
            && !onchainView
            && participants.buyer
            && !lockMenuSelectionMissing
            && !menuOrderNotFinal && (() => {
            const fiatCategory = state.category === "p2p-trade"
              || state.category === "bill-pay"
              || state.category === "lending";
            const allHandles = fiatCategory ? listSavedHandles() : [];
            const menuSelectionMissing = lockMenuSelectionMissing;
            return (
            <div style={{
              paddingTop: 16,
              marginTop: 16,
              marginBottom: 16,
              borderTop: `1px solid ${T.accent}33`,
            }}>
              {/* Handle reveal picker for fiat categories */}
              {fiatCategory && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: T.muted,
                    fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 6,
                  }}>
                    {t("trade.revealHandleHeader")}
                  </div>
                  {allHandles.length === 0 ? (
                    <div style={{
                      padding: "10px 12px", borderRadius: T.rs,
                      background: T.surface, border: `1px dashed ${T.border}`,
                      color: T.muted, fontFamily: T.mono, fontSize: 11,
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                    }}>
                      <span>{t("trade.noSavedHandles")}</span>
                      {onOpenSettings && (
                        <button onClick={onOpenSettings} style={{
                          background: "none", border: "none",
                          color: T.accent, fontFamily: T.mono, fontSize: 11,
                          fontWeight: 700, cursor: "pointer", padding: 0,
                        }}>{t("trade.addHandle")}</button>
                      )}
                    </div>
                  ) : (
                    <select
                      value={selectedHandleId}
                      onChange={e => setSelectedHandleId(e.target.value)}
                      style={{ ...inputStyle, color: T.text, background: T.surface }}
                    >
                      <option value="">{t("trade.dontRevealHandle")}</option>
                      {allHandles.map(h => {
                        const rail = getRailByKey(h.rail);
                        return (
                          <option key={h.id} value={h.id}>
                            {(rail?.displayName || h.rail) + " · " + maskHandle(h.handle)}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>
              )}

              {/* v1.2.4: NWC status banner + direct-NWC Fund path. If the
                  user has a saved NWC wallet, the Fund button bypasses the
                  AtomicFundingModal chooser and dispatches straight via
                  actions.fundAndLock. The banner above lets the user
                  switch / add wallets without leaving the trade page. */}
              {!disableNwc && (
                <NwcStatusBanner
                  activeConnection={activeNwc}
                  onSaved={refreshSavedNwcs}
                  onManage={onOpenNwcSettings}
                />
              )}

              <button
                type="button"
                disabled={locking || directNwcFundPhase !== null || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal}
                title={fundingInProgress
                  ? t("trade.fundingInProgressNote")
                  : receiveUnavailable
                    ? t("trade.receiveUnavailableTitle")
                  : lockBlockedByNoArbiter
                    ? t("trade.noArbiterTitle")
                  : menuOrderNotFinal
                    ? t("trade.mustPressReady", { role: roleDisplayName(menuSelectorRole, t) })
                  : menuSelectionMissing
                    ? menuSelectionTitle(state.category, t)
                    : undefined}
                onClick={async () => {
                  // v1.2.4: when the user has a saved NWC and the parent
                  // wired the direct path, skip the modal entirely. The
                  // direct path threads phase labels back via onPhase so
                  // the button itself becomes the progress indicator.
                  if (activeNwc && onLockDirectNwc) {
                    setDirectNwcFundPhase(t("trade.starting"));
                    try {
                      const result = await onLockDirectNwc({
                        nwcConnectionString: activeNwc.connectionString,
                        savedHandleId: selectedHandleId || undefined,
                        selectedItems: hasMenu ? lockMenuItems : undefined,
                        amountMsats: lockAmountMsats,
                        onPhase: (label) => setDirectNwcFundPhase(label),
                      });
                      if (!result.ok) {
                        // Failure path: parent has already surfaced the
                        // humanized toast. The "Try other method" link
                        // below offers the modal as a fallback.
                      }
                    } finally {
                      setDirectNwcFundPhase(null);
                    }
                    return;
                  }
                  setLocking(true);
                  try {
                    await onLock({
                      savedHandleId: selectedHandleId || undefined,
                      selectedItems: hasMenu ? lockMenuItems : undefined,
                      amountMsats: lockAmountMsats,
                    });
                  } finally {
                    setLocking(false);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  width: "100%", padding: "16px", borderRadius: T.rs,
                  background: locking || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal
                    ? T.surface
                    : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
                  border: "none",
                  color: locking || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal ? T.muted : T.bg,
                  fontFamily: T.mono, fontSize: 14, fontWeight: 800,
                  cursor: locking || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal ? "default" : "pointer",
                  letterSpacing: 0.5, transition: "all 0.2s",
                }}
              >
                {directNwcFundPhase
                  ? `${directNwcFundPhase}`
                  : locking
                  ? t("trade.funding")
                  : fundingInProgress || receiveUnavailable || lockBlockedByNoArbiter
                    ? t("trade.lockUnavailable", { label: lockLabel })
                  : menuOrderNotFinal
                    ? t("trade.waitingForReady", { role: roleDisplayName(menuSelectorRole, t) })
                  : menuSelectionMissing
                    ? menuSelectionButtonLabel(state.category, t)
                    : activeNwc && onLockDirectNwc
                      ? (
                          <>
                            {t("trade.fundViaWalletPrefix", { label: lockLabel, wallet: activeNwc.label })} <BitcoinAmount msats={lockAmountMsats} size={14} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                          </>
                        )
                      : (
                          <>
                            {t("trade.fundPrefix", { label: lockLabel })} <BitcoinAmount msats={lockAmountMsats} size={14} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                          </>
                        )}
              </button>
              {/* v1.2.4: indeterminate progress strip under the Fund
                  button while the direct-NWC path is mid-action.
                  Cosmetic — the button label already shows the phase
                  text; this gives a continuous visual that something is
                  moving during NWC round-trips. */}
              {directNwcFundPhase && (
                <div style={{
                  marginTop: 8,
                  height: 3,
                  borderRadius: 999,
                  background: `${T.accent}1f`,
                  overflow: "hidden",
                  position: "relative",
                }}>
                  <div style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "30%",
                    height: "100%",
                    borderRadius: 999,
                    background: `linear-gradient(90deg, ${T.accent}00, ${T.accent}, ${T.amber}, ${T.amber}00)`,
                    animation: "nwcProgressSweep 1.4s ease-in-out infinite",
                  }} />
                </div>
              )}
              {/* v1.2.4: "Try other method" fallback when the direct-NWC
                  path is the default and the user wants the chooser
                  modal instead (different wallet, Onchain, external swap,
                  etc.). Hidden when no NWC is set up — the regular button
                  already routes through the modal in that case. */}
              {activeNwc && onLockDirectNwc && !directNwcFundPhase && !locking && (
                <button
                  onClick={async () => {
                    setLocking(true);
                    try {
                      await onLock({
                        savedHandleId: selectedHandleId || undefined,
                        selectedItems: hasMenu ? lockMenuItems : undefined,
                        amountMsats: lockAmountMsats,
                      });
                    } finally {
                      setLocking(false);
                    }
                  }}
                  style={{
                    background: "none", border: "none",
                    color: T.muted, fontFamily: T.mono, fontSize: 10,
                    cursor: "pointer", padding: "8px 0",
                    width: "100%", textAlign: "center",
                    textDecoration: "underline",
                  }}
                >
                  {t("trade.useDifferentFunding")}
                </button>
              )}
              {fundingInProgress && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: T.amber, fontFamily: T.mono,
                }}>
                  {t("trade.fundingInProgressNote")}
                </div>
              )}
              {lockBlockedByNoArbiter && !fundingInProgress && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: T.amber, fontFamily: T.mono,
                }}>
                  {t("trade.noArbiterShort")}
                </div>
              )}
              {bootProbeFailed && !fundingInProgress && !lockBlockedByNoArbiter && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: T.amber, fontFamily: T.mono,
                }}>
                  {t("trade.fedUnreachable")}
                </div>
              )}
              {receiveUnavailable && !bootProbeFailed && !fundingInProgress && !lockBlockedByNoArbiter && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: T.amber, fontFamily: T.mono,
                }}>
                  {t("trade.receiveUnavailableShort")}
                </div>
              )}
            </div>
            );
          })()}
          {/* Vote buttons — vertical-aware copy from the label dictionary.
              v0.2.0 item 9: when the user is the arbiter, the vote
              buttons mirror role colors per Pillar 5.2 — purple for
              "side with buyer," orange for "side with seller." Buyer
              and seller voting on their own experience keep the
              green/amber semantics (happy path / refund).

              Color derivation: RELEASE flows sats to the role that
              didn't lock. For marketplace, buyer locks → RELEASE goes
              to seller. For other verticals, seller locks → RELEASE
              goes to buyer. The arbiter's button color reflects who
              actually receives the sats on each vote, removing the
              ambiguity that otherwise sits in the highest-stakes UI
              interaction in the product. */}
          {/* v3.2: skip the waiting line for the seated arbiter on a quiet
              trade — their matrix cell already says "only step in if they
              disagree"; repeating it inside one card reads as a stutter. The
              backup-arbiter countdown (no seat) keeps its timer line. */}
          {votePrompt.kind === "waiting" && !(myRole === Role.ARBITER && !titleDisputed) && (
            <div style={{
              padding: "14px 0 0",
              marginTop: 16,
              borderTop: `1px solid ${T.border}`,
              color: T.muted, fontFamily: T.mono, fontSize: 11,
              lineHeight: 1.5, textAlign: "center", marginBottom: 16,
            }}>
              {votePrompt.message}
            </div>
          )}

          {votePrompt.kind === "buttons" && (() => {
            const voteRole = votePrompt.role;
            const isArbiter = voteRole === Role.ARBITER;
            const isMarketplace = state.category === "marketplace";
            // Oversold order: this unit was already taken by an earlier buyer, so the
            // ONLY correct action for BOTH sides is to refund — releasing just loses
            // someone their sats. Hide Release for buyer and seller alike (the arbiter,
            // in the rare case it reaches them, still sees both to decide). Refunding
            // the right order is what protects everyone.
            const isOversoldVoterView = isOversoldOrder && voteRole !== Role.ARBITER;
            const showRelease = votePrompt.outcomes.includes(Outcome.RELEASE) && !isOversoldVoterView;
            const showRefund = votePrompt.outcomes.includes(Outcome.REFUND);
            // v3.5 (C1/C7): the PERFORMER — the non-locker whom RELEASE pays —
            // is the party a colluding arbiter can rob (locker + arbiter hold
            // 2 of 3 shares and can force a REFUND after the performer paid
            // fiat / delivered). Their release action is the at-risk moment,
            // so it sits behind an explicit two-tap acknowledge whenever
            // arbiter trust is degraded. Refund (backing out) is never gated.
            const releaseRecipient = payoutRecipientFor(state, Outcome.RELEASE);
            const iAmPerformer = !isArbiter && !!releaseRecipient && voteRole === releaseRecipient.role;
            const performRisk = !iAmPerformer ? null
              : arbiterAssignment.status === "off-assignment"
                ? {
                    loud: true,
                    line: t("trade.riskOffAssignmentLine"),
                    ack: t("trade.riskOffAssignmentAck"),
                  }
              : selfRostered
                ? {
                    loud: true,
                    line: t("trade.riskSelfRosteredLine"),
                    ack: t("trade.riskSelfRosteredAck"),
                  }
              : feeGateUnmet
                ? {
                    loud: false,
                    line: t("trade.riskFeeGateLine"),
                    ack: t("trade.riskFeeGateAck"),
                  }
                : null;
            // Both adjacent money buttons arm-to-confirm now (not just the
            // performer's at-risk release). armedOutcome tracks which is armed.
            const releaseArmed = armedOutcome === Outcome.RELEASE;
            const refundArmed = armedOutcome === Outcome.REFUND;
            const riskNotice = performRisk && showRelease ? (
              <div style={{
                gridColumn: "1 / -1",
                padding: "9px 11px", borderRadius: T.rs,
                background: performRisk.loud ? T.redDim : T.amberDim,
                border: `1px solid ${performRisk.loud ? T.red : T.amber}55`,
                color: performRisk.loud ? T.red : T.amber,
                fontFamily: T.mono, fontSize: 10, fontWeight: 700, lineHeight: 1.5,
              }}>
                ⚠ {performRisk.line} {t("trade.riskProceed")}
              </div>
            ) : null;
            // Who wins on RELEASE / REFUND
            const releaseWinner = isMarketplace ? "seller" : "buyer";
            const refundWinner = isMarketplace ? "buyer" : "seller";

            const arbiterReleaseColor = ROLE_COLOR[releaseWinner];
            const arbiterRefundColor = ROLE_COLOR[refundWinner];

            const releaseBg = isArbiter ? `${arbiterReleaseColor}22` : T.greenDim;
            const releaseBorder = isArbiter ? `${arbiterReleaseColor}66` : `${T.green}44`;
            const releaseText = isArbiter ? arbiterReleaseColor : T.green;

            const refundBg = isArbiter
              ? `${arbiterRefundColor}22`
              : state.subscription ? T.redDim : T.amberDim;
            const refundBorder = isArbiter
              ? `${arbiterRefundColor}66`
              : `${state.subscription ? T.red : T.amber}44`;
            const refundText = isArbiter
              ? arbiterRefundColor
              : state.subscription ? T.red : T.amber;
            // Vote #1 (the off-chain deed-doer, zero votes cast): no real duality
            // exists yet — the voter has ONE task plus a back-out hatch, so the
            // primary button drops the protocol prefix and the refund demotes to a
            // quiet cancel link below (rendered in the firstVote branch).
            const isFirstVoteMoment = votePrompt.firstVote === true && !isArbiter && !isOversoldVoterView;
            // The performer's release vote IS their "mark done" — ONE button,
            // labelled with the per-vertical verb (Mark delivered / completed /
            // sent / paid / received / repaid) instead of the protocol "Release".
            // Marking done = casting the release vote (no separate chat-note step).
            const performerVerb = iAmPerformer ? markDoneVerb(state.category, state.fulfillment) : null;
            // v3.2 prototype: the ruling names where the sats GO — "Release →
            // Mariam" beats "Side with seller". Recipient colours unchanged.
            const releaseLabel = isArbiter
              ? t("trade.releaseTo", { name: (releaseWinner === "seller" ? dealSellerName : dealBuyerName)
                  ?? (releaseWinner === "seller" ? t("trade.roleSeller") : t("trade.roleBuyer")) })
              : performerVerb
                ? performerVerb.label
                : isFirstVoteMoment
                  ? getVoteLabel(state.category, state.fulfillment, voteRole, Outcome.RELEASE)
                  : voteOutcomeLabel("Release", getVoteLabel(state.category, state.fulfillment, voteRole, Outcome.RELEASE));
            const refundLabel = state.subscription
              ? t("trade.cancelRefundRemaining")
              : isArbiter
                ? t("trade.refundTo", { name: (refundWinner === "seller" ? dealSellerName : dealBuyerName)
                    ?? (refundWinner === "seller" ? t("trade.roleSeller") : t("trade.roleBuyer")) })
                : isOversoldVoterView
                  // The single, unmistakable action on an oversold unit, phrased for
                  // whoever is tapping it: the seller refunds the duplicate; the buyer
                  // simply gets their own sats back.
                  ? (voteRole === Role.SELLER ? t("trade.refundDuplicateOrder") : t("trade.refundGetSatsBack"))
                  : isMarketplace && voteRole === Role.SELLER
                    // Market seller votes first; "Refund" stays neutral rather than
                    // presuming "Buyer never received" before any dispute exists.
                    ? t("trade.refundNeutral")
                    : voteOutcomeLabel("Refund", getVoteLabel(state.category, state.fulfillment, voteRole, Outcome.REFUND));
            const releaseCopy = splitVoteActionLabel("Release", releaseLabel);
            const refundCopy = splitVoteActionLabel("Refund", refundLabel);

            const amtLabel = t("trade.amountSats", { amount: fmtSats(state.amountMsats) });
            const releaseRecipientName = (releaseWinner === "seller" ? dealSellerName : dealBuyerName)
              ?? (releaseWinner === "seller" ? t("trade.theSeller") : t("trade.theBuyer"));
            // When the refund lands back on the VIEWER (e.g. the seller casting
            // the second vote on their own refund), name them "you" — "refund to
            // the seller" reads oddly when you ARE the seller.
            const refundToSelf = !isArbiter
              && voteRole === (refundWinner === "seller" ? Role.SELLER : Role.BUYER);
            const refundRecipientName = refundToSelf
              ? t("trade.recipientYou")
              : ((refundWinner === "seller" ? dealSellerName : dealBuyerName)
                ?? (refundWinner === "seller" ? t("trade.theSeller") : t("trade.theBuyer")));
            // Armed (second-tap) confirm copy names who gets paid + the amount.
            // The performer's risky release keeps its louder acknowledge wording.
            // Exchange/CBP: the FIAT payer's release IS "I sent the fiat" — their
            // confirm must name the FIAT they're attesting to (not the sats), so the
            // double-tap reads "you're sure you sent X?" rather than the seller's
            // release-the-sats wording. Falls back to the sats copy when no fiat.
            const fiatPayerSending = voteRole === fiatPayerRole && !!checkoutFiatLabel;
            const releaseConfirm = fiatPayerSending
              ? t("trade.confirmSentFiat", { amount: checkoutFiatLabel ?? "" })
              : performRisk
                ? t("trade.ackTapAgain", { ack: performRisk.ack })
                : performerVerb
                  ? t("trade.confirmReleaseAmount", { amount: amtLabel })
                  : t("trade.confirmPayAmount", { name: releaseRecipientName, amount: amtLabel });
            const refundConfirm = t("trade.confirmRefundAmount", { amount: amtLabel, name: refundRecipientName });
            // Focused armed-state action line (the eyebrow says "tap again"; this
            // says only WHERE the sats go) — kept short so it centers cleanly
            // instead of wrapping an orphan word. The full sentence still rides
            // the aria-label (releaseConfirm/refundConfirm) for screen readers.
            const releaseArmedAction = fiatPayerSending
              ? t("trade.armedSentFiat", { amount: checkoutFiatLabel ?? "" })
              : performRisk
                ? performRisk.ack
                : performerVerb
                  ? t("trade.armedRelease", { amount: amtLabel })
                  : t("trade.armedPay", { name: releaseRecipientName, amount: amtLabel });
            const refundArmedAction = t("trade.armedRefund", { amount: amtLabel, name: refundRecipientName });
            // Refund reason chips for the double-gate (parties only — the arbiter
            // rules, it isn't asked "why"). Picking one sends it as the user's own
            // chat message AND casts the refund. Display-only: the reason rides the
            // existing kind:38108 chat, no reducer/wire change.
            //
            // The reason belongs to whoever INITIATES the refund — the party who
            // was meant to act and backed out. When your counterparty has ALREADY
            // voted refund, you're just confirming a mutual refund to get your OWN
            // sats back: no "why?" (it's redundant, and asks the wrong person) —
            // you still get the plain double-tap confirm ("refund X to you"), so
            // an empty reasonList closes the picker (refundPickerOpen below). A
            // genuine dispute (they voted the OTHER way — release) KEEPS the picker,
            // because your reason is then a contested claim the arbiter needs.
            // Vertical-independent: cleans up Exchange/Marketplace the same way.
            const otherPrincipalRole = voteRole === Role.BUYER ? Role.SELLER : Role.BUYER;
            const counterpartyAlreadyRefunded = state.votes[otherPrincipalRole] === Outcome.REFUND;
            const reasonList = (!isArbiter && showRefund && !counterpartyAlreadyRefunded)
              ? refundReasons(state.category, state.fulfillment, voteRole) : [];
            const reasonChips = (onChoose: (reason: string) => void) => (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {reasonList.map(reason => (
                  <button
                    key={reason}
                    type="button"
                    disabled={voting}
                    onClick={() => onChoose(reason)}
                    style={{
                      padding: "8px 13px", borderRadius: 999,
                      background: T.surface, border: `1px solid ${T.amber}55`,
                      color: T.text, fontFamily: T.sans, fontSize: 12.5, fontWeight: 600,
                      cursor: voting ? "default" : "pointer",
                    }}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            );
            const releaseButton = showRelease ? (
              <button
                key="release"
                className={releaseArmed ? "td-armed" : undefined}
                disabled={voting}
                onClick={() => armOrVote(Outcome.RELEASE)}
                aria-label={releaseArmed ? t("trade.confirmAria", { text: releaseConfirm }) : t("trade.voteReleaseAria", { label: releaseLabel })}
                style={{
                  ...voteActionButtonStyle({
                    disabled: voting,
                    background: releaseArmed ? T.amberDim : releaseBg,
                    border: releaseArmed ? `${T.amber}66` : releaseBorder,
                    color: releaseArmed ? T.amber : releaseText,
                  }),
                  ...(releaseArmed ? { animation: "armPulse 1s ease-in-out infinite" } : {}),
                }}
              >
                {releaseArmed ? (
                  <span style={voteConfirmStackStyle}>
                    <span style={voteConfirmEyebrowStyle}>{t("trade.tapAgainEyebrow")}</span>
                    <span style={voteConfirmActionStyle}>{releaseArmedAction}</span>
                  </span>
                ) : (
                  <span style={voteActionLabelStyle()}>
                    <span style={voteActionTitleStyle}>
                      <span aria-hidden="true" style={voteInlineIconStyle}>
                        {performerVerb ? performerVerb.icon : "✓"}
                      </span>
                      {releaseCopy.title}
                    </span>
                    {releaseCopy.detail && <span style={voteActionDetailStyle}>{releaseCopy.detail}</span>}
                  </span>
                )}
              </button>
            ) : null;
            const refundButton = showRefund ? (
              <button
                key="refund"
                className={refundArmed ? "td-armed" : undefined}
                disabled={voting}
                onClick={() => armOrVote(Outcome.REFUND)}
                aria-label={refundArmed ? t("trade.confirmAria", { text: refundConfirm }) : t("trade.voteRefundAria", { label: refundLabel })}
                style={{
                  ...voteActionButtonStyle({
                    disabled: voting,
                    background: refundArmed ? T.amberDim : refundBg,
                    border: refundArmed ? `${T.amber}66` : refundBorder,
                    color: refundArmed ? T.amber : refundText,
                  }),
                  ...(refundArmed ? { animation: "armPulse 1s ease-in-out infinite" } : {}),
                }}
              >
                {refundArmed ? (
                  <span style={voteConfirmStackStyle}>
                    <span style={voteConfirmEyebrowStyle}>{t("trade.tapAgainEyebrow")}</span>
                    <span style={voteConfirmActionStyle}>{refundArmedAction}</span>
                  </span>
                ) : (
                  <span style={voteActionLabelStyle()}>
                    <span style={voteActionTitleStyle}>
                      <span aria-hidden="true" style={voteInlineIconStyle}>↩</span>
                      {refundCopy.title}
                    </span>
                    {refundCopy.detail && <span style={voteActionDetailStyle}>{refundCopy.detail}</span>}
                  </span>
                )}
              </button>
            ) : null;
            // Vote #1: ONE primary task button, refund demoted to a quiet two-tap
            // "cancel this trade" hatch whose routing copy derives from the engine
            // (payoutRecipientFor) so it can never lie about where the sats go.
            if (isFirstVoteMoment && showRelease && showRefund) {
              const refundRecipient = payoutRecipientFor(state, Outcome.REFUND);
              const cancelRouting = refundRecipient && refundRecipient.pubkey === pubkey
                ? t("trade.refundMe")
                : refundRecipient
                  ? t("trade.satsReturnToParty", { party: partyNoun(state.category, refundRecipient.role, t) })
                  : t("trade.lockedSatsReturned");
              return (
                <div className="trade-vote-actions" style={{
                  display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 16,
                }}>
                  {riskNotice}
                  {releaseButton}
                  {/* 3.5.1 #7: back-out guard. Arming opens a confirm that
                      restates the routing AND steers a deed-doer who already
                      performed off the refund hatch onto the RELEASE vote (the
                      arbiter can still settle, so their sats aren't forfeited).
                      Routing is unchanged — this is a confirm + copy guard. */}
                  {!cancelArmed ? (
                    <button
                      disabled={voting}
                      aria-label={t("trade.backOutAria", { routing: cancelRouting })}
                      onClick={() => setCancelArmed(true)}
                      style={{
                        width: "100%", marginTop: 10, padding: "9px 10px",
                        background: "none",
                        border: `1px dashed ${T.border}`,
                        borderRadius: T.rs,
                        color: T.muted,
                        fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                        cursor: voting ? "default" : "pointer",
                      }}
                    >
                      {getVoteLabel(state.category, state.fulfillment, voteRole, Outcome.REFUND)} · {cancelRouting}
                    </button>
                  ) : (
                    <div style={{
                      marginTop: 10, padding: "10px 12px", borderRadius: T.rs,
                      background: T.amberDim, border: `1px solid ${T.amber}66`,
                    }}>
                      <div style={{ color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                        {t("trade.backOutQuestion")}
                      </div>
                      <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5, marginBottom: 10 }}>
                        {t("trade.castsRefundVote", { routing: cancelRouting })}{" "}
                        {deedDonePrompt(state.category, t)} {t("trade.dontBackOut")}
                      </div>
                      <div style={{ display: "grid", gap: 10 }}>
                        <button
                          disabled={voting}
                          onClick={() => { setCancelArmed(false); handleVote(Outcome.RELEASE); }}
                          style={{
                            width: "100%", padding: "9px 10px", borderRadius: T.rs,
                            background: T.accent, border: `1px solid ${T.accent}`, color: "#000",
                            fontFamily: T.mono, fontSize: 11, fontWeight: 800,
                            cursor: voting ? "default" : "pointer",
                          }}
                        >
                          {t("trade.markItDone")}
                        </button>
                        {/* …or back out, tapping the reason — it rides into chat. */}
                        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 1 }}>
                          {t("trade.orBackOutReason", { routing: cancelRouting })}
                        </div>
                        {reasonChips(reason => { setCancelArmed(false); onSendChat(reason); handleVote(Outcome.REFUND); })}
                        <button
                          disabled={voting}
                          onClick={() => { setCancelArmed(false); handleVote(Outcome.REFUND); }}
                          style={{
                            width: "100%", padding: "8px 10px", borderRadius: T.rs,
                            background: "none", border: `1px dashed ${T.amber}66`, color: T.amber,
                            fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                            cursor: voting ? "default" : "pointer",
                          }}
                        >
                          {t("trade.backOutNoNote")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            }
            // When a PARTY arms refund, the second tap becomes a "why?" reason
            // picker (the double-gate's confirm step). The arbiter keeps the plain
            // two-tap (it rules, it isn't asked why).
            const refundPickerOpen = refundArmed && !isArbiter && reasonList.length > 0;
            if (refundPickerOpen) {
              return (
                <div className="trade-vote-actions" style={{ display: "grid", gap: 10, marginBottom: 16 }}>
                  <div style={{
                    background: T.amberDim, border: `1px solid ${T.amber}55`,
                    borderRadius: T.r, padding: 14,
                  }}>
                    <div style={{ color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, marginBottom: 10 }}>
                      {t("trade.refundWhy", { amount: amtLabel })}
                    </div>
                    {reasonChips(reason => { disarmVote(); onSendChat(reason); handleVote(Outcome.REFUND); })}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                      <button
                        type="button"
                        disabled={voting}
                        onClick={() => { disarmVote(); handleVote(Outcome.REFUND); }}
                        style={{ background: "none", border: "none", color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: voting ? "default" : "pointer", padding: "4px 0" }}
                      >
                        {t("trade.refundNoNote")}
                      </button>
                      <button
                        type="button"
                        onClick={disarmVote}
                        style={{ marginLeft: "auto", background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 11, cursor: "pointer", padding: "4px 0" }}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            }
            // Protocol order is invariant across every vertical and role:
            // RELEASE (green) on the left, REFUND (orange) on the right. Do not
            // reorder by recipient — that made the controls move between trades.
            return (
              <div className="trade-vote-actions" style={{
                display: "grid",
                gridTemplateColumns: showRelease && showRefund ? "minmax(0, 1fr) minmax(0, 1fr)" : "1fr",
                gap: 10,
                marginBottom: 16,
              }}>
                {riskNotice}
                {releaseButton}
                {refundButton}
              </div>
            );
          })()}
          {/* Claim button.
              v0.3.1 Phase 3 expanded scope (Q4): boot probe also gates
              the Claim button. When bootProbeFailed === true, the button
              disables with "Federation unreachable — reconnect first"
              subtitle. The Reconnect CTA lives in ChamaBar (single
              source of truth). */}
          {/* ⚠⚠ `!onchainView` — the same class of bug as the funding modal.
              This is the ECASH claim surface: it redeems SSS shares and pays
              out over Lightning/NWC. An on-chain escrow has no shares and no
              notes; its sats sit in a Taproot output that moves only when two
              of three keys sign a settlement transaction. Offering "claim via
              your Lightning address" there invites an action that cannot
              succeed, on the one screen where the user believes they are being
              paid. The on-chain settlement surface renders in its place, via
              OnchainEscrowPanel above. */}
          {(state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED) && iAmWinner && !state.subscription && !onchainView && (
            <div style={{
              marginTop: 18,
              paddingTop: 16,
              marginBottom: 18,
              borderTop: `1px solid ${T.border}`,
            }}>
              {/* v1.2.4: NWC status banner + direct-NWC Claim path.
                  Mirror of the Fund button treatment — saved NWC wallet
                  → one-tap claim straight to that wallet, banner above
                  for context + paste-to-add. */}
              {!disableNwc && (
                <NwcStatusBanner
                  activeConnection={activeNwc}
                  onSaved={refreshSavedNwcs}
                  onManage={onOpenNwcSettings}
                />
              )}

              <button
                disabled={claiming || directNwcClaimPhase !== null || bootProbeFailed || claimRetryBlocked || payoutConfirming}
                onClick={async () => {
                  // v1.2.4: direct-NWC claim path. Saved NWC wallet skips
                  // the ClaimPayoutModal chooser → resolveNwcConnectionToInvoice
                  // → claimAndPayout in one shot, all from the button.
                  if (activeNwc && onClaimDirectNwc) {
                    setDirectNwcClaimPhase(t("trade.starting"));
                    try {
                      await onClaimDirectNwc({
                        nwcConnectionString: activeNwc.connectionString,
                        onPhase: (label) => setDirectNwcClaimPhase(label),
                      });
                    } finally {
                      setDirectNwcClaimPhase(null);
                    }
                    return;
                  }
                  setClaiming(true);
                  try {
                    await onClaim();
                  } finally {
                    setClaiming(false);
                  }
                }}
                style={{
                  width: "100%", padding: "18px", borderRadius: T.rs,
                  background: claimRetryBlocked
                    ? T.redDim
                    : claiming || directNwcClaimPhase !== null || bootProbeFailed
                    ? T.surface
                    : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
                  border: claimRetryBlocked ? `1px solid ${T.red}55` : "none",
                  color: claimRetryBlocked ? T.red : claiming || directNwcClaimPhase !== null || bootProbeFailed ? T.muted : T.bg,
                  fontFamily: T.mono, fontSize: 15, fontWeight: 800,
                  cursor: claiming || directNwcClaimPhase !== null || bootProbeFailed || claimRetryBlocked ? "default" : "pointer", letterSpacing: 1,
                  animation: (claiming || directNwcClaimPhase !== null || bootProbeFailed || claimRetryBlocked) ? "none" : "pulse 2s ease-in-out infinite",
                }}>
                {directNwcClaimPhase
                  ? directNwcClaimPhase
                  : payoutConfirming
                  ? t("trade.payoutSentConfirming")
                  : claimRetryBlocked
                  ? t("trade.claimDidNotSettle")
                  : claiming
                  ? state.status === EscrowStatus.CLAIMED ? t("trade.retryingClaim") : t("trade.claiming")
                  : activeNwc && onClaimDirectNwc
                    ? (state.status === EscrowStatus.CLAIMED
                        ? t("trade.retryClaimVia", { wallet: activeNwc.label })
                        : t("trade.claimSatsVia", { wallet: activeNwc.label }))
                    : state.status === EscrowStatus.CLAIMED ? t("trade.retryClaim") : t("trade.claimSats")}
              </button>
              {/* v1.2.4: same indeterminate progress strip under the
                  Claim button while the direct-NWC claim is mid-action.
                  Mirror of the Fund strip — purely cosmetic, since the
                  button label is already showing the phase text. */}
              {directNwcClaimPhase && (
                <div style={{
                  marginTop: 8,
                  height: 3,
                  borderRadius: 999,
                  background: `${T.accent}1f`,
                  overflow: "hidden",
                  position: "relative",
                }}>
                  <div style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "30%",
                    height: "100%",
                    borderRadius: 999,
                    background: `linear-gradient(90deg, ${T.accent}00, ${T.accent}, ${T.amber}, ${T.amber}00)`,
                    animation: "nwcProgressSweep 1.4s ease-in-out infinite",
                  }} />
                </div>
              )}
              {/* "Try other method" fallback link — same pattern as the
                  Fund button. Opens ClaimPayoutModal with the full
                  chooser when the user wants a different destination. */}
              {activeNwc && onClaimDirectNwc && !directNwcClaimPhase && !claiming && !payoutConfirming && (
                <button
                  onClick={async () => {
                    setClaiming(true);
                    try {
                      await onClaim();
                    } finally {
                      setClaiming(false);
                    }
                  }}
                  style={{
                    background: "none", border: "none",
                    color: T.muted, fontFamily: T.mono, fontSize: 10,
                    cursor: "pointer", padding: "8px 0",
                    width: "100%", textAlign: "center",
                    textDecoration: "underline",
                  }}
                >
                  {t("trade.useDifferentPayout")}
                </button>
              )}
              {bootProbeFailed && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: T.amber, fontFamily: T.mono,
                }}>
                  {t("trade.fedUnreachable")}
                </div>
              )}
              {claimRetryBlocked && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: T.red, fontFamily: T.mono,
                }}>
                  {t("trade.ecashRedeemFailed")}
                </div>
              )}
              {!bootProbeFailed && !claimRetryBlocked && state.status === EscrowStatus.CLAIMED && (
                <div style={{
                  textAlign: "center", marginTop: 8,
                  fontSize: 10, color: payoutConfirming ? T.green : T.amber, fontFamily: T.mono,
                }}>
                  {payoutConfirming
                    ? t("trade.payoutConfirmingNote")
                    : t("trade.claimAlreadySentNote")}
                </div>
              )}
            </div>
          )}
          {/* JOIN buttons — show when user is not a participant and slots are open */}
          {isChildOrder(state)
            && state.status === EscrowStatus.CREATED
            && samePubkey(state.initiator.pubkey, pubkey)
            && onCancelDraftOrder && (
            <div style={{ margin: "12px 0 16px" }}>
              <button
                type="button"
                disabled={draftCancelling}
                onClick={async () => {
                  if (!draftCancelArmed) {
                    setDraftCancelArmed(true);
                    return;
                  }
                  setDraftCancelling(true);
                  try {
                    await onCancelDraftOrder(state.id);
                  } finally {
                    setDraftCancelling(false);
                  }
                }}
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: T.rs,
                  background: draftCancelArmed ? T.amberDim : "transparent",
                  border: `1px ${draftCancelArmed ? "solid" : "dashed"} ${draftCancelArmed ? T.amber + "77" : T.border}`,
                  color: draftCancelArmed ? T.amber : T.muted,
                  fontFamily: T.mono, fontSize: 11, fontWeight: 800,
                  cursor: draftCancelling ? "default" : "pointer",
                }}
              >
                {draftCancelling
                  ? t("trade.cancellingDraftOrder")
                  : draftCancelArmed
                    ? t("trade.confirmCancelDraftOrder")
                    : t("trade.cancelDraftOrder")}
              </button>
              <div style={{ marginTop: 6, color: T.muted, fontFamily: T.mono, fontSize: 9.5, lineHeight: 1.45, textAlign: "center" }}>
                {t("trade.cancelDraftOrderNote")}
              </div>
            </div>
          )}
          {!myRole && !hasDuplicateParticipant && !currentKeyAlreadyPresent && state.status === EscrowStatus.CREATED && canJoinTrade && (
            <div style={{
              paddingTop: 16,
              marginTop: 16,
              marginBottom: 16,
              borderTop: `1px solid ${T.border}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
                {isMultiUnitParent ? t("trade.buyFromListing") : t("trade.joinThisTrade")}
              </div>
              {isMultiUnitParent && onPurchase && (
                soldOut ? (
                  <div style={{ padding: "12px 14px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 12, fontWeight: 700, textAlign: "center", letterSpacing: 0.5 }}>
                    {t("trade.soldOut")}
                  </div>
                ) : (
                <div style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <button type="button" disabled={purchasing || buyQtyClamped <= 1}
                      onClick={() => setBuyQty(q => Math.max(1, Math.min(q, buyMax) - 1))}
                      style={{ width: 40, height: 40, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 18, fontWeight: 800, cursor: (purchasing || buyQtyClamped <= 1) ? "default" : "pointer" }}>−</button>
                    <div style={{ minWidth: 44, textAlign: "center", fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.text }}>{buyQtyClamped}</div>
                    <button type="button" disabled={purchasing || buyQtyClamped >= buyMax}
                      onClick={() => setBuyQty(q => Math.min(buyMax, q + 1))}
                      style={{ width: 40, height: 40, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 18, fontWeight: 800, cursor: (purchasing || buyQtyClamped >= buyMax) ? "default" : "pointer" }}>+</button>
                    <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11, marginLeft: 4 }}>
                      {typeof stockLeft === "number" ? t("trade.stockLeft", { count: stockLeft }) : t("trade.inStock", { count: state.stock ?? 0 })}
                    </div>
                  </div>
                  <button type="button" disabled={purchasing}
                    onClick={async () => {
                      setPurchasing(true);
                      try { await onPurchase(state.id, buyQtyClamped); } finally { setPurchasing(false); }
                    }}
                    style={{
                      width: "100%", padding: "14px", borderRadius: T.rs,
                      background: T.accentDim, border: `1px solid ${T.accent}44`,
                      color: T.accent, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                      cursor: purchasing ? "default" : "pointer",
                    }}>
                    {purchasing ? t("trade.startingOrder") : (buyQtyClamped > 1 ? t("trade.buyUnitsMany", { count: buyQtyClamped }) : t("trade.buyUnitsOne", { count: buyQtyClamped }))}
                  </button>
                  <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, margin: "8px 2px 0" }}>
                    {t("trade.purchaseEscrowNote")}
                  </p>
                </div>
                )
              )}
              {!isMultiUnitParent && (<>
              <div style={{ display: "flex", gap: 10 }}>
                {canJoinAsBuyer && (
                  <button disabled={joining} onClick={async () => {
                    setJoining(true);
                    try {
                      await onJoin(Role.BUYER);
                      landOnDetailsAfterJoin();
                    } finally { setJoining(false); }
                  }} style={{
                    flex: 1, padding: "14px", borderRadius: T.rs,
                    background: `${ROLE_COLOR.buyer}22`, border: `1px solid ${ROLE_COLOR.buyer}44`,
                    color: ROLE_COLOR.buyer, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                    cursor: joining ? "default" : "pointer", transition: "all 0.2s",
                  }}>
                    {joining ? t("trade.joining") : t("trade.joinAsBuyer")}
                  </button>
                )}
                {/* v0.6.5: hide the Join-as-Arbiter affordance when the
                    community pool will auto-assign one. v0.8.0 tightens
                    the empty-pool case too: no pool means no trusted arbiter
                    slot, not "anyone may volunteer." */}
                {/* ⚠ The on-chain publish CTA lives in the panel above, where
                    the explanation is. This row keeps it ONLY as a fallback for
                    the case the panel isn't showing it — otherwise the arbiter
                    gets two identical buttons and has to guess. */}
                {(canJoinAsArbiter
                  || (onchainNeedsMyArbiterKey && !onchainView?.viewerMustPublishKey)) && (
                  <button disabled={joining} onClick={async () => {
                    setJoining(true);
                    try {
                      await onJoin(Role.ARBITER);
                      landOnDetailsAfterJoin();
                    } finally { setJoining(false); }
                  }} style={{
                    flex: 1, padding: "14px", borderRadius: T.rs,
                    background: `${ROLE_COLOR.arbiter}22`, border: `1px solid ${ROLE_COLOR.arbiter}44`,
                    color: ROLE_COLOR.arbiter, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                    cursor: joining ? "default" : "pointer", transition: "all 0.2s",
                  }}>
                    {joining ? t("trade.joining")
                      : onchainNeedsMyArbiterKey ? t("onchain.publishMyKey")
                      : t("trade.joinAsArbiter")}
                  </button>
                )}
              </div>
              {canJoinAsSeller && (
                <button disabled={joining} onClick={async () => {
                  setJoining(true);
                  try {
                    await onJoin(Role.SELLER);
                    landOnDetailsAfterJoin();
                  } finally { setJoining(false); }
                }} style={{
                  width: "100%", marginTop: 10, padding: "14px", borderRadius: T.rs,
                  background: `${ROLE_COLOR.seller}22`, border: `1px solid ${ROLE_COLOR.seller}44`,
                  color: ROLE_COLOR.seller, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                  cursor: joining ? "default" : "pointer", transition: "all 0.2s",
                }}>
                  {joining ? t("trade.joining") : t("trade.joinAsSeller")}
                </button>
              )}
              </>)}
            </div>
          )}

          {/* Arbiter's evidence shortcut while ruling — swipes to the Chat pane,
              where the evidence lives (messages + receipt images + lifecycle). */}
          {titleDisputed && myRole === Role.ARBITER && (
            <button
              type="button"
              onClick={() => goPane(0)}
              style={{
                background: "none", border: "none", padding: "10px 0 0",
                color: ROLE_COLOR_TEXT.arbiter, fontFamily: T.mono, fontSize: 12,
                fontWeight: 700, cursor: "pointer", textAlign: "left",
              }}
            >
              {t("trade.openChatEvidence")}
            </button>
          )}
        </div>
        </div>{/* end .td-action-scroll — the internal-scroll top zone */}

      {/* Zone B — swipe middle: a horizontal pager of three full-width panes
          (Chat · Details · Parties). The pager scrolls natively (touch); the
          pills row also drags to page (pointer + touch), so the whole region
          from the pills down is one swipe surface. */}
      {/* v4.1 fixed-rectangle: td-lower (the chat pager) keeps a min-height FLOOR so
          chat never vanishes, and flex:1 so it claims every bit of height the action
          card above isn't using. When the action card is tall it scrolls INSIDE its
          own .td-action-scroll zone; td-lower stays ≥ floor, the shell never scrolls,
          and the timeline footer below stays anchored. The outer frame is fixed; only
          the internal top-vs-chat divide flexes (Jetty's dynamic split, 2026-06-25). */}
      <div className="td-lower" style={{ marginTop: 2, flex: "1 1 0", minHeight: "clamp(140px, 22dvh, 340px)", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          onPointerDown={onPillsPointerDown}
          onPointerUp={onPillsPointerUp}
          onTouchStart={onPillsTouchStart}
          onTouchEnd={onPillsTouchEnd}
          style={{ flex: "0 0 auto", cursor: "grab", touchAction: "pan-y", userSelect: "none" }}
        >
          <PagerPills tabs={PAGER_TABS} active={activePane} onSelect={userGoPane} badges={pagerBadges} />
        </div>
        <div
          className="td-pager"
          ref={pagerRef}
          onScroll={onPagerScroll}
          style={{
            display: "flex", overflowX: "auto", overflowY: "hidden",
            scrollSnapType: "x mandatory",
            flex: 1, minWidth: 0, minHeight: 0, scrollbarWidth: "none",
          }}
        >
          {/* pane 0 — Chat (living feed: messages + system event bubbles) */}
          <div className="td-pane" style={TD_PANE_STYLE}>
            {myRole ? (
              <ChatPanel state={state} myRole={myRole} onSend={onSendChat} embedded hideHeader fill systemBubbles={livingChatBubbles} ratingCta={chatRatingCta} />
            ) : (
              <div style={TD_PANE_PLACEHOLDER}>
                {t("trade.chatPlaceholder")}
              </div>
            )}
          </div>
          {/* pane 1 — Details (cart/order pre-lock, read-only reminder after) */}
          <div className="td-pane" style={TD_PANE_STYLE}>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: 1, color: T.accent, fontWeight: 700, margin: "2px 2px 13px" }}>
              DETAILS <span style={{ color: T.muted }}>· {verticalKicker}</span>
            </div>
            {billTypeChip && (
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "5px 11px", borderRadius: 999,
                  background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                }}>
                  <span aria-hidden="true">{billTypeChip.icon}</span>
                  {billTypeChip.label}
                </span>
              </div>
            )}
            {/* v4.1 checkout headline: at the pay moment (LOCKED), promote the FINAL
                fiat to the single biggest element on Details, phrased as the viewer's
                obligation. Both parties see the SAME number — the verb (owe/receive)
                carries the direction, so there's zero ambiguity. */}
            {state.status === EscrowStatus.LOCKED && checkoutFiatLabel && fiatPayerRole && (
              <div style={{
                background: myRole === fiatPayerRole ? `${ROLE_COLOR.buyer}14` : T.card,
                border: `1px solid ${myRole === fiatPayerRole ? ROLE_COLOR.buyer + "55" : T.border}`,
                borderRadius: T.r,
                padding: "13px 14px",
                marginBottom: 12,
                textAlign: "center" as const,
              }}>
                <div style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: T.muted, marginBottom: 5 }}>
                  {myRole === fiatPayerRole ? t("trade.youOwe") : myRole === Role.SELLER ? t("trade.youllReceive") : t("trade.fiatDue")}
                </div>
                <div style={{ fontFamily: T.sans, fontSize: 30, fontWeight: 900, color: T.text, lineHeight: 1.05 }}>
                  {checkoutFiatLabel}
                </div>
                {premiumCheckoutLine && (
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, marginTop: 6, lineHeight: 1.4 }}>
                    {premiumCheckoutLine}
                  </div>
                )}
              </div>
            )}
            <ArbiterInsuranceRow state={state} pubkey={pubkey} />
          <div className="trade-detail-hero" style={{
            padding: "0 0 10px",
            marginBottom: 4,
            textAlign: "center" as const,
          }}>
            {heroImages.length > 0 && (
              <div style={{ marginBottom: 10, borderRadius: T.r, overflow: "hidden", border: `1px solid ${T.border}` }}>
                <SwipeImageGallery images={heroImages} height={148} label="Trade photos" />
              </div>
            )}
            {/* v2.7 Stage 2: the decorative 128px woven-mark orb was removed —
                it was the single biggest space-waster on the core screen and
                conveyed nothing. The trade amount is the hero now; status lives
                in the header Badge. A thin status-tinted rule keeps a subtle
                brand/status accent without the vertical cost. */}
            <div aria-hidden="true" style={{
              width: 40, height: 3, borderRadius: 2,
              margin: "2px auto 10px",
              background: s.c,
              boxShadow: `0 0 12px ${s.c}66`,
            }} />
            <div className="trade-detail-amount-row" style={{
              textAlign: "center",
            }}>
              {showHeroFiat ? (
                <div className="trade-detail-amount" style={{
                  color: T.accent,
                  fontFamily: T.mono,
                  fontSize: 32,
                  fontWeight: 900,
                  lineHeight: 1,
                  letterSpacing: 0,
                }}>
                  {heroFiatLabel}
                </div>
              ) : (
                <BitcoinAmount className="trade-detail-amount" msats={heroAmountMsats} size={34} gap={7} glyphScale={1.12} />
              )}
            </div>
            <div style={{
              marginTop: 7,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.45,
            }}>
              {state.description}
              {showHeroFiat
                ? ` · ₿ ${fmtSats(heroAmountMsats)}`
                : heroFiatLabel
                  ? ` · ${heroFiatLabel}`
                  : ""}
              {viewerEstimateLabel ? ` · ${viewerEstimateLabel}` : ""}
              {routeNote ? ` · ${routeNote}` : ""}
              {myRole ? ` · ${roleDisplayName(myRole, t)}` : ""}
            </div>
            {state.category === "marketplace" && sellerPubkey && (
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: 10,
                padding: "5px 9px",
                borderRadius: 999,
                background: `linear-gradient(135deg, ${T.amber}2b, ${T.green}18)`,
                border: `1px solid ${T.amber}55`,
                color: T.amber,
                fontFamily: T.mono,
                fontSize: 10,
                fontWeight: 900,
                maxWidth: "100%",
              }}>
                <span aria-hidden="true">★</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t("trade.storeName", { name: sellerProfileName ?? shortParticipantPubkey(sellerPubkey) })}
                </span>
              </div>
            )}
          </div>

          {hasMenu && (
            <div className="trade-order-panel" style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: T.r,
              padding: 12,
              marginBottom: 12,
            }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.muted,
              fontFamily: T.mono,
              letterSpacing: 1,
            }}>
              {state.status === EscrowStatus.CREATED && !canSelectMenu
                ? t("trade.roleCart", { role: roleDisplayName(menuSelectorRole, t).toUpperCase() })
                : menuHeaderTitle(state.category, state.status === EscrowStatus.CREATED, t)}
            </div>
            <div style={{
              color: T.accent,
              fontFamily: T.mono,
              fontSize: 13,
              fontWeight: 800,
              display: "inline-flex",
              justifyContent: "flex-end",
              minWidth: 96,
            }}>
              {state.status === EscrowStatus.CREATED && !canSelectMenu && menuDisplayAmountMsats <= 0
                ? t("trade.waitingOnRole", { role: roleDisplayName(menuSelectorRole, t).toLowerCase() })
                : state.status === EscrowStatus.CREATED && hasExchangeMenu && menuDisplayAmountMsats <= 0
                ? t("trade.chooseAmount")
                : state.status === EscrowStatus.CREATED && menuDisplayAmountMsats <= 0
                ? menuSelectionHint(state.category, t)
                : (
                  <BitcoinAmount
                    msats={state.status === EscrowStatus.CREATED ? (menuDisplayAmountMsats || lockAmountMsats) : state.amountMsats}
                    size={13}
                    gap={4}
                    glyphScale={1.18}
                  />
                )}
            </div>
          </div>
          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            // v4.1 pre-lock menu compaction: a tighter window so the storefront
            // menu doesn't dominate the Details pane before lock (it scrolls
            // internally past the cap). Rows + thumbnails are denser too.
            maxHeight: canSelectMenu ? 224 : 150,
            overflowY: "auto",
            paddingRight: 2,
          }}>
            {renderedMenuRows.length === 0 && (
              <div style={{
                padding: "18px 14px",
                background: T.surface,
                border: `1px dashed ${T.border}`,
                borderRadius: T.rs,
                color: T.muted,
                fontFamily: T.mono,
                fontSize: 11,
                lineHeight: 1.55,
                textAlign: "center",
              }}>
                {t("trade.waitingToBuildOrder", { role: roleDisplayName(menuSelectorRole, t).toLowerCase() })}
              </div>
            )}
            {renderedMenuRows.map(item => {
              const itemId = "itemId" in item ? item.itemId : item.id;
              const itemImage = "imageDataUrl" in item
                ? item.imageDataUrl
                : menuItems.find(menuItem => menuItem.id === itemId)?.imageDataUrl;
              const savedOrderItem = savedOrderItems.find(orderItem => orderItem.itemId === itemId);
              const interactive = canSelectMenu;
              const qty = "quantity" in item
                ? item.quantity
                : interactive
                  ? (menuQuantities[itemId] ?? 0)
                  : (savedOrderItem?.quantity ?? 0);
              const exactSats = parsePositiveWholeSats(menuAmounts[itemId] ?? "");
              const minMsats = item.minAmountMsats ?? item.amountMsats;
              const maxMsats = item.maxAmountMsats ?? item.amountMsats;
              const exactMsats = exactSats * 1000;
              const exactAmountValid = exactMsats >= minMsats && exactMsats <= maxMsats;
              const metaLine = menuMetaLine(item, t);
              const allowsQuantity = state.category === "marketplace";
              // Anti-drain (#6): clamp the buyer's stepper to the seller's
              // per-item cap (and the global 99 ceiling). The reducer rejects
              // over-cap LOCKs regardless; this just stops the buyer building
              // an order the seller could never lock.
              const itemQtyCap = "maxQuantity" in item && typeof item.maxQuantity === "number"
                ? Math.min(99, item.maxQuantity)
                : 99;
              const selected = hasExchangeMenu
                ? interactive
                  ? exactSats > 0 && exactAmountValid
                  : !!savedOrderItem
                : qty > 0;
              return (
                <div key={itemId} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: T.rs,
                }}>
                  {showStorefrontImages && itemImage && (
                    <img
                      src={itemImage}
                      alt=""
                      style={{
                        width: 46,
                        height: 38,
                        objectFit: "cover",
                        borderRadius: 8,
                        border: `1px solid ${T.border}`,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: T.text,
                      fontFamily: T.sans,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap" as const,
                    }}>
                      {item.label}
                    </div>
                    <div style={{
                      marginTop: 3,
                      fontSize: 10,
                      color: T.muted,
                      fontFamily: T.mono,
                    }}>
                      {menuAmountLabel(item)}
                      {"quantity" in item && item.quantity > 1 ? ` × ${item.quantity}` : ""}
                      {allowsQuantity && itemQtyCap < 99 ? ` · ${t("trade.maxQty", { count: itemQtyCap })}` : ""}
                    </div>
                    {metaLine && (
                      <div style={{
                        marginTop: 3,
                        fontSize: 9,
                        color: T.muted,
                        fontFamily: T.mono,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap" as const,
                      }}>
                        {metaLine}
                      </div>
                    )}
                  </div>
                  {interactive && hasExchangeMenu ? (
                    <div style={{ minWidth: 104 }}>
                      <input
                        type="number"
                        value={menuAmounts[itemId] ?? ""}
                        onChange={e => setMenuAmounts(prev => ({ ...prev, [itemId]: e.target.value }))}
                        placeholder={fmtSats(minMsats)}
                        style={{
                          ...inputStyle,
                          padding: "9px 10px",
                          fontSize: 12,
                          borderColor: (menuAmounts[itemId] && !exactAmountValid) ? `${T.red}66` : T.border,
                          color: exactAmountValid ? T.accent : T.text,
                        }}
                      />
                    </div>
                  ) : interactive && !allowsQuantity ? (
                    <button
                      onClick={() => setMenuQuantities(prev => ({
                        ...prev,
                        [itemId]: (prev[itemId] ?? 0) > 0 ? 0 : 1,
                      }))}
                      style={menuPickButtonStyle(selected)}
                    >
                      {selected ? t("trade.selectedCap") : menuPickLabel(state.category, t)}
                    </button>
                  ) : interactive ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={() => setMenuQuantities(prev => ({
                          ...prev,
                          [itemId]: Math.max(0, (prev[itemId] ?? 0) - 1),
                        }))}
                        style={menuQtyButtonStyle()}
                      >
                        −
                      </button>
                      <span style={{
                        minWidth: 18,
                        textAlign: "center",
                        color: qty > 0 ? T.accent : T.muted,
                        fontFamily: T.mono,
                        fontSize: 12,
                        fontWeight: 800,
                      }}>
                        {qty}
                      </span>
                      <button
                        onClick={() => setMenuQuantities(prev => ({
                          ...prev,
                          [itemId]: Math.min(itemQtyCap, (prev[itemId] ?? 0) + 1),
                        }))}
                        style={menuQtyButtonStyle()}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <div style={{
                      color: selected ? T.accent : T.muted,
                      fontFamily: T.mono,
                      fontSize: 12,
                      fontWeight: 800,
                    }}>
                      {selected
                        ? hasExchangeMenu && savedOrderItem
                          ? (
                            <BitcoinAmount
                              msats={savedOrderItem.amountMsats}
                              size={12}
                              gap={4}
                              glyphScale={1.18}
                            />
                          )
                          : allowsQuantity
                            ? `×${qty}`
                            : t("trade.selectedLower")
                        : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {selectorNeedsSaveOrder && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 8,
              marginTop: 12,
            }}>
              <button
                disabled={joining || selectedMenuItems.length === 0 || selectionMatchesSavedOrder}
                onClick={async () => {
                  setJoining(true);
                  try {
                    await onJoin(menuSelectorRole, {
                      selectedItems: selectedMenuItems,
                      amountMsats: selectedMenuAmountMsats,
                    });
                    landOnDetailsAfterJoin();
                  } finally {
                    setJoining(false);
                  }
                }}
                style={{
                  padding: "12px 10px",
                  borderRadius: T.rs,
                  border: `1px solid ${selectedMenuItems.length > 0 && !selectionMatchesSavedOrder ? T.border : T.border}`,
                  background: T.surface,
                  color: selectedMenuItems.length > 0 && !selectionMatchesSavedOrder ? T.text : T.muted,
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 900,
                  cursor: joining || selectedMenuItems.length === 0 || selectionMatchesSavedOrder ? "default" : "pointer",
                }}
              >
                {joining
                  ? t("trade.saving")
                  : selectionMatchesSavedOrder
                    ? t("trade.cartSaved")
                    : selectedMenuItems.length === 0
                      ? menuSelectionButtonLabel(state.category, t)
                      : (
                        <>
                          {t("trade.saveCartPrefix")} <BitcoinAmount msats={selectedMenuAmountMsats} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                        </>
                      )}
              </button>
              <button
                disabled={joining || selectedMenuItems.length === 0}
                onClick={async () => {
                  setJoining(true);
                  try {
                    await onJoin(menuSelectorRole, {
                      selectedItems: selectedMenuItems,
                      amountMsats: selectedMenuAmountMsats,
                      orderFinalized: true,
                    });
                    landOnDetailsAfterJoin();
                  } finally {
                    setJoining(false);
                  }
                }}
                style={{
                  padding: "12px 10px",
                  borderRadius: T.rs,
                  border: `1px solid ${selectedMenuItems.length > 0 ? T.accent + "66" : T.border}`,
                  background: selectedMenuItems.length > 0 ? T.accentDim : T.surface,
                  color: selectedMenuItems.length > 0 ? T.accent : T.muted,
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 900,
                  cursor: joining || selectedMenuItems.length === 0 ? "default" : "pointer",
                }}
              >
                {joining
                  ? t("trade.confirming")
                  : selectedMenuItems.length === 0
                    ? t("trade.notReady")
                    : (
                      <>
                        {t("trade.readyPrefix")} <BitcoinAmount msats={selectedMenuAmountMsats} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                      </>
                    )}
              </button>
            </div>
          )}
        </div>
      )}

      {(categoryUsesPaymentRails(state.category) && acceptedPaymentMethods.length > 0 || premiumLine) && (
        <div style={{
          background: T.card,
          border: `1px solid ${premiumLine ? T.amber + "33" : T.border}`,
          borderRadius: T.r,
          padding: 12,
          marginBottom: 12,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.muted,
            fontFamily: T.mono,
            letterSpacing: 1,
            marginBottom: 9,
          }}>
            {t("trade.tradeTerms")}
          </div>
          {acceptedPaymentMethods.length > 0 && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {acceptedPaymentMethods.map(method => {
                  // For a prospective buyer, flag the rails they can already pay on.
                  const isShared = myRole !== Role.SELLER && sharedRailSet.has(toRailKey(method));
                  return (
                    <span
                      key={method}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "5px 9px",
                        borderRadius: 999,
                        background: isShared ? `${T.green}22` : T.surface,
                        border: `1px solid ${isShared ? T.green : T.border}`,
                        color: isShared ? T.green : T.text,
                        fontFamily: T.mono,
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      {isShared ? "✓ " : ""}{method}
                    </span>
                  );
                })}
              </div>
              {myRole !== Role.SELLER && suggestedRail && railMatch.shared.length > 0 && (
                <div style={{ marginTop: 8, color: T.muted, fontSize: 11, lineHeight: 1.5 }}>
                  {t("trade.youBothUseBefore")} <strong style={{ color: T.green }}>{suggestedRail.displayName}</strong>{t("trade.youBothUseAfter")}
                </div>
              )}
            </>
          )}
          {premiumLine && (
            <div style={{
              marginTop: acceptedPaymentMethods.length > 0 ? 10 : 0,
              paddingTop: acceptedPaymentMethods.length > 0 ? 10 : 0,
              borderTop: acceptedPaymentMethods.length > 0 ? `1px solid ${T.border}` : "none",
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              color: T.amber,
              fontFamily: T.mono,
              fontSize: 11,
              lineHeight: 1.4,
            }}>
              <span style={{ color: T.muted, fontWeight: 800, letterSpacing: 0.7 }}>{t("trade.premiumLabel")}</span>
              <span style={{ fontSize: 13, fontWeight: 900, textAlign: "right" as const }}>
                {premiumLine}
                {premiumCheckoutLine && (
                  <span style={{ display: "block", marginTop: 2, color: T.muted, fontSize: 10, fontWeight: 500 }}>
                    {premiumCheckoutLine}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {publicStoreListingUri && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: T.r,
          padding: "10px 12px",
          marginBottom: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 800 }}>
              {t("trade.nostrListing")}
            </div>
            <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.45, marginTop: 2 }}>
              {t("trade.nostrListingHint")}
            </div>
          </div>
          <CopyButton
            value={publicStoreListingUri}
            label={t("common.copyLink")}
            style={{
              flexShrink: 0,
              background: T.surface,
              border: `1px solid ${T.accent}`,
              borderRadius: T.rs,
              color: T.accent,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 800,
              padding: "7px 10px",
              whiteSpace: "nowrap",
            }}
          />
        </div>
      )}

      {/* v0.2.0 item 1: State A vs State B narration. Only fires on
          CREATED listings (the funding moment); LOCKED+ trades have
          a clearer status surface elsewhere and don't need the
          home/listing-fed framing. */}
      {showVerboseRouteEducation && state.status === EscrowStatus.CREATED && framing.kind === "state-a" && (
        <div style={{
          padding: "8px 12px", marginBottom: 12,
          fontSize: 11, color: T.muted, fontFamily: T.mono,
          textAlign: "center" as const, lineHeight: 1.5,
        }}>
          {framing.sameFedSameCommunity
            ? t("trade.sameCommunityAsChama")
            : t("trade.sameFedCrossCommunity")}
        </div>
      )}
      {/* v0.3.0 Phase 6: one-time State B educational card. Renders
          ONCE per pubkey above the permanent State B callout. Dismiss
          is sticky via chama_state_b_explained_<pubkey> in localStorage
          (same shape as v0.2.0's chama_first_publish_done_<pubkey>).
          Pillar 2.7: educate at the first opportunity, never lecture
          returning users. */}
      {showVerboseRouteEducation && state.status === EscrowStatus.CREATED && framing.kind === "state-b" && !stateBDismissed && (
        <div style={{
          padding: 14, marginBottom: 12,
          background: T.accentDim, border: `1px solid ${T.accent}33`,
          borderRadius: T.r,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {t("trade.stateBHeadsUp")}
          </div>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 12 }}>
            {t("trade.stateBBody", {
              homeFlag: framing.homeFlagEmoji,
              homeName: framing.homeCommunityName,
              listingFlag: framing.listingFlagEmoji,
              listingName: framing.listingCommunityName,
            })}
          </div>
          <button
            onClick={() => {
              markStateBExplained(pubkey);
              setStateBDismissed(true);
            }}
            style={{
              background: "none", border: `1px solid ${T.accent}66`,
              color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              padding: "6px 12px", borderRadius: T.rs,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            {t("trade.gotIt")}
          </button>
        </div>
      )}
      {showVerboseRouteEducation && state.status === EscrowStatus.CREATED && framing.kind === "state-b" && (
        <div style={{
          padding: 14, marginBottom: 12,
          background: T.surface, border: `1px solid ${T.amber}33`,
          borderRadius: T.rs,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {t("trade.crossFederation")}
          </div>
          {/* v0.3.0 Phase 6: tightened from
                "Running on {emoji} {name} · we switched you in for this trade."
              to drop "we" — the system did it; the framing is the user's. */}
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 6 }}>
            {t("trade.runningOnBefore")} {framing.listingFlagEmoji} <strong>{framing.listingCommunityName}</strong> {t("trade.runningOnAfter")}
          </div>
          {/* v0.3.0 Phase 6: educational essay moved to the one-time
              card above. This callout is now a single reassuring
              sentence, the only thing returning State-B users see. */}
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5 }}>
            {t("trade.switchedAutomatically")}
          </div>
        </div>
      )}

      {/* Subscription timeline */}
      {state.subscription && (
        <SubscriptionTimeline
          subscription={state.subscription}
          onRelease={async (periodIndex) => {
            try {
              await onReleasePeriod?.(periodIndex);
            } catch (e: any) {
              console.error("[chama] Period release failed:", e);
            }
          }}
        />
      )}

      {/* Expiry policy — visible on all LOCKED trades */}
      {state.status === "LOCKED" && (() => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = state.expiresAt - now;
        const isExpired = remaining <= 0;
        const isUrgent = remaining > 0 && remaining < 7200;
        // v2.9: a standing RELEASE from the non-locker (the performer) means the
        // deadline NO LONGER auto-refunds the locker — an arbiter decides. The
        // old "auto-refunds at expiry" copy would be a lie in that state, so the
        // banner flips. The version note is the companion to the v2.9 consensus
        // change (relaxed vote acceptance): a dispute only settles the same for
        // everyone if all parties are on the latest client. (DECISIONS
        // 2026-06-07/08 — expiry exploit + coordinated release.)
        const contested = isPerformanceContest(state);
        return (
          <div style={{ marginBottom: 12 }}>
            {contested ? (
              <div style={{
                padding: "12px 14px", borderRadius: 8, textAlign: "center",
                background: T.amberDim, border: `1px solid ${T.amber}44`,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.amber, fontFamily: T.mono }}>
                  {isExpired ? t("trade.expiredArbiterDecides") : t("trade.releaseVoteIn")}
                </div>
                <div style={{ fontSize: 11, color: T.text, fontFamily: T.sans, marginTop: 6 }}>
                  {isExpired
                    ? t("trade.expiredNoAutoRefund")
                    : t("trade.deadlineGoesToArbiter")}
                </div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 6 }}>
                  {t("trade.latestChamaNote")}
                </div>
              </div>
            ) : isExpired ? (
              <div style={{
                padding: "14px 16px", borderRadius: 8, textAlign: "center",
                background: T.redDim, border: `1px solid ${T.red}44`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.red, fontFamily: T.mono }}>
                  {t("trade.tradeExpired")}
                </div>
                <div style={{ fontSize: 11, color: T.text, fontFamily: T.sans, marginTop: 6 }}>
                  {t("trade.arbiterAutoRefund")}
                </div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
                  {t("trade.satsReturnedAuto", { party: refundRecipientFor(state.category) === "seller" ? t("trade.sellerNoun") : t("trade.buyerNoun") })}
                </div>
              </div>
            ) : (
              <div style={{
                padding: "8px 12px", borderRadius: 6, textAlign: "center",
                background: isUrgent ? T.redDim : T.surface,
                border: `1px solid ${isUrgent ? T.red + "33" : T.amber + "22"}`,
              }}>
                <span style={{
                  fontSize: 10, fontFamily: T.mono,
                  color: isUrgent ? T.red : T.amber,
                }}>
                  {isUrgent ? `${t("trade.expiringSoon")} ` : "⏱️ "}
                  {t("trade.ifTimeExpires", { party: refundRecipientFor(state.category) === "seller" ? t("trade.sellerNoun") : t("trade.buyerNoun") })}
                </span>
              </div>
            )}
          </div>
        );
      })()}

      {reservedByOther && (
        <div style={{
          marginBottom: 16,
          padding: 14,
          borderRadius: T.r,
          background: T.amberDim,
          border: `1px solid ${T.amber}55`,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 800, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {t("trade.reservedByOther", { role: roleDisplayName(reservedByOther.role, t).toUpperCase() })}
          </div>
          <CountdownTimer
            expiresAt={reservedByOther.expiresAt}
            label={t("trade.freesUpIn")}
          />
          <div style={{
            marginTop: 8, fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
          }}>
            {t("trade.reservedNote")}
          </div>
        </div>
      )}

      {state.expiresAt
        && !reservedByOther
        && state.status !== "COMPLETED"
        && state.status !== "CANCELLED"
        && state.status !== "EXPIRED"
        && state.status !== "APPROVED"
        && state.status !== "CLAIMED" && (
        <div style={{ marginBottom: 16 }}>
          <CountdownTimer
            expiresAt={liveJoinHold?.expiresAt ?? state.expiresAt}
            label={liveJoinHold
              ? t("trade.lockWindowEndsIn", { role: roleDisplayName(liveLockWindowRole ?? liveJoinHold.role, t).toUpperCase() })
              : state.status === EscrowStatus.CREATED ? t("trade.listingExpiresIn") : t("trade.tradeExpiresIn")}
          />
        </div>
      )}

          </div>
          {/* pane 2 — Parties (trinity ring · shield · tally · ratings) */}
          <div className="td-pane" style={TD_PANE_STYLE}>
        {/* v3.2: the draft placeholder — the other side is still building the
            order, make the "forming" state visible instead of empty space. */}
        {state.status === EscrowStatus.CREATED && hasMenu && myRole
          && myRole !== menuSelectorRole && !savedOrderFinalized && (
          <div style={{
            marginBottom: 16, padding: 13, textAlign: "center",
            background: T.surface, border: `1px dashed ${T.border}`,
            borderRadius: T.rs,
          }}>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
              {t("trade.draftOrderForming")}
            </div>
            <div style={{
              marginTop: 7, display: "flex", alignItems: "center",
              justifyContent: "center", gap: 7,
              fontFamily: T.mono, fontSize: 11,
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999,
                background: ROLE_COLOR[menuSelectorRole as keyof typeof ROLE_COLOR] ?? T.muted,
              }} />
              <span style={{ color: ROLE_COLOR[menuSelectorRole as keyof typeof ROLE_COLOR] ?? T.muted }}>
                {t("trade.waitingOnRole", { role: roleDisplayName(menuSelectorRole, t).toLowerCase() })}
              </span>
            </div>
          </div>
        )}

        {/* R3-2 (3.5.x): the explicit pre-lock "Leave" button was removed.
            "Window shopping" — a joined buyer who wanders off simply lets the
            5-minute seat hold (JOIN_HOLD_SECONDS) expire; the seat frees on its
            own. Removing the action also removes its forget-forever path, so a
            pre-lock trade is never buried and its chat is never wiped. The
            honest "reserved · frees in Xm" display lives above; the post-lock
            cancel hatch / hide-gate are unaffected. */}

        {/* Ratings (kind:38123): one-tap rate the counterparty the moment the
            trade settles — non-blocking, and the same slot is re-tappable from
            Me history if they bolt with their sats first. */}
        {state.status === EscrowStatus.COMPLETED && onRateCounterparty && (() => {
          const ratee = counterpartyToRate(state, pubkey);
          if (!ratee) return null;
          const ratedThumb = (myGivenRatings ?? []).find(
            r => r.tradeId === state.id && r.ratee === ratee.toLowerCase(),
          )?.thumb;
          return (
            <RatingTap
              tradeId={state.id}
              ratee={ratee}
              ratedThumb={ratedThumb}
              onRate={onRateCounterparty}
              leading
            />
          );
        })()}

        {showBuyerAttempts && (
          <div style={{
            paddingTop: 14,
            marginBottom: 16,
            borderTop: `1px solid ${T.border}`,
          }}>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              marginBottom: 10,
            }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: T.muted,
                fontFamily: T.mono,
                letterSpacing: 1,
              }}>
                {t("trade.buyerAttempts")}
              </div>
              <div style={{
                color: T.amber,
                fontFamily: T.mono,
                fontSize: 10,
                fontWeight: 900,
              }}>
                {buyerAttemptRows.length === 1 ? t("trade.eventCountOne", { count: buyerAttemptRows.length }) : t("trade.eventCountMany", { count: buyerAttemptRows.length })}
              </div>
            </div>
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}>
              {buyerAttemptRows.slice(0, 5).map(attempt => (
                <div key={attempt.id} style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: `1px solid ${T.border}66`,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      minWidth: 0,
                    }}>
                      <span style={{
                        color: attempt.isLive ? T.accent : T.muted,
                        fontFamily: T.mono,
                        fontSize: 10,
                        fontWeight: 900,
                        textTransform: "uppercase",
                      }}>
                        {attempt.statusLabel}
                      </span>
                      <span style={{
                        color: T.text,
                        fontFamily: T.mono,
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {shortParticipantPubkey(attempt.pubkey)}
                      </span>
                    </div>
                    <div style={{
                      marginTop: 4,
                      color: T.muted,
                      fontFamily: T.mono,
                      fontSize: 10,
                      lineHeight: 1.4,
                    }}>
                      {attempt.selectedCount > 0
                        ? (attempt.selectedCount === 1 ? t("trade.optionsSelectedOne", { count: attempt.selectedCount }) : t("trade.optionsSelectedMany", { count: attempt.selectedCount }))
                        : t("trade.noOrderSnapshot")}
                      {" · "}
                      {attempt.expiresAt > nowSec
                        ? t("trade.minutesLeft", { count: Math.ceil((attempt.expiresAt - nowSec) / 60) })
                        : t("trade.minutesExpired", { count: Math.ceil((nowSec - attempt.expiresAt) / 60) })}
                    </div>
                  </div>
                  {attempt.amountMsats > 0 && (
                    <BitcoinAmount
                      msats={attempt.amountMsats}
                      size={12}
                      gap={4}
                      glyphScale={1.18}
                      color={attempt.isLive ? T.accent : T.muted}
                      glyphColor={attempt.isLive ? T.accent : T.muted}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Zone 3 — elastic deal slot: collapses to "who ⇄ who · item", expands
            to the trinity ring + shield. Auto-open at fund (CREATED) & dispute. */}
        <div style={{
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: T.r, overflow: "hidden", marginBottom: 16,
        }}>
          <div onClick={() => setDealSlotOpen(!dealOpen)} style={{
            cursor: "pointer", padding: "11px 14px",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
              {TRINITY_RING_ORDER.map(role => {
                // 3.5.1 #8a: mirror the trinity ring — an auto-assigned arbiter
                // (effective participant, or the pool preview pre-lock) fills
                // its dot too, so these small header dots don't read "arbiter
                // not joined" while the ring shows it joined.
                const dotFilled = role === Role.ARBITER
                  ? !!(participants[Role.ARBITER] ?? previewArbiterPk)
                  : !!participants[role];
                return (
                  <span key={role} style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: dotFilled ? ROLE_COLOR[role as keyof typeof ROLE_COLOR] : "transparent",
                    border: `1.5px solid ${ROLE_COLOR[role as keyof typeof ROLE_COLOR]}${dotFilled ? "" : "66"}`,
                  }} />
                );
              })}
            </div>
            <div style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700 }}>
                <span style={{ color: ROLE_COLOR.buyer }}>{dealBuyerName ?? "Buyer"}</span>
                <span style={{ color: T.muted }}> ⇄ </span>
                <span style={{ color: ROLE_COLOR.seller }}>{dealSellerName ?? "Seller"}</span>
              </span>
              <span style={{ fontFamily: T.sans, fontSize: 11, color: T.muted }}> · {state.description || tradeRoomTitle}</span>
            </div>
            <span style={{ color: T.muted, fontSize: 11, fontFamily: T.mono, flexShrink: 0 }}>{dealOpen ? "▾" : "▸"}</span>
          </div>
          {dealOpen && (
          <div style={{ padding: "4px 14px 14px" }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1 }}>{t("trade.participants")}</div>
          {state.communityArbiters && state.communityArbiters.length > 0 && (
            <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono }}>
              {state.actingArbiter && state.actingArbiter !== participants[Role.ARBITER]
                // Arbiter substitution: a pool backup's vote currently holds the
                // arbiter slot (the assigned arbiter went absent past the floor).
                ? t("trade.standbyArbiterSteppedIn", { pubkey: shortParticipantPubkey(state.actingArbiter) })
                : (state.communityArbiters.length !== 1
                    ? t("trade.arbitersOnStandbyMany", { count: state.communityArbiters.length })
                    : t("trade.arbitersOnStandbyOne", { count: state.communityArbiters.length }))}
            </div>
          )}
        </div>
        <ArbiterProvenanceBanner
          state={state}
          prov={arbiterProv}
          assignment={arbiterAssignment}
          selfRostered={selfRostered}
        />
        <ArbiterSubstitutionNotice state={state} />
        {forgedBondedStamp && (
          <div style={{
            padding: "11px 13px", marginBottom: 12, borderRadius: T.rs,
            background: `${T.red}12`, border: `1px solid ${T.red}44`,
            fontFamily: T.sans, fontSize: 12, color: T.red, lineHeight: 1.55,
          }}>
            <strong>⚠ {t("trade.forgedStampTitle")}</strong> {t("trade.forgedStampBody")}
          </div>
        )}
        {/* The on-chain panel used to render here TOO, giving two copies of the
            same address on two tabs. It now lives once, in Details, beside the
            action it belongs to. */}
        {/* ⚠ The funder-clawback warning is an ECASH property. An on-chain
            escrow removes that capability outright, so showing it there would
            be false in the frightening direction. */}
        {!onchainView && <LockCustodyNotice state={state} myRole={myRole} />}
        <ArbiterCommitmentCard
          bond={seatedBond}
          tipHeight={bondTipHeight}
          cohortPeers={cohortPeers}
          concentration={seatedConcentration}
        />
        {/* Match the vote tally's 3-column grid (below) exactly so the arbiter
            (middle) sits directly above the FINAL DECISION chip and the buyer /
            seller align over their vote columns. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, justifyItems: "center" }}>
          {TRINITY_RING_ORDER.map(role => {
            const realPk = participants[role];
            const isAutoArbiter = role === Role.ARBITER && !realPk && !!previewArbiterPk;
            const dotPk = realPk ?? (isAutoArbiter ? previewArbiterPk : null);
            return (
              <Dot key={role} role={role}
                pk={dotPk}
                isYou={myRole === role}
                voted={!!state.votes[role]} outcome={state.votes[role]}
                autoAssigned={isAutoArbiter}
                onClick={fetchRatingSummary && dotPk ? () => setRepFor(prev => prev === dotPk ? null : dotPk) : undefined}
                displayName={profileNameFor(profileNames, dotPk, kind0Enabled)} />
            );
          })}
        </div>
        {/* v3.1.1 (#2): tap a filled avatar above → its verified reputation. */}
        {repFor && fetchRatingSummary && (
          <ReputationReadout
            pubkey={repFor}
            name={profileNameFor(profileNames, repFor, kind0Enabled)}
            fetchSummary={fetchRatingSummary}
          />
        )}

        {/* v2.7: the trust story + B/A/S legend. Plain-language "why this is
            safe" at the moment it matters, decoding the three coloured dots
            above. Progressive disclosure (native <details>) so the shield +
            label reassure always, the detail is one tap away — no permanent
            clutter on an already-busy screen. */}
        <details style={{
          marginTop: 14,
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: T.r,
          overflow: "hidden",
        }}>
          <summary style={{
            cursor: "pointer", listStyle: "none",
            padding: "11px 14px",
            display: "flex", alignItems: "center", gap: 9,
            fontFamily: T.sans, fontSize: 13, fontWeight: 700, color: T.text,
          }}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>🛡️</span>
            {t("trade.howMoneyProtected")}
            <span style={{ marginLeft: "auto", color: T.muted, fontSize: 11, fontFamily: T.mono }}>▾</span>
          </summary>
          <div style={{ padding: "0 14px 14px", fontFamily: T.sans }}>
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginBottom: 12 }}>
              {t("trade.shieldBody1")}{" "}
              <strong style={{ color: T.text }}>{t("trade.shieldEscrowStrong")}</strong> {t("trade.shieldBody2")}{" "}
              <strong style={{ color: T.text }}>{t("trade.shield2of3Strong")}</strong> {t("trade.shieldBody3")}{" "}
              <strong style={{ color: T.text }}>{t("trade.shieldNeverHolds")}</strong>
            </div>
            {/* ⚠ The 2-of-3 holds against the arbiter and against the
                counterparty. It does NOT hold against the party who funded it —
                they know the bearer-note string and can reissue it. See
                escrow-engine/lock-custody.ts. Stated here for everyone, and
                again where the exposed party will actually see it. */}
            <div style={{
              fontSize: 12, color: T.amber, lineHeight: 1.55, marginBottom: 12,
              padding: "9px 11px", borderRadius: T.rs,
              background: `${T.amber}10`, border: `1px solid ${T.amber}33`,
            }}>
              {t("trade.shieldFunderLimit")}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {([
                { c: ROLE_COLOR.buyer, k: "Buyer", labelKey: "trade.roleBuyer", descKey: "trade.legendBuyer" },
                { c: ROLE_COLOR.arbiter, k: "Arbiter", labelKey: "trade.roleArbiter", descKey: "trade.legendArbiter" },
                { c: ROLE_COLOR.seller, k: "Seller", labelKey: "trade.roleSeller", descKey: "trade.legendSeller" },
              ] as const).map(({ c, k, labelKey, descKey }) => (
                <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 9, fontSize: 12, lineHeight: 1.45 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: c, flexShrink: 0, transform: "translateY(1px)" }} />
                  <span>
                    <strong style={{ color: T.text }}>{t(labelKey)}</strong>
                    <span style={{ color: T.muted }}> — {t(descKey)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </details>
          </div>
          )}
        </div>

        {(state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED ||
          state.status === EscrowStatus.CLAIMED || state.status === EscrowStatus.COMPLETED) && (
          <div style={{
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.r, overflow: "hidden", marginBottom: 18,
          }}>
            <div onClick={() => setVotesRowOpen(!votesOpen)} style={{
              cursor: "pointer", padding: "11px 14px",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: titleDisputed ? T.amber : T.muted, letterSpacing: 1 }}>
                {titleDisputed ? t("trade.votesOnRecord") : t("trade.settlementHeader")}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: decisionTone }}>
                {state.resolvedOutcome ? String(state.resolvedOutcome).toLowerCase() : t("trade.awaiting")} · {releaseVoteCount}R / {refundVoteCount}F
              </span>
              <span style={{ marginLeft: "auto", color: T.muted, fontSize: 11, fontFamily: T.mono }}>{votesOpen ? "▾" : "▸"}</span>
            </div>
            {votesOpen && (
          <div className="trade-vote-decisions" style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
            paddingTop: 14,
            marginTop: 16,
            marginBottom: 18,
            borderTop: `1px solid ${T.border}`,
          }}>
            {/* Tally reads left→right like the Trinity ring above it (Buyer ·
                Arbiter · Seller). The winning outcome's green chip sits under
                whoever wins RELEASE: the Buyer for p2p/bill-pay/lending, but the
                SELLER for Market (buyer locks → seller wins release). So Market
                mirrors the chips — amber refund under the Buyer, green release
                under the Seller — and the arbiter's decision stays centered. */}
            {(() => {
              const releaseChip = (
                <div className="trade-vote-decision-chip" style={voteDecisionChipStyle(T.green)}>
                  <strong style={voteDecisionValueStyle()}>{releaseVoteCount}</strong>
                  <span style={voteDecisionLabelStyle()}>{t("trade.releaseVotesLabel")}</span>
                </div>
              );
              const centerChip = (
                <div className="trade-vote-decision-chip" style={voteDecisionChipStyle(decisionTone)}>
                  <strong style={voteDecisionValueStyle()}>{decisionValue}</strong>
                  <span style={voteDecisionLabelStyle()}>{decisionLabel}</span>
                </div>
              );
              const refundChip = (
                <div className="trade-vote-decision-chip" style={voteDecisionChipStyle(T.amber)}>
                  <strong style={voteDecisionValueStyle()}>{refundVoteCount}</strong>
                  <span style={voteDecisionLabelStyle()}>{t("trade.refundVotesLabel")}</span>
                </div>
              );
              return state.category === "marketplace"
                ? <>{refundChip}{centerChip}{releaseChip}</>
                : <>{releaseChip}{centerChip}{refundChip}</>;
            })()}
          </div>
            )}
          </div>
        )}

      {isOversoldOrder && (state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED) && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}66`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.5,
        }}>
          <div style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, marginBottom: 6 }}>
            {t("trade.oversoldTitle")}{state.participants[Role.BUYER] ? ` · ${t("trade.oversoldBuyer", { pubkey: shortParticipantPubkey(state.participants[Role.BUYER]!) })}` : ""}
          </div>
          {myRole === Role.SELLER
            ? t("trade.oversoldSellerBody")
            : t("trade.oversoldBuyerBody")}
        </div>
      )}

      {hasDuplicateParticipant && (
        <div style={{
          background: T.redDim, border: `1px solid ${T.red}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.red, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          {t("trade.duplicateKeyWarning")}
        </div>
      )}

      {!hasDuplicateParticipant && lockBlockedByNoArbiter && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          {t("trade.noArbiterPairWarning")}
        </div>
      )}

      {expiredJoinHold && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 800, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 6,
          }}>
            {t("trade.lockWindowExpired")}
          </div>
          {samePubkey(expiredJoinHold.pubkey, pubkey)
            ? t("trade.yourReservationExpired", { role: roleDisplayName(expiredJoinHold.role, t).toLowerCase() })
            : t("trade.theirReservationExpired", { role: roleDisplayName(expiredJoinHold.role, t), pubkey: `${expiredJoinHold.pubkey.slice(0, 8)}...` })}
        </div>
      )}

      {!myRole && !hasDuplicateParticipant && state.status === EscrowStatus.CREATED && currentKeyAlreadyPresent && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          {t("trade.listingTiedToKey")}
        </div>
      )}



      {/* Revealed payment handle for the trade's three participants. */}
      {state.status === EscrowStatus.LOCKED && state.lock.handle && (
        <div style={{
          paddingTop: 16,
          marginTop: 16,
          marginBottom: 16,
          borderTop: `1px solid ${T.amber}33`,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            {t("trade.paymentHandle")}
            {state.lock.handle.rail && (
              <span style={{ color: T.amber, marginLeft: 8 }}>
                · {getRailByKey(state.lock.handle.rail)?.displayName || state.lock.handle.rail}
              </span>
            )}
          </div>
          <div style={{
            fontFamily: T.mono, fontSize: 14, color: T.text,
            padding: "10px 12px", background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.border}`,
            wordBreak: "break-all" as const,
          }} title={myRole ? state.lock.handle.value : undefined}>
            {handleDisplayForViewer(state.lock.handle.value, !!myRole)}
          </div>
          {/* v0.6.5: networks the seller accepts on this handle.
              Phone numbers serve many mobile-money networks; without
              this chip row the buyer has no honest way to know which
              one to use. Only renders for participants (the cleartext
              value itself is hidden from non-participants anyway, so
              the network tags would be a privacy leak there). */}
          {!!myRole && state.lock.handle.networks && state.lock.handle.networks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{
                fontSize: 9, color: T.muted, fontFamily: T.mono,
                letterSpacing: 0.3, marginBottom: 5,
              }}>
                {t("trade.accepts")}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {state.lock.handle.networks.map(networkKey => (
                  <span key={networkKey} style={{
                    padding: "4px 10px", borderRadius: 12,
                    background: T.tealDim,
                    border: `1px solid ${T.teal}66`,
                    color: T.teal, fontFamily: T.mono,
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.2,
                  }}>
                    {getRailByKey(networkKey)?.displayName || networkKey}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            marginTop: 8, lineHeight: 1.4,
          }}>
            {myRole
              ? t("trade.revealedToParticipants")
              : t("trade.handleHidden")}
          </div>
        </div>
      )}

          </div>
        </div>
      </div>
      {/* Event chain */}
      <details className="td-timeline" style={{
        flex: "0 0 auto",
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: T.r,
        padding: "10px 14px",
        marginTop: 6,
      }}>
        {/* Anchored bottom — the demoted technical log behind a visible anchor
            row with a rotating chevron (CSS: .td-timeline[open] .td-tl-chev). */}
        <summary style={{
          listStyle: "none", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span aria-hidden="true" style={{
            width: 25, height: 25, borderRadius: 7, flex: "0 0 auto",
            background: T.surface, border: `1px solid ${T.border}`,
            display: "grid", placeItems: "center", fontSize: 12,
          }}>⚙</span>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: T.muted }}>
            {t("trade.tradeTimeline")}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, opacity: 0.7 }}>
            · {state.eventChain.length !== 1 ? t("trade.stepCountMany", { count: state.eventChain.length }) : t("trade.stepCountOne", { count: state.eventChain.length })} · {t("trade.msgCount", { count: state.chatMessages.length })}
          </span>
          <span className="td-tl-chev" aria-hidden="true" style={{
            marginLeft: "auto", width: 25, height: 25, borderRadius: 999, flex: "0 0 auto",
            border: `1.5px solid ${T.borderHi}`, color: T.muted,
            display: "grid", placeItems: "center", fontSize: 12,
            transition: "transform .22s, border-color .22s, color .22s",
          }}>›</span>
        </summary>
        <div style={{ marginTop: 12 }}>
          {state.eventChain.map((evt) => (
            <div key={evt.raw.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.green }} />
              <span style={{ fontSize: 11, fontFamily: T.sans, color: T.muted }}>
                {({
                  "escrow:create": t("trade.evtCreate"),
                  "escrow:join": t("trade.evtJoin"),
                  "escrow:lock": t("trade.evtLock"),
                  "escrow:vote": t("trade.evtVote"),
                  "escrow:resolve": t("trade.evtResolve"),
                  "escrow:claim": t("trade.evtClaim"),
                  "escrow:cancel": t("trade.evtCancel"),
                } as Record<string, string>)[evt.payload.type]
                  ?? evt.payload.type.replace("escrow:", "").replace(/_/g, " ")}
              </span>
              <span style={{ fontSize: 9, fontFamily: T.mono, color: T.border, marginLeft: "auto" }}>
                {evt.raw.id.slice(0, 8)}…
              </span>
            </div>
          ))}
        </div>
        {onRebroadcast && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
            <button
              type="button"
              disabled={rebroadcasting}
              onClick={async () => {
                setRebroadcasting(true);
                setRebroadcastResult(null);
                setRebroadcastDone(false);
                try {
                  const { published, total } = await onRebroadcast(state.id);
                  if (total === 0) {
                    setRebroadcastResult(t("trade.nothingToRebroadcast"));
                  } else {
                    // Show the ID-to-share whenever we have a chain. Relays may
                    // not re-ACK events they already store (published can be 0
                    // even though they're available) — the ID hand-off is what
                    // actually heals it, so never hide that on the ACK count.
                    setRebroadcastResult(
                      published > 0
                        ? t("trade.republished", { published, total })
                        : t("trade.sentEventsShareId", { total }),
                    );
                    setRebroadcastDone(true);
                  }
                } catch (e) {
                  setRebroadcastResult(`Re-broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setRebroadcasting(false);
                }
              }}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                borderRadius: T.r,
                color: T.muted,
                cursor: rebroadcasting ? "default" : "pointer",
                fontFamily: T.mono,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.5,
                opacity: rebroadcasting ? 0.6 : 1,
                padding: "8px 12px",
                width: "100%",
              }}
            >
              {rebroadcasting ? t("trade.resending") : t("trade.resendHeal")}
            </button>
            <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, margin: "8px 2px 0" }}>
              {rebroadcastResult
                ?? t("trade.resendNote")}
            </p>
            {rebroadcastDone && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: T.card, border: `1px solid ${T.accent}`, borderRadius: T.r }}>
                <div style={{ color: T.text, fontSize: 10, fontWeight: 700, fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 6 }}>
                  {t("trade.sendTradeIdNext")}
                </div>
                <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginBottom: 8 }}>
                  {t("trade.sendTradeIdBody")}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ flex: 1, color: T.text, fontSize: 10, fontFamily: T.mono, wordBreak: "break-all", background: T.border, padding: "6px 8px", borderRadius: 6, userSelect: "all", WebkitUserSelect: "all" }}>
                    {state.id}
                  </code>
                  <CopyButton
                    value={state.id}
                    label={t("trade.copyUpper")}
                    copiedLabel={t("trade.copiedUpper")}
                    style={{
                      background: T.accent, border: "none", borderRadius: 6, color: "#fff",
                      cursor: "pointer", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      padding: "7px 10px", whiteSpace: "nowrap",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
        {onForget && (
          <div style={{ marginTop: 12 }}>
            {tradeHoldsUnresolvedSats(state) ? (
              // 3.5.1 #7(a): never let a trade that still holds sats be hidden
              // — that's the "cold vanish" burial. Resolved trades still live
              // in Me → Done, so history is preserved either way.
              <div style={{
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
                color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5,
                padding: "8px 10px",
              }}>
                {t("trade.satsStillInEscrow")}
              </div>
            ) : !forgetArmed ? (
              <button
                type="button"
                onClick={() => setForgetArmed(true)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: T.red,
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  padding: "6px 2px",
                  textDecoration: "underline",
                }}
              >
                {t("trade.forgetTradeLocally")}
              </button>
            ) : (
              <div style={{ background: T.card, border: `1px solid ${T.red}`, borderRadius: T.r, padding: "10px 12px" }}>
                <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginBottom: 8 }}>
                  {t("trade.forgetConfirmBody")}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => { setForgetArmed(false); onForget(state.id); }}
                    style={{
                      background: T.red, border: "none", borderRadius: 6, color: "#fff",
                      cursor: "pointer", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      letterSpacing: 0.5, padding: "7px 12px",
                    }}
                  >
                    {t("trade.forgetIt")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForgetArmed(false)}
                    style={{
                      background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6,
                      color: T.muted, cursor: "pointer", fontFamily: T.mono, fontSize: 10,
                      fontWeight: 700, letterSpacing: 0.5, padding: "7px 12px",
                    }}
                  >
                    {t("trade.cancelUpper")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </details>
    </div>
  );
}

// The arbiter's commitment, shown by default (5.7).
//
// The person who can decide where your money goes was the least-described
// party on this screen: ratings only, and only if you thought to tap. This
// states the two things that are chain-provable — how much is locked, and for
// how long it has stood — plus the outpoint, so "verify it yourself" is an
// actual invitation rather than a figure of speech.
//
// DESCRIPTIVE ONLY. The tint deepens with tenure and never turns green: green
// reads as "approved by Chama", and Chama does not vouch for people. Time is
// the one claim nobody can fake — sats can be borrowed for an afternoon.
// A1b (5.8) adds three things to it, all descriptive, none a verdict:
//   · tenure now counts PROVEN renewals, so a long commitment stops reading as
//     six days every time the arbiter rolls their bond over;
//   · a partial-lineage line, because "3 of 5 renewals verified" is information
//     and a silent 3 is not;
//   · cohort context and ruling concentration — two numbers, no conclusions.
function ArbiterCommitmentCard({ bond, tipHeight, cohortPeers, concentration }: {
  bond: VerifiedBond | null;
  tipHeight: number | null;
  cohortPeers: number | null;
  concentration: RulingConcentration | null;
}) {
  const { t } = useT();
  if (!bond || !bond.funded) return null;

  // ⭐ The 5.8 fix: measure from the PROVEN lineage root, not this UTXO. A bond
  // with no proven ancestry falls back to its own funding height, so this is
  // never longer than what the chain backs — only, at last, not shorter.
  const blocks = verifiedBondTenureBlocks(bond, tipHeight);
  const days = tenureDays(blocks, BOND_BLOCKS_PER_DAY);
  const tier = tenureTier(blocks, BOND_BLOCKS_PER_DAY);
  const proven = bond.lineageProven;
  const renewalsShown = proven && proven.provenHops > 0;
  const renewalsPartial = !!proven && proven.claimedHops > proven.provenHops;
  // Subtle, like Browse's stranger cue — noticed, never shouted.
  const tint = tier === "year" ? 0.16 : tier === "half-year" ? 0.11 : tier === "month" ? 0.07 : 0.03;

  return (
    <div style={{
      padding: "10px 12px", marginBottom: 12, borderRadius: T.rs,
      background: `${T.accent}${Math.round(tint * 255).toString(16).padStart(2, "0")}`,
      border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 11,
      color: T.text, lineHeight: 1.6,
    }}>
      <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1, marginBottom: 4 }}>
        {t("trade.arbiterCommitment")}
      </div>
      <div>
        <BitcoinAmount sats={Number(bond.actualSats)} size={12} gap={3} glyphScale={1.1} />
        {days !== null && <span style={{ color: T.muted }}> · {t("trade.bondedForDays", { count: days })}</span>}
      </div>
      {/* Renewals are stated as a COUNT, never as a virtue. "Kept going through
          4 renewals" is a fact about time; "trusted arbiter" would be Chama
          vouching for a person, which it does not do. */}
      {renewalsShown && (
        <div style={{ color: T.muted, fontSize: 9.5 }}>
          {t("trade.bondRenewals", { count: proven!.provenHops })}
          {renewalsPartial && (
            <span style={{ color: T.amber }}>
              {" · "}{t("trade.bondRenewalsPartial", { proven: proven!.provenHops, claimed: proven!.claimedHops })}
            </span>
          )}
        </div>
      )}
      {/* Cohort: a number, and nothing else. Several bonds appearing in one week
          is what a Sybil looks like AND what a good recruitment drive looks
          like. The people in the community can tell those apart; an algorithm
          cannot, so it does not try. */}
      {typeof cohortPeers === "number" && cohortPeers > 0 && (
        <div style={{ color: T.muted, fontSize: 9.5 }}>
          {t("trade.bondCohort", { count: cohortPeers })}
        </div>
      )}
      {/* Ruling concentration — the instrument that can actually see
          arbiter-favours-the-same-winner, which testimony structurally cannot
          (the winner never signs against their own benefit). Shown only past
          CONCENTRATION_MIN_RULINGS, because "1 of 1" manufactures suspicion out
          of a first dispute. The denominator is always present: "3 of 3" and
          "3 of 40" are different worlds and the reader gets to see which. */}
      {concentration && concentrationWorthShowing(concentration) && (
        <div style={{ color: T.muted, fontSize: 9.5 }}>
          {t("trade.arbiterRulings", {
            top: concentration.byBeneficiary[0].count,
            total: concentration.rulings,
          })}
        </div>
      )}
      {bond.fundingTxid && (
        <a
          href={`https://mempool.space/tx/${bond.fundingTxid}`}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: T.muted, fontSize: 9.5, textDecoration: "underline", opacity: 0.8 }}
        >
          {t("trade.verifyOnChain")} ↗
        </a>
      )}
    </div>
  );
}

// ⚠ Honest custody — what LOCKED does and doesn't mean.
//
// A lock is 2-of-3 against the arbiter and against the counterparty, and it is
// NOT against the funder: they minted the bearer notes and can reissue them
// (escrow-engine/lock-custody.ts has the full reasoning). Nothing detects a
// drained escrow — `verifyClaim` is dead code — so the loss surfaces only when
// the winner's claim fails, after the goods shipped or the fiat was sent.
//
// Shown ONLY to the exposed party: the non-locker, who performs the
// irreversible off-platform leg. The funder holds the capability and is not at
// risk from it, and telling them would be noise that trains everyone to ignore
// the banner. Unfolded, because the person carrying the risk should not have to
// open an accordion to learn they are carrying it.
//
// DELETE THIS COMPONENT when the escrow is held somewhere no single party can
// reach — not before, and not because it makes the screen look less safe.
function LockCustodyNotice({ state, myRole }: { state: EscrowState; myRole: Role | null }) {
  const { t } = useT();
  if (!viewerIsExposedByLock(state, myRole)) return null;
  const lockerRole = lockerRoleOf(state);
  const funder = lockerRole === Role.BUYER ? t("trade.lockFunderTheBuyer")
    : lockerRole === Role.SELLER ? t("trade.lockFunderTheSeller")
    : t("trade.lockFunderTheOther");
  return (
    <div style={{
      padding: "11px 13px", marginBottom: 12, borderRadius: T.rs,
      background: `${T.amber}12`, border: `1px solid ${T.amber}44`,
      fontFamily: T.sans, color: T.amber, lineHeight: 1.55,
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>
        <span aria-hidden="true">⚠</span> {t("trade.lockNotCustodyTitle")}
      </div>
      <div style={{ fontSize: 12, opacity: 0.95 }}>
        {t("trade.lockNotCustodyBody", { funder })}
      </div>
    </div>
  );
}

// Accountability #1 — say out loud that a backup stepped in.
//
// Substitution has always worked silently: the assigned arbiter never answers,
// the grace window opens, a backup rules, the trade settles. Nobody is told.
// That silence is what made "an arbiter can influence a trade and walk away"
// feel unanswerable — the rescue was invisible, so only the failure was.
//
// Purely derived from the committed chain (see isArbiterNoShow), so it needs no
// event, no reducer change, and every client shows it identically.
function ArbiterSubstitutionNotice({ state }: { state: EscrowState }) {
  const { t } = useT();
  const nowSec = Math.floor(Date.now() / 1000);
  if (!isArbiterNoShow(state, nowSec)) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "9px 12px",
      marginBottom: 12, background: `${T.amber}12`,
      border: `1px solid ${T.amber}44`, borderRadius: T.rs,
      fontFamily: T.mono, fontSize: 11, color: T.amber, lineHeight: 1.5,
    }}>
      <span>↻</span>
      <span>{t("trade.arbiterSubstituted")}</span>
    </div>
  );
}

// v2.3 — arbiter provenance ("close the arbiter door"). The trade's
// communityArbiters ride in on CREATE, set by the creator's own client, and
// the reducer only checks the LOCK arbiter is a member of THAT pool — never
// that the pool itself is the community's real one. A stuffed pool lets a
// party seat sock-puppet arbiters and rig disputes. This banner is the
// informed-consent surface: a quiet green tick when every named arbiter is one
// THIS device recognizes for the community, an amber warning the instant the
// pool contains keys it doesn't. Soft by design (Pillar 2.7) — the locker's
// Fund moment carries the louder version of the same check.
// v3.5 (C1+C7): the banner grew two louder states on top of membership —
// OFF-ASSIGNMENT (the seated arbiter matches no historical deterministic
// assignment for this escrow id; someone hand-picked it) and SELF-ROSTERED
// (the pool is recognized only via a kind:38120 roster signed by a party to
// this very trade). Both stay informed-consent, never a reducer reject; the
// Arbiter insurance (task #53 E1): the 0.25%-per-side premium line. Shows
// from LOCKED onward for a principal on a trade with a BONDED seated
// arbiter: a prechecked include-toggle pre-settlement (one uncheck to
// decline — the durable preference the pay sweep respects), a calm
// "insurance sent" line once the outbox records paid. Disclosed at lock
// time, never a settle-time surprise.
function ArbiterInsuranceRow({ state, pubkey }: { state: EscrowState; pubkey: string }) {
  const { t } = useT();
  const [, forceRefresh] = useState(0);
  const decision = computeArbiterPremium(state, pubkey);
  if (!decision.payable) return null;
  const showFrom = new Set<EscrowStatus>([
    EscrowStatus.LOCKED, EscrowStatus.APPROVED, EscrowStatus.CLAIMED, EscrowStatus.COMPLETED,
  ]);
  if (!showFrom.has(state.status)) return null;

  const record = getPremiumOutboxRecord(state.id);
  if (record?.status === "paid") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", marginBottom: 12, background: `${T.green}12`, border: `1px solid ${T.green}44`, borderRadius: T.rs, fontFamily: T.mono, fontSize: 11, color: T.green }}>
        <span>🛡</span>
        <span>{t("trade.insuranceSent")}</span>
      </div>
    );
  }
  if (record?.status === "sending") return null;

  const included = record?.status !== "declined";
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", marginBottom: 12, background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rs, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={included}
        onChange={(e) => {
          setPremiumDeclined(state.id, !e.target.checked);
          forceRefresh((x) => x + 1);
        }}
        style={{ accentColor: T.accent, width: 15, height: 15, flexShrink: 0 }}
      />
      <span style={{ fontFamily: T.mono, fontSize: 11, color: included ? T.text : T.muted, lineHeight: 1.45, display: "flex", alignItems: "baseline", gap: 5, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800 }}>🛡 {t("trade.insuranceLabel")}</span>
        <BitcoinAmount sats={decision.amountSats} size={11} gap={3} glyphScale={1.15} color="inherit" glyphColor="inherit" />
        <span style={{ color: T.muted }}>{t("trade.insuranceSuffix")}</span>
      </span>
    </label>
  );
}

// performer's vote gate carries the matching two-tap acknowledge.
function ArbiterProvenanceBanner({ state, prov, assignment, selfRostered }: {
  state: EscrowState;
  prov: ArbiterProvenance;
  assignment: ArbiterAssignment;
  selfRostered: boolean;
}) {
  const { t } = useT();
  const pool = state.communityArbiters ?? [];
  if (pool.length === 0) return null;
  const communityName = state.community
    ? getCommunityBySlug(state.community)?.displayName ?? t("trade.thisCommunity")
    : t("trade.thisCommunity");

  const blocks: React.ReactNode[] = [];

  if (assignment.status === "off-assignment") {
    const seated = state.participants[Role.ARBITER];
    blocks.push(
      <div key="off-assignment" style={{
        padding: "9px 11px", borderRadius: T.rs,
        background: T.redDim, border: `1px solid ${T.red}55`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: T.red }}>⚠</span>
          <span style={{ fontSize: 10, color: T.red, fontFamily: T.mono, fontWeight: 800, letterSpacing: 0.5 }}>
            {t("trade.offAssignmentTitle")}
          </span>
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5 }}>
          {t("trade.offAssignBody1", { seated: seated ? ` (${shortParticipantPubkey(seated)})` : "" })}
          {assignment.accepted.length > 0 && (
            <> {t("trade.offAssignExpected", { list: assignment.accepted.map(shortParticipantPubkey).join(" or ") })}</>
          )}{t("trade.offAssignBody2")}
        </div>
      </div>
    );
  }

  if (selfRostered) {
    blocks.push(
      <div key="self-rostered" style={{
        padding: "9px 11px", borderRadius: T.rs,
        background: T.amberDim, border: `1px solid ${T.amber}55`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: T.amber }}>⚠</span>
          <span style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, fontWeight: 800, letterSpacing: 0.5 }}>
            {t("trade.selfRosteredTitle")}
          </span>
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5 }}>
          {t("trade.selfRosteredBody")}
        </div>
      </div>
    );
  }

  if (!prov.verified) {
    // Has unrecognized members — the sock-puppet signal.
    blocks.push(
      <div key="unrecognized" style={{
        padding: "9px 11px", borderRadius: T.rs,
        background: T.amberDim, border: `1px solid ${T.amber}55`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: T.amber }}>⚠</span>
          <span style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, fontWeight: 800, letterSpacing: 0.5 }}>
            {prov.unrecognized.length !== 1 ? t("trade.unrecognizedMany") : t("trade.unrecognizedOne")}
          </span>
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5 }}>
          {t(
            pool.length === 1
              ? "trade.unrecognizedBodyOneOfOne"
              : prov.unrecognized.length === 1
                ? "trade.unrecognizedBodyOneOfMany"
                : "trade.unrecognizedBodyMany",
            { count: prov.unrecognized.length, total: pool.length, community: communityName },
          )}
          {prov.unrecognized.length > 0 && (
            <> {t("trade.unrecognizedList", { list: prov.unrecognized.map(shortParticipantPubkey).join(", ") })}</>
          )}{t("trade.unrecognizedAdvice")}
        </div>
      </div>
    );
  } else if (!selfRostered && blocks.length === 0) {
    // The genuine green — refused outright when the verification depends on a
    // conflicted roster (C7) or the seated arbiter is off-assignment (C1).
    blocks.push(
      <div key="verified" style={{
        padding: "7px 10px", borderRadius: T.rs,
        background: T.greenDim, border: `1px solid ${T.green}33`,
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ fontSize: 11, color: T.green }}>✓</span>
        <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.4 }}>
          {t("trade.verifiedArbiters", { community: communityName })}
          {pool.length < 3 && (
            <> {pool.length === 1 ? t("trade.smallPoolOne") : t("trade.smallPoolMany", { count: pool.length })}</>
          )}
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, marginBottom: 16, display: "grid", gap: 8 }}>
      {blocks}
    </div>
  );
}

// TradeView pager pane styling — each pane owns the full phone width, snaps,
// and scrolls its own overflow vertically.
const TD_PANE_STYLE: React.CSSProperties = {
  // v4.1 #19 hard-snap: `scroll-snap-stop: always` makes a swipe land on exactly ONE
  // pane — a fast fling can't skip Chat↔Parties straight past Details. Programmatic
  // multi-pane jumps (goPane) sidestep this by scrolling instantly (see goPane).
  flex: "0 0 100%", scrollSnapAlign: "start", scrollSnapStop: "always",
  overflowY: "auto", overflowX: "hidden", minWidth: 0,
  padding: "2px 3px 12px",
};
const TD_PANE_PLACEHOLDER: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "100%", textAlign: "center", color: T.muted,
  fontFamily: T.mono, fontSize: 12, lineHeight: 1.6, padding: "0 26px",
};

type DetailNextStepTone = "accent" | "green" | "red" | "purple" | "teal";

function detailNextStep({
  t,
  state,
  myRole,
  canILock,
  hasMenu,
  menuSelectorRole,
  savedOrderFinalized,
  savedOrderAmountMsats,
  lockAmountMsats,
  menuSelectionMissing,
  menuOrderNotFinal,
  participantsBuyer,
  votePromptKind,
  votePromptOutcomes,
  votePromptRole,
  iAmWinner,
  claimRetryBlocked,
  canJoinTrade,
}: {
  t: TFunc;
  state: EscrowState;
  myRole: Role | null;
  canILock: boolean;
  hasMenu: boolean;
  menuSelectorRole: Role;
  savedOrderFinalized: boolean;
  savedOrderAmountMsats: number;
  lockAmountMsats: number;
  menuSelectionMissing: boolean;
  menuOrderNotFinal: boolean;
  participantsBuyer?: string;
  votePromptKind: "waiting" | "buttons" | "none";
  /** v3.2: the offered outcomes when buttons are live — REFUND-only means the
   *  heal path (expired-unresolved), and the matrix must say so instead of
   *  promising a Release that isn't on offer. */
  votePromptOutcomes?: Outcome[];
  /** v3.2: who the buttons belong to. A pool-backup arbiter ruling a dispute
   *  has votePromptRole === ARBITER while myRole is null — the matrix must
   *  treat them as the arbiter, not a visitor. */
  votePromptRole?: Role | null;
  iAmWinner: boolean;
  claimRetryBlocked: boolean;
  canJoinTrade: boolean;
}): {
  kicker: string;
  title: string;
  body: string;
  tone: DetailNextStepTone;
  color: string;
  amountMsats: number | null;
} {
  // v3.2 prototype matrix: role × state cells. Everything below derives from
  // state + myRole — dispute = both outcomes on record, unresolved.
  const voteValues = Object.values(state.votes);
  const matrixReleaseVotes = voteValues.filter(v => v === Outcome.RELEASE).length;
  const matrixRefundVotes = voteValues.filter(v => v === Outcome.REFUND).length;
  const isDisputed = matrixReleaseVotes > 0 && matrixRefundVotes > 0 && !state.resolvedOutcome;
  const myVote = myRole ? state.votes[myRole] : undefined;
  const arbiterRuled = !!state.votes[Role.ARBITER];
  const isMarketplaceCell = state.category === "marketplace";
  // RELEASE pays the non-locker; REFUND returns to the locker. Marketplace:
  // buyer locks → release pays seller. Other verticals: seller locks → buyer.
  const releaseWinnerRole: Role = isMarketplaceCell ? Role.SELLER : Role.BUYER;
  const refundWinnerRole: Role = isMarketplaceCell ? Role.BUYER : Role.SELLER;
  const settledWinnerRole = state.resolvedOutcome === Outcome.RELEASE
    ? releaseWinnerRole
    : state.resolvedOutcome === Outcome.REFUND ? refundWinnerRole : null;

  if (state.status === EscrowStatus.CREATED) {
    if (!myRole) {
      if (!canJoinTrade) {
        if (hasMenu && participantsBuyer && !savedOrderFinalized) {
          return {
            kicker: t("trade.nsOrderPending"),
            title: t("trade.nsStillChoosing", { role: roleDisplayName(menuSelectorRole, t) }),
            body: t("trade.nsReservedSnapshot"),
            tone: "accent",
            color: T.accent,
            amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
          };
        }
        return {
          kicker: t("trade.nsWaiting"),
          title: t("trade.nsWaitingLockerFund"),
          body: t("trade.nsReservedVotePath"),
          tone: "purple",
          color: T.purple,
          amountMsats: savedOrderAmountMsats || state.amountMsats,
        };
      }
      return {
        kicker: t("trade.nsCheckout"),
        title: t("trade.nsJoinWhenReady"),
        body: t("trade.nsJoiningReserves"),
        tone: "teal",
        color: T.teal,
        amountMsats: hasMenu ? null : state.amountMsats,
      };
    }
    if (myRole === Role.ARBITER) {
      // v3.2: the arbiter is the watchful guardian from minute one — present
      // for both sides the whole way, but acts ONLY if they disagree.
      return {
        kicker: t("trade.nsStandingBy"),
        title: t("trade.nsYouAreArbiter"),
        body: t("trade.nsArbiterWatch"),
        tone: "teal",
        color: ROLE_COLOR.arbiter,
        amountMsats: state.amountMsats,
      };
    }
    // v3.2 prototype reserved@seller: the storefront owner watching an order
    // form. Without these the seller fell to "waiting for the locking side to
    // fund" while the buyer was still picking items — premature and confusing.
    if (isMarketplaceCell && myRole === Role.SELLER) {
      if (!participantsBuyer) {
        return {
          kicker: t("trade.nsStorefrontLive"),
          title: t("trade.nsWaitingBuyerOrder"),
          body: t("trade.nsListingVisibleBrowse"),
          tone: "teal",
          color: T.teal,
          amountMsats: hasMenu ? null : state.amountMsats,
        };
      }
      if (hasMenu && !savedOrderFinalized) {
        return {
          kicker: t("trade.nsOrderForming"),
          title: t("trade.nsBuyerChoosing"),
          body: t("trade.nsNothingYetDeliver"),
          tone: "teal",
          color: T.teal,
          amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
        };
      }
    }
    if (hasMenu && myRole === menuSelectorRole && !savedOrderFinalized) {
      return {
        kicker: t("trade.nsYourOrder"),
        title: savedOrderAmountMsats > 0
          ? t("trade.nsReviewCart")
          // v3.2 review fix: only a selector who ALSO locks is told to lock —
          // in p2p/bill-pay the selector builds the order and the OTHER side funds.
          : canILock ? t("trade.nsBuildCartLock") : t("trade.nsBuildOrderReady"),
        body: canILock
          ? t("trade.nsPickItemsFund")
          : t("trade.nsPickItemsOther"),
        tone: "accent",
        color: T.accent,
        amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
      };
    }
    if (canILock) {
      if (!participantsBuyer) {
        return {
          kicker: t("trade.nsWaiting"),
          title: t("trade.nsWaitingBuyerEnter"),
          body: t("trade.nsListingStaysVisible"),
          tone: "teal",
          color: T.teal,
          amountMsats: null,
        };
      }
      if (menuSelectionMissing || menuOrderNotFinal) {
        return {
          kicker: t("trade.nsOrderPending"),
          title: t("trade.nsStillChoosing", { role: roleDisplayName(menuSelectorRole, t) }),
          body: t("trade.nsDontFundEarly"),
          tone: "accent",
          color: T.accent,
          amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
        };
      }
      // ⚠ Tier 2.1: an ON-CHAIN trade is not funded from the Chama balance.
      // Offering the Lightning/NWC "Fund it" affordance here would send the
      // funder down the ecash path for a trade whose LOCK the reducer will
      // refuse — and the bridge would have spent their sats before finding out.
      // The on-chain panel above carries the address instead.
      if ((state.escrowMode ?? "ecash") === "onchain") {
        return {
          kicker: t("trade.nsReadyToFund"),
          title: t("onchain.fundOnchainTitle"),
          body: t("onchain.fundOnchainBody"),
          tone: "accent",
          color: T.accent,
          amountMsats: lockAmountMsats,
        };
      }
      return {
        kicker: t("trade.nsReadyToFund"),
        title: t("trade.nsFundIt"),
        body: t("trade.nsLockedSatsMove"),
        tone: "accent",
        color: T.accent,
        amountMsats: lockAmountMsats,
      };
    }
    return {
      kicker: t("trade.nsReserved"),
      title: t("trade.nsWaitingLockerFund"),
      body: t("trade.nsStayNearby"),
      tone: "purple",
      color: T.purple,
      amountMsats: savedOrderAmountMsats || state.amountMsats,
    };
  }

  if (state.status === EscrowStatus.LOCKED) {
    // v3.2 review fix (heal-awareness): decideVotePrompt offers REFUND-only
    // buttons to ANY seat — arbiter included, no dispute needed — when the
    // trade is past its deadline (a quiet dead trade still reads LOCKED until
    // an event lands). The matrix must describe that heal instead of denying
    // it ("nothing for you") or promising a Release that isn't on offer.
    const healOnly = votePromptKind === "buttons"
      && !!votePromptOutcomes
      && votePromptOutcomes.includes(Outcome.REFUND)
      && !votePromptOutcomes.includes(Outcome.RELEASE);
    // v3.2 review fix: a pool-backup arbiter ruling a dispute has
    // votePromptRole === ARBITER while myRole is null — treat them as the
    // arbiter, never as a visitor.
    const actsAsArbiter = myRole === Role.ARBITER || votePromptRole === Role.ARBITER;
    // v3.2 dispute cells — both outcomes on record, unresolved. The header
    // says "A call is needed"; each seat gets its own framing.
    if (isDisputed && !healOnly) {
      if (actsAsArbiter) {
        if (arbiterRuled) {
          return {
            kicker: t("trade.nsRulingSent"),
            title: t("trade.nsRulingSettling"),
            body: t("trade.nsResolveLands"),
            tone: "teal",
            color: ROLE_COLOR.arbiter,
            amountMsats: state.amountMsats,
          };
        }
        return {
          kicker: t("trade.nsYourRuling"),
          title: t("trade.nsBothVotedDisagree"),
          body: myRole === Role.ARBITER
            ? t("trade.nsWeighChat")
            : t("trade.nsAssignedAbsent"),
          tone: "teal",
          color: ROLE_COLOR.arbiter,
          amountMsats: state.amountMsats,
        };
      }
      if (myRole === Role.BUYER || myRole === Role.SELLER) {
        return {
          kicker: t("trade.nsInDispute"),
          title: myVote === Outcome.REFUND
            ? t("trade.nsAskedRefund")
            : myVote === Outcome.RELEASE
              ? t("trade.nsAskedRelease")
              : t("trade.nsSidesDisagree"),
          body: t("trade.nsAddCaseChat"),
          tone: "purple",
          color: T.amber,
          amountMsats: state.amountMsats,
        };
      }
    }
    if (healOnly) {
      return {
        kicker: t("trade.nsPastDeadline"),
        title: t("trade.nsExpiredHeal"),
        body: t("trade.nsDeadlinePassed"),
        tone: "accent",
        color: T.amber,
        amountMsats: state.amountMsats,
      };
    }
    if (myRole === Role.ARBITER && votePromptKind !== "buttons") {
      return {
        kicker: t("trade.nsLiveTrade"),
        title: t("trade.nsLockedQuiet"),
        body: t("trade.nsWatchfulThirdKey"),
        tone: "teal",
        color: ROLE_COLOR.arbiter,
        amountMsats: state.amountMsats,
      };
    }
    // v3.2 review fix: the marketplace cells render in BOTH phases (your turn
    // to act vs waiting on the other side) — the buyer's "on its way" moment
    // is mostly the waiting phase, which the old gate skipped entirely.
    if (isMarketplaceCell && myRole === Role.SELLER) {
      return {
        kicker: t("trade.nsLiveTrade"),
        title: t("trade.nsDeliverOrder"),
        body: votePromptKind === "buttons"
          ? t("trade.nsBuyerSatsLocked")
          : t("trade.nsConfirmedWaitingBuyer"),
        tone: "purple",
        color: T.purple,
        amountMsats: state.amountMsats,
      };
    }
    if (isMarketplaceCell && myRole === Role.BUYER) {
      return {
        kicker: t("trade.nsLiveTrade"),
        title: t("trade.nsOrderOnWay"),
        body: votePromptKind === "buttons"
          ? t("trade.nsReleaseWhenArrives")
          : t("trade.nsSellerGetting"),
        tone: "purple",
        color: T.purple,
        amountMsats: state.amountMsats,
      };
    }
    if (votePromptKind === "buttons") {
      return {
        kicker: t("trade.nsYourNextStep"),
        title: t("trade.nsConfirmOutcome"),
        // v3.2 review fix: no protocol jargon at the highest-stakes tap — the
        // buttons below carry the exact per-category direction labels.
        body: t("trade.nsButtonsSayWhere"),
        tone: "purple",
        color: T.purple,
        amountMsats: state.amountMsats,
      };
    }
    return {
      kicker: t("trade.nsLiveTrade"),
      title: t("trade.nsSatsLockedWaiting"),
      body: t("trade.nsUseChatProof"),
      tone: "purple",
      color: T.purple,
      amountMsats: state.amountMsats,
    };
  }

  if (state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED) {
    if (iAmWinner) {
      return {
        kicker: claimRetryBlocked ? t("trade.nsClaimBlocked") : t("trade.nsReadyToClaim"),
        // v3.2 review fix: outcome-honest — a refund winner is getting their
        // OWN sats back, not a payout.
        title: claimRetryBlocked
          ? t("trade.nsClaimNeedsRecovery")
          : state.resolvedOutcome === Outcome.REFUND
            ? t("trade.nsRefundedSatsBack")
            : t("trade.nsReleasedSatsYours"),
        body: claimRetryBlocked
          ? t("trade.nsFederationConsumed")
          : t("trade.nsChamaPulls"),
        tone: claimRetryBlocked ? "red" : "accent",
        color: claimRetryBlocked ? T.red : T.accent,
        amountMsats: state.amountMsats,
      };
    }
    // v3.2 settling cells for the non-claiming seats: name where the sats
    // went, and make "nothing left for you" explicit. Subscription trades skip
    // these (periods settle on their own schedule — the cells' claim-promise
    // and full-amount pill would both mislead) and keep the generic fallback.
    if (myRole === Role.ARBITER) {
      return {
        kicker: t("trade.nsSettled"),
        title: arbiterRuled ? t("trade.nsRulingSettling") : t("trade.nsBothAgreedSettling"),
        body: t("trade.nsOutcomeOnRecord"),
        tone: "teal",
        color: ROLE_COLOR.arbiter,
        amountMsats: state.amountMsats,
      };
    }
    if (!state.subscription && (myRole === Role.BUYER || myRole === Role.SELLER)) {
      const winnerLabel = settledWinnerRole === Role.SELLER ? t("trade.sellerNoun") : t("trade.buyerNoun");
      return {
        kicker: t("trade.nsSettling"),
        title: state.resolvedOutcome === Outcome.REFUND
          ? t("trade.nsRefundedBackTo", { party: winnerLabel })
          : t("trade.nsReleasedTo", { party: winnerLabel }),
        body: t("trade.nsNothingLeftClose"),
        tone: "purple",
        color: T.purple,
        amountMsats: state.amountMsats,
      };
    }
  }

  if (state.status === EscrowStatus.COMPLETED) {
    if (myRole === Role.SELLER) {
      return {
        kicker: t("trade.nsComplete"),
        // v3.2 review fix: "you were paid" only on a RELEASE outcome — a
        // refunded seller merely got their own locked sats back.
        title: !state.subscription && state.resolvedOutcome === Outcome.RELEASE && settledWinnerRole === Role.SELLER
          ? t("trade.nsCompletePaid")
          : state.resolvedOutcome === Outcome.REFUND && settledWinnerRole === Role.SELLER
            ? t("trade.nsCompleteSatsBack")
            : t("trade.nsCompletePlain"),
        body: t("trade.nsSellerHistoryRate"),
        tone: "green",
        color: T.green,
        amountMsats: state.amountMsats,
      };
    }
    if (myRole === Role.BUYER) {
      return {
        kicker: t("trade.nsComplete"),
        title: t("trade.nsCompletePlain"),
        body: t("trade.nsBuyerHistoryRate"),
        tone: "green",
        color: T.green,
        amountMsats: state.amountMsats,
      };
    }
    if (myRole === Role.ARBITER) {
      return {
        kicker: t("trade.nsComplete"),
        title: t("trade.nsCompletePlain"),
        body: arbiterRuled
          ? t("trade.nsRulingHelped")
          : t("trade.nsMutualAgreement"),
        tone: "green",
        color: T.green,
        amountMsats: state.amountMsats,
      };
    }
    return {
      kicker: t("trade.nsComplete"),
      title: t("trade.nsTradeSettled"),
      body: t("trade.nsHistorySavedRatings"),
      tone: "green",
      color: T.green,
      amountMsats: state.amountMsats,
    };
  }

  if (state.status === EscrowStatus.CANCELLED || state.status === EscrowStatus.EXPIRED) {
    // v2.2.0: an EXPIRED trade with locked sats is NOT a dead end — the
    // healing path (assigned arbiter or any pool backup) auto-refunds
    // the locker. During the live v2.1.0 substitution test this branch
    // said "CLOSED — no longer active" while the heal was mid-flight,
    // which read as money lost. Frame the truth instead: votes on
    // record → the refund is confirming; no votes yet but locked sats
    // → a heal is available.
    if (state.status === EscrowStatus.EXPIRED && state.lock?.notesHash) {
      const hasResolve = state.eventChain.some(
        (e: any) => e.kind === EscrowEventKind.RESOLVE,
      );
      if (!hasResolve) {
        const voteCount = state.eventChain.filter(
          (e: any) => e.kind === EscrowEventKind.VOTE,
        ).length;
        if (voteCount > 0) {
          return {
            kicker: t("trade.nsHealing"),
            title: t("trade.nsExpiredVotesRefund"),
            body: t("trade.nsLockedSatsRoute"),
            tone: "accent",
            color: T.accent,
            amountMsats: state.amountMsats,
          };
        }
        return {
          kicker: t("trade.nsExpiredHealable"),
          title: t("trade.nsExpiredUnresolved"),
          body: t("trade.nsArbiterCanHeal"),
          tone: "accent",
          color: T.accent,
          amountMsats: state.amountMsats,
        };
      }
    }
    return {
      kicker: t("trade.nsClosed"),
      title: t("trade.nsNoLongerActive"),
      body: t("trade.nsNoNewFunding"),
      tone: "red",
      color: T.red,
      amountMsats: null,
    };
  }

  return {
    kicker: t("trade.nsTradeRoom"),
    title: STATUS[state.status]?.l ?? state.status,
    body: t("trade.nsFollowControls"),
    tone: "teal",
    color: T.teal,
    amountMsats: state.amountMsats,
  };
}

function menuQtyButtonStyle(): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: 999,
    border: `1px solid ${T.border}`,
    background: T.card,
    color: T.text,
    fontFamily: T.mono,
    fontSize: 15,
    fontWeight: 900,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  };
}

function menuPickButtonStyle(selected: boolean): React.CSSProperties {
  return {
    padding: "8px 11px",
    borderRadius: 999,
    border: `1px solid ${selected ? T.green : T.border}`,
    background: selected ? `${T.green}22` : T.card,
    color: selected ? T.green : T.text,
    fontFamily: T.mono,
    fontSize: 11,
    fontWeight: 800,
    cursor: "pointer",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
}

function voteDecisionChipStyle(color: string): React.CSSProperties {
  return {
    minHeight: 44,
    minWidth: 0,
    borderRadius: 18,
    border: `1px solid ${color}38`,
    background: color === T.muted
      ? T.surface
      : `linear-gradient(180deg, ${color}1f 0%, ${color}0f 100%)`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    padding: "7px 5px",
    color,
    fontFamily: T.mono,
    textTransform: "uppercase",
    boxShadow: color === T.muted ? "none" : `inset 0 1px 0 ${color}22`,
    overflow: "hidden",
  };
}

function voteDecisionValueStyle(): React.CSSProperties {
  return {
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 16,
    fontWeight: 900,
    lineHeight: 1.05,
    letterSpacing: 0,
  };
}

function voteDecisionLabelStyle(): React.CSSProperties {
  return {
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 7,
    fontWeight: 800,
    lineHeight: 1.15,
    letterSpacing: 0.45,
    opacity: 0.86,
  };
}

function voteActionButtonStyle({
  disabled,
  background,
  border,
  color,
}: {
  disabled: boolean;
  background: string;
  border: string;
  color: string;
}): React.CSSProperties {
  // Readable-first money buttons (the "EASY" theme): big, bold, centered, and
  // rounded — DM Sans, NOT mono. These carry the highest-stakes taps (release /
  // refund / mark-done), so anyone, including low-vision users, should read them
  // at a glance. The label/icon styles below match (16.5px / 800, inline glyph).
  return {
    width: "100%",
    minWidth: 0,
    minHeight: 62,
    padding: "16px 18px",
    borderRadius: 16,
    background: disabled ? T.surface : background,
    border: `1.5px solid ${border}`,
    color,
    fontFamily: T.sans,
    cursor: disabled ? "default" : "pointer",
    transition: "transform 0.15s, border-color 0.2s, background 0.2s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 11,
    boxShadow: disabled ? "none" : `inset 0 1px 0 ${color}24`,
    overflow: "hidden",
    textAlign: "center",
  };
}

// Icon lives INSIDE the centered label (not as a separate flex item to its
// left) — a left icon offset the wrapping confirm text and made it read
// off-center. As the first inline glyph it wraps with the text as one centered
// block.
const voteInlineIconStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  marginRight: 7,
  color: "inherit",
};

// Armed (second-tap) confirm content: a small uppercase "tap again" eyebrow
// over a short action line, stacked + centered. Focused and never spilling —
// the wordy full sentence stays on the aria-label.
const voteConfirmStackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  minWidth: 0,
  width: "100%",
  textAlign: "center",
};
const voteConfirmEyebrowStyle: React.CSSProperties = {
  fontFamily: T.sans,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  opacity: 0.9,
  lineHeight: 1.1,
};
const voteConfirmActionStyle: React.CSSProperties = {
  fontFamily: T.sans,
  fontSize: 16.5,
  fontWeight: 800,
  lineHeight: 1.2,
  letterSpacing: 0.2,
  overflowWrap: "anywhere",
};

function voteActionLabelStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minWidth: 0,
    color: "inherit",
    fontFamily: T.sans,
    fontSize: 16.5,
    fontWeight: 800,
    lineHeight: 1.25,
    letterSpacing: 0.2,
    textAlign: "center",
    overflowWrap: "anywhere",
  };
}

const voteActionTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  fontSize: 16.5,
  fontWeight: 850,
  lineHeight: 1.15,
};

const voteActionDetailStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 650,
  lineHeight: 1.25,
  opacity: 0.86,
};

function splitVoteActionLabel(
  outcome: "Release" | "Refund",
  label: string,
): { title: string; detail: string | null } {
  const clean = label.trim();
  const prefix = clean.slice(0, outcome.length);
  if (prefix.toLowerCase() !== outcome.toLowerCase()) {
    return { title: outcome, detail: clean || null };
  }
  const rawRest = clean.slice(outcome.length).trim();
  const pointsToRecipient = rawRest.startsWith("→");
  const detail = rawRest.replace(/^[·—–:\-→]+\s*/, "").trim();
  return {
    title: outcome,
    detail: detail ? `${pointsToRecipient ? "To " : ""}${detail}` : null,
  };
}

function voteOutcomeLabel(outcome: "Release" | "Refund", label: string): string {
  return label.toLowerCase().includes(outcome.toLowerCase())
    ? label
    : `${outcome} · ${label}`;
}

function menuPickLabel(category: string, t: TFunc): string {
  if (category === "bill-pay") return t("trade.pickBill");
  if (category === "lending") return t("trade.pickLoan");
  return t("trade.pick");
}

// i18n: `t` is optional so the many call sites that only need the English noun
// (or apply their own .toUpperCase()/.toLowerCase() before their surrounding
// copy is extracted) keep compiling; pass t to translate. Un-t'd callers are
// tracked as remaining extraction work.
function roleDisplayName(role: Role, t?: TFunc): string {
  const key = role === Role.BUYER ? "trade.roleBuyer"
    : role === Role.SELLER ? "trade.roleSeller"
    : "trade.roleArbiter";
  if (t) return t(key);
  if (role === Role.BUYER) return "Buyer";
  if (role === Role.SELLER) return "Seller";
  return "Arbiter";
}

/** Category-aware party noun for routing/copy. Bill Pay reads in its own
 *  terms — the buyer is the VOLUNTEER, the seller is the BILL OWNER — so the
 *  refund-routing line agrees with the vote labels instead of leaking the
 *  generic "seller" (3.5.1 #1). Lending reads borrower/lender; everything
 *  else falls back to buyer/seller. */
/** 3.5.1 #7(a): does this trade still hold sats the user could lose track of?
 *  Mirrors the recovery-banner's "committed/unresolved" notion but per-trade:
 *  any non-terminal money state (locked/approved/claimed/expired-not-claimed),
 *  plus an in-flight redeem stash or a submitted-but-unconfirmed payout for
 *  this escrow. Only terminally-resolved trades (completed+claimed, refunded-
 *  claimed, or cancelled pre-lock) return false and may be hidden. */
function tradeHoldsUnresolvedSats(state: EscrowState): boolean {
  const s = state.status;
  if (
    s === EscrowStatus.LOCKED ||
    s === EscrowStatus.APPROVED ||
    s === EscrowStatus.CLAIMED ||
    s === EscrowStatus.EXPIRED
  ) {
    return true;
  }
  // A terminal chain status can still sit on in-flight sats: a pending redeem
  // stash, or a payout we submitted but haven't confirmed (the #2 journal).
  try {
    if (listPendingRedemptions().some((e) => e.escrowId === state.id)) return true;
    if (getPayoutRecord(state.id)?.status === "submitted") return true;
  } catch {
    // best-effort — storage unavailable shouldn't unblock a risky hide
  }
  return false;
}

/** 3.5.1 #7: category-aware "did you already do your part?" prompt for the
 *  back-out guard, steering a deed-doer who already performed off the refund
 *  hatch and onto the RELEASE vote (which the arbiter can still settle). */
function deedDonePrompt(category: string | undefined, t: TFunc): string {
  if (category === "bill-pay") return t("trade.deedPaidBill");
  if (category === "p2p-trade") return t("trade.deedSentFiat");
  if (category === "marketplace") return t("trade.deedDelivered");
  if (category === "lending") return t("trade.deedDisbursed");
  return t("trade.deedDefault");
}

function partyNoun(category: string | undefined, role: Role, t: TFunc): string {
  if (category === "bill-pay") {
    if (role === Role.BUYER) return t("trade.volunteer");
    if (role === Role.SELLER) return t("trade.billOwner");
  }
  if (category === "lending") {
    if (role === Role.BUYER) return t("trade.borrower");
    if (role === Role.SELLER) return t("trade.lender");
  }
  return roleDisplayName(role, t).toLowerCase();
}

function parsePositiveWholeSats(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function detailHeroFiatAmount({
  state,
  selectedMenuItems,
  savedOrderItems,
  menuItems,
}: {
  state: EscrowState;
  selectedMenuItems: SelectedMenuItem[];
  savedOrderItems: SelectedMenuItem[];
  menuItems: NonNullable<EscrowState["items"]>;
}): { amount: number; currency: string } | null {
  const lockedRows = state.lock.selectedItems ?? [];
  const activeRows = lockedRows.length > 0
    ? lockedRows
    : selectedMenuItems.length > 0
      ? selectedMenuItems
      : savedOrderItems;
  const rowTotal = sumFiatRows(activeRows);
  if (rowTotal) return rowTotal;
  if (state.fiatAmount != null && state.fiatCurrency) {
    return { amount: state.fiatAmount, currency: state.fiatCurrency };
  }
  return fiatFloorRows(menuItems);
}

function detailEstimatedHeroFiatAmount({
  state,
  amountMsats,
  quoteCurrency,
  usdPerBtc,
  usdFiatRates,
}: {
  state: EscrowState;
  amountMsats: number;
  quoteCurrency: string | null | undefined;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): { amount: number; currency: string } | null {
  const currency = resolveEstimatedFiatCurrency({
    viewerCurrency: quoteCurrency,
    listingCurrency: normalizeFiatCurrency(state.fiatCurrency)
      ?? normalizeFiatCurrency(state.community ? getCommunityBySlug(state.community)?.currency : null),
  });
  if (!currency) return null;
  const amount = estimateFiatForMsats({
    amountMsats,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : { amount, currency };
}

function detailPremiumCheckoutLine(
  state: EscrowState,
  heroFiat: { amount: number; currency: string } | null,
  t: TFunc,
): string | null {
  if (state.category !== "p2p-trade" && state.category !== "bill-pay") return null;
  if (state.premiumBps === undefined || !heroFiat || heroFiat.amount <= 0) return null;
  if (state.category === "bill-pay") {
    return t("trade.premiumBillPayLine", { fiat: formatFiatAmount(heroFiat.amount, heroFiat.currency) });
  }
  const checkoutFiat = heroFiat.amount * (1 + state.premiumBps / 10_000);
  if (!Number.isFinite(checkoutFiat) || checkoutFiat < 0) return null;
  return t("trade.premiumCheckoutLine", {
    base: formatFiatAmount(heroFiat.amount, heroFiat.currency),
    checkout: formatFiatAmount(checkoutFiat, heroFiat.currency),
  });
}

function sumFiatRows(rows: readonly { fiatAmount?: number; fiatCurrency?: string; quantity?: number }[]): { amount: number; currency: string } | null {
  const priced = rows.filter((row) => row.fiatAmount !== undefined && row.fiatCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((row) => row.fiatCurrency));
  if (currencies.size !== 1) return null;
  const currency = priced[0]?.fiatCurrency;
  const amount = priced.reduce((sum, row) => sum + (row.fiatAmount ?? 0) * Math.max(1, row.quantity ?? 1), 0);
  return currency && Number.isFinite(amount) && amount > 0 ? { amount, currency } : null;
}

function fiatFloorRows(rows: readonly { fiatAmount?: number; fiatCurrency?: string }[]): { amount: number; currency: string } | null {
  const priced = rows.filter((row) => row.fiatAmount !== undefined && row.fiatCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((row) => row.fiatCurrency));
  if (currencies.size !== 1) return null;
  const currency = priced[0]?.fiatCurrency;
  const amount = Math.min(...priced.map((row) => row.fiatAmount ?? Number.POSITIVE_INFINITY));
  return currency && Number.isFinite(amount) ? { amount, currency } : null;
}

function satsInputValue(amountMsats: number): string {
  return String(Math.floor(amountMsats / 1000));
}

function menuAmountLabel(item: { amountMsats: number; minAmountMsats?: number; maxAmountMsats?: number }) {
  if (item.minAmountMsats !== undefined && item.maxAmountMsats !== undefined) {
    const min = fmtSats(item.minAmountMsats);
    const max = fmtSats(item.maxAmountMsats);
    return (
      <BitcoinAmount
        label={min === max ? min : `${min}-${max}`}
        size={10}
        gap={3}
        glyphScale={1.2}
        color={T.muted}
        glyphColor={T.muted}
      />
    );
  }
  return (
    <BitcoinAmount
      msats={item.amountMsats}
      size={10}
      gap={3}
      glyphScale={1.2}
      color={T.muted}
      glyphColor={T.muted}
    />
  );
}

function menuHeaderTitle(category: string, isListing: boolean, t: TFunc): string {
  if (!isListing) return t("trade.menuOrder");
  if (category === "p2p-trade") return t("trade.menuAmountOptions");
  if (category === "bill-pay") return t("trade.menuBillBundle");
  if (category === "lending") return t("trade.menuLoanOffers");
  if (category === "marketplace") return t("trade.menuStore");
  return t("trade.menuMenu");
}

function shortParticipantPubkey(pubkey: string): string {
  return pubkey.length > 13 ? `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}` : pubkey;
}

function menuSelectionHint(category: string, t: TFunc): string {
  if (category === "bill-pay") return t("trade.hintPickBills");
  if (category === "lending") return t("trade.hintPickLoans");
  if (category === "marketplace") return t("trade.hintBuildCart");
  return t("trade.hintChoose");
}

function menuSelectionTitle(category: string, t: TFunc): string {
  if (category === "p2p-trade") return t("trade.selectionTitleP2p");
  if (category === "bill-pay") return t("trade.selectionTitleBillPay");
  if (category === "lending") return t("trade.selectionTitleLending");
  if (category === "marketplace") return t("trade.selectionTitleMarketplace");
  return t("trade.selectionTitleDefault");
}

function menuSelectionButtonLabel(category: string, t: TFunc): string {
  if (category === "p2p-trade") return t("trade.selBtnP2p");
  if (category === "bill-pay") return t("trade.selBtnBillPay");
  if (category === "lending") return t("trade.selBtnLending");
  if (category === "marketplace") return t("trade.selBtnMarketplace");
  return t("trade.selBtnDefault");
}

function menuMetaLine(item: {
  dueAt?: number;
  termDays?: number;
  aprBps?: number;
  trustTier?: number;
  fiatAmount?: number;
  fiatCurrency?: string;
}, t: TFunc): string | null {
  const parts: string[] = [];
  if (item.fiatAmount !== undefined && item.fiatCurrency) {
    parts.push(`${item.fiatCurrency} ${item.fiatAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  if (item.dueAt) parts.push(t("trade.dueDate", { date: new Date(item.dueAt * 1000).toLocaleDateString() }));
  if (item.termDays) parts.push(t("trade.termDaysShort", { count: item.termDays }));
  if (item.aprBps) parts.push(t("trade.aprLabel", { rate: (item.aprBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) }));
  if (item.trustTier) parts.push(t("trade.tierLabel", { tier: item.trustTier }));
  return parts.length > 0 ? parts.join(" · ") : null;
}
