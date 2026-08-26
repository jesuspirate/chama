import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import { useEscrow } from "../hooks/useEscrow.js";
import {
  registerNotificationTapHandlers,
  consumePendingTradeDeepLink,
  onTradeDeepLink,
  LATEST_ACTIONABLE,
} from "../notifications/deep-link.js";
import { notifySelfTest } from "../notifications/notify-service.js";
import type { AggregateRatings, RatingThumb } from "../reputation/ratings.js";
import {
  type EscrowState,
  type SelectedMenuItem,
  EscrowStatus,
  Outcome,
  Role,
  TRULY_TERMINAL_STATES,
  getEffectiveParticipantsAt,
} from "../escrow-engine/types.js";
import { DEFAULT_RELAYS } from "../escrow-engine/default-relays.js";
import { getWinner } from "../escrow-engine/state-machine.js";
import { remainingStock, isSoldOut, overcommittedChildren, isLiveChildOrder, isActiveChildOrder } from "../escrow-engine/storefront.js";
import { unreadChatForTrade } from "../chat/unread.js";
import { archivedTradeEntries } from "../escrow-engine/trade-index.js";
import {
  isSlicedTradeShape,
  TRADE_SLICING_ENABLED,
} from "../escrow-engine/experimental-escrow-features.js";
import { compareTradeChronology, participantTradeHistory } from "./latest-trade.js";
import {
  lapsedRenewableListings,
  autoRenewableListings,
  ownUnfundedListings,
  sellerIsBonded,
  hasPendingStoreRollover,
  isSellerOwnedListing,
  listingNeverFunded,
  resolveRenewalPolicy,
} from "../escrow-engine/listing-renewal.js";
import { listCommitmentBonds } from "../bond-multisig/commitment-store.js";
import {
  retireListing,
  getRetiredIds,
  supersededListingIds,
  listingIdentityKey,
} from "../escrow-engine/listing-renewal-ledger.js";
import {
  bumpAutoRenewCount,
  getAutoRenewCount,
  isManuallyKept,
  markManuallyKept,
  shouldAgeOutListing,
  listingHasBuyerInterest,
} from "../escrow-engine/listing-renewal-age.js";
import {
  registerCbpRecurrence,
  recordCbpRepost,
  cancelCbpRecurrence,
  activeCbpRecurrence,
  dueRecurringSeries,
  supersededRecurringSeriesIds,
} from "../escrow-engine/cbp-recurrence.js";
import {
  CURATED_PRESETS,
  getActiveInvite,
  getConfiguredNativeBridgeCommunitySlug,
  getNativeBridgeUrl,
  hasFediInternalEcash,
  isNativeBridgeModeOn,
  REMOTE_BRIDGE_REVOKED_KEY,
  REMOTE_BRIDGE_REVOKED_EVENT,
  isTestnetMode,
  expectedFederationIdForInvite,
  listPendingNativeLocks,
  setActiveInvite,
  summarizeNativeLocksForUi,
} from "../fedimint/index.js";
import { getPayoutRecord } from "../payments/payout-journal.js";
import {
  computeArbiterPremium,
  funderPremiumMsats,
  selectPremiumPayTargets,
  selectPremiumRedeemTargets,
  PREMIUM_PROBE_INTERVAL_MS,
} from "../arbiters/arbiter-premium.js";
import {
  hasPremiumOutboxRecord,
  isEarningSettled,
} from "../arbiters/arbiter-earnings.js";
import {
  getCommunityBySlug,
  communityForInvite,
  DEFAULT_COMMUNITY_SLUG,
  claimGeneratedShellCreator,
} from "../communities/registry.js";
import { getUserCommunitySlugRaw } from "../communities/storage.js";
import {
  getPendingCommunityReport,
  setPendingCommunityReport,
  clearPendingCommunityReport,
} from "../communities/community-request.js";

import {
  BROWSE_CATS, T, TRINITY_RING_ORDER,
  applyThemeMode, readThemeMode, writeThemeMode, type ThemeMode,
} from "./theme.js";
import { useT, translate, getCurrentLang } from "../i18n/index.js";
import {
  decideAutoInitTarget,
  decideListingTapEffect,
  decideArbiterWarning,
  canOfferSubscription,
  shouldShowRecoveryBanner,
  MAIN_SURFACE_RECOVERY_MIN_SATS,
  hasActiveBuyerSellerCommitment,
  countActiveBuyerSellerCommitments,
  sumActiveBuyerSellerTradeMsats,
  activeCommittedMsats,
  decideChamaBarLabel,
  findActiveTrade,
  mergeOnchainPayoutAttention,
  selectNeedsYouTrades,
  shouldOpenSellerListingManagement,
  identifyStrandedEcashSource,
  isMidFunding,
  shouldShowOnBrowse,
  listingMatchesActiveRoute,
  summarizePendingPayoutsForUi,
  selectPayoutReattachTargets,
  strandedSourceExplainsBalance,
} from "./decisions.js";
import { Toast } from "./components/Toast.js";
import { BitcoinAmount } from "./components/BitcoinAmount.js";
import { VerticalIcon } from "./components/VerticalIcon.js";
import { BottomNav, BOTTOM_NAV_HEIGHT, type Tab } from "./components/BottomNav.js";
import { CoachMarkTour, readCoachSeen, type CoachStep } from "./components/CoachMarkTour.js";
import { ActiveTradePill } from "./components/ActiveTradePill.js";
import { BitcoinPricePill } from "./components/BitcoinPricePill.js";
import { RecoveryBanner } from "./screens/RecoveryBanner.js";
import { PendingLockCard } from "./components/PendingLockCard.js";
import { PendingPayoutCard } from "./components/PendingPayoutCard.js";
import { useFederationCommands } from "./hooks/useFederationCommands.js";

import { BrowseView } from "./screens/BrowseView.js";
import { GuidedHome } from "./screens/GuidedHome.js";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { GlobeCountryPicker } from "./screens/GlobeCountryPicker.js";
import { DashboardScreen } from "./screens/DashboardScreen.js";
import { TradeDetail } from "./screens/TradeDetail.js";
import { CreateForm } from "./screens/CreateForm.js";
import { MeScreen } from "./screens/MeScreen.js";
import { LapsedStoreCard } from "./components/LapsedStoreCard.js";
import { RecurringBillCard } from "./components/RecurringBillCard.js";
import { SettingsAdvanced } from "./screens/SettingsAdvanced.js";
import { HelpScreen } from "./screens/HelpScreen.js";

import { WalletBar } from "./panels/WalletBar.js";
import { ChamaBar } from "./panels/ChamaBar.js";
import { DestroyEcashConfirmModal } from "./panels/DestroyEcashConfirmModal.js";
import { FundWalletModal } from "./panels/FundWalletModal.js";
import { AtomicFundingModal } from "./panels/AtomicFundingModal.js";
import { ClaimPayoutModal } from "./panels/ClaimPayoutModal.js";
import { BondCeremonyModal } from "./panels/BondCeremonyModal.js";
import { copyTextRobust } from "./components/CopyButton.js";
import { RecoveryPayoutModal } from "./panels/RecoveryPayoutModal.js";
import { EditListingModal } from "./panels/EditListingModal.js";
import type { ListingEdits } from "../escrow-engine/listing-edit.js";
import { EcashExportModal } from "./panels/EcashExportModal.js";
import { addOrTouchPayoutDestination, listPayoutDestinations } from "../payments/payout-destinations.js";
import {
  addOrTouchSavedNwcConnection,
  listSavedNwcConnections,
} from "../payments/nwc-connections.js";
import { humanizeNwcError } from "../payments/nwc.js";
import { balanceBlocksFederationSwitch } from "../payments/lightning-fees.js";
import {
  buildChamaOperationMeta,
  getBestSatsTrace,
  listOpenSatsTraces,
  recordSatsTrace,
  type SatsTraceEntry,
} from "../payments/sats-trace.js";
import {
  clearPendingRedemptionsMatchingNotes,
  listPendingRedemptions,
  clearPendingRedemption,
  markPendingRedemptionsProbedDead,
  recordBearerProbe,
  recordConsumedUncreditedNote,
  type StrandedRedemption,
} from "../fedimint/pending-redemptions.js";
import type { ReabsorbOutcome } from "../fedimint/reabsorb-bearer-notes.js";
import { clearEcashExport, getEcashExport } from "../payments/ecash-exports.js";
import {
  MIN_REAL_ATOMIC_FUNDING_MSATS,
  minimumAtomicFundingMessage,
} from "../payments/funding-limits.js";
import { SavedHandlesPanel } from "./panels/SavedHandlesPanel.js";
import { PayoutDestinationsPanel } from "./panels/PayoutDestinationsPanel.js";
import { SimModePill, SimEntryModal, SIM_PILL_HEIGHT } from "../sim/SimModeBanner.js";
import { isSimModeOn } from "../sim/simMode.js";
import {
  getSignInEnvironment,
  isFediWebViewSignInEnvironment,
  isTauriRuntime,
  shouldApplyCssSafeAreaInsets,
} from "./sign-in-environment.js";
import { readKind0Toggle, type NostrProfileNameMap } from "./nostr-profiles.js";
import { isWorkListing } from "./work-resume.js";
import {
  readAmountDisplayMode,
  writeAmountDisplayMode,
  type AmountDisplayMode,
} from "./amount-display.js";

const QRScanner = lazy(() => import("./QRScanner.js"));

// View routing — flat enum; the bottom nav highlights based on which
// "tab family" the current view belongs to (see TAB_FOR_VIEW below).
type View =
  | "guided"
  | "browse"
  | "detail"
  | "create"
  | "dashboard"
  | "me"
  | "saved-handles"
  | "payout-destinations"
  | "advanced"
  | "help";

type PendingDestroyConfirm = {
  invite: string;
  label: string;
  balanceMsats: number;
  activeInvite: string;
  /** v0.2.0 item 1: when set, navigate to this escrow's detail
   *  after the switch confirms. Used by listing-tap dispatch when
   *  a recoverable balance forces confirmation before the silent
   *  switch to the listing's fed can happen. */
  navigateToEscrowAfter?: string;
  /** Community-pill taps optimistically update the visual community
   *  before surfacing the balance guard. If the user cancels the guard,
   *  restore the old community/filter alongside the active invite. */
  restoreCommunitySlug?: string | null;
};

// Liveness "~D-day" readout scale. Commitment bonds live on BOND_NETWORK (mainnet,
// ~10-min blocks ⇒ ~144/day) as of v5.0.
const BOND_LIVENESS_BLOCKS_PER_DAY = 144;

const TAB_FOR_VIEW: Record<View, Tab> = {
  guided: "browse",
  browse: "browse",
  detail: "browse",
  // v4.2.1: the inline create view is legacy/dead (Create lives on the pencil
  // FAB overlay now); keep it mapped to a valid tab. The middle tab is Dashboard.
  create: "browse",
  dashboard: "dashboard",
  me: "me",
  "saved-handles": "me",
  "payout-destinations": "me",
  advanced: "me",
  help: "me",
};

// v4.1 C1 / v4.2.1: the one-time post-sign-in coach-mark tour over the home
// screen's reachable surfaces. Chama Assisted is called out immediately after
// Browse because it is the low-friction path for a newcomer who does not yet
// know which trade form they need.
// i18n: title/body are DICTIONARY KEYS, resolved with t() at render (module-
// level constants can't call hooks) — same pattern as INTRO_USE_CASES.
const COACH_STEPS: CoachStep[] = [
  {
    selector: '[data-coach="nav-browse"]',
    titleKey: "app.coachBrowseTitle",
    bodyKey: "app.coachBrowseBody",
  },
  {
    selector: '[data-coach="chama-assisted"]',
    titleKey: "app.coachAssistedTitle",
    bodyKey: "app.coachAssistedBody",
  },
  {
    selector: '[data-coach="browse-preferences"]',
    titleKey: "app.coachBrowsePreferencesTitle",
    bodyKey: "app.coachBrowsePreferencesBody",
  },
  {
    selector: '[data-coach="fab-create"]',
    titleKey: "app.coachCreateTitle",
    bodyKey: "app.coachCreateBody",
  },
  {
    selector: '[data-coach="nav-dashboard"]',
    titleKey: "app.coachDashboardTitle",
    bodyKey: "app.coachDashboardBody",
  },
  {
    selector: '[data-coach="nav-me"]',
    titleKey: "app.coachMeTitle",
    bodyKey: "app.coachMeBody",
  },
];

type GivenRatingSlot = {
  tradeId: string;
  ratee: string;
  thumb: RatingThumb;
  ratedAt?: number;
};

const GIVEN_RATINGS_STORAGE_PREFIX = "chama_given_ratings_v1";
const SWITCH_FEEDBACK_MIN_MS = 550;
const SAVED_NSEC_KEY = "chama_saved_nsec";
const NSEC_ORIGIN_KEY = "chama_nsec_origin";

function shouldPersistNsecInShell(): boolean {
  return Capacitor.isNativePlatform() || isTauriRuntime();
}

async function readSavedNsec(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const { value } = await Preferences.get({ key: SAVED_NSEC_KEY });
    return value?.trim() || null;
  }
  if (isTauriRuntime()) {
    try {
      return localStorage.getItem(SAVED_NSEC_KEY)?.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function writeSavedNsec(nsec: string, origin: "generated" | "imported"): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Preferences.set({ key: SAVED_NSEC_KEY, value: nsec });
    await Preferences.set({ key: NSEC_ORIGIN_KEY, value: origin });
    return;
  }
  if (isTauriRuntime()) {
    try {
      localStorage.setItem(SAVED_NSEC_KEY, nsec);
      localStorage.setItem(NSEC_ORIGIN_KEY, origin);
    } catch {
      // Tauri desktop storage is a convenience cache; sign-in still works manually.
    }
  }
}

async function removeSavedNsec(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    try { await Preferences.remove({ key: SAVED_NSEC_KEY }); } catch {}
    try { await Preferences.remove({ key: NSEC_ORIGIN_KEY }); } catch {}
  }
  if (isTauriRuntime()) {
    try { localStorage.removeItem(SAVED_NSEC_KEY); } catch {}
    try { localStorage.removeItem(NSEC_ORIGIN_KEY); } catch {}
  }
}

function givenRatingsStorageKey(pubkey: string): string {
  return `${GIVEN_RATINGS_STORAGE_PREFIX}:${pubkey.toLowerCase()}`;
}

function normalizeGivenRatingSlot(value: unknown): GivenRatingSlot | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  const tradeId = typeof slot.tradeId === "string" ? slot.tradeId.trim() : "";
  const ratee = typeof slot.ratee === "string" ? slot.ratee.trim().toLowerCase() : "";
  const thumb = slot.thumb === "up" || slot.thumb === "down" ? slot.thumb : null;
  const ratedAt = typeof slot.ratedAt === "number" && Number.isFinite(slot.ratedAt)
    ? slot.ratedAt
    : undefined;
  if (!tradeId || !ratee || !thumb) return null;
  return { tradeId, ratee, thumb, ratedAt };
}

function readCachedGivenRatings(pubkey: string): GivenRatingSlot[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(givenRatingsStorageKey(pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeGivenRatingSlot)
      .filter((slot): slot is GivenRatingSlot => !!slot);
  } catch {
    return [];
  }
}

function writeCachedGivenRatings(pubkey: string, slots: GivenRatingSlot[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(givenRatingsStorageKey(pubkey), JSON.stringify(slots));
  } catch {
    // Cache only; relay state is still canonical.
  }
}

function mergeGivenRatingSlots(...groups: GivenRatingSlot[][]): GivenRatingSlot[] {
  const latest = new Map<string, GivenRatingSlot>();
  for (const group of groups) {
    for (const raw of group) {
      const slot = normalizeGivenRatingSlot(raw);
      if (!slot) continue;
      const key = `${slot.tradeId}:${slot.ratee}`;
      const existing = latest.get(key);
      if (!existing || (slot.ratedAt ?? 0) >= (existing.ratedAt ?? 0)) {
        latest.set(key, slot);
      }
    }
  }
  return [...latest.values()].sort((a, b) => (b.ratedAt ?? 0) - (a.ratedAt ?? 0));
}

function waitForSwitchFeedback(startedAt: number): Promise<void> {
  const remaining = SWITCH_FEEDBACK_MIN_MS - (Date.now() - startedAt);
  return remaining > 0
    ? new Promise((resolve) => setTimeout(resolve, remaining))
    : Promise.resolve();
}

function normalizeRouteFedId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function resolveLiveActiveInvite(inputs: {
  joined: boolean;
  federationId: string | null | undefined;
  storedInvite: string | null;
}): string | null {
  if (!inputs.joined) return null;
  const liveFedId = normalizeRouteFedId(inputs.federationId);
  if (!liveFedId) return inputs.storedInvite;

  const expectedStoredFedId = normalizeRouteFedId(expectedFederationIdForInvite(inputs.storedInvite));
  if (expectedStoredFedId === liveFedId) {
    return inputs.storedInvite;
  }

  const livePresetInvite = CURATED_PRESETS.find(
    (preset) => normalizeRouteFedId(preset.federationId) === liveFedId,
  )?.inviteCode ?? null;

  if (livePresetInvite) return livePresetInvite;
  return expectedStoredFedId ? null : inputs.storedInvite;
}

function routeCommunitySlugForInvite(communitySlug: string, activeInvite: string | null): string {
  if (!activeInvite) return communitySlug;
  const community = getCommunityBySlug(communitySlug);
  if (community?.federationInvite === activeInvite) return communitySlug;
  return communityForInvite(activeInvite)?.slug ?? communitySlug;
}

function nativeBridgePortLabel(): string | null {
  if (!isNativeBridgeModeOn()) return null;
  try {
    const url = new URL(getNativeBridgeUrl());
    return url.port ? `:${url.port}` : url.host;
  } catch {
    return "native";
  }
}

export default function App() {
  const { t } = useT();
  // Toast state needs to be declared before the hook since we pass
  // onClaimProgress which dispatches toasts. useRef holds the callback
  // so the hook gets a stable reference and doesn't re-wire on every render.
  const toastRef = useRef<((t: { message: ReactNode; type: "success" | "error" | "info" }) => void) | null>(null);

  const [{
    connected,
    pubkey,
    escrows,
    relayStatuses,
    connectedRelays,
    error,
    loading,
    publicListingsLoading,
    myTradesLoading,
    earningsRevision,
    fedimint,
    fundingInProgress,
    claimPayoutInProgress,
  }, actions] = useEscrow({
    relays: DEFAULT_RELAYS,
    defaultPlatformFeeBps: 50,
    onClaimProgress: (p) => {
      const t = toastRef.current;
      if (!t) return;
      // i18n: `t` here is the TOAST dispatcher (shadowing the hook's t), and
      // this callback may be captured once by useEscrow — translate() reads
      // the live language at fire time instead of a possibly-stale closure.
      if (p.phase === "submitted") {
        t({ message: translate(getCurrentLang(), "app.claimingReconstructing"), type: "info" });
      } else if (p.phase === "watching") {
        t({
          message: translate(getCurrentLang(), "app.claimSubmittedWatching"),
          type: "info",
        });
      } else if (p.phase === "success") {
        const sats = Math.floor(p.deltaMsats / 1000);
        t({
          message: p.viaWatchdog
            ? <>{translate(getCurrentLang(), "app.claimedBefore")} <BitcoinAmount sats={sats} size={12} gap={3} glyphScale={1.2} color="inherit" glyphColor="inherit" /> {translate(getCurrentLang(), "app.claimedAfter")}</>
            : translate(getCurrentLang(), "app.claimedRedeemed"),
          type: "success",
        });
      } else if (p.phase === "timeout") {
        t({
          message: translate(getCurrentLang(), "app.claimStillPending"),
          type: "info",
        });
      } else if (p.phase === "failure") {
        t({ message: p.reason || translate(getCurrentLang(), "app.claimFailed"), type: "error" });
      }
    },
  });

  const [view, setView] = useState<View>("guided");
  // v4.1 C1 coach-mark tour: shown once after the user's first sign-in, on the
  // Browse home screen (where the FABs are mounted). `coachReady` adds a short
  // settle delay so the bottom-nav + FAB layout has painted before we measure.
  const [coachSeen, setCoachSeen] = useState<boolean>(() => readCoachSeen());
  const [coachReady, setCoachReady] = useState(false);
  // v3.2: the create flow opens as one shared overlay. The Browse pencil and
  // the old bottom-nav Create slot both hit this same path for now.
  const [createOverlayOpen, setCreateOverlayOpen] = useState(false);
  // When the Advanced screen is opened from the trade-page NWC "Change" link,
  // land focused on the NWC wallets section instead of the top of the page.
  const [advancedFocusNwc, setAdvancedFocusNwc] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sellerManageId, setSellerManageId] = useState<string | null>(null);
  const urlEscrowOpenAttemptedRef = useRef(false);
  const [detailBackView, setDetailBackView] = useState<View>("browse");
  // V3 #75: set when a listing-tap silently switched the wallet onto the
  // listing's fed (identity stayed home). Consumed by maybeSnapBackHome()
  // when the user backs out of the detail view.
  const visitedForeignFedRef = useRef(false);
  const [browseCategory, setBrowseCategory] = useState<string>("all");
  // Per the "every user has a home" doctrine (§2.1, locked for v0.2.0):
  // every user — first-time or returning — gets a community from the
  // moment they sign in. v0.1.87 retired the synthetic "All communities"
  // pill, so browseCommunity is always a real slug. First-time users
  // start on DEFAULT_COMMUNITY_SLUG; community-pill taps mutate from
  // there. v0.2.0 will replace this filter with the matching/non-
  // matching two-section amber layout.
  const [browseCommunity, setBrowseCommunity] = useState<string>(
    () => getUserCommunitySlugRaw() ?? DEFAULT_COMMUNITY_SLUG,
  );
  // v4.3 auth-first: a fresh npub connects with no home chama yet. This gates the
  // post-connect GlobeCountryPicker (the pick moved out of the pre-signer
  // ConnectScreen). Re-evaluated whenever a signer connects.
  const [needsHomePick, setNeedsHomePick] = useState(false);
  const [toast, setToast] = useState<{ message: ReactNode; type: "success" | "error" | "info"; sticky?: boolean; dismissOnTap?: boolean } | null>(null);
  toastRef.current = setToast;
  const [showFundModal, setShowFundModal] = useState(false);
  // v2.4 #56: "withdraw as ecash" modal (fee-free Fedimint note export).
  const [showEcashExport, setShowEcashExport] = useState(false);
  // v3.4.0 C13 — a stranded claim entry being exported via the
  // EcashExportModal preset mode (bearer note from the
  // pending-redemptions stash that automatic retry gave up on).
  const [strandedClaimExport, setStrandedClaimExport] = useState<StrandedRedemption | null>(null);
  const [autoLoginChecked, setAutoLoginChecked] = useState(false);
  // `actions` is rebuilt as hook state changes, so this effect can re-run while
  // secure-storage I/O is still pending. Latch synchronously before the first
  // await; React's loading state alone cannot prevent already-started reads
  // from dispatching several connect() calls together.
  const autoLoginStartedRef = useRef(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [pendingDestroyConfirm, setPendingDestroyConfirm] = useState<PendingDestroyConfirm | null>(null);
  // #25 foreign-chama guidance: a trade whose fed ≠ the wallet's fed (FED_MISMATCH)
  // — instead of "sign out and rejoin with the correct federation", offer a one-tap
  // switch to the chama the trade lives in. Captures the trade's community + a retry.
  const [pendingFedSwitch, setPendingFedSwitch] = useState<{ community: string; retry: () => Promise<void> } | null>(null);
  const [autoInitDone, setAutoInitDone] = useState(false);
  // Relay-resilience re-arm. The auto-init effect latches autoInitDone on
  // dispatch so it fires once and never hot-loops — but that left a failed/empty
  // first attempt stuck until a manual Reconnect. These re-open the latch when
  // the relay pool actually grows. autoInitHardStopRef suppresses the re-arm for
  // a deliberate stop (reconcile-refused, which is awaiting the user's modal).
  const autoInitHardStopRef = useRef(false);
  const prevConnectedRelaysRef = useRef(0);
  // Reputation (kind:38123): my own aggregate (feeds seller graduation + the Me
  // dashboard) and the (trade, ratee) slots I've already rated (drives the
  // one-tap capture's "rated" state). Both null/empty until connected — exactly
  // today's behavior, so the graduation gate degrades closed on any fetch miss.
  const [myRatings, setMyRatings] = useState<AggregateRatings | null>(null);
  const [myGivenRatings, setMyGivenRatings] = useState<GivenRatingSlot[]>([]);
  const ratingHydrationKey = useMemo(() => {
    return [...escrows.values()]
      .filter((trade) => trade.status === EscrowStatus.COMPLETED || trade.resolvedOutcome !== null)
      .map((trade) => `${trade.id}:${trade.resolvedOutcome ?? "open"}:${trade.eventChain?.length ?? 0}`)
      .sort()
      .join("|");
  }, [escrows]);
  useEffect(() => {
    if (!pubkey) { setMyRatings(null); setMyGivenRatings([]); return; }
    const cached = readCachedGivenRatings(pubkey);
    setMyGivenRatings(cached);
    if (!connected || connectedRelays <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const [summary, given] = await Promise.all([
          actions.fetchRatingSummary(pubkey),
          actions.fetchMyGivenRatings(),
        ]);
        if (!cancelled) {
          setMyRatings(summary);
          const merged = mergeGivenRatingSlots(cached, given);
          setMyGivenRatings(merged);
          writeCachedGivenRatings(pubkey, merged);
        }
      } catch { /* leave null — graduation stays closed, same as before */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, pubkey, connectedRelays, ratingHydrationKey]);

  const handleRateCounterparty = async (tradeId: string, ratee: string, thumb: RatingThumb) => {
    await actions.rateCounterparty(tradeId, ratee, thumb);
    const lc = ratee.toLowerCase();
    const slot: GivenRatingSlot = {
      tradeId,
      ratee: lc,
      thumb,
      ratedAt: Math.floor(Date.now() / 1000),
    };
    // Optimistic: flip the one-tap to "rated" immediately (the slot is
    // replaceable, so a later re-fetch converges on the same value).
    setMyGivenRatings(prev => {
      const merged = mergeGivenRatingSlots(prev, [slot]);
      if (pubkey) writeCachedGivenRatings(pubkey, merged);
      return merged;
    });
  };
  // v0.2.0 item 1: brief inline overlay during silent re-init triggered
  // by listing-tap. Sub-second on a healthy fed; modal-free.
  const [switchingToCommunity, setSwitchingToCommunity] = useState<{ displayName: string } | null>(null);

  // v0.2.0 item 8: when the user picks "Withdraw via Lightning" from the
  // destroy-confirm modal, we stash the pending switch here. The
  // withdraw-watcher useEffect (below the actions setup) auto-dispatches
  // the switch once balance reaches zero. Per Q4: if the user closes the
  // FundWalletModal before draining, drop this state — explicit
  // abandonment.
  const [pendingSwitchAfterWithdraw, setPendingSwitchAfterWithdraw] = useState<{
    invite: string;
    label: string;
    navigateToEscrowAfter?: string;
    persistCustom?: boolean;
  } | null>(null);
  // v0.3.0 Phase 2: AtomicFundingModal mount state. When the user taps
  // Fund on a listing, we stash the pending fund-and-lock here and the
  // modal mounts. The TradeDetail Fund button awaits a promise that
  // resolves on modal close, preserving the in-flight disabled state
  // throughout the modal's lifetime.
  const [pendingFundAndLock, setPendingFundAndLock] = useState<{
    escrowId: string;
    amountMsats: number;
    /** E1.1: funder's 0.25% arbiter insurance, folded into the invoice. */
    premiumMsats?: number;
    ctaLabel: string;
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
    // Trade context fields, kept on the funding modal as informational
    // metadata. The pre-LOCK external-swap CTA was removed in the
    // 2026-06-24 fiat-ramps pass (all swaps are offramp-only, post-CLAIM),
    // so only ClaimPayoutModal actually reads these now.
    tradeCommunity?: string | null;
    fiatCurrency?: string | null;
    tradeCategory?: string | null;
    resolve: () => void;
  } | null>(null);
  // v0.3.0 Phase 3: ClaimPayoutModal mount state. Same shape as
  // pendingFundAndLock — TradeDetail's setClaiming(true) flag survives
  // the modal lifetime via the resolve-on-close promise.
  const [pendingClaim, setPendingClaim] = useState<{
    escrowId: string;
    payoutMsats: number;
    /** E1.1: winner's 0.25% arbiter insurance, held back from the payout
     *  quote so the settle-time sweep finds it in the wallet. */
    premiumMsats?: number;
    tradeCommunity?: string | null;
    fiatCurrency?: string | null;
    resolve: () => void;
  } | null>(null);
  // Bond Phase 2A: the cabinet-only "Post your bond" ceremony modal.
  const [showBondCeremony, setShowBondCeremony] = useState(false);
  const [blockedClaimReasons, setBlockedClaimReasons] = useState<Record<string, string>>({});
  // v0.3.0 Phase 4: RecoveryPayoutModal mount state. Single mount used
  // by BOTH the failure-mode RecoveryBanner (no follow-up after drain)
  // AND the DestroyEcashConfirmModal flow (queues pendingSwitchAfter-
  // Withdraw — the existing watcher useEffect dispatches the switch
  // when balance reaches zero). The `title` prop differentiates the
  // two surfaces visually.
  const [pendingRecovery, setPendingRecovery] = useState<{
    title: string;
    subtitle?: string;
    traceContext?: {
      escrowId?: string;
      amountMsats?: number;
    };
  } | null>(null);
  // #37: true while the PendingLockCard's "Finish lock" call is in flight.
  const [pendingLockBusy, setPendingLockBusy] = useState(false);
  // Stranded-payout recovery: escrows already swept by the once-per-session
  // background reattachPayout (the boot sweep effect below).
  const payoutReattachSweptRef = useRef<Set<string>>(new Set());
  // Arbiter premium (task #53 E1): session latches for the pay + redeem
  // sweeps (durable idempotence lives in the ledger; these just stop
  // same-session re-fires).
  const premiumPaySweptRef = useRef<Set<string>>(new Set());
  const premiumRedeemSweptRef = useRef<Set<string>>(new Set());
  const [kind0Enabled, setKind0Enabled] = useState(false);
  const [nostrProfiles, setNostrProfiles] = useState<NostrProfileNameMap>({});
  const [amountDisplayMode, setAmountDisplayModeState] = useState<AmountDisplayMode>(readAmountDisplayMode);
  const setAmountDisplayMode = (mode: AmountDisplayMode) => {
    setAmountDisplayModeState(mode);
    writeAmountDisplayMode(mode);
  };
  // #50 dark/light theming: theme.ts swapped the palette into T at module
  // load; this state exists so a toggle (or an OS scheme change in "system"
  // mode) repaints the tree. Inline styles re-read T on every render and
  // there are no memo barriers in src/ui, so one root bump is enough.
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readThemeMode);
  const [, setThemeEpoch] = useState(0);
  const setThemeMode = (mode: ThemeMode) => {
    writeThemeMode(mode);
    applyThemeMode(mode);
    setThemeModeState(mode);
    setThemeEpoch(e => e + 1);
  };
  const storedActiveInvite = getActiveInvite();
  const liveActiveInvite = resolveLiveActiveInvite({
    joined: fedimint.joined,
    federationId: fedimint.federationId,
    storedInvite: storedActiveInvite,
  });
  const routeCommunitySlug = routeCommunitySlugForInvite(browseCommunity, liveActiveInvite);
  const nativeBridgeLabel = nativeBridgePortLabel();
  const localWalletSats = Math.floor(Math.max(0, fedimint.balanceMsats ?? 0) / 1000);
  const sessionBadge = nativeBridgeLabel
    ? `${nativeBridgeLabel}${localWalletSats > 0 ? ` · ${localWalletSats} sats` : ""}`
    : "";

  useEffect(() => {
    if (!fedimint.joined || !liveActiveInvite) return;
    if (storedActiveInvite === liveActiveInvite) return;
    setActiveInvite(liveActiveInvite);
  }, [fedimint.joined, liveActiveInvite, storedActiveInvite]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = nativeBridgeLabel ? `Chama ${nativeBridgeLabel}` : "Chama";
  }, [nativeBridgeLabel]);

  useEffect(() => {
    if (themeMode !== "system" || typeof globalThis.matchMedia !== "function") return;
    const mq = globalThis.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      applyThemeMode("system");
      setThemeEpoch(e => e + 1);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [themeMode]);
  // V3 roster keystone: whenever the user lands on a community, refresh its
  // signed kind:38120 arbiter roster (fetch → verify against the hybrid
  // authority → cache). Fire-and-forget; no-op for communities without an
  // anchor. The cached roster feeds getTrustedArbiterPool as the strongest
  // source, so Create stamps roster-backed pools without any await here.
  useEffect(() => {
    if (!connected || !browseCommunity) return;
    actions.refreshCommunityRoster(browseCommunity).catch(() => {});
  }, [connected, browseCommunity]);
  // v4.1 C1: arm the coach-mark tour a beat after first sign-in, once the home
  // screen has painted (so the nav + FABs are measurable). Skips entirely for
  // returning users (coachSeen).
  useEffect(() => {
    if (!connected || coachSeen) return;
    const t = setTimeout(() => setCoachReady(true), 600);
    return () => clearTimeout(t);
  }, [connected, coachSeen]);
  // A revoked friend-wallet token dropped this browser back onto its own
  // wallet during Fedimint init. That restored the identity, NOT the balance:
  // the bridge owns a separate seed and database, so sats held there are still
  // there and are not in this wallet. Say so once, plainly — the swap happens
  // too deep in init to surface itself, and a silent jump to a zero balance
  // reads as "Chama lost my money".
  useEffect(() => {
    const raise = () => {
      try {
        if (localStorage.getItem(REMOTE_BRIDGE_REVOKED_KEY) !== "1") return;
        localStorage.removeItem(REMOTE_BRIDGE_REVOKED_KEY);
      } catch {
        return;
      }
      setToast({ message: t("app.remoteBridgeRevoked"), type: "info" });
    };
    globalThis.addEventListener?.(REMOTE_BRIDGE_REVOKED_EVENT, raise);
    raise();
    return () => globalThis.removeEventListener?.(REMOTE_BRIDGE_REVOKED_EVENT, raise);
  }, [t]);

  // Two-tap confirm for destructive listing delete. window.confirm() is a
  // no-op in the Tauri/Capacitor webview (it silently returned false, so the
  // old confirm-gated delete never fired). This arms on the first tap and
  // deletes on a second tap of the same listing within 5s — no native dialog.
  const pendingDeleteRef = useRef<{ id: string; at: number } | null>(null);

  // A3: an edit is a replacement (listing-edit.ts) — publish the new terms,
  // cancel the old. The sheet collects the changes; useEscrow owns the swap.
  const [editListingId, setEditListingId] = useState<string | null>(null);
  const editSellerListing = (id: string) => {
    setSellerManageId(null);
    setEditListingId(id);
  };
  // Tranching: the hook re-checks the safety gate itself, so a stale render
  // or a double tap can never start the next slice early.
  const handleStartNextTranche = async (fromEscrowId: string) => {
    try {
      const next = await actions.startNextTranche(fromEscrowId);
      openEscrow(next.escrowId);
      setToast({ message: t("tranche.startedToast"), type: "success" });
    } catch (e: any) {
      setToast({ message: e?.message || t("tranche.startFailed"), type: "error" });
      // TradeDetail owns the persistent plan surface. Let it keep the failure
      // visible beside the slices instead of reducing a continuity failure to
      // a transient toast that disappears while the plan appears stuck.
      throw e;
    }
  };

  const saveListingEdits = async (id: string, edits: ListingEdits) => {
    const result = await actions.editListing(id, edits);
    setEditListingId(null);
    setRetiredTick((n) => n + 1);
    setToast({
      // Honest about the partial case: the new listing is live either way, but
      // if the CANCEL didn't land the seller may briefly see both.
      message: result.oldCancelled ? t("edit.saved") : t("edit.savedOldRemains"),
      type: result.oldCancelled ? "success" : "info",
    });
  };

  const deleteSellerListing = async (id: string) => {
    const armed = pendingDeleteRef.current;
    if (!armed || armed.id !== id || Date.now() - armed.at > 5000) {
      pendingDeleteRef.current = { id, at: Date.now() };
      setToast({ message: t("app.tapDeleteAgain"), type: "info" });
      return;
    }
    pendingDeleteRef.current = null;
    try {
      await actions.cancel(id, "seller_deleted_listing");
      setSellerManageId(null);
      setToast({ message: t("app.listingDeleted"), type: "success" });
    } catch (e: any) {
      setToast({
        message: e?.message || t("app.couldntDeleteListing"),
        type: "error",
      });
    }
  };

  // ── 6.0.2 · reissuance as the liveness probe ──────────────────────────
  //
  // Three recovery cards used to present bearer material as recoverable value
  // without ever asking whether it was live. This is where that stops: the
  // card taps here, the federation is asked by CONSUMING the note, and the
  // record is resolved by the answer instead of by an inference.
  //
  // Storage resolution lives here (not in the probe, and not in MeScreen) for
  // one reason: the probe must stay a pure question-and-answer that no caller
  // can talk into a different verdict, and MeScreen must stay a surface that
  // renders records rather than one that decides them.
  const handleReabsorbBearerNotes = async (input: {
    oobNotes: string;
    expectedMsats: number;
    context: "pending-export" | "stranded-claim";
    escrowId?: string;
  }): Promise<ReabsorbOutcome> => {
    let result;
    try {
      result = await actions.reabsorbBearerNotes(input);
    } catch (e: any) {
      // The probe is documented never to throw; if a caller layer does, that
      // is still "we don't know", which means CHANGE NOTHING.
      console.error("[chama] reabsorb probe threw — treating as unknown:", e);
      setToast({ message: t("app.reabsorbUnknown"), type: "info" });
      return "unknown";
    }

    const pending = getEcashExport();
    const isThisExport = input.context === "pending-export"
      && pending?.notes === input.oobNotes;

    if (result.outcome === "recovered") {
      // Exact-bearer-note identity, and amount explicitly not accepted as
      // identity — the same discipline the recovery records already enforce.
      clearPendingRedemptionsMatchingNotes(input.oobNotes);
      if (isThisExport) {
        if (pending?.source === "claim" && pending.escrowId) {
          // The sats are irreversibly in this wallet, which is the same
          // terminal state a claim-into-wallet reaches. Publishing COMPLETE
          // is honest here; it also clears the export stash.
          try {
            await actions.confirmClaimEcashExport(pending.escrowId);
          } catch (e) {
            console.warn("[chama] COMPLETE after reabsorb failed (advisory):", e);
            clearEcashExport();
          }
        } else {
          clearEcashExport();
        }
      }
      setToast({
        message: t("app.reabsorbRecovered", {
          sats: String(Math.floor(result.recoveredMsats / 1000)),
        }),
        type: "success",
      });
    } else if (result.outcome === "consumed-uncredited") {
      // Two facts, and both have to survive. The note is finished — the
      // federation has taken it and will never honour it again, so it stops
      // being offered and stops jamming assertEcashExportWritable. The SATS
      // are a different question, and an unanswered one: the record is written
      // FIRST (creating one if this export never had a trade behind it), so
      // clearing the export can't delete the last trace of it.
      recordConsumedUncreditedNote({
        oobNotes: input.oobNotes,
        amountMsats: input.expectedMsats,
        reason: result.reason,
        escrowId: input.escrowId,
      });
      // Deliberately NOT confirmClaimEcashExport: nobody was made whole, so
      // COMPLETE would be a claim we haven't earned.
      if (isThisExport) clearEcashExport();
      setToast({ message: t("app.reabsorbConsumedUncredited"), type: "info", sticky: true, dismissOnTap: true });
    } else if (result.outcome === "dead") {
      // The federation rejected the string as one it will never honour — there
      // was never money here, so there is no question to keep open. Deliberately
      // no "are you sure?": nothing is being discarded, the user is being told.
      markPendingRedemptionsProbedDead(input.oobNotes, result.reason);
      if (isThisExport) clearEcashExport();
      setToast({ message: t("app.reabsorbDead"), type: "info", sticky: true, dismissOnTap: true });
    } else {
      // unknown / foreign: the entry is left EXACTLY as it was. The verdict is
      // still recorded so the forensic trail can tell "asked, couldn't tell"
      // apart from "never asked".
      recordBearerProbe(input.oobNotes, result.outcome, "reason" in result ? result.reason : undefined);
      setToast({
        message: result.outcome === "foreign"
          ? t("app.reabsorbForeign")
          : t("app.reabsorbUnknown"),
        type: "info",
      });
    }
    return result.outcome;
  };

  // v0.2.0 item 8 / v0.3.0 Phase 4 reminder #3: post-recover auto-
  // switch. State machine unchanged; only the trigger surface moves
  // (FundWalletModal in v0.2.0 → RecoveryPayoutModal in v0.3.0). When
  // the user picked "Recover & switch" from the destroy-confirm modal,
  // the watcher waits for balance to drain to zero, then dispatches
  // the originally-attempted federation switch. If the user dismisses
  // the picker before resolving, the modal's onClose drops the pending
  // switch (explicit abandonment).
  useEffect(() => {
    if (!pendingSwitchAfterWithdraw) return;
    if ((fedimint.balanceMsats ?? 0) >= 1000) return;
    // Balance reached zero or only sub-sat dust remains — dispatch the switch.
    const target = pendingSwitchAfterWithdraw;
    setPendingSwitchAfterWithdraw(null);
    (async () => {
      try {
        setToast({ message: t("app.switchingTo", { label: target.label }), type: "info" });
        if (fedimint.federationId) {
          await actions.switchFederation(target.invite, {
            persistCustom: target.persistCustom !== false,
          });
        } else {
          await actions.initFedimint(target.invite, {
            persistCustom: target.persistCustom !== false,
          });
        }
        setToast({ message: t("app.joinedLabel", { label: target.label }), type: "success" });
        if (target.navigateToEscrowAfter) {
          setSelectedId(target.navigateToEscrowAfter);
          setView("detail");
        }
      } catch (e: any) {
        setToast({
          message: e?.message || t("app.couldntSwitchTo", { label: target.label }),
          type: "error",
        });
      }
    })();
  }, [pendingSwitchAfterWithdraw, fedimint.balanceMsats, fedimint.federationId, actions]);

  // Once a signer is known, localStorage reads switch from legacy
  // browser-wide keys to per-npub keys. Keep Browse's identity pill in
  // lockstep with that scoped home so a stale pre-connect selection
  // cannot visually disagree with the wallet route we auto-init below.
  useEffect(() => {
    if (!connected) return;
    setBrowseCommunity(getUserCommunitySlugRaw() ?? DEFAULT_COMMUNITY_SLUG);
    setKind0Enabled(readKind0Toggle(pubkey));
    // Auth-first: if THIS npub has never picked a home chama, gate the
    // post-connect picker before the main app renders.
    setNeedsHomePick(getUserCommunitySlugRaw() === null);
  }, [connected, pubkey]);

  // v2.7 onboarding completion — two pre-login deferrals settle once a signer
  // exists (the globe picker runs before sign-in):
  //   1. Stamp this identity onto any pre-login generated country shells, so
  //      their permissionless arbiter rosters become verifiable (creatorPubkey
  //      was null before we knew who the user was). Idempotent.
  //   2. Publish the deferred "no Chama here — make one" community report and
  //      clear it. Read-then-clear guards against a double send; on a hard
  //      failure we re-stash it (the sender only throws when zero arbiters were
  //      reached, so there's no partial-send dup risk) to retry next connect.
  useEffect(() => {
    if (!connected || !pubkey) return;
    try { claimGeneratedShellCreator(pubkey); } catch { /* storage-only, non-fatal */ }
    const pending = getPendingCommunityReport();
    if (!pending) return;
    clearPendingCommunityReport();
    actions.publishCommunityReport(pending)
      .then((r) => setToast({
        message: r.sent === 1
          ? t("app.onMapReportSentOne", { count: r.sent })
          : t("app.onMapReportSentMany", { count: r.sent }),
        type: "success",
      }))
      .catch((e: any) => {
        setPendingCommunityReport(pending);
        console.warn("[chama] Deferred community report failed; will retry next connect:", e);
      });
    // actions/setToast intentionally omitted — fire once per connect, not per
    // actions-identity churn (actions is rebuilt every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, pubkey]);

  // Auto-login: in app shells, check for a saved nsec before showing login.
  useEffect(() => {
    if (autoLoginChecked || connected || loading || autoLoginStartedRef.current) return;
    if (!shouldPersistNsecInShell()) { setAutoLoginChecked(true); return; }
    autoLoginStartedRef.current = true;
    (async () => {
      try {
        const value = await readSavedNsec();
        if (value) {
          (window as any).__chama_connect_nsec = value;
          actions.connect();
        }
      } catch (e) {
        console.warn("[chama] auto-login check failed:", e);
      } finally {
        setAutoLoginChecked(true);
      }
    })();
  }, [autoLoginChecked, connected, loading, actions]);

  // Auto-init Fedimint after connect. v0.1.87 wires the
  // sticky-community decision via decideAutoInitTarget — refresh
  // always lands the user on their home community's federation,
  // unless an in-flight trade with funds at risk forces preserving
  // the OPFS-bound fed so the trade can resume.
  //
  // Note on inputs at boot: hasCurrentEscrow and balanceMsats are
  // both unknowable before initFedimint completes (escrows haven't
  // streamed yet, the WASM client isn't open). For v0.1.87 we pass
  // conservative defaults (false / 0); the v0.1.74 reconciliation
  // guard in initFedimint catches the race where balance is actually
  // non-zero and the home fed differs from the OPFS-bound one. v0.2.0
  // will tighten this once the recovery-banner / one-trade-at-a-time
  // gates are in place.
  // ── Cross-device bond recovery ───────────────────────────────────────────────
  // Once connected, pull my OWN on-chain bonds into this device's local store (from
  // my kind-38135 announcements + seed), so a bond posted on another device shows +
  // reclaims/sweeps here — the Dashboard + ceremony read the same local store. Once
  // per session, fail-soft.
  const bondRecoveryDoneRef = useRef(false);
  useEffect(() => {
    if (!connected || bondRecoveryDoneRef.current) return;
    bondRecoveryDoneRef.current = true;
    void actions.recoverMyBonds().catch(() => {});
  }, [connected]);

  useEffect(() => {
    if (!connected || autoInitDone) return;
    // `connected` flips true synchronously when client.connect() is
    // dispatched, but relay WebSocket handshakes happen async. Firing
    // initFedimint with zero connected relays drives getOrCreateSeed
    // into the fresh-seed publish path (first-launch users with no
    // marker) → relayManager.publish() throws "No connected relays —
    // cannot publish" → autoInitDone is already true → the user is
    // stuck on "No Chama" until they tap Reconnect manually. Wait
    // until at least one relay is actually open before dispatching.
    if (connectedRelays === 0) return;
    if (fedimint.joined || fedimint.busy || fedimint.initialized) return;

    const activeInvite = getActiveInvite();
    const storedHomeCommunity = getUserCommunitySlugRaw();
    // v4.3 auth-first: while the post-connect home picker gates the app
    // (this npub has never picked a home → same condition as needsHomePick,
    // read from the source to stay effect-order-proof), do NOT auto-init a
    // default fed behind it. The pick itself resolves + inits the chosen
    // federation (handleSelectCommunity), so initing BLF here would (a)
    // burn a join + immediate switch, and (b) worse: use-default PERSISTS
    // a home this user never picked — quit mid-pick + relaunch would then
    // skip the picker silently. Deferred WITHOUT latching autoInitDone so
    // the effect re-arms normally once the pick lands (its guards then
    // skip re-dispatch: the pick's own init sets busy/initialized).
    if (storedHomeCommunity === null) return;
    const nativeCommunity = isNativeBridgeModeOn()
      ? getConfiguredNativeBridgeCommunitySlug()
      : null;
    const nativeCommunityIsValid = nativeCommunity
      ? getCommunityBySlug(nativeCommunity) !== null
      : false;
    const homeCommunity = nativeCommunityIsValid
      ? nativeCommunity
      : storedHomeCommunity;
    const target = decideAutoInitTarget({
      activeInvite,
      homeCommunity,
      hasCurrentEscrow: false,
      balanceMsats: 0,
    });

    if ((import.meta as any).env?.DEV) {
      const targetInvite = "invite" in target ? target.invite : null;
      console.info("[chama] auto-init target", {
        homeCommunity,
        storedHomeCommunity,
        nativeCommunity: nativeCommunityIsValid ? nativeCommunity : null,
        activeInvite: activeInvite ? activeInvite.slice(0, 24) + "…" : null,
        targetKind: target.kind,
        targetCommunity: target.kind === "use-home"
          ? target.slug
          : target.kind === "use-default"
            ? target.defaultCommunity
            : null,
        targetInvite: targetInvite ? targetInvite.slice(0, 24) + "…" : null,
      });
    }

    if (target.kind === "skip") return;
    setAutoInitDone(true);

    // Native sidecar mode can still be pointed at an explicit debug
    // community via nativeFedimintCommunity. Otherwise it follows the
    // user's normal home-community routing, just like the browser path.
    if (nativeCommunityIsValid && homeCommunity && storedHomeCommunity !== homeCommunity) {
      actions.setCommunity(homeCommunity);
      setBrowseCommunity(homeCommunity);
    }

    // v0.2.0 item 6: when target.kind === "use-default" we also persist
    // the assigned community to localStorage so subsequent reloads land
    // in the use-home branch — first-time-default fires exactly once
    // per npub, not on every refresh.
    if (target.kind === "use-default") {
      actions.setCommunity(target.defaultCommunity);
      setBrowseCommunity(target.defaultCommunity);
    } else if (target.kind === "use-home") {
      setBrowseCommunity(target.slug);
    }

    // All branches dispatch through initFedimint(invite). The v0.1.74
    // reconciliation guard inside initFedimint handles the case where
    // the desired invite differs from the OPFS-bound one AND a
    // non-zero balance is detected — it throws
    // RECONCILE_REFUSED_NONZERO_BALANCE and we surface the modal.
    const failureLabel =
      target.kind === "use-home"
        ? (getCommunityBySlug(target.slug)?.displayName ?? target.slug)
        : target.kind === "use-default"
          ? (getCommunityBySlug(target.defaultCommunity)?.displayName ?? target.defaultCommunity)
          : t("app.fallbackPreviousCommunity");
    actions.initFedimint(target.invite).catch((e: any) => {
      if (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE") {
        // Deliberate fund-safety stop — don't re-arm into a modal loop.
        autoInitHardStopRef.current = true;
        queueDestroyConfirm({
          invite: e.desiredInvite,
          label: failureLabel,
          balanceMsats: e.balanceMsats || 0,
          activeInvite: e.previousActiveInvite,
        });
      } else if (
        e?.code === "RELAYS_CONNECTING" ||
        e?.code === "NOT_CONNECTED" ||
        e?.code === "SIGNER_NOT_READY"
      ) {
        // Transient: relays/signer still settling. Stay quiet — the re-arm
        // effect retries when the pool grows, instead of dead-ending the user.
        console.debug("[chama] auto-init deferred (not ready):", e.code);
      } else {
        setToast({
          message: e?.message || t("app.couldntReconnect"),
          type: "error",
        });
      }
    });
  }, [connected, connectedRelays, autoInitDone, fedimint.joined, fedimint.busy, fedimint.initialized, actions]);

  // Re-arm auto-init when the relay pool grows after a failed/empty first
  // attempt. The auto-init effect above latches autoInitDone on dispatch (fires
  // once, no hot-loop); this re-opens that latch only when connectedRelays
  // actually increases AND we still haven't initialized — closing the "fired
  // into a not-ready pool, now stuck until manual Reconnect" dead-end. A
  // deliberate stop (reconcile-refused) is suppressed via autoInitHardStopRef;
  // a successful init clears it.
  useEffect(() => {
    const prev = prevConnectedRelaysRef.current;
    prevConnectedRelaysRef.current = connectedRelays;
    if (fedimint.initialized || fedimint.joined) {
      autoInitHardStopRef.current = false;
      return;
    }
    if (
      connectedRelays > prev &&
      autoInitDone &&
      !fedimint.busy &&
      !autoInitHardStopRef.current
    ) {
      setAutoInitDone(false);
    }
  }, [connectedRelays, autoInitDone, fedimint.initialized, fedimint.joined, fedimint.busy]);

  const now = Math.floor(Date.now() / 1000);
  const HIDE_AFTER = 7 * 86400;

  // Durable retired-listing ledger (#74/#75): ids superseded by a renewal /
  // repost / one-time dedupe. Cheap synchronous scoped-localStorage read per
  // render (same precedent as isSimModeOn below); a tick forces a re-read after
  // any markRetired. Only the OWNER ever has entries (their own listings), so
  // filtering these out never changes what other users see.
  const [, setRetiredTick] = useState(0);
  const retiredIds = getRetiredIds();
  const markRetired = (id: string) => {
    retireListing(id);
    setRetiredTick((n) => n + 1);
  };

  const visibleTrades = [...escrows.values()]
    .filter(s => {
      // Superseded (retired) own listings must not surface as live trades in
      // Browse, Me, or the attention queue — they were replaced by a renewal.
      if (retiredIds.has(s.id)) return false;
      if (["CREATED", "LOCKED", "APPROVED"].includes(s.status)) return true;
      if (s.createdAt && (now - s.createdAt) > HIDE_AFTER) return false;
      return true;
    })
    .sort(compareTradeChronology);

  // Participant history must not inherit Browse's seven-day retention filter:
  // completed payouts remain recoverable on a fresh/cross-device client.
  const myTrades = participantTradeHistory(escrows.values(), pubkey, now, retiredIds);

  // Loss-proof history: durable-index trades whose chain isn't loaded this
  // session (relay eviction / pre-community-relay / never-locked). Excludes
  // everything currently loaded so there are no dupes; the Me "All" view
  // renders these as compact "earlier trades" rows below the live list. Cheap
  // synchronous scoped-localStorage read; recomputed as escrows load.
  const archivedTrades = pubkey
    ? archivedTradeEntries(myTrades.map((trade) => trade.id))
        .filter((entry) => !retiredIds.has(entry.id))
    : [];

  // ── Store permanence (#49) ─────────────────────────────────────────────
  // Tier 1: the seller's own listings that lapsed UNFUNDED — feed the manual
  // "your store lapsed — renew?" card. Cheap pure filter over loaded escrows.
  const lapsedListings = pubkey
    ? lapsedRenewableListings(escrows.values(), pubkey, now, retiredIds)
    : [];
  const [renewingId, setRenewingId] = useState<string | null>(null);
  // Tier 3: is the signed-in seller chain-verified bonded (funded+active 38135
  // ≥ floor) in their home community? Gates auto-renew (bonded ⇒ store persists
  // while online; unbonded ⇒ manual renew only) and the card's copy. Resolved
  // once per connect via the existing fetchCommunityBonds/esplora path.
  const [sellerBonded, setSellerBonded] = useState(false);
  const [bondTip, setBondTip] = useState<number | null>(null);
  // Store renewal is an explicit, per-identity preference. Older builds
  // silently treated every bonded seller as opted in; defaulting OFF makes the
  // behavior visible and consensual while leaving manual renewal untouched.
  const autoRenewStorageKey = pubkey ? `chama_store_auto_renew_v1_${pubkey.toLowerCase()}` : null;
  const [storeAutoRenewEnabled, setStoreAutoRenewEnabled] = useState(() => {
    if (!pubkey || typeof localStorage === "undefined") return false;
    try {
      return localStorage.getItem(`chama_store_auto_renew_v1_${pubkey.toLowerCase()}`) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!autoRenewStorageKey || typeof localStorage === "undefined") {
      setStoreAutoRenewEnabled(false);
      return;
    }
    try {
      setStoreAutoRenewEnabled(localStorage.getItem(autoRenewStorageKey) === "1");
    } catch {
      setStoreAutoRenewEnabled(false);
    }
  }, [autoRenewStorageKey]);
  const changeStoreAutoRenew = (enabled: boolean) => {
    setStoreAutoRenewEnabled(enabled);
    if (!autoRenewStorageKey || typeof localStorage === "undefined") return;
    try {
      if (enabled) localStorage.setItem(autoRenewStorageKey, "1");
      else localStorage.removeItem(autoRenewStorageKey);
    } catch {
      // Best-effort preference; the in-memory choice still applies this session.
    }
  };
  // Auto-renew dedupe: an id we've already re-published this session so the
  // online effect can't re-fire on the same lapsed listing every tick.
  const autoRenewedRef = useRef<Set<string>>(new Set());

  const renewListing = async (id: string) => {
    setRenewingId(id);
    try {
      // A MANUAL renew is a deliberate "keep this store alive" — mark the
      // offer's lineage kept so the auto-renew age-out cap never lapses it.
      const src = escrows.get(id);
      if (src) markManuallyKept(listingIdentityKey(src));
      const { escrowId } = await actions.renewListing(id);
      markRetired(id); // durably supersede the old lapsed source
      setToast({ message: t("me.storeRenewed"), type: "success" });
      openEscrow(escrowId, "me");
    } catch (e: any) {
      setToast({ message: e?.message || t("me.storeRenewFailed"), type: "error" });
    } finally {
      setRenewingId(null);
    }
  };

  // "Clear my unfunded listings" (#82): the seller's own never-funded offers —
  // the wall of stale/abandoned/test listings. Retiring them drops them from
  // Browse/Me immediately and they lapse for everyone within ~24h (no CANCEL
  // write-burst). Only touches the user's OWN unfunded listings.
  const clearableListings = pubkey
    ? ownUnfundedListings(escrows.values(), pubkey, retiredIds)
    : [];
  // A1b: the trades this device knows, for the seated arbiter's ruling
  // concentration on TradeDetail. Materialized once per escrow-map change so
  // the card's memo has a stable identity to key on — a fresh array every
  // render would recompute the concentration on every keystroke in the chat.
  const knownTradesForConcentration = useMemo(() => [...escrows.values()], [escrows]);

  const [showClearListings, setShowClearListings] = useState(false);
  const clearUnfundedListings = () => {
    for (const s of clearableListings) retireListing(s.id);
    setRetiredTick((n) => n + 1);
    setShowClearListings(false);
    setToast({ message: t("me.listingsCleared", { count: clearableListings.length }), type: "success" });
  };

  // Tier 3 bond resolution: chain-verify the seller's own bond once per connect
  // (fail-soft — any hiccup leaves them unbonded ⇒ manual renew only).
  useEffect(() => {
    if (!connected || !pubkey || !browseCommunity) { setSellerBonded(false); setBondTip(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const [bonds, tip] = await Promise.all([actions.fetchCommunityBonds(browseCommunity), actions.getBondChainTip()]);
        if (!cancelled) { setSellerBonded(sellerIsBonded(bonds, pubkey)); setBondTip(tip); }
      } catch { if (!cancelled) setSellerBonded(false); }
    })();
    return () => { cancelled = true; };
  }, [connected, pubkey, browseCommunity]);

  // Tier 1 auto-renew (online-gated, bonded-only): while the seller's client is
  // connected, re-publish their about-to-lapse / just-lapsed UNFUNDED stores so
  // the shopfront never disappears between buyers. DECIDED: requires the seller
  // online (a vanished owner's store SHOULD lapse — auto-renew is a liveness
  // signal). Unbonded sellers get manual renew only, so this no-ops for them.
  useEffect(() => {
    // A locally journaled+broadcast direct rollover gets a tightly bounded
    // storefront-only bridge while its replacement waits for 1 confirmation.
    // It never flows into the verified bond pool used for arbiter privileges.
    const storeBondContinuity = sellerBonded || hasPendingStoreRollover(listCommitmentBonds(), bondTip, Date.now());
    // Keep-my-offers-live is a bonded-seller privilege. If the active bond is
    // absent, the control is hidden and this background path is inert.
    if (!connected || !pubkey || !sellerBonded || !storeAutoRenewEnabled) return;
    // Persistent retired ledger is the cross-reload guard; autoRenewedRef stays
    // the in-session guard on top. Cap per pass so a pathological state can't
    // burst dozens of relay publishes on one load — the rest resolve next pass.
    const renewables = autoRenewableListings(
      escrows.values(), pubkey, now, getRetiredIds(), { bonded: storeBondContinuity },
    )
      .filter((l) => !autoRenewedRef.current.has(l.id))
      // Age-out (#82): stop auto-renewing an abandoned/test offer once its
      // lineage has hit the cap with no buyer interest. A listing that ever had
      // a JOIN/hold, or that the seller manually renewed, is exempt and stays.
      .filter((l) => {
        const key = listingIdentityKey(l);
        return !shouldAgeOutListing({
          autoRenewCount: getAutoRenewCount(key),
          manuallyKept: isManuallyKept(key),
          hasBuyerInterest: listingHasBuyerInterest(l),
          // Lane-aware: a 30-day Work offer gets ~30 cycles, a store keeps 7.
          cap: resolveRenewalPolicy(l, { bonded: storeBondContinuity }).maxAutoRenewCycles,
        });
      })
      .slice(0, 5);
    if (renewables.length === 0) return;
    for (const l of renewables) {
      autoRenewedRef.current.add(l.id); // mark first so a throw can't hot-loop
      bumpAutoRenewCount(listingIdentityKey(l)); // count this lineage's auto-renew
      void actions
        .renewListing(l.id)
        .then(() => markRetired(l.id)) // durably supersede the old source
        .catch((e: any) => {
          console.warn("[chama] auto-renew failed:", l.id, e?.message || e);
        });
    }
  }, [connected, pubkey, sellerBonded, bondTip, storeAutoRenewEnabled, escrows, now]);

  // One-time dedupe (#74/#75): collapse an existing pile of accidental renewals
  // (the pre-fix +N-per-open duplication) down to one live listing per unique
  // offer. Retire ALL-BUT-THE-NEWEST of each identity group among the seller's
  // own unfunded listings. ⚠ Scoped to NEVER-FUNDED but NOT gated on lapsed: the
  // accumulated duplicates are freshly-renewed copies with a 24h window still
  // OPEN (not lapsed yet), so a lapsed-only scope missed them and the clone-war
  // pile survived. Any never-locked owned listing is a candidate; the identity
  // grouping keeps distinct offers intact (only byte-identical copies collapse).
  // NOT latched: re-runs whenever the loaded escrow set changes so duplicates
  // that STREAM in later (loadEscrow rehydrates listings over time) also get
  // collapsed. Idempotent — once a group is down to its single newest listing,
  // `superseded` is empty and it early-returns without touching state, so it
  // can't loop (setRetiredTick isn't in the deps).
  useEffect(() => {
    if (!connected || !pubkey) return;
    const retired = getRetiredIds();
    const ownUnfunded = [...escrows.values()].filter(
      (s) => isSellerOwnedListing(s, pubkey) && listingNeverFunded(s) && !retired.has(s.id),
    );
    const superseded = supersededListingIds(ownUnfunded);
    if (superseded.length === 0) return;
    for (const id of superseded) retireListing(id);
    setRetiredTick((n) => n + 1);
  }, [connected, pubkey, escrows]);

  // ── Monthly CBP recurrence ─────────────────────────────────────────────
  // The owner's active recurring bill series (from local storage), resolved to
  // the currently-loaded instance state for display. Drives the "🔁 Monthly
  // bill" card (indicator + Stop). Recomputed cheaply as escrows/now change.
  const [, setRecurringTick] = useState(0);
  const recurringSeries = pubkey
    ? activeCbpRecurrence()
        .map((cfg) => ({ cfg, state: escrows.get(cfg.lastPostId) ?? escrows.get(cfg.seriesId) ?? null }))
    : [];
  // Per-cycle dedupe so the effect can't re-fire a repost on the same 30-day
  // cycle while it's in flight or before the loaded state updates. Keyed by
  // (seriesId, lastPostAt) — recordCbpRepost advances lastPostAt so the NEXT
  // cycle re-arms naturally 30 days later.
  const cbpRepostedRef = useRef<Set<string>>(new Set());

  const cancelRecurring = (seriesId: string) => {
    cancelCbpRecurrence(seriesId);
    setToast({ message: t("me.recurringStopped"), type: "info" });
    setRecurringTick((n) => n + 1); // re-render so the card drops immediately
  };

  // Retire duplicate historical recurrence registrations before the repost
  // effect below runs. This is intentionally identity-exact and never touches
  // already-published/funded trades; it only prevents another clone next month.
  useEffect(() => {
    if (!connected || !pubkey) return;
    const duplicates = supersededRecurringSeriesIds(activeCbpRecurrence(), escrows);
    if (duplicates.length === 0) return;
    for (const seriesId of duplicates) cancelCbpRecurrence(seriesId);
    setRecurringTick((n) => n + 1);
  }, [connected, pubkey, escrows]);

  // Auto-repost effect (online-gated, NO bond gate — CBP is self-limiting).
  // Home-community-only + zero-sats are inherent: repostRecurringCbp reuses
  // buildRenewCreateParams, which copies the listing's own community (= home)
  // and re-publishes a fresh CREATE. Anti-stacking (concurrent-unpaid cap = 1)
  // lives in dueRecurringSeries via priorInstanceBlocks.
  useEffect(() => {
    if (!connected || !pubkey) return;
    const due = dueRecurringSeries(escrows, now);
    for (const cfg of due) {
      const cycleKey = `${cfg.seriesId}:${cfg.lastPostAt}`;
      if (cbpRepostedRef.current.has(cycleKey)) continue;
      // Need a loaded source instance to rebuild the CREATE from. If neither the
      // latest instance nor the original series listing is loaded this session,
      // skip WITHOUT marking done so it retries once the chain rehydrates.
      const sourceId = escrows.has(cfg.lastPostId)
        ? cfg.lastPostId
        : escrows.has(cfg.seriesId)
          ? cfg.seriesId
          : null;
      if (!sourceId) continue;
      cbpRepostedRef.current.add(cycleKey); // mark first so a throw can't hot-loop
      void actions
        .repostRecurringCbp(sourceId)
        .then(({ escrowId }) => {
          recordCbpRepost(cfg.seriesId, escrowId, Math.floor(Date.now() / 1000));
          markRetired(sourceId); // durably supersede the reposted source instance
        })
        .catch((e: any) => {
          console.warn("[chama] cbp-recurrence repost failed:", cfg.seriesId, e?.message || e);
        });
    }
  }, [connected, pubkey, escrows, now]);

  // v0.6.5: hasActiveBuyerSellerCommitment + findActiveTrade are now
  // informational only — they still drive the ChamaBar "in escrow"
  // pill and the ActiveTradePill, but no longer gate Create or Fund.
  // The only gate is isMidFunding (one funding *operation* at a time;
  // see decisions.ts header comment).
  const activeTrade = pubkey
    ? findActiveTrade({ escrows: escrows.values(), userPubkey: pubkey, nowSec: now })
    : null;
  const hasActiveCommitment = pubkey
    ? hasActiveBuyerSellerCommitment({ escrows: escrows.values(), userPubkey: pubkey, nowSec: now })
    : false;
  const activeCommitmentCount = pubkey
    ? countActiveBuyerSellerCommitments({ escrows: escrows.values(), userPubkey: pubkey, nowSec: now })
    : 0;
  // Arbiter earnings are intentionally federation-bound and preserved in
  // separate stores. This flag only comes from a real locked bond; buyers,
  // sellers, and future Stack users retain the single-federation balance gate.
  const preservesArbiterFederationBalances = listCommitmentBonds()
    .some((bond) => bond.phase === "locked");
  // v0.6.5: total amountMsats across every live buyer/seller trade.
  // Drives the ActiveTradePill headline "N active trades · X sats"
  // honestly — the implied total reading. Distinct from
  // activeCommittedMsats below (LOCKED+APPROVED only, "actually in
  // escrow" — ChamaBar's reading).
  const activeTradeMsats = pubkey
    ? sumActiveBuyerSellerTradeMsats({ escrows: escrows.values(), userPubkey: pubkey, nowSec: now })
    : 0;
  // v0.4.2 hotfix round 3: msats locked in active escrows where the
  // user is buyer/seller. Drives the ChamaBar "X sats in escrow" pill
  // during LOCKED state, when balance is correctly 0 (ecash spent
  // into SSS shares) but the commitment is still live.
  const committedMsats = pubkey
    ? activeCommittedMsats({ escrows: escrows.values(), userPubkey: pubkey, nowSec: now })
    : 0;

  // Part ① — liquidity/attention: the trades needing the user to act right now,
  // most-urgent first (claim → dispute → vote/deliver → buyer-waiting). Drives
  // the Me-tab red badge and promotes the attention pill to its loud, actionable
  // "N waiting · tap to act" reading (routing to the most urgent item). Falls
  // back to the calm active-trade pill when nothing needs the user.
  const [pendingOnchainPayoutIds, setPendingOnchainPayoutIds] = useState<ReadonlySet<string>>(new Set());
  const refreshOnchainPayoutAttention = useCallback(async () => {
    if (!pubkey) {
      setPendingOnchainPayoutIds(new Set());
      return { payouts: [], balanceSats: 0n };
    }
    const result = await actions.scanMyOnchainPayouts();
    setPendingOnchainPayoutIds(new Set(
      result.payouts
        .filter(payout => payout.balanceSats > 0n)
        .map(payout => payout.escrowId),
    ));
    return result;
  }, [pubkey, actions.scanMyOnchainPayouts]);
  const onchainPayoutScanKey = pubkey
    ? [...escrows.values()]
        .filter(trade => !!trade.lock.onchain && getWinner(trade)?.pubkey === pubkey)
        .map(trade => `${trade.id}:${trade.status}`)
        .sort()
        .join("|")
    : "";
  useEffect(() => {
    if (!pubkey || !onchainPayoutScanKey) {
      setPendingOnchainPayoutIds(new Set());
      return;
    }
    const refresh = () => { void refreshOnchainPayoutAttention().catch(() => undefined); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [pubkey, onchainPayoutScanKey, refreshOnchainPayoutAttention]);

  const ordinaryNeedsYouTrades = pubkey
    ? selectNeedsYouTrades({ escrows: escrows.values(), userPubkey: pubkey, nowSec: now })
    : [];
  const needsYouTrades = mergeOnchainPayoutAttention({
    needsYou: ordinaryNeedsYouTrades,
    escrows: escrows.values(),
    pendingEscrowIds: pendingOnchainPayoutIds,
  });
  const needsYouCount = needsYouTrades.length;
  const attentionTrade = needsYouTrades[0] ?? activeTrade;
  // Participant discovery hydrates incrementally. A partial set makes the
  // orange summary count/amount visibly count down, so keep it neutral until
  // the initial saved-ID + relay pass is complete.
  const visibleAttentionTrade = myTradesLoading ? null : attentionTrade;
  const attentionActionMode = needsYouCount > 0;

  // v0.6.5 funding-operation gate. The single backstop against two
  // concurrent runFundAndLock calls racing on the shared OPFS wallet.
  // Disables the Fund button on the active listing detail; everything
  // else stays open. isMidFunding accepts either spelling — passing
  // the state field directly keeps the call site terse.
  const midFunding = isMidFunding({ fundingInProgress });

  // #37: pending SDK-wallet lock attempts (crash-window recovery). While an
  // actionable entry exists, the balance belongs to a KNOWN trade — the
  // drain-shaped surfaces (banner / stranded pill / Me recover card /
  // fed-switch drain CTA) suppress and the "finish locking" card takes
  // over. Synchronous scoped-localStorage read per render, same precedent
  // as isSimModeOn() below; empty (and cost-free) pre-connect.
  // Sim/testnet render NOTHING here (F4): a real-mode entry must not offer
  // a resume whose lock would spend fake notes into a real trade; the
  // entries wait untouched for the next real-mode session.
  // Fed + balance context bound the story (F1/F9): other-fed entries go to
  // the calm stuck card instead of suppressing, and an intent only speaks
  // when the balance could actually satisfy its lock.
  const nativeLockSummary = (!isSimModeOn() && !isTestnetMode())
    ? summarizeNativeLocksForUi(listPendingNativeLocks(), Date.now(), {
        currentFederationId: fedimint.federationId,
        balanceMsats: fedimint.balanceMsats ?? 0,
      })
    : { suppressRecovery: false, resume: null, stuck: [] };
  // Display-side staleness filter: only offer resume while the trade is
  // still lockable (CREATED) — or not yet loaded (trust the stash until
  // relay state proves otherwise; the boot drain settles it).
  const nativeLockResume = nativeLockSummary.resume && (() => {
    const trade = escrows.get(nativeLockSummary.resume.escrowId);
    return !trade || trade.status === EscrowStatus.CREATED;
  })()
    ? nativeLockSummary.resume
    : null;
  // Suppress the drain surfaces ONLY while the resume is actually ACTIONABLE
  // (its trade is still CREATED / not-yet-loaded). A stash entry whose trade
  // has since gone terminal/expired must NOT keep suppressing — that would
  // hide a safe, recoverable balance for up to the intent TTL (the re-absorb
  // story-loss gap: a downgraded-to-intent trade that later expires). Once
  // the resume is filtered out, the funding trace + honest "funds returned"
  // banner take over instead. (summarize couples suppressRecovery↔resume, so
  // this only ever RELEASES suppression the display filter already dropped.)
  const hasPendingNativeLock = nativeLockResume !== null;

  // Stranded-payout recovery: the claim-side analog of the block above. A
  // CLAIMED-not-COMPLETED trade the user won means claimed ecash sits in
  // the wallet with its outbound payout still owed — that balance is
  // EXPLAINED, so the drain-shaped surfaces suppress and the calm "Finish
  // your payout" card takes over (the trade's own double-pay-guarded RETRY
  // CLAIM is the money path). Bounded upstream: other-fed trades and
  // entries older than PENDING_PAYOUT_SUPPRESS_MAX_MS stop suppressing.
  // Sim/testnet render nothing here, same gate as the native-lock summary.
  const pendingPayoutSummary = (pubkey && !isSimModeOn() && !isTestnetMode())
    ? summarizePendingPayoutsForUi({
        escrows: escrows.values(),
        userPubkey: pubkey,
        getPayoutRecord,
        balanceMsats: fedimint.balanceMsats ?? 0,
        nowMs: Date.now(),
        currentFederationId: fedimint.federationId,
      })
    : { suppressRecovery: false, card: null, entries: [] };
  const hasPendingClaimPayout = pendingPayoutSummary.suppressRecovery;
  // Display-side staleness filter, mirroring nativeLockResume: only card a
  // trade that's still CLAIMED locally (the summary reads the same map, so
  // this is just belt-and-braces against a mid-render status flip).
  const pendingPayoutCard = pendingPayoutSummary.card
    && escrows.get(pendingPayoutSummary.card.escrowId)?.status === EscrowStatus.CLAIMED
    ? pendingPayoutSummary.card
    : null;

  // #37: one-tap resume. The bridge settles the stashed entry first
  // (re-absorb / idempotent already-locked return), then locks fresh from
  // the restored balance — no new invoice, no double payment.
  const handleFinishPendingLock = async () => {
    if (!nativeLockResume || pendingLockBusy) return;
    const { escrowId, lockOpts } = nativeLockResume;
    setPendingLockBusy(true);
    try {
      const st = await actions.lockAndPublish(escrowId, lockOpts ?? {});
      // Positive confirmation (F5): the hook swallows "Cannot LOCK" as a
      // benign stale and resolves with the current state — a trade that
      // just went terminal must not toast a success.
      if (st?.lock?.notesHash) {
        setToast({ message: t("app.lockFinished"), type: "success" });
      } else {
        setToast({
          message: t("app.lockNoLongerPossible"),
          type: "info",
        });
      }
      openEscrow(escrowId);
    } catch (e: any) {
      setToast({
        message: e?.message || t("app.lockFinishRetrying"),
        type: "error",
      });
    } finally {
      setPendingLockBusy(false);
    }
  };

  // Stranded-payout recovery: boot sweep. Every CLAIMED trade the user won
  // that still holds a payout-journal record gets ONE background
  // reattachPayout per session — a stuck "payout confirming" resolves
  // (settled → COMPLETE published, refunded → record cleared so RETRY CLAIM
  // goes live) without the user having to re-open the trade. reattachPayout
  // only re-attaches to the existing operationId; it structurally never
  // re-pays. Gated on an initialized wallet so requireBridge() inside
  // doesn't fail-soft and waste the once-per-session latch.
  useEffect(() => {
    if (!pubkey || !fedimint.initialized) return;
    if (isSimModeOn() || isTestnetMode()) return;
    const targets = selectPayoutReattachTargets({
      escrows: escrows.values(),
      userPubkey: pubkey,
      getPayoutRecord,
    });
    for (const id of targets) {
      if (payoutReattachSweptRef.current.has(id)) continue;
      payoutReattachSweptRef.current.add(id);
      void actions.reattachPayout(id);
    }
    // actions.* is a fresh identity each render but reads live refs
    // internally (same pattern as the MeScreen liveness effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, fedimint.initialized, escrows]);

  // Arbiter premium (task #53 E1), payer side: every COMPLETED trade on
  // which I still owe the 0.25% premium (bonded seated arbiter, no outbox
  // record — paid/declined/sending all block) gets ONE background pay per
  // session. Covers both the live settle moment (COMPLETED propagates into
  // `escrows`) and the boot catch-up (trade settled while I was offline).
  useEffect(() => {
    if (!pubkey || !fedimint.initialized) return;
    if (isSimModeOn() || isTestnetMode()) return;
    const targets = selectPremiumPayTargets({
      escrows: escrows.values(),
      myPubkey: pubkey,
      hasOutboxRecord: hasPremiumOutboxRecord,
    });
    for (const id of targets) {
      if (premiumPaySweptRef.current.has(id)) continue;
      premiumPaySweptRef.current.add(id);
      void actions.payArbiterPremium(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, fedimint.initialized, escrows]);

  // Arbiter premium, arbiter side: redeem premium notes addressed to me.
  // Latched per (trade, note-count) so a NEW note arriving mid-session
  // re-triggers the sweep for that trade.
  useEffect(() => {
    if (!pubkey || !fedimint.initialized) return;
    if (isSimModeOn() || isTestnetMode()) return;
    const targets = selectPremiumRedeemTargets({
      escrows: escrows.values(),
      myPubkey: pubkey,
      isSettled: isEarningSettled,
    });
    for (const id of targets) {
      // A premium note is federation-bound ecash. Switching from the wrong
      // federation to the note's federation must license a fresh redeem
      // attempt; the old latch keyed only by trade + note count permanently
      // suppressed that retry for the rest of the session.
      const latch = `v2:${fedimint.federationId ?? "no-fed"}:${id}:${escrows.get(id)?.premiumNotes?.length ?? 0}`;
      if (premiumRedeemSweptRef.current.has(latch)) continue;
      premiumRedeemSweptRef.current.add(latch);
      void actions.redeemArbiterPremiums(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, fedimint.initialized, fedimint.federationId, escrows]);

  // Task #62 arbiter redeem-probe: the sweep above only walks LOADED
  // trades — a settled trade is unwatched and discovery-skipped, so a
  // premium published AFTER settlement never reaches a passive arbiter's
  // state through it. Probe relays for 38113s #p-tagged to me at boot plus
  // a gentle re-probe (one cheap single-filter REQ) and loadEscrow+redeem
  // whatever's missing. The action is fail-soft and self-idempotent (the
  // earnings ledger settles each note once).
  useEffect(() => {
    if (!pubkey || !fedimint.initialized) return;
    if (isSimModeOn() || isTestnetMode()) return;
    void actions.probeArbiterPremiums();
    const timer = setInterval(
      () => void actions.probeArbiterPremiums(),
      PREMIUM_PROBE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, fedimint.initialized, fedimint.federationId]);

  // v0.2.0 item 2: recovery banner. Fires when balance > 0 AND nothing
  // else explains the balance — no locked/approved commitment, no
  // mid-funding flow, no mid-claim sweep. CREATED listings do not explain
  // local ecash because no money has moved yet.
  const showRecoveryBanner = shouldShowRecoveryBanner({
    balanceMsats: fedimint.balanceMsats ?? 0,
    hasAnyActiveEscrow: committedMsats > 0,
    fundingInProgress: midFunding,
    claimPayoutInProgress,
    // Phase 1: sim manual-fund balances are intentional & fake — never let
    // the production stranded-funds alarm fire on them. Read isSimModeOn()
    // directly (a pure localStorage read); the memoized `simOn` in the
    // connect-screen block is declared later in this render body.
    simModeOn: isSimModeOn(),
    hasPendingNativeLock,
    // Stranded-payout recovery: an unfinished claim payout explains the
    // balance — the "Finish your payout" card owns the story instead.
    hasPendingClaimPayout,
  });
  const walletBalanceMsats = fedimint.balanceMsats ?? 0;
  // #37: the pending-lock gate also stops the WRONG durable attribution —
  // without it, the effect below persists an "inferred-from-claim-history"
  // sats-trace naming an unrelated old claim for a balance that actually
  // belongs to the pending lock's trade (fires from 1 sat, banner or not).
  const hasTraceableIdleBalance = Math.floor(Math.max(0, walletBalanceMsats) / 1000) > 0
    && committedMsats <= 0
    && !midFunding
    && !claimPayoutInProgress
    && !hasPendingNativeLock
    // Same rule for a pending claim payout: while it owns the balance
    // story, don't persist an inferred-from-claim-history trace that may
    // name a DIFFERENT (older) claim than the one actually pending.
    && !hasPendingClaimPayout;
  const traceableStrandedSource = pubkey && hasTraceableIdleBalance
    ? identifyStrandedEcashSource({ escrows: escrows.values(), userPubkey: pubkey })
    : null;
  const bestSatsTrace: SatsTraceEntry | null = getBestSatsTrace(walletBalanceMsats);
  // Re-absorb story-loss fix + attribution correctness: a FUNDING trace is a
  // DIRECT record of "this balance is your funding for trade X that didn't
  // lock" (written by fund-and-lock's lock-failed-after-funding + the
  // reabsorb's lock-reabsorbed). It BEATS identifyStrandedEcashSource, which
  // WALKS claim history and mis-attributes a funding residue to an unrelated
  // old claim (Jetty's ₿6,463-buyer-card-on-a-₿2,000-funding-balance repro).
  // Scan the open traces (persisted, synchronous — so the banner is stable
  // from first render, no glitchy claim-walk flip as escrows load async) for
  // a funding trace whose amount explains the balance.
  const fundingResidueTrace = showRecoveryBanner
    ? (listOpenSatsTraces().find(t =>
        t.source === "funding" && !!t.escrowId && typeof t.amountMsats === "number"
        && strandedSourceExplainsBalance(t.amountMsats, walletBalanceMsats)) ?? null)
    : null;
  const fundingReturned = !!fundingResidueTrace;
  // The RIGHT trade to name on the funds-returned card (the funded trade
  // itself), looked up from the trace's escrowId. Description fills in once
  // the escrow loads; the id + amount are always honest.
  const fundingTrade = fundingResidueTrace
    ? {
        escrowId: fundingResidueTrace.escrowId!,
        description: escrows.get(fundingResidueTrace.escrowId!)?.description ?? "",
        amountMsats: fundingResidueTrace.amountMsats!,
      }
    : null;
  // Stranded-payout recovery (attribution honesty): the CLAIM identity card
  // only names a claim whose amount can explain the balance being swept, and
  // only when a funding trace hasn't already claimed the story. When residue
  // from more than one trade is mixed in (a ₿1,570 claim on a ₿2,462 balance)
  // the card drops to "leftover sats from earlier trades" — it never fronts
  // an aggregate sweep with a single trade's number.
  const strandedSourceConsistent = !!traceableStrandedSource
    && strandedSourceExplainsBalance(traceableStrandedSource.amountMsats, walletBalanceMsats);
  const strandedSource = showRecoveryBanner && !fundingReturned && strandedSourceConsistent
    ? traceableStrandedSource
    : null;
  const strandedGenericResidue =
    showRecoveryBanner && !fundingReturned && !!traceableStrandedSource && !strandedSourceConsistent;
  const displayedSatsTrace: SatsTraceEntry | null = bestSatsTrace ?? (
    traceableStrandedSource
      ? {
          id: `inferred_${traceableStrandedSource.escrowId}`,
          source: "claim",
          status: "open",
          escrowId: traceableStrandedSource.escrowId,
          amountMsats: traceableStrandedSource.amountMsats,
          balanceMsats: walletBalanceMsats,
          reason: "inferred-from-claim-history",
          createdAt: now,
          updatedAt: now,
        }
      : null
  );
  // Stranded-payout recovery (stale-key fix): the recovery drain's
  // double-pay journal is keyed by this escrowId — an INHERITED key from
  // the most-recent-CLAIM / sats-trace inference. If that trade's amount
  // can't explain the live balance, the key is provably about some OTHER
  // (usually already-settled) payout, and keying the drain to it makes the
  // journal's settled short-circuit return a false green "Recovered!"
  // without sending anything (the observed Recover → success → banner-back
  // no-op loop). Same consistency rule as the banner's identity card:
  // unexplained balance ⇒ keyless drain ("a drained balance is its own
  // guard", balance-recovery.ts).
  const recoveryTraceCandidate = traceableStrandedSource
    ? { escrowId: traceableStrandedSource.escrowId as string | undefined, amountMsats: traceableStrandedSource.amountMsats as number | undefined }
    : { escrowId: bestSatsTrace?.escrowId, amountMsats: bestSatsTrace?.amountMsats };
  const recoveryKeyTrusted = recoveryTraceCandidate.escrowId !== undefined
    && recoveryTraceCandidate.amountMsats !== undefined
    && strandedSourceExplainsBalance(recoveryTraceCandidate.amountMsats, walletBalanceMsats);
  const recoveryTraceContext = pendingRecovery?.traceContext ?? {
    escrowId: recoveryKeyTrusted ? recoveryTraceCandidate.escrowId : undefined,
    amountMsats: recoveryTraceCandidate.amountMsats,
  };

  useEffect(() => {
    if (!traceableStrandedSource || bestSatsTrace) return;
    recordSatsTrace({
      source: "claim",
      escrowId: traceableStrandedSource.escrowId,
      amountMsats: traceableStrandedSource.amountMsats,
      balanceMsats: walletBalanceMsats,
      reason: "inferred-from-claim-history",
    });
  }, [
    bestSatsTrace?.id,
    traceableStrandedSource?.escrowId,
    traceableStrandedSource?.amountMsats,
    walletBalanceMsats,
  ]);

  // v0.2.0 item 10: arbiter attention warning. Computed once at App
  // level and threaded into the Create wizard. Fires alongside the
  // buyer/seller hard-block; in practice the hard-block takes priority
  // (a buyer/seller on a non-terminal trade can't reach Create at all).
  const arbiterWarning = pubkey
    ? decideArbiterWarning({ escrows: escrows.values(), userPubkey: pubkey })
    : { kind: "none" as const };

  // v0.2.0 item 7: graduated trust gate for subscription mode. v0.2.0
  // ships with the aggregator returning null (no rating events being
  // published yet) → gate is closed for everyone. v0.2.1 wires the
  // aggregator and the gate naturally opens for qualifying sellers.
  const userCanSubscribe = canOfferSubscription({ ratings: myRatings });

  // v0.2.0 item 4: browse two-section layout. matchingListings render
  // first as normal cards; nonMatchingListings render below an
  // "N LISTINGS ON OTHER FEDERATIONS" divider with amber tint per
  // chama_browse_amber_tint_sorted spec. The community-pill filter
  // is gone (along with the "All" pill in v0.1.87) — pills are
  // identity-only now; Browse shows everything fed-routed.
  //
  // Match predicate: prefer the CREATE event's `fed` id when present,
  // falling back to mintUrl for legacy listings. The fed id is the
  // load-bearing money-route fact; mintUrl can be stale if a power user
  // switched routes without changing their home community.
  const myActiveInvite = liveActiveInvite;
  // #7 Stage 3: index child purchases by parent so a multi-unit listing can
  // show a derived "N left" and drop off Browse when sold out. Children seen via
  // the public CREATE feed are enough to subtract visible reservations; a
  // prospective buyer can't decrypt others' LOCKs, so this is a safe estimate
  // (an overcommit just refunds — Option A).
  const childrenByParent = new Map<string, EscrowState[]>();
  for (const s of escrows.values()) {
    if (s.parent !== undefined) {
      const arr = childrenByParent.get(s.parent);
      if (arr) arr.push(s); else childrenByParent.set(s.parent, [s]);
    }
  }
  const listingChildren = (s: EscrowState) => childrenByParent.get(s.id) ?? [];
  // #70 seller-side order indicators: a parent storefront card must surface
  // EVERY live child order's attention, not just its own chat. Child orders
  // never appear as their own Browse cards (shouldShowOnBrowse filters
  // parent !== undefined), so without this the seller sees a single indicator
  // however many orders are open. Aggregate, per parent, the count of active
  // child orders + the unread chat across them (unreadChatForTrade returns 0 for
  // a non-participant, so this is non-zero only on the viewer's OWN listings).
  const listingOrderIndicator = new Map<string, { orders: number; unread: number; viewerOrderId?: string }>();
  for (const [parentId, kids] of childrenByParent) {
    const parent = escrows.get(parentId);
    const viewerOwnsParent = parent?.participants[Role.SELLER] === pubkey
      || (parent?.initiator.role === Role.SELLER && parent.initiator.pubkey === pubkey);
    let orders = 0;
    let unread = 0;
    let viewerOrder: EscrowState | null = null;
    for (const c of kids) {
      if (!isActiveChildOrder(c)) continue;
      if (viewerOwnsParent) orders++;
      const myRole = c.participants[Role.SELLER] === pubkey ? Role.SELLER
        : c.participants[Role.BUYER] === pubkey ? Role.BUYER
        : c.participants[Role.ARBITER] === pubkey ? Role.ARBITER
        : null;
      if (myRole) unread += unreadChatForTrade(c, myRole);
      if (myRole === Role.BUYER && (!viewerOrder || c.createdAt > viewerOrder.createdAt)) {
        viewerOrder = c;
      }
    }
    if (orders > 0 || viewerOrder) {
      listingOrderIndicator.set(parentId, {
        orders,
        unread,
        viewerOrderId: viewerOrder?.id,
      });
    }
  }
  const listingSoldOut = (s: EscrowState) =>
    s.stock !== undefined && isSoldOut(s, listingChildren(s), now);
  const allVisibleListings = visibleTrades.filter(s =>
    // #74/#75: a listing superseded by a renewal/repost/dedupe must not render
    // as a live offer OR be counted. Retired is device-local (owner-only), so
    // this only ever hides the owner's own superseded duplicates.
    !retiredIds.has(s.id) &&
    // Slicing is paused, but its replay code remains for history/recovery.
    // Do not advertise old sliced parents beside today's single escrows.
    (TRADE_SLICING_ENABLED || !isSlicedTradeShape(s)) &&
    shouldShowOnBrowse({ escrow: s, browseCategory: "all", nowSec: now, isSoldOut: listingSoldOut(s) })
  );
  const visibleListings = allVisibleListings.filter(s =>
    shouldShowOnBrowse({ escrow: s, browseCategory, nowSec: now, isSoldOut: listingSoldOut(s) })
  );
  // "N left" badge data for the cards — only for multi-unit parents (stock set).
  const stockByListing = new Map<string, number>();
  for (const s of allVisibleListings) {
    if (s.stock !== undefined) stockByListing.set(s.id, remainingStock(s, listingChildren(s), now));
  }
  // #7 seller overcommit refund: which child orders are OVERSOLD (locked beyond
  // the parent's stock by lock order). Reliable only for the seller — they hold
  // every child's lock. Surfaced as a refund banner on the oversold child.
  const oversoldChildIds = new Set<string>();
  for (const [parentId, kids] of childrenByParent) {
    const parentState = escrows.get(parentId);
    if (parentState?.stock !== undefined) {
      for (const c of overcommittedChildren(parentState, kids)) oversoldChildIds.add(c.id);
    }
  }
  const browseCategoryCounts = BROWSE_CATS.reduce((acc, cat) => {
    acc[cat.id] = cat.id === "all"
      ? allVisibleListings.length
      : allVisibleListings.filter(listing =>
          cat.id === "work"
            ? isWorkListing(listing)
            : cat.id === "marketplace"
              ? listing.category === "marketplace" && !isWorkListing(listing)
              : listing.category === cat.id
        ).length;
    return acc;
  }, {} as Record<string, number>);
  const listingMatchesRoute = (s: EscrowState) => listingMatchesActiveRoute({
    listingMintUrl: s.mintUrl,
    listingFedId: (s.eventChain[0]?.payload as { fed?: string } | undefined)?.fed ?? null,
    listingCommunity: s.community,
    activeInvite: myActiveInvite,
    activeFedId: fedimint.federationId,
  });
  const matchingListings = visibleListings.filter(listingMatchesRoute);
  const nonMatchingListings = visibleListings.filter(s => !listingMatchesRoute(s));

  // v0.6.5: belt-and-suspenders live-update guarantee for Browse.
  //
  // loadEscrow already calls watchEscrow internally once hydration
  // succeeds, but a few cold-path edges miss that wiring:
  //   - On reload, prior-session listings sit in `escrows` already,
  //     so the CREATE handler skips loadEscrow (state exists) and
  //     the watchEscrow side-effect doesn't fire.
  //   - Listings hydrated via My-trades replay (the user is a
  //     participant) also bypass the Browse-discovery path.
  //
  // The user reported "if anyone joins, nobody knows unless they
  // refresh" — this re-watch makes JOINs flow live regardless of
  // how the listing first landed in state. watchEscrow is
  // label-keyed inside the client, so duplicate calls are no-ops.
  useEffect(() => {
    for (const listing of visibleListings) {
      actions.watchEscrow(listing.id);
    }
    // visibleListings is recomputed every render; depending on its
    // length is a cheap-enough proxy for "did the visible set change"
    // without forcing deep equality on the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleListings.length, visibleListings.map(l => l.id).join(",")]);
  const selected = selectedId ? escrows.get(selectedId) : null;
  const sellerManagedListing = sellerManageId ? escrows.get(sellerManageId) ?? null : null;
  const selectedPoisonedClaimReason = selected
    ? listPendingRedemptions().find(entry =>
        entry.escrowId === selected.id &&
        !!entry.lastError &&
        !!entry.poisonedAt
      )?.lastError ?? null
    : null;
  const selectedClaimBlockedReason = selected
    ? blockedClaimReasons[selected.id] ?? selectedPoisonedClaimReason
    : null;
  const profilePubkeys = useMemo(() => {
    const keys = new Set<string>();
    const add = (value?: string | null) => {
      const pk = value?.trim().toLowerCase();
      if (pk && /^[0-9a-f]{64}$/.test(pk)) keys.add(pk);
    };

    for (const trade of visibleTrades) {
      add(trade.initiator.pubkey);
      for (const role of TRINITY_RING_ORDER) {
        add(getEffectiveParticipantsAt(trade, now)[role]);
      }
      for (const arbiter of trade.communityArbiters) add(arbiter);
      for (const event of trade.eventChain) add(event.raw.pubkey);
    }

    return Array.from(keys).sort();
  }, [visibleTrades, now]);
  const profilePubkeyKey = profilePubkeys.join(",");

  useEffect(() => {
    if (!kind0Enabled || !connected || connectedRelays === 0 || profilePubkeys.length === 0) return;
    let cancelled = false;

    actions.fetchNostrProfiles(profilePubkeys)
      .then(names => {
        if (cancelled || Object.keys(names).length === 0) return;
        setNostrProfiles(prev => ({ ...prev, ...names }));
      })
      .catch(err => {
        console.debug("[chama] kind:0 profile fetch failed:", err);
      });

    return () => { cancelled = true; };
    // actions is intentionally omitted: the hook returns a fresh object
    // each render, while the fetch target is fully captured by the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind0Enabled, connected, connectedRelays, profilePubkeyKey]);

  const queueDestroyConfirm = (request: PendingDestroyConfirm | null) => {
    if (!request) {
      setPendingDestroyConfirm(null);
      // Modal resolved/dismissed — clear the deliberate stop so a later relay
      // recovery can re-arm auto-init normally.
      autoInitHardStopRef.current = false;
      return;
    }

    if (!preservesArbiterFederationBalances
      && balanceBlocksFederationSwitch(request.balanceMsats)) {
      setPendingDestroyConfirm(request);
      return;
    }

    // Nothing recoverable: sub-fee/sub-sat dust must not open the
    // "Recover & switch" path because that path can only send whole sats.
    setPendingDestroyConfirm(null);
    (async () => {
      const switchStartedAt = Date.now();
      try {
        setSwitchingToCommunity({ displayName: request.label });
        setToast({ message: t("app.switchingToDots", { label: request.label }), type: "info" });
        const persistCustom = !("restoreCommunitySlug" in request);
        if (fedimint.federationId) {
          await actions.switchFederation(request.invite, { persistCustom });
        } else {
          await actions.initFedimint(request.invite, { persistCustom });
        }
        setToast({ message: t("app.onLabel", { label: request.label }), type: "success" });
        if (request.navigateToEscrowAfter) {
          setSelectedId(request.navigateToEscrowAfter);
          setView("detail");
        }
      } catch (e: any) {
        if (
          (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE"
            || e?.code === "SWITCH_REFUSED_NONZERO_BALANCE")
          && balanceBlocksFederationSwitch(e.balanceMsats || 0)
        ) {
          setPendingDestroyConfirm({
            ...request,
            balanceMsats: e.balanceMsats || 0,
            activeInvite: e.previousActiveInvite || request.activeInvite,
          });
          return;
        }
        if ("restoreCommunitySlug" in request) {
          const restoreSlug = request.restoreCommunitySlug;
          actions.setCommunity(restoreSlug ?? "");
          setBrowseCommunity(restoreSlug ?? DEFAULT_COMMUNITY_SLUG);
        }
        setToast({
          message: e?.message || t("app.couldntSwitchTo", { label: request.label }),
          type: "error",
        });
      } finally {
        await waitForSwitchFeedback(switchStartedAt);
        setSwitchingToCommunity(null);
      }
    })();
  };

  // v0.1.66.32: refetch on tap when local state may be stale.
  // v0.2.0 item 1: federation-follows-listing dispatch. When the user
  // taps a listing, we silently re-init to the listing's fed BEFORE
  // the detail screen renders. The detail screen always opens on the
  // right fed, so every action (Fund, payment-handle preview, lock
  // timing, etc.) is coherent regardless of where the user came from.
  // State A vs State B narration is computed inside TradeDetail via
  // decideTradeDetailFraming — always-true post-switch is fine because
  // the framing compares listing.fed against home.fed, not against
  // active.fed.
  const openEscrow = (id: string, returnTo?: View) => {
    const local = escrows.get(id);
    const nextBackView = returnTo ?? (view === "detail" ? detailBackView : view);
    const safeBackView = nextBackView === "detail" ? "browse" : nextBackView;

    // No local copy yet — the listing may have come from a relay
    // refetch race. Fall through to the legacy refetch path; the
    // post-fetch render will see the local copy and the user can
    // re-tap if a switch is needed. Edge case; rare in practice.
    if (!local) {
      setDetailBackView(safeBackView);
      setSelectedId(id);
      setView("detail");
      actions.loadEscrow(id).catch((e: any) => {
        console.debug(
          "[chama] background refetch on openEscrow failed:",
          e?.message || e,
        );
      });
      return;
    }

    // A seller-authored, never-funded listing is inventory/configuration,
    // not an active trade. Its owner gets management actions instead of the
    // buyer-oriented TradeDetail. Spawned/funded child orders still pass
    // through normally because those are real trades requiring attention.
    if (shouldOpenSellerListingManagement({ escrow: local, viewerPubkey: pubkey })) {
      setSellerManageId(id);
      return;
    }

    const effect = decideListingTapEffect({
      listing: {
        mintUrl: local.mintUrl,
        community: local.community,
        fedId: (local.eventChain[0]?.payload as { fed?: string } | undefined)?.fed ?? null,
      },
      currentInvite: liveActiveInvite,
      balanceMsats: preservesArbiterFederationBalances
        ? 0
        : (fedimint.balanceMsats ?? 0),
      activeCommitmentCount,
    });

    // V3 #72 (listing-tap face of the same gate): a foreign-route listing
    // would silently switch the wallet's fed — never out from under a live
    // trade. Matching listings fall through untouched.
    if (effect.kind === "blocked-active-commitment") {
      setToast({
        message: t("app.listingOtherChama"),
        type: "info",
      });
      return;
    }

    // Always background-refetch so the detail screen sees fresh state
    // by the time it renders. Mirrors the pre-v0.2.0 behavior.
    if (!TRULY_TERMINAL_STATES.has(local.status)) {
      actions.loadEscrow(id).catch((e: any) => {
        console.debug(
          "[chama] background refetch on openEscrow failed:",
          e?.message || e,
        );
      });
    }

    if (effect.kind === "matching") {
      setDetailBackView(safeBackView);
      setSelectedId(id);
      setView("detail");
      return;
    }

    if (effect.kind === "switch-silent") {
      setSwitchingToCommunity({ displayName: effect.displayName });
      setToast({ message: t("app.switchingForTrade", { name: effect.displayName }), type: "info" });
      (async () => {
        const switchStartedAt = Date.now();
        try {
          if (fedimint.federationId) {
            await actions.switchFederation(effect.targetInvite);
          } else {
            await actions.initFedimint(effect.targetInvite);
          }
          // V3 #75: this was a listing-tap VISIT — identity stays home, only
          // the wallet's fed moved. Remember it so backing out of the detail
          // view can snap the wallet back to the home fed (unless a live
          // commitment has anchored the user here by then).
          visitedForeignFedRef.current = true;
          setDetailBackView(safeBackView);
          setSelectedId(id);
          setView("detail");
          setToast({ message: t("app.onForTrade", { name: effect.displayName }), type: "success" });
        } catch (e: any) {
          if (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE"
            || e?.code === "SWITCH_REFUSED_NONZERO_BALANCE") {
            // Race: balance was zero at decision time, became non-zero
            // before the switch landed. Surface the modal with the
            // navigate-after target so confirm-then-navigate still works.
            queueDestroyConfirm({
              invite: effect.targetInvite,
              label: effect.displayName,
              balanceMsats: e.balanceMsats || 0,
              activeInvite: e.previousActiveInvite || liveActiveInvite || "",
              navigateToEscrowAfter: id,
            });
          } else {
            setToast({
              message: e?.message || t("app.couldntSwitchTo", { label: effect.displayName }),
              type: "error",
            });
          }
        } finally {
          await waitForSwitchFeedback(switchStartedAt);
          setSwitchingToCommunity(null);
        }
      })();
      return;
    }

    // destroy-confirm — funds at risk on user's current fed, surface
    // the modal. After confirm, the switch happens AND we navigate to
    // the listing detail (per v0.2.0 spec the listing-tap user intent
    // carries through the modal).
    queueDestroyConfirm({
      invite: effect.targetInvite,
      label: effect.displayName,
      balanceMsats: effect.balanceMsats,
      activeInvite: effect.currentInvite,
      navigateToEscrowAfter: id,
    });
  };

  // Open a durable-index "Earlier trade" whose chain isn't loaded. Unlike
  // openEscrow, this AWAITS the rehydrate and only navigates on success — a
  // trade whose events aged off the relay returns null, and blindly opening
  // the detail view for a null escrow silently dumps the user on Browse (the
  // detail render only mounts when `selected` is truthy). Instead: reload,
  // open if it comes back, else stay put and explain honestly.
  const openArchivedTrade = async (id: string) => {
    setToast({ message: t("app.reloadingTrade"), type: "info" });
    // Cap the wait: loadEscrow's relay fetch runs to a 15s timeout and can add
    // completeness retries (~45s worst case), so awaiting it raw left the user
    // hanging on a stuck-looking toast. Race a 10s cap — a reloadable trade
    // (events still on the relay / durable cache) resolves in a couple seconds;
    // an aged-off one just yields the honest "not on the relay" result faster.
    // If loadEscrow finishes AFTER the cap, its result still lands in the live
    // list on the next render (harmless), so we never double-load.
    let state: EscrowState | null = null;
    let timedOut = false;
    try {
      state = await Promise.race([
        // An explicit tap is exactly where paying for a durable-cache rebuild
        // is worth it: the relays may hold only part of this chain, and this
        // device often still has the rest. Boot discovery deliberately does
        // NOT ask for this (see EscrowClient.loadEscrow).
        actions.loadEscrow(id, { repairFromCache: true }),
        new Promise<null>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, 10_000),
        ),
      ]);
    } catch { /* handled below */ }
    if (state) {
      openEscrow(id, "me");
      return;
    }
    // Be honest about WHICH failure this is. The old copy blamed relay
    // eviction for every empty load, including chains that were merely
    // incomplete (a COMPLETED trade whose VOTEs are missing can't replay) and
    // loads that simply hadn't finished. Those tell the user different things
    // about whether the history is coming back.
    const failure = timedOut ? null : actions.getLoadFailure(id);
    // Name the replay error. "chain-incomplete" covers several genuinely
    // different failures — a missing CREATE, a vote threshold that can't be met,
    // a participant the chain doesn't recognise — and the reducer already knows
    // which one (`LoadFailure.code`). Without it the copy reads the same whether
    // the relay lost an event or this device failed to decrypt one, which sent a
    // 2026-08-19 investigation down the wrong path for hours. Terse and
    // technical on purpose: it is a handle for a bug report, not an explanation.
    const code = failure?.reason === "chain-incomplete" && failure.code
      ? ` (${failure.code})`
      : "";
    const message = timedOut
      ? t("app.archivedStillLoading")
      : failure?.reason === "chain-incomplete"
        ? t("app.archivedIncomplete") + code
        : failure?.reason === "undecryptable"
          ? t("app.archivedUnreadable")
          : t("app.archivedNotOnRelay");
    setToast({ message, type: "info" });
  };

  useEffect(() => {
    if (urlEscrowOpenAttemptedRef.current || !connected) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("escrowId") || params.get("trade");
    if (!id || !/^sm_[a-z0-9_]+$/i.test(id)) return;

    urlEscrowOpenAttemptedRef.current = true;
    setDetailBackView("browse");
    setSelectedId(id);
    setView("detail");
    // Deep link = an explicit open, same as tapping an archived trade: worth a
    // durable-cache rebuild if the relays only hold part of the chain.
    actions.loadEscrow(id, { repairFromCache: true }).then((state) => {
      if (!state) {
        setToast({ message: t("app.tradeNotFoundYet", { id }), type: "error" });
      }
    }).catch((e: any) => {
      setToast({ message: e?.message || t("app.couldntLoadTrade", { id }), type: "error" });
    });
  }, [connected, actions]);

  // ── Notification deep-links: a tapped trade notification opens that trade ───
  // Register native tap handlers once at mount. Web taps wire themselves in
  // notify-service via Notification.onclick. Both feed the same pending-deeplink
  // buffer drained below.
  useEffect(() => {
    const unregister = registerNotificationTapHandlers();
    // Opt-in delivery probe (localStorage chama_notify_selftest=1) — fires one
    // known-good notification so an on-device tester can confirm the OS layer
    // delivers at all, independent of any trade transition. No-op otherwise.
    void notifySelfTest();
    return unregister;
  }, []);

  // Drain tap targets once connected — a cold-launch tap can land before the
  // client is up, so we buffer and replay here. openEscrow is the same warm-
  // cache / cold-loadEscrow route the trade list uses, so the user lands on a
  // hydrating TradeDetail, never the list. A no-payload desktop tap resolves to
  // the current active trade.
  useEffect(() => {
    if (!connected) return;
    const route = () => {
      const target = consumePendingTradeDeepLink();
      if (!target) return;
      const id = target === LATEST_ACTIONABLE ? activeTrade?.id : target;
      if (id) openEscrow(id);
    };
    route();
    return onTradeDeepLink(route);
  }, [connected, activeTrade]);

  const handleCreate = async (params: any) => {
    try {
      setToast({ message: t("app.signingNip07"), type: "info" });
      // Monthly CBP: pull off the client-only recurrence intent BEFORE publish so
      // it never leaks into the CREATE event (it's not a consensus field).
      const recurringCbp = params?.recurringCbp === true;
      const recurringCommunity = params?.community ?? null;
      if ("recurringCbp" in (params ?? {})) delete params.recurringCbp;
      const { escrowId } = await actions.createEscrow(params);
      // Register the recurring series locally (bill-pay only, home-community
      // inherited, no bond). Best-effort — a bookkeeping failure never breaks
      // the publish.
      if (recurringCbp && params?.category === "bill-pay") {
        try {
          registerCbpRecurrence({ escrowId, community: recurringCommunity });
        } catch (e) {
          console.warn("[chama] cbp-recurrence register failed:", e);
        }
      }
      setToast({ message: t("app.tradePublished", { escrowId }), type: "success" });
      // Post-publish: land on Browse (the listing is now live among the
      // community's) instead of dumping the seller inside an empty trade to
      // stare at "waiting for a buyer" — dead air. They'll be pulled BACK to the
      // trade by a notification + the attention signal the moment a buyer acts.
      setSelectedId(null);
      setView("browse");
    } catch (e: any) {
      console.error("[chama] Create failed:", e);
      setToast({ message: e.message || t("app.createFailed"), type: "error" });
      throw e;
    }
  };

  const handleSignOut = async () => {
    await removeSavedNsec();
    delete (window as any).__chama_connect_nsec;
    window.location.reload();
  };

  // Community-pill tap and custom-invite-paste handlers live in their
  // own hook so the orchestrator stays an orchestrator. The hook
  // encapsulates the dispatch + revert logic; decision logic
  // (decideCommunityTapEffect) lives in src/ui/decisions.ts.
  // V3 #75: snap the wallet back to the HOME fed after a listing-tap visit.
  // Fires on back-out from the detail view. Self-healing by re-resolving
  // everything at fire time: if the user committed to a trade on the visited
  // fed (hasActiveCommitment), or home can't resolve, or we're already on
  // home's fed, it quietly does nothing. Failure is soft — the user stays on
  // the visited fed and the Me switcher / Reconnect remain the manual paths.
  const maybeSnapBackHome = () => {
    if (!visitedForeignFedRef.current) return;
    visitedForeignFedRef.current = false;
    if (hasActiveCommitment) return; // anchored here now; #72's gate owns the rest
    const homeSlug = getUserCommunitySlugRaw();
    const home = homeSlug ? getCommunityBySlug(homeSlug) : null;
    const homeInvite = home?.federationInvite;
    if (!home || !homeInvite) return;
    const homeFedId = normalizeRouteFedId(expectedFederationIdForInvite(homeInvite));
    const activeFedId = normalizeRouteFedId(fedimint.federationId);
    const alreadyHome = homeFedId && activeFedId
      ? homeFedId === activeFedId
      : liveActiveInvite === homeInvite;
    if (alreadyHome) return;
    void (async () => {
      const switchStartedAt = Date.now();
      try {
        setSwitchingToCommunity({ displayName: home.displayName });
        setToast({ message: t("app.returningTo", { name: home.displayName }), type: "info" });
        await actions.switchFederation(homeInvite);
        setToast({ message: t("app.backHomeIn", { name: home.displayName }), type: "info" });
      } catch (e: any) {
        console.warn("[chama] snap-back to home failed:", e?.message || e);
      } finally {
        await waitForSwitchFeedback(switchStartedAt);
        setSwitchingToCommunity(null);
      }
    })();
  };

  const { handleSelectCommunity, handlePasteCustomInvite } = useFederationCommands({
    fedimint,
    actions,
    activeCommitmentCount,
    preservesFederationBalances: preservesArbiterFederationBalances,
    setToast,
    setBrowseCommunity,
    setPendingDestroyConfirm: queueDestroyConfirm,
  });

  const switchTab = (t: Tab) => {
    if (t === "browse") setView("browse");
    else if (t === "dashboard") setView("dashboard");
    else if (t === "me") setView("me");
    // V3 #75: leaving a visited trade via the bottom nav counts as backing
    // out — same snap-back as the detail back button.
    if (view === "detail") maybeSnapBackHome();
  };

  // ── Not connected → show connect screen ──
  const simOn = isSimModeOn();
  const signInEnvironment = getSignInEnvironment();
  const fediWebView = isFediWebViewSignInEnvironment(signInEnvironment);
  const useSafeAreaInsets = shouldApplyCssSafeAreaInsets(signInEnvironment);
  const safeAreaTop = useSafeAreaInsets ? "env(safe-area-inset-top, 0px)" : 0;
  // The sim-pill offset is now an in-flow spacer inside <SimModePill/> (a plain
  // height applies reliably; the inline paddingTop env() calc below was being
  // dropped by React's style reconciliation on the main shell — the header
  // rendered under the banner). shellPaddingTop now handles only the safe-area.
  const shellPaddingTop = safeAreaTop;
  const shellPaddingBottom = useSafeAreaInsets
    ? `calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`
    : BOTTOM_NAV_HEIGHT;
  // On a fresh account, `connected` and `pubkey` arrive before the effect above
  // has a chance to flip `needsHomePick`. Derive the first gate synchronously so
  // the Browse shell never paints for a frame between account creation and the
  // globe. Keep `needsHomePick` as the in-flight latch while a selected
  // community is joining.
  const shouldShowHomePicker =
    connected && !!pubkey && (needsHomePick || getUserCommunitySlugRaw() === null);

  if (!connected) {
    return (
      <div style={{
        background: T.bg, color: T.text, minHeight: "100dvh", fontFamily: T.sans,
        paddingTop: shellPaddingTop,
      }}>
        <style>{globalCss()}</style>
        <SimModePill />
        <SimEntryModal />
        {showQRScanner && (
          <Suspense fallback={null}>
            <QRScanner
              onClose={() => setShowQRScanner(false)}
              onScan={async (scanned) => {
                setShowQRScanner(false);
                if (scanned.startsWith("nsec1")) {
                  // v2.5: the scan IS the consent (the user opened the scanner
                  // to scan their key), and window.confirm() is a silent no-op
                  // in the Capacitor/Tauri webview — so proceed and toast,
                  // rather than gate behind a dialog that never fires.
                  (window as any).__chama_connect_nsec = scanned;
                  // A scanned key is imported, never Chama-generated.
                  if (shouldPersistNsecInShell()) {
                    try { await writeSavedNsec(scanned, "imported"); } catch {}
                  }
                  setToast({ message: t("app.keyScanned"), type: "success" });
                  actions.connect();
                } else if (scanned.startsWith("nostrconnect://") || scanned.startsWith("bunker://")) {
                  copyTextRobust(scanned);
                  setToast({ message: t("app.signerUriCopied"), type: "success" });
                } else {
                  setToast({ message: t("app.unrecognizedQr"), type: "error" });
                }
              }}
            />
          </Suspense>
        )}
        <ConnectScreen
          onConnect={actions.connect}
          onConnectNsec={async (nsec: string, remember: boolean, wasGenerated: boolean) => {
            (window as any).__chama_connect_nsec = nsec;
            if (remember && shouldPersistNsecInShell()) {
              try {
                // v2.5: record key origin alongside the saved nsec so Me ›
                // Advanced reveals the master key ONLY when Chama generated it
                // (an imported key is the user's to back up where they made it;
                // NIP-46 keys are never saved here at all).
                await writeSavedNsec(nsec, wasGenerated ? "generated" : "imported");
              } catch (e) {
                console.warn("[chama] Failed to save nsec to secure storage:", e);
              }
            }
            actions.connect();
          }}
          loading={loading}
          error={error}
        />
      </div>
    );
  }

  // ── Connected but no home chama yet → the post-connect market picker ──
  // v4.3 auth-first: the pick moved here from the pre-signer ConnectScreen. The
  // npub is known, so onSelect writes straight to its scope (handleSelectCommunity
  // persists + resolves the federation), and — because the client is connected —
  // the picker's country-detail liveness signal can actually fetch.
  if (shouldShowHomePicker) {
    return (
      <div style={{
        background: T.bg, color: T.text, minHeight: "100dvh", fontFamily: T.sans,
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "flex-start", padding: "36px 18px", textAlign: "center",
        paddingTop: shellPaddingTop,
      }}>
        <style>{globalCss()}</style>
        <SimModePill />
        {/* Failed first picks toast their reason (handleSelectCommunity's
            "Couldn't reach X. Try another community.") — without this the
            gate swallowed them and a retry looked like a dead tap. */}
        {toast && <Toast message={toast.message} type={toast.type} sticky={toast.sticky} dismissOnTap={toast.dismissOnTap} onDone={() => setToast(null)} />}
        <GlobeCountryPicker
          onSelect={async (slug) => {
            // handleSelectCommunity persists the identity choice synchronously
            // before its first federation await. Let that committed choice take
            // the user straight to Browse; wallet join, bond reads, and health
            // work may finish behind the shell. If the switch later fails, the
            // handler clears the first-time choice and this gate returns.
            const selection = handleSelectCommunity(slug);
            setNeedsHomePick(getUserCommunitySlugRaw() === null);
            await selection;
            // Reconcile after success/failure. A failed first-time switch has
            // cleared the choice, so the picker comes back with its error toast.
            setNeedsHomePick(getUserCommunitySlugRaw() === null);
          }}
          loadLiveness={actions.getChamaLiveness}
          loadBondedCounts={actions.fetchBondedArbiterCounts}
          livenessBlocksPerDay={BOND_LIVENESS_BLOCKS_PER_DAY}
        />
      </div>
    );
  }

  // ── Connected → main app ──
  const detailMode = view === "detail" && !!selected;
  const activeTab = detailMode ? TAB_FOR_VIEW[detailBackView] : TAB_FOR_VIEW[view];
  const effectiveShellPaddingBottom = detailMode ? 0 : shellPaddingBottom;

  return (
    <div style={{
      background: T.bg, color: T.text, minHeight: "100dvh",
      // v2.7 Stage 4: detail mode widens to 1120 so TradeDetail's built-in
      // ≥980px two-column layout (listing pane + sticky trade-room/chat) can
      // actually engage on desktop/landscape — it was previously throttled to
      // 720px and never triggered. `.trade-detail-shell` caps + centers itself
      // responsively (520 → 1040 → 1120); narrow/mobile is unaffected.
      fontFamily: T.sans, maxWidth: detailMode ? 1120 : 520, margin: "0 auto",
      paddingBottom: effectiveShellPaddingBottom,
      paddingTop: shellPaddingTop,
    }}>
      <style>{globalCss()}</style>
      <SimModePill />
      <SimEntryModal />

      {toast && <Toast message={toast.message} type={toast.type} sticky={toast.sticky} dismissOnTap={toast.dismissOnTap} onDone={() => setToast(null)} />}

      {!detailMode && (
        <>
          {/* Header */}
          <div style={{
            padding: "16px 16px 12px", borderBottom: `1px solid ${T.border}`,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img
                src="/icons/chama-woven-trust-mark-transparent-64.png"
                alt="Chama"
                width={32}
                height={32}
                style={{ display: "block", flexShrink: 0 }}
              />
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: T.mono, letterSpacing: -0.5 }}>Chama</div>
                <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1.5, textTransform: "uppercase" }}>
                  {t("app.headerTagline")}
                </div>
              </div>
            </div>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}>
              <div style={{ fontSize: 9, color: __BUILD_STAMP__ ? T.amber : T.muted, fontFamily: T.mono, padding: "4px 10px", borderRadius: 6, background: T.surface, border: `1px solid ${__BUILD_STAMP__ ? T.amber + "55" : T.border}` }}>
                {/* Local/test builds carry an amber "dev <build time>" stamp so a
                    Tauri/ASDK refresh visibly confirms it picked up the new
                    bundle. ship.sh exports CHAMA_RELEASE=1 → clean version. */}
                v{__APP_VERSION__}{__BUILD_STAMP__ ? ` · dev ${__BUILD_STAMP__}` : ""}{__BUILD_STAMP__ && sessionBadge ? ` · ${sessionBadge}` : ""}
              </div>
            </div>
          </div>

          <div style={{
            padding: "12px 16px",
            borderBottom: `1px solid ${T.border}`,
          }}>
            <BitcoinPricePill
              hero
              amountMode={amountDisplayMode}
              onAmountModeChange={setAmountDisplayMode}
              quoteCurrency={getCommunityBySlug(routeCommunitySlug)?.currency ?? null}
            />
          </div>

          {/* Identity bar (relays + npub). Sign out lives in Me → Settings. */}
          <WalletBar
            pubkey={pubkey!}
            connectedRelays={connectedRelays}
            relayStatuses={relayStatuses}
          />

          {/* Chama bar (renamed from FedimintBar in v0.3.0 Phase 5).
          showReconnect is true for users who have a reconnect target
          (picked community or active invite) so the Reconnect CTA
          appears after a failed switch+revert; first-time users (no
          community yet) don't see it because their join path is
          community pills, not Reconnect.

          v0.3.0 Phase 5: onFund is gone. The right-side surface is
          state-aware via chamaLabel — in-trade / stranded / ready —
          rather than a permanent funding entry point. The stranded
          tap reuses the same RecoveryPayoutModal as the banner, so
          the failure-mode escape hatch is reachable from anywhere. */}
          <ChamaBar
            fedimint={fedimint}
            communitySlug={routeCommunitySlug}
            chamaLabel={(myTradesLoading || publicListingsLoading)
              ? { kind: "ready" }
              : decideChamaBarLabel({
              balanceMsats: fedimint.balanceMsats ?? 0,
              hasActiveBuyerSellerCommitment: hasActiveCommitment,
              activeCommittedMsats: committedMsats,
              activeTradeCount: activeCommitmentCount,
              // v0.3.1 Phase 3: bootProbeState routes the "unreachable"
              // ChamaBar variant. Failed → "⚠ Chama unreachable ·
              // Reconnect →"; pending/ok pass through to the existing
              // three-state decision. Same source of truth gates
              // TradeDetail's Fund + Claim buttons (see TradeDetail
              // mount below).
              bootProbeState: fedimint.bootProbeState,
              // Phase 1: suppress the "stranded → ⚠ Recover" alarm pill on
              // intentional sim manual-fund balances — the sibling
              // shouldShowRecoveryBanner is gated the same way. simOn is in
              // scope here (declared above the connected render).
              simModeOn: simOn,
              // #37: same suppressor as the banner — the pill one-taps into
              // the drain modal, which must not fire on a recoverable lock.
              hasPendingNativeLock,
              // Stranded-payout recovery: same rule while an unfinished
              // claim payout owns the balance story.
              hasPendingClaimPayout,
              })}
            onTapStranded={() => setPendingRecovery({
              title: t("app.recoverSatsTitle"),
              traceContext: recoveryTraceContext,
            })}
            showReconnect={getUserCommunitySlugRaw() !== null || !!(storedActiveInvite || liveActiveInvite)}
            onInit={() => {
              // Reconnect does two jobs: re-probe backed-off/abandoned relays
              // (the per-relay backoff gives up after MAX_RETRY_COUNT and won't
              // recover on its own), AND re-init/re-probe the federation. The
              // relay re-probe runs first so init has a live pool to publish the
              // seed round-trip into.
              actions.recoverRelays();
              const runInit = () => actions.initFedimint().catch((e: any) => {
                // A refused runtime lease is the one failure Reconnect cannot
                // fix by retrying: the slot is held by another tab, or by one
                // that never closed cleanly and still owns it until the TTL
                // expires. Offer the takeover rather than leaving the user
                // tapping a button that is guaranteed to keep failing.
                if (e?.code === "FEDIMINT_RUNTIME_IN_OTHER_TAB") {
                  setToast({
                    type: "error",
                    sticky: true,
                    message: (
                      <>
                        {t("app.walletOpenInOtherTab")}{" "}
                        <button
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const { armBrowserRuntimeTakeover } = await import(
                                "../fedimint/browser-runtime-lease.js"
                              );
                              armBrowserRuntimeTakeover();
                              runInit();
                            })();
                          }}
                          style={{
                            background: "none", border: "none", padding: 0,
                            color: "inherit", font: "inherit", fontWeight: 800,
                            textDecoration: "underline", cursor: "pointer",
                          }}
                        >
                          {t("app.useWalletHere")}
                        </button>
                      </>
                    ),
                  });
                  return;
                }
                setToast({ message: e.message || t("app.couldntJoinChama"), type: "error" });
              });
              runInit();
            }}
          />
        </>
      )}

      {/* The first-time onboarding picker no longer renders in the shell.
          Community pills in BrowseView are the primary first-time join
          surface (one-tap = identity + fed init). Power users still get
          the picker via Me → Settings → Advanced → Sandbox mode (which
          surfaces SwitchFederationPanel + custom-invite paste). */}

      {/* Fund Chama modal */}
      {showFundModal && (
        <FundWalletModal
          onClose={() => {
            setShowFundModal(false);
            // v0.2.0 item 8 + Q4: closing the modal before balance
            // drains = explicit abandonment. Drop the pending switch
            // so we don't unexpectedly switch later if they happen to
            // drain via another path.
            setPendingSwitchAfterWithdraw(null);
          }}
          onCreateInvoice={(amountSats, desc) =>
            actions.createFundingInvoice(amountSats * 1000, desc)
          }
          onPayInvoice={async (bolt11) => { await actions.payInvoice(bolt11); }}
          // This is a recipient-facing export, so use the explicit browser-safe
          // 14-day horizon. The export helper deliberately emits the compact
          // Fedi-compatible payload; `true` selects that hardened helper.
          onSpendNotes={(amountMsats) => actions.spendNotes(amountMsats, undefined, true)}
          onRedeemEcash={(oobNotes) => actions.redeemEcash(oobNotes)}
          // 6.1 · the UNCOLLECTED ECASH "put it back" button routes through the
          // same probe as the Me-screen teal card, so both give one honest
          // structured answer for the same note (verdict toast + storage
          // resolution owned here, not guessed at the call site).
          onReabsorbBearerNotes={handleReabsorbBearerNotes}
          balanceMsats={fedimint.balanceMsats ?? 0}
        />
      )}

      {/* v0.3.0 Phase 2: AtomicFundingModal — listing-tap → exact-amount
          BOLT11 → mint → LOCK in one motion. Replaces the prior
          FundWalletModal-then-Fund two-step on the production funding
          path. FundWalletModal stays mounted above for the (Phase 5-
          gated) Sandbox-mode path. */}
      {pendingFundAndLock && (
        <AtomicFundingModal
          escrowId={pendingFundAndLock.escrowId}
          amountMsats={pendingFundAndLock.amountMsats}
          premiumMsats={pendingFundAndLock.premiumMsats ?? 0}
          ctaLabel={pendingFundAndLock.ctaLabel}
          savedHandleId={pendingFundAndLock.savedHandleId}
          selectedItems={pendingFundAndLock.selectedItems}
          homeCommunity={getUserCommunitySlugRaw()}
          tradeCommunity={pendingFundAndLock.tradeCommunity}
          fiatCurrency={pendingFundAndLock.fiatCurrency}
          tradeCategory={pendingFundAndLock.tradeCategory}
          fundAndLock={actions.fundAndLock}
          getOnchainInfo={actions.getOnchainInfo}
          lockAndPublish={actions.lockAndPublish}
          disableNwc={fediWebView}
          onClose={(terminal) => {
            const { resolve } = pendingFundAndLock;
            setPendingFundAndLock(null);
            if (terminal.kind === "locked") {
              setToast({ message: t("app.satsLocked"), type: "success" });
            } else if (terminal.kind === "lock-failed") {
              // v1.2.5: translate NWC FAILURE_REASON_* / NIP-47 codes
              // into human-readable copy so the user knows what to do
              // (retry, rebalance, switch wallet) instead of seeing
              // "INTERNAL: FAILURE_REASON_NO_ROUTE".
              setToast({ message: humanizeNwcError(terminal.error), type: "error" });
            } else if (terminal.kind === "expired") {
              setToast({ message: t("app.invoiceExpired"), type: "info" });
            } else if (terminal.kind === "mint-timeout") {
              setToast({
                message: t("app.mintStalled"),
                type: "info",
              });
            }
            // aborted = silent (user cancelled)
            resolve();
          }}
        />
      )}

      {/* v0.3.0 Phase 3: ClaimPayoutModal — APPROVED winner taps Claim →
          DestinationPicker → atomic claim+payout in one motion.
          Replaces the prior "claim into wallet then withdraw" two-step
          on the production path. claimAndRedeem stays as a building
          block + Sandbox path; production winners always go through
          this modal. */}
      {/* v2.4 #56 — fee-free ecash exit. Spends the local balance into a
          Fedimint bearer note; crash-safe stash + pending-export surface in Me
          guard against loss. */}
      {showEcashExport && (
        <EcashExportModal
          balanceMsats={fedimint.balanceMsats ?? 0}
          federationLabel={
            // ⚠ The FEDERATION name first, community label only as a fallback.
            // This string tells the user which wallet the bearer note will
            // import into ("it only works on X"). A community displayName is
            // "USA · USD" — a country and a currency, which no Fedimint wallet
            // is named after and which therefore tells them nothing they can
            // act on. The federation is "Bitcoin Life Federation", which is
            // exactly what they'll be looking for in Fedi.
            fedimint.federationName
            ?? getCommunityBySlug(routeCommunitySlug)?.displayName
            ?? t("app.yourFederation")
          }
          // Use the hardened export spend (long auto-refund horizon). Its OOB
          // payload stays compact: invite-bearing notes repeatedly parsed in
          // Fedi but then failed to claim for real users.
          spendNotes={(amountMsats) => actions.spendNotes(amountMsats, undefined, true)}
          recoverUnstashed={(notes) => actions.redeemEcash(
            notes,
            buildChamaOperationMeta({
              flow: "recovery_payout",
              amountMsats: fedimint.balanceMsats ?? 0,
              reason: "ecash-export-stash-failed-reabsorb",
            }),
          )}
          onExported={() => { actions.refreshBalance().catch(() => {}); }}
          onConfirmCleared={async () => {
            const pending = getEcashExport();
            if (pending?.source === "claim" && pending.escrowId) {
              await actions.confirmClaimEcashExport(pending.escrowId);
              clearPendingRedemptionsMatchingNotes(pending.notes);
            } else {
              // The export is the canonical copy. Once the user confirms it
              // was imported, remove any byte-identical legacy recovery record
              // before clearing that canonical copy. Equal value alone never
              // authorizes a merge.
              if (pending?.notes) clearPendingRedemptionsMatchingNotes(pending.notes);
              clearEcashExport();
            }
          }}
          onClose={() => setShowEcashExport(false)}
        />
      )}

      {/* v3.4.0 C13 — stranded-claim bearer-note export. Same modal in
          preset mode: shows the EXISTING note from the pending-
          redemptions stash (no spend), QR + copy, two-tap clear that
          removes the stash entry only after the user confirms it's
          secured elsewhere. */}
      {strandedClaimExport && (
        <EcashExportModal
          balanceMsats={fedimint.balanceMsats ?? 0}
          federationLabel={
            // ⚠ The FEDERATION name first, community label only as a fallback.
            // This string tells the user which wallet the bearer note will
            // import into ("it only works on X"). A community displayName is
            // "USA · USD" — a country and a currency, which no Fedimint wallet
            // is named after and which therefore tells them nothing they can
            // act on. The federation is "Bitcoin Life Federation", which is
            // exactly what they'll be looking for in Fedi.
            fedimint.federationName
            ?? getCommunityBySlug(routeCommunitySlug)?.displayName
            ?? t("app.yourFederation")
          }
          spendNotes={(amountMsats) => actions.spendNotes(amountMsats)}
          preset={{
            notes: strandedClaimExport.oobNotes,
            amountMsats: strandedClaimExport.amountMsats,
            headline: t("app.strandedClaimHeadline"),
            body: strandedClaimExport.stranded === "unresolved-credit"
              ? t("app.strandedClaimUnresolvedBody")
              : t("app.strandedClaimBody"),
            onConfirmCleared: () => {
              clearPendingRedemption(strandedClaimExport.escrowId);
              setStrandedClaimExport(null);
            },
          }}
          onClose={() => setStrandedClaimExport(null)}
        />
      )}

      {showBondCeremony && pubkey && (
        <BondCeremonyModal
          createCommitmentBond={actions.createCommitmentBond}
          checkCommitmentFunding={actions.checkCommitmentFunding}
          getCommitmentReclaimQuote={actions.getCommitmentReclaimQuote}
          renewCommitmentBond={actions.renewCommitmentBond}
          recoverMyBonds={actions.recoverMyBonds}
          reclaimCommitmentBond={actions.reclaimCommitmentBond}
          creditReclaimedCommitmentBond={actions.creditReclaimedCommitmentBond}
          getBondChainTip={actions.getBondChainTip}
          publishBondAnnouncement={actions.publishBondAnnouncement}
          onClose={() => setShowBondCeremony(false)}
        />
      )}

      {showClearListings && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 20, zIndex: 1100,
        }}>
          <div style={{
            maxWidth: 420, width: "100%", padding: 20, borderRadius: T.r,
            background: T.card, border: `1px solid ${T.border}`,
          }}>
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55,
              marginBottom: 18,
            }}>
              {t("me.clearListingsConfirm", { count: clearableListings.length })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={clearUnfundedListings}
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: T.rs,
                  background: T.accent, border: "none", color: T.bg,
                  fontFamily: T.mono, fontSize: 13, fontWeight: 800, cursor: "pointer",
                }}
              >
                {t("me.clearListingsConfirmBtn", { count: clearableListings.length })}
              </button>
              <button
                onClick={() => setShowClearListings(false)}
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: T.rs,
                  background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {t("me.clearListingsCancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingClaim && (
        <ClaimPayoutModal
          escrowId={pendingClaim.escrowId}
          payoutMsats={pendingClaim.payoutMsats}
          premiumMsats={pendingClaim.premiumMsats ?? 0}
          savedDestinations={listPayoutDestinations()}
          savedNwcConnections={fediWebView ? [] : listSavedNwcConnections()}
          homeCommunity={getUserCommunitySlugRaw()}
          tradeCommunity={pendingClaim.tradeCommunity}
          fiatCurrency={pendingClaim.fiatCurrency}
          claimAndPayout={actions.claimAndPayout}
          confirmClaimEcashExport={actions.confirmClaimEcashExport}
          claimTarget={hasFediInternalEcash() ? "ecash" : "lightning"}
          probeFederation={actions.probeFederation}
          onClose={(terminal) => {
            const { resolve } = pendingClaim;
            setPendingClaim(null);
            if (!terminal) {
              // User dismissed picker before resolving — silent.
            } else if (terminal.kind === "done") {
              // The ecash export's explicit clear is the terminal claim action.
              // Re-anchor the shell on this trade so a refresh cannot expose
              // the destination picker again.
              setSelectedId(pendingClaim.escrowId);
              setView("detail");
              setBlockedClaimReasons(prev => {
                if (!prev[pendingClaim.escrowId]) return prev;
                const next = { ...prev };
                delete next[pendingClaim.escrowId];
                return next;
              });
              // Name the sats movement so the moment lands: a release pays the
              // winner, a refund returns the funder's locked sats.
              const wasRefund = escrows.get(pendingClaim.escrowId)?.resolvedOutcome === Outcome.REFUND;
              setToast({
                message: wasRefund
                  ? t("app.refundedToast")
                  : t("app.releasedToast"),
                type: "success",
              });
            } else if (terminal.kind === "claim-failed") {
              if (/reissue|consumed|settle/i.test(terminal.error)) {
                setBlockedClaimReasons(prev => ({
                  ...prev,
                  [pendingClaim.escrowId]: terminal.error,
                }));
              }
              setToast({ message: humanizeNwcError(terminal.error), type: "error" });
            } else if (terminal.kind === "claim-bridge-threw") {
              // v0.3.1 Phase 1: structural failure (FED_PROBE_FAILED /
              // FED_MISMATCH). Modal surfaced the actual error +
              // Try-again button; if user closed without retrying,
              // the toast reminds them what happened. No sats moved.
              setToast({ message: terminal.error, type: "error" });
            } else if (terminal.kind === "claim-pending") {
              setToast({
                message: t("app.claimInFlight"),
                type: "info",
              });
            } else if (terminal.kind === "payout-failed") {
              // Route by what can actually help. New claim payouts defer
              // COMPLETE until the outbound leg succeeds, so the trade's
              // Claim button is alive and retries with a fresh invoice.
              // Older terminals may still arrive completed; below the
              // material line, Me's Lightning recovery surface stays quiet.
              const payoutSatsForCopy = Math.floor(pendingClaim.payoutMsats / 1000);
              if (terminal.claimCompleted === false) {
                setToast({
                  message: t("app.payoutRetryClaim"),
                  type: "error",
                });
              } else if (payoutSatsForCopy < MAIN_SURFACE_RECOVERY_MIN_SATS) {
                setToast({
                  message: t("app.payoutSafeInChama"),
                  type: "error",
                });
              } else {
                setView("me");
                setToast({
                  message: t("app.payoutRecoverFromMe"),
                  type: "error",
                });
              }
            }
            resolve();
          }}
        />
      )}

      {/* Federation drift confirm.
          v0.3.0 Phase 4: now a TWO-button modal (no destroy escape).
          Primary "Recover & switch" stashes the pending switch in
          pendingSwitchAfterWithdraw and opens RecoveryPayoutModal
          (DestinationPicker → outbound LN). The withdraw-watcher
          useEffect dispatches the queued switch once balance reaches
          zero. The destroy escape (v0.2.0's tertiary button) is gone
          — Sandbox-mode users who truly need to nuke OPFS use
          Settings → Advanced → Sandbox → Reset OPFS. */}
      {pendingDestroyConfirm && balanceBlocksFederationSwitch(pendingDestroyConfirm.balanceMsats) && (
        <DestroyEcashConfirmModal
          targetLabel={pendingDestroyConfirm.label}
          balanceMsats={pendingDestroyConfirm.balanceMsats}
          hasPendingNativeLock={hasPendingNativeLock}
          onWithdraw={() => {
            // pendingSwitchAfterWithdraw state machine unchanged —
            // only the trigger surface moves from FundWalletModal
            // to RecoveryPayoutModal (Phase 4 reminder #3). The
            // existing useEffect watcher dispatches the switch when
            // balance reaches zero. Cancel of the picker = explicit
            // abandonment, drops the pending switch.
            setPendingSwitchAfterWithdraw({
              invite: pendingDestroyConfirm.invite,
              label: pendingDestroyConfirm.label,
              navigateToEscrowAfter: pendingDestroyConfirm.navigateToEscrowAfter,
              persistCustom: !("restoreCommunitySlug" in pendingDestroyConfirm),
            });
            setPendingDestroyConfirm(null);
            setPendingRecovery({
              title: t("app.recoverAndSwitchTitle"),
              subtitle: t("app.recoverAndSwitchSubtitle", { label: pendingDestroyConfirm.label }),
              traceContext: recoveryTraceContext,
            });
          }}
          onCancel={() => {
            actions.setCustomInvite(pendingDestroyConfirm.activeInvite);
            if ("restoreCommunitySlug" in pendingDestroyConfirm) {
              const restoreSlug = pendingDestroyConfirm.restoreCommunitySlug;
              actions.setCommunity(restoreSlug ?? "");
              setBrowseCommunity(restoreSlug ?? DEFAULT_COMMUNITY_SLUG);
            }
            setPendingDestroyConfirm(null);
            actions.initFedimint(pendingDestroyConfirm.activeInvite).catch((e: any) =>
              setToast({ message: e?.message || t("app.reinitFailed"), type: "error" })
            );
          }}
        />
      )}

      {/* #25 foreign-chama guidance — a trade on a fed the wallet isn't currently
          on. Instead of the raw "sign out and rejoin with the correct federation"
          error, name the chama and offer a one-tap switch + auto-retry the join. */}
      {pendingFedSwitch && (() => {
        const chama = getCommunityBySlug(pendingFedSwitch.community);
        const name = chama?.displayName ?? pendingFedSwitch.community;
        const flag = chama?.flagEmoji ?? "🌍";
        return (
          <div style={{ position: "fixed", inset: 0, background: "#000c", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
            onClick={(e) => { if (e.target === e.currentTarget) setPendingFedSwitch(null); }}>
            <div style={{ background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, width: "100%", maxWidth: 360, padding: 22 }}>
              <div style={{ fontSize: 26, marginBottom: 10, textAlign: "center" }}>🔀</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: T.text, fontFamily: T.sans, textAlign: "center", marginBottom: 10 }}>
                {t("app.fedSwitchTitle", { flag, name })}
              </div>
              <div style={{ fontSize: 13, color: T.muted, fontFamily: T.sans, lineHeight: 1.55, textAlign: "center", marginBottom: 18 }}>
                {t("app.fedSwitchBodyBefore")} <b style={{ color: T.text }}>{name}</b> {t("app.fedSwitchBodyAfter")}
              </div>
              <button
                onClick={async () => {
                  const target = pendingFedSwitch;
                  setPendingFedSwitch(null);
                  try {
                    await handleSelectCommunity(target.community);
                    await target.retry();
                    setToast({ message: t("app.fedSwitchPickedUp", { name }), type: "success" });
                  } catch (err: any) {
                    setToast({ message: err?.message || t("app.fedSwitchFailed", { name }), type: "error" });
                  }
                }}
                style={{ width: "100%", padding: "13px", borderRadius: T.rs, background: T.accent, border: "none", color: T.bg, fontFamily: T.sans, fontSize: 14, fontWeight: 800, cursor: "pointer", marginBottom: 8 }}>
                {t("app.fedSwitchCta", { flag, name })}
              </button>
              <button onClick={() => setPendingFedSwitch(null)}
                style={{ width: "100%", padding: "11px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 12, cursor: "pointer" }}>
                {t("app.notNow")}
              </button>
            </div>
          </div>
        );
      })()}

      {/* v0.3.0 Phase 4: RecoveryPayoutModal — single mount serving
          both the failure-mode RecoveryBanner path AND the destroy-
          modal recover-then-switch path. Title differentiates per
          surface; the underlying drain semantics are identical. */}
      {pendingRecovery && (
        <RecoveryPayoutModal
          balanceMsats={fedimint.balanceMsats ?? 0}
          savedDestinations={listPayoutDestinations()}
          savedNwcConnections={fediWebView ? [] : listSavedNwcConnections()}
          title={pendingRecovery.title}
          subtitle={pendingRecovery.subtitle}
          payInvoice={(bolt11) => actions.payInvoice(
            bolt11,
            buildChamaOperationMeta({
              flow: "recovery_payout",
              escrowId: recoveryTraceContext.escrowId,
              amountMsats: fedimint.balanceMsats ?? recoveryTraceContext.amountMsats,
              reason: pendingRecovery.title,
            }),
          )}
          awaitPayoutOutcome={actions.awaitPayoutOutcome}
          getBalance={actions.getBalance}
          traceContext={recoveryTraceContext}
          addOrTouchPayoutDestination={(addr) => { addOrTouchPayoutDestination(addr); }}
          onClose={(terminal) => {
            setPendingRecovery(null);
            if (!terminal) {
              // User dismissed picker before resolving. If a switch
              // was queued, drop it (explicit abandonment per the
              // v0.2.0 Q4 semantics — stays the same in Phase 4).
              setPendingSwitchAfterWithdraw(null);
            } else if (terminal.kind === "done") {
              setToast({ message: t("app.recoveredToWallet"), type: "success" });
              // Balance reaching zero will trigger the watcher
              // useEffect (line ~187) which dispatches the queued
              // switch automatically. No extra wiring needed here.
            } else if (terminal.kind === "payout-failed") {
              setToast({ message: humanizeNwcError(terminal.error), type: "error" });
              // Payout failed — drop any queued switch since the
              // balance never drained.
              setPendingSwitchAfterWithdraw(null);
            }
          }}
        />
      )}

      {/* Switching overlay during silent re-init when a user taps a
          listing on another Chama route. The native bridge now caps
          slow federation RPC, but the copy stays honest while the
          target route is opening. */}
      {switchingToCommunity && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9990,
          background: "rgba(10,10,15,0.85)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 14,
        }}>
          <div style={{
            width: 42, height: 42, borderRadius: "50%",
            border: `3px solid ${T.accent}`,
            borderTopColor: "transparent",
            animation: "spin 0.8s linear infinite",
          }} />
          {/* Readable-first fed-switch banner: big bold DM Sans so it reads at a
              glance, with a calm reassurance line beneath. */}
          <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.sans, textAlign: "center", padding: "0 24px", lineHeight: 1.3 }}>
            {t("app.switchOverlayBefore")} <span style={{ color: T.accent }}>{switchingToCommunity.displayName}</span>{t("app.switchOverlayAfter")}
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: T.muted, fontFamily: T.sans }}>
            {t("app.noSatsMoveWhileSwitching")}
          </div>
        </div>
      )}

      {/* Content — routed by view */}
      {view === "guided" ? (
        <GuidedHome
          listings={allVisibleListings}
          stockByListing={stockByListing}
          browseCommunity={routeCommunitySlug}
          activeMintUrl={myActiveInvite}
          viewerPubkey={pubkey!}
          listingsLoading={publicListingsLoading}
          attentionTrades={needsYouTrades}
          fetchRatingSummary={actions.fetchRatingSummary}
          onBrowse={(category) => {
            setBrowseCategory(category);
            setView("browse");
          }}
          onCreate={() => setCreateOverlayOpen(true)}
          onOpenTrade={(id) => openEscrow(id, "guided")}
        />
      ) : view === "detail" && selected ? (
        <div style={{
          animation: "fadeIn 0.3s ease",
          // Fill the viewport so the trade screen is ONE window — fixed top,
          // a chat pager that flexes to take the leftover room, and the timeline
          // glued to the bottom. It scrolls only when a tall phase truly needs
          // it. Subtract the top chrome (safe-area / sim pill) the shell pads for.
          height: `calc(100dvh - ${typeof shellPaddingTop === "number" ? `${shellPaddingTop}px` : shellPaddingTop} - ${simOn ? `${SIM_PILL_HEIGHT}px` : "0px"} - env(safe-area-inset-bottom, 0px))`,
          display: "flex", flexDirection: "column", minHeight: 0,
        }}>
          <TradeDetail
            key={`${selected.id}:${(() => {
              const p = getEffectiveParticipantsAt(selected, Math.floor(Date.now() / 1000));
              return p.buyer === pubkey ? "buyer"
                : p.seller === pubkey ? "seller"
                : p.arbiter === pubkey ? "arbiter"
                : "viewer";
            })()}`}
            state={selected}
            pubkey={pubkey!}
            homeCommunity={getUserCommunitySlugRaw()}
            amountDisplayMode={amountDisplayMode}
            onAmountDisplayModeChange={setAmountDisplayMode}
            kind0Enabled={kind0Enabled}
            profileNames={nostrProfiles}
            onRateCounterparty={handleRateCounterparty}
            myGivenRatings={myGivenRatings}
            fetchRatingSummary={actions.fetchRatingSummary}
            fetchCommunityBonds={actions.fetchCommunityBonds}
            knownTrades={knownTradesForConcentration}
            onStartNextTranche={TRADE_SLICING_ENABLED ? handleStartNextTranche : undefined}
            onchainFundingPlan={actions.onchainFundingPlan}
            onPublishOnchainLock={actions.publishOnchainLock}
            onPrepareOnchainSettlement={actions.prepareOnchainSettlement}
            onSignOnchainSettlement={actions.signOnchainSettlement}
            onFinalizeOnchainSettlement={actions.finalizeOnchainSettlement}
            onScanMyOnchainPayouts={refreshOnchainPayoutAttention}
            onSweepOnchainPayout={actions.sweepOnchainPayout}
            // v0.3.1 Phase 3 (Q4 scope): same boot-probe flag the
            // ChamaBar's "unreachable" pill reads from. Fund + Claim
            // buttons disable with the "Federation unreachable —
            // reconnect first" subtitle when this is true. Reconnect
            // dispatch lives in ChamaBar only.
            bootProbeFailed={fedimint.bootProbeState === "failed"}
            receiveUnavailable={fedimint.lastHealthOk === false}
            fundingInProgress={midFunding}
            claimBlockedReason={selectedClaimBlockedReason}
            disableNwc={fediWebView}
            onBack={() => { setView(detailBackView); setSelectedId(null); maybeSnapBackHome(); }}
            onVote={(outcome) => actions.vote(selectedId!, outcome).then(
              () => setToast({ message: t("app.votedOutcome", { outcome }), type: "success" }),
              (e: any) => {
                // v1.2.2 vote-freeze fix: distinguish "your vote was
                // already on chain" (info, neutral) from "the publish
                // actually failed" (error, red). Without this branch
                // both used to render as red toasts, and worse, the
                // useEscrow swallow returned silently — sellers would
                // tap, see nothing, tap again, see nothing again.
                if (e?.voteSuppressed) {
                  setToast({
                    message: e?.message || t("app.voteAlreadyRecorded"),
                    type: "info",
                  });
                  return;
                }
                setToast({ message: e?.message || t("app.voteFailed"), type: "error" });
              },
            )}
            // R3-1b: re-attach to a submitted payout on view → complete a
            // CLAIMED trade whose refund/claim already landed (no re-pay).
            onConfirmPayout={(escrowId) => { void actions.reattachPayout(escrowId); }}
            onClaim={async () => {
              // v0.3.0 Phase 3: open ClaimPayoutModal instead of
              // dispatching claimAndRedeem directly. In browsers this
              // can still route through a payout destination; inside
              // Fedi, the modal auto-claims into the host wallet.
              if (!selected) return;
              // Current Fedi/ecash path expects the whole reconstructed
              // token. Fee fields stay in the protocol record, but should
              // only affect this amount once real payout fan-out exists.
              const payoutMsats = selected.amountMsats;
              // E1.1: hold back the winner's 0.25% arbiter insurance from
              // the payout quote so the settle sweep finds it in the wallet.
              const claimDecision = (!isSimModeOn() && !isTestnetMode() && pubkey)
                ? computeArbiterPremium(selected, pubkey)
                : null;
              return new Promise<void>((resolve) => {
                setPendingClaim({
                  escrowId: selectedId!,
                  payoutMsats,
                  premiumMsats: claimDecision?.payable ? claimDecision.amountMsats : 0,
                  tradeCommunity: selected.community,
                  fiatCurrency: selected.fiatCurrency,
                  resolve,
                });
              });
            }}
            onJoin={async (role, joinOpts) => {
              try {
                setToast({
                  message: joinOpts?.orderFinalized
                    ? t("app.confirmingOrder")
                    : joinOpts?.selectedItems?.length
                      ? t("app.savingCart")
                      : t("app.joiningAsRole", { role }),
                  type: "info",
                });
                await actions.joinEscrow(selectedId!, role, joinOpts);
                setToast({
                  message: joinOpts?.orderFinalized
                    ? t("app.orderReady")
                    : joinOpts?.selectedItems?.length
                      ? t("app.cartSaved")
                      : t("app.joinedAsRole", { role }),
                  type: "success",
                });
              } catch (e: any) {
                // #25: the trade lives on a different fed than the wallet. Don't
                // dump "sign out and rejoin" — offer a one-tap switch to its chama.
                if (e?.code === "FED_MISMATCH" && selected?.community) {
                  setPendingFedSwitch({
                    community: selected.community,
                    retry: async () => { await actions.joinEscrow(selectedId!, role, joinOpts); },
                  });
                  return;
                }
                setToast({ message: e.message || t("app.joinFailed"), type: "error" });
              }
            }}
            onReleasePeriod={async (periodIndex: number) => {
              try {
                await actions.releasePeriod(selectedId!, periodIndex);
                setToast({ message: t("app.periodReleased", { n: periodIndex + 1 }), type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || t("app.releaseFailed"), type: "error" });
              }
            }}
            onSendChat={(message) => {
              actions.sendChat(selectedId!, message).catch((e: any) =>
                setToast({ message: e.message || t("app.sendFailed"), type: "error" })
              );
            }}
            // Re-broadcast / heal a "ghost" trade: re-publish its cached event
            // chain to today's relays so a counterparty who can't see it
            // (events never reached their relays) can finally load + claim it.
            onRebroadcast={(escrowId) => actions.rebroadcastEscrow(escrowId)}
            // Forget an unrecoverable ghost locally, then leave the now-empty
            // detail view. Money stays in escrow; re-loadable by ID.
            onForget={(escrowId) => {
              actions.forgetEscrow(escrowId);
              setToast({ message: t("app.tradeForgotten"), type: "success" });
              setView(detailBackView);
              setSelectedId(null);
              maybeSnapBackHome();
            }}
            // R3-2 (3.5.x): the pre-lock "Leave" handler was removed — a buyer
            // who wanders off just lets the 5-minute seat hold expire (no
            // explicit abandon → never buries the trade or wipes the chat).
            // #7 multi-unit storefront: buy N units from a parent listing →
            // spawn the buyer's own child escrow and open it so they fund + lock
            // it via the normal flow. The parent stays a perpetual offer.
            onPurchase={async (_parentId, quantity) => {
              if (!selected) return;
              try {
                // One active draft per buyer + storefront. Relay delivery can
                // replay the parent while its child already exists; never mint
                // another child merely because the buyer tapped Buy again.
                const existingDraft = listingChildren(selected)
                  .filter((child) => isActiveChildOrder(child)
                    && child.participants[Role.BUYER] === pubkey)
                  .sort((a, b) => b.createdAt - a.createdAt)[0];
                if (existingDraft) {
                  setToast({ message: t("app.resumingDraftOrder"), type: "info" });
                  openEscrow(existingDraft.id);
                  return;
                }
                setToast({ message: t("app.startingOrder"), type: "info" });
                const { escrowId } = await actions.purchaseFromListing(selected, quantity);
                openEscrow(escrowId);
              } catch (e: any) {
                setToast({ message: e?.message || t("app.couldntStartOrder"), type: "error" });
              }
            }}
            onCancelDraftOrder={async (escrowId) => {
              try {
                await actions.cancel(escrowId, "buyer_abandoned_draft_order");
                actions.forgetEscrow(escrowId);
                setSelectedId(null);
                setView("browse");
                setToast({ message: t("app.draftOrderCancelled"), type: "success" });
              } catch (e: any) {
                setToast({ message: e?.message || t("app.couldntCancelDraftOrder"), type: "error" });
              }
            }}
            stockLeft={selected ? stockByListing.get(selected.id) : undefined}
            isOversoldOrder={selected ? oversoldChildIds.has(selected.id) : false}
            // #63 storefront routing: the live (LOCKED, unsettled) child orders
            // spawned from THIS parent storefront, so the seller can see and
            // tap through to each order to fulfill it. Reuses the App-derived
            // childrenByParent grouping (via listingChildren) — no re-query.
            liveChildOrders={selected ? listingChildren(selected).filter(isLiveChildOrder) : undefined}
            // Pre-lock reservations on this storefront where I'm the seller:
            // CREATED (unfunded) child orders that haven't passed their own
            // deadline. Surfaces a "joined but not paid" order to the seller —
            // the multi-unit analogue of the single-listing buyer-attempts panel.
            pendingChildOrders={selected
              ? listingChildren(selected).filter((c) =>
                  isActiveChildOrder(c)
                  && c.status === EscrowStatus.CREATED
                  && c.participants[Role.SELLER] === pubkey
                  && (c.expiresAt === undefined || c.expiresAt <= 0 || now <= c.expiresAt))
              : undefined}
            onOpenChild={(id) => openEscrow(id)}
            onStartEcashSlicePlan={TRADE_SLICING_ENABLED ? async (parentId) => {
              try {
                const result = await actions.startEcashSlicePlan(parentId);
                setToast({ message: `Protected ${result.children.length}-slice ecash plan started.`, type: "success" });
                // PLAN_START is not the user's destination. The first child is
                // the only fundable escrow now, so take the locking seller
                // straight there instead of leaving them on a manifest whose
                // rows merely look informational.
                const firstSlice = result.children.find((child) => child.trancheChild?.index === 0)
                  ?? result.children[0];
                if (firstSlice) openEscrow(firstSlice.id);
              } catch (e: any) {
                setToast({ message: e?.message || "Couldn't start the ecash slice plan.", type: "error" });
                throw e;
              }
            } : undefined}
            // v1.2.4: direct-NWC Fund. Saved-NWC users skip the
            // AtomicFundingModal chooser entirely; the button on
            // TradeDetail dispatches fundAndLock with NWC params and
            // renders the phase inline. Falls back to the regular
            // onLock (modal flow) on failure via the "Try other
            // method" link.
            onLockDirectNwc={async (opts) => {
              if (fediWebView) {
                setToast({
                  message: t("app.fediNwcDisabledFund"),
                  type: "info",
                });
                return { ok: false, error: "NWC disabled in Fedi" };
              }
              if (!fedimint.joined) {
                setToast({ message: t("app.joinChamaFirst"), type: "error" });
                return { ok: false, error: "Join a Chama first" };
              }
              if (midFunding) {
                setToast({
                  message: t("app.anotherFundingInProgress"),
                  type: "error",
                });
                return { ok: false, error: "Mid-funding" };
              }
              if (!selected) return { ok: false, error: "No selected trade" };
              if (
                !simOn &&
                !isTestnetMode() &&
                opts.amountMsats < MIN_REAL_ATOMIC_FUNDING_MSATS
              ) {
                setToast({
                  message: `${minimumAtomicFundingMessage()} ${t("app.enterPositiveAmount")}`,
                  type: "error",
                });
                return { ok: false, error: "Amount too small" };
              }
              const probe = await actions.probeFederation();
              if (!probe.ok) {
                setToast({
                  message: probe.error || t("app.walletDisconnectedReconnect"),
                  type: "error",
                });
                return { ok: false, error: probe.error || "Probe failed" };
              }
              const description = (selected.category === "marketplace" ? "Pay for Item"
                : selected.category === "lending" ? "Fund Loan"
                : selected.category === "bill-pay" ? "Lock Sats"
                : selected.category === "p2p-trade" ? "Fund Escrow"
                : "Lock Sats");
              try {
                const terminal = await actions.fundAndLock(selectedId!, {
                  amountMsats: opts.amountMsats,
                  // E1.1: same insurance fold as the modal path.
                  premiumMsats: funderPremiumMsats(selected, opts.amountMsats),
                  description,
                  fundingMethod: "nwc",
                  nwcConnectionString: opts.nwcConnectionString,
                  rememberNwc: false, // already saved
                  savedHandleId: opts.savedHandleId,
                  selectedItems: opts.selectedItems,
                  onPhase: (phase) => {
                    // Map engine phase kinds to compact button labels.
                    const label =
                      phase.kind === "creating-invoice" ? t("app.phaseCreatingInvoice")
                      : phase.kind === "creating-invoice-slow" ? t("app.phaseStillCreatingInvoice")
                      : phase.kind === "awaiting-payment" ? t("app.phaseAwaitingPayment")
                      : phase.kind === "paying-with-nwc" ? t("app.phasePayingNwc")
                      : phase.kind === "mint-confirming" ? t("app.phaseMintConfirming")
                      : phase.kind === "mint-confirming-slow" ? t("app.phaseMintConfirmingSlow")
                      : phase.kind === "payment-confirmed" ? t("app.phaseLocking")
                      : phase.kind === "locking" ? t("app.phaseLocking")
                      : phase.kind === "locked" ? t("app.phaseLocked")
                      : phase.kind === "invoice-created" ? t("app.phaseInvoiceReady")
                      : t("app.phaseFunding");
                    opts.onPhase?.(label);
                  },
                });
                if (terminal.kind === "locked") {
                  setToast({ message: t("app.satsLocked"), type: "success" });
                  return { ok: true };
                }
                if (terminal.kind === "lock-failed") {
                  setToast({ message: humanizeNwcError(terminal.error), type: "error" });
                  return { ok: false, error: terminal.error };
                }
                if (terminal.kind === "expired") {
                  setToast({ message: t("app.invoiceExpired"), type: "info" });
                  return { ok: false, error: "Invoice expired" };
                }
                if (terminal.kind === "mint-timeout") {
                  setToast({
                    message: t("app.mintStalled"),
                    type: "info",
                  });
                  return { ok: false, error: "Mint timeout" };
                }
                // aborted = silent
                return { ok: false, error: "Aborted" };
              } catch (e: any) {
                const msg = humanizeNwcError(e?.message || t("app.fundingFailed"));
                setToast({ message: msg, type: "error" });
                return { ok: false, error: msg };
              }
            }}
            // v1.2.4: direct-NWC Claim. Resolves a destination
            // invoice via NWC make_invoice, then dispatches the
            // claim-and-payout flow. Skips ClaimPayoutModal entirely.
            onClaimDirectNwc={async (opts) => {
              if (fediWebView) {
                setToast({
                  message: t("app.fediNwcDisabledClaim"),
                  type: "info",
                });
                return { ok: false, error: "NWC disabled in Fedi" };
              }
              if (!selected) return { ok: false, error: "No selected trade" };
              const winner = getWinner(selected);
              if (!winner) return { ok: false, error: "No winner yet" };
              const payoutMsats = selected.amountMsats;
              // E1.1: same insurance holdback as the ClaimPayoutModal path.
              const nwcClaimDecision = (!isSimModeOn() && !isTestnetMode() && pubkey)
                ? computeArbiterPremium(selected, pubkey)
                : null;
              const nwcPremiumMsats = nwcClaimDecision?.payable ? nwcClaimDecision.amountMsats : 0;
              const effectivePayoutMsats = Math.max(0, payoutMsats - nwcPremiumMsats);
              const { resolveNwcConnectionToInvoice } = await import("../payments/nwc.js");
              const { claimPayoutSats } = await import("../payments/lightning-fees.js");
              const payoutSats = claimPayoutSats(effectivePayoutMsats, "lightning");
              opts.onPhase?.(t("app.askingNwcInvoice"));
              let invoice: string;
              try {
                invoice = await resolveNwcConnectionToInvoice(
                  opts.nwcConnectionString,
                  payoutSats,
                  { description: "Chama claim payout" },
                );
              } catch (e: any) {
                const msg = humanizeNwcError(e?.message || t("app.nwcWalletRefused"));
                setToast({ message: msg, type: "error" });
                return { ok: false, error: msg };
              }
              opts.onPhase?.(t("app.phaseClaiming"));
              try {
                const terminal = await actions.claimAndPayout(selectedId!, {
                  bolt11: invoice,
                  expectedDeltaMsats: effectivePayoutMsats,
                  saveAfter: false,
                  onPhase: (phase) => {
                    const label =
                      phase.kind === "claiming" ? t("app.phaseRecoveringShare")
                      : phase.kind === "confirming" ? t("app.phaseMintConfirming")
                      : phase.kind === "paying-invoice" ? t("app.phaseSendingNwc")
                      : t("app.phaseClaiming");
                    opts.onPhase?.(label);
                  },
                });
                // R3-1: payout-confirming is NOT an error — the payment was
                // submitted and is settling; the #2 background re-attach flips
                // the trade to done when it lands. Treat it as success here so
                // the direct-NWC surface stops "Sending to NWC…" and doesn't
                // invite a retry (the journal guard makes retry inert anyway).
                if (terminal.kind === "done" || terminal.kind === "payout-confirming") {
                  setToast({
                    message: terminal.kind === "done"
                      ? t("app.payoutSent")
                      : t("app.payoutSentConfirming"),
                    type: "success",
                  });
                  try { addOrTouchSavedNwcConnection(opts.nwcConnectionString); } catch {}
                  return { ok: true };
                }
                const msg = humanizeNwcError(
                  ("error" in terminal ? terminal.error : "") || t("app.claimFailed"),
                );
                setToast({ message: msg, type: "error" });
                return { ok: false, error: msg };
              } catch (e: any) {
                const msg = humanizeNwcError(e?.message || t("app.claimFailed"));
                setToast({ message: msg, type: "error" });
                return { ok: false, error: msg };
              }
            }}
            onLock={async (lockOpts = {}) => {
              const savedHandleId = lockOpts.savedHandleId;
              const selectedItems = lockOpts.selectedItems;
              if (!fedimint.joined) {
                setToast({ message: t("app.joinChamaFirst"), type: "error" });
                return;
              }
              // v0.6.5: the only Fund gate is mid-funding — multiple
              // concurrent trades are fine, but two concurrent atomic
              // funding flows would race the shared OPFS wallet.
              if (midFunding) {
                setToast({
                  message: t("app.anotherFundingInProgress"),
                  type: "error",
                });
                return;
              }
              if (!selected) return;
              const lockAmountMsats = lockOpts.amountMsats ?? selected.amountMsats;
              if (
                !simOn &&
                !isTestnetMode() &&
                lockAmountMsats < MIN_REAL_ATOMIC_FUNDING_MSATS
              ) {
                setToast({
                  message: `${minimumAtomicFundingMessage()} ${t("app.enterPositiveAmount")}`,
                  type: "error",
                });
                return;
              }
              const probe = await actions.probeFederation();
              if (!probe.ok) {
                setToast({
                  message: probe.error || t("app.walletDisconnectedReconnect"),
                  type: "error",
                });
                return;
              }
              // v0.3.0 Phase 2: open AtomicFundingModal instead of
              // dispatching lockAndPublish directly. The modal handles
              // BOLT11 → mint → LOCK in one user-perceived motion.
              // Pillar 2.1 Option B: no intermediate balance UI.
              const lockLabel = selected.category === "marketplace" ? "Pay for Item"
                : selected.category === "lending" ? "Fund Loan"
                : selected.category === "bill-pay" ? "Lock Sats"
                : selected.category === "p2p-trade" ? "Fund Escrow"
                : "Lock Sats";
              // E1.1: fold the funder's 0.25% arbiter insurance into the
              // invoice (bonded-stamp trades only; zero in sim/testnet).
              const fundPremiumMsats = (!simOn && !isTestnetMode())
                ? funderPremiumMsats(selected, lockAmountMsats)
                : 0;
              return new Promise<void>((resolve) => {
                setPendingFundAndLock({
                  escrowId: selectedId!,
                  amountMsats: lockAmountMsats,
                  premiumMsats: fundPremiumMsats,
                  ctaLabel: lockLabel,
                  savedHandleId,
                  selectedItems,
                  tradeCommunity: selected.community,
                  fiatCurrency: selected.fiatCurrency,
                  tradeCategory: selected.category,
                  resolve,
                });
              });
            }}
            onPrewarmFunding={() => {
              void actions.prewarmFunding();
            }}
            onOpenSettings={() => setView("saved-handles")}
            onOpenNwcSettings={() => { setAdvancedFocusNwc(true); setView("advanced"); }}
          />
        </div>
      ) : view === "create" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {/* v0.6.5: Create no longer hard-blocks on active trades.
              The pill stays as the informational "you have N active
              trades" reminder; the form is always available below. */}
          {visibleAttentionTrade && (
            <ActiveTradePill
              trade={visibleAttentionTrade}
              activeTradeCount={activeCommitmentCount}
              activeTradeMsats={activeTradeMsats}
              actionMode={attentionActionMode}
              actionCount={needsYouCount}
              onTap={() => openEscrow(visibleAttentionTrade.id)}
            />
          )}
          {nativeLockResume && (
            <PendingLockCard
              entry={nativeLockResume}
              tradeDescription={escrows.get(nativeLockResume.escrowId)?.description ?? null}
              busy={pendingLockBusy}
              onFinishLock={handleFinishPendingLock}
              onOpenTrade={() => openEscrow(nativeLockResume.escrowId)}
            />
          )}
          {pendingPayoutCard && (
            <PendingPayoutCard
              entry={pendingPayoutCard}
              onOpenTrade={() => openEscrow(pendingPayoutCard.escrowId)}
            />
          )}
          {showRecoveryBanner ? (
            <RecoveryBanner
              balanceMsats={fedimint.balanceMsats ?? 0}
              source={strandedSource}
              genericResidue={strandedGenericResidue}
              fundsReturned={fundingReturned}
              fundingTrade={fundingTrade}
              fetchKind0Enabled={false}
              onRecover={() => {
                // v0.3.0 Phase 4: open RecoveryPayoutModal — no
                // queued follow-up since this path isn't gated by a
                // pending federation switch.
                setPendingRecovery({
                  title: t("app.recoverSatsTitle"),
                  traceContext: recoveryTraceContext,
                });
              }}
            />
          ) : (
            <CreateForm
              onCreate={handleCreate}
              onClose={() => setView("browse")}
              arbiterWarning={arbiterWarning}
              onGoToArbiterTrade={(escrowId) => openEscrow(escrowId)}
              canOfferSubscription={userCanSubscribe}
              userPubkey={pubkey ?? null}
              activeInvite={liveActiveInvite}
              amountDisplayMode={amountDisplayMode}
              communitySlug={browseCommunity}
              fetchCommunityBonds={actions.fetchCommunityBonds}
              fetchFaultExcludedArbiters={actions.fetchFaultExcludedArbiters}
              authorizeImageUpload={actions.authorizeImageUpload}
            />
          )}
        </div>
      ) : view === "dashboard" ? (
        // v5.0 "finish the bond": the real Dashboard — standing (ratings), your
        // bond, chama liveness, and trade stats, composed from data the app
        // already has. Replaces the v4.2.1 "coming soon" placeholder.
        <DashboardScreen
          pubkey={pubkey!}
          ratings={myRatings}
          myTrades={myTrades}
          communitySlug={browseCommunity}
          loadLiveness={actions.getChamaLiveness}
          livenessBlocksPerDay={BOND_LIVENESS_BLOCKS_PER_DAY}
          onOpenBondCeremony={() => setShowBondCeremony(true)}
          earningsRevision={earningsRevision}
          balanceMsats={fedimint.balanceMsats ?? 0}
          onWithdrawEcash={() => setShowEcashExport(true)}
          fetchMyBonds={actions.fetchMyBonds}
          getBondChainTip={actions.getBondChainTip}
        />
      ) : view === "me" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {visibleAttentionTrade && (
            <ActiveTradePill
              trade={visibleAttentionTrade}
              activeTradeCount={activeCommitmentCount}
              activeTradeMsats={activeTradeMsats}
              actionMode={attentionActionMode}
              actionCount={needsYouCount}
              onTap={() => openEscrow(visibleAttentionTrade.id)}
            />
          )}
          <LapsedStoreCard
            listings={lapsedListings}
            bonded={sellerBonded}
            showAutoRenew={sellerBonded}
            autoRenewEnabled={storeAutoRenewEnabled}
            onAutoRenewChange={changeStoreAutoRenew}
            renewingId={renewingId}
            onRenew={renewListing}
          />
          <RecurringBillCard series={recurringSeries} onStop={cancelRecurring} />
          <MeScreen
            pubkey={pubkey!}
            kind0Enabled={kind0Enabled}
            onKind0EnabledChange={setKind0Enabled}
            themeMode={themeMode}
            onThemeModeChange={setThemeMode}
            myTrades={myTrades}
            allTrades={visibleTrades}
            needsYouTrades={needsYouTrades}
            archivedTrades={archivedTrades}
            onOpenArchivedTrade={openArchivedTrade}
            ratings={myRatings}
            onRateCounterparty={handleRateCounterparty}
            myGivenRatings={myGivenRatings}
            balanceMsats={fedimint.balanceMsats ?? 0}
            hasActiveCommitment={hasActiveCommitment}
            satsTrace={displayedSatsTrace}
            hasPendingNativeLock={hasPendingNativeLock}
            hasPendingClaimPayout={hasPendingClaimPayout}
            stuckNativeLocks={nativeLockSummary.stuck}
            onRecoverSats={() => setPendingRecovery({
              title: t("app.recoverSatsTitle"),
              traceContext: recoveryTraceContext,
            })}
            onOpenTrade={(id) => openEscrow(id, "me")}
            onRefreshTrades={async () => {
              const added = await actions.refreshMyTrades();
              setToast({
                message: added > 0
                  ? (added === 1
                      ? t("app.foundTradesOne", { count: added })
                      : t("app.foundTradesMany", { count: added }))
                  : t("app.tradesUpToDate"),
                type: added > 0 ? "success" : "info",
              });
              return added;
            }}
            onSellerEditListing={editSellerListing}
            onSellerDeleteListing={deleteSellerListing}
            onOpenSavedHandles={() => setView("saved-handles")}
            onOpenPayoutDestinations={() => setView("payout-destinations")}
            unfundedListingCount={clearableListings.length}
            onClearUnfundedListings={() => setShowClearListings(true)}
            onOpenAdvanced={() => { setAdvancedFocusNwc(false); setView("advanced"); }}
            onOpenHelp={() => setView("help")}
            onSignOut={handleSignOut}
            onWithdrawEcash={() => setShowEcashExport(true)}
            onExportStrandedClaim={(entry) => setStrandedClaimExport(entry)}
            onReabsorbBearerNotes={handleReabsorbBearerNotes}
            communitySlug={browseCommunity}
            onSelectCommunity={handleSelectCommunity}
            onOpenBondCeremony={() => setShowBondCeremony(true)}
            loadLiveness={actions.getChamaLiveness}
            livenessBlocksPerDay={BOND_LIVENESS_BLOCKS_PER_DAY}
          />
        </div>
      ) : view === "saved-handles" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {visibleAttentionTrade && (
            <ActiveTradePill
              trade={visibleAttentionTrade}
              activeTradeCount={activeCommitmentCount}
              activeTradeMsats={activeTradeMsats}
              actionMode={attentionActionMode}
              actionCount={needsYouCount}
              onTap={() => openEscrow(visibleAttentionTrade.id)}
            />
          )}
          <SavedHandlesPanel
            communitySlug={actions.getCommunity()}
            onClose={() => setView("me")}
          />
        </div>
      ) : view === "payout-destinations" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {visibleAttentionTrade && (
            <ActiveTradePill
              trade={visibleAttentionTrade}
              activeTradeCount={activeCommitmentCount}
              activeTradeMsats={activeTradeMsats}
              actionMode={attentionActionMode}
              actionCount={needsYouCount}
              onTap={() => openEscrow(visibleAttentionTrade.id)}
            />
          )}
          <PayoutDestinationsPanel
            onClose={() => setView("me")}
          />
        </div>
      ) : view === "help" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <HelpScreen onBack={() => setView("me")} />
        </div>
      ) : view === "advanced" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {visibleAttentionTrade && (
            <ActiveTradePill
              trade={visibleAttentionTrade}
              activeTradeCount={activeCommitmentCount}
              activeTradeMsats={activeTradeMsats}
              actionMode={attentionActionMode}
              actionCount={needsYouCount}
              onTap={() => openEscrow(visibleAttentionTrade.id)}
            />
          )}
          <SettingsAdvanced
            fedimint={fedimint}
            loadActiveRecoveryKey={actions.exportActiveRecoveryKey}
            focusNwc={advancedFocusNwc}
            onBack={() => setView("me")}
            onSandboxFund={() => setShowFundModal(true)}
            communitySlug={browseCommunity}
            userPubkey={pubkey}
            onRunDiscovery={actions.refreshMyTrades}
            onProbeFetchById={actions.probeFetchById}
            onPublishRoster={async (community, arbiters) => {
              await actions.publishCommunityRoster(community, arbiters);
            }}
            onFetchApplications={async (community, exclude) =>
              actions.fetchArbiterApplications(community, exclude)
            }
            onSwitchFederation={async (inviteCode, opts) => {
              try {
                setToast({ message: t("app.joiningChama"), type: "info" });
                // Dispatch: init for first-time join (no fed loaded yet),
                // switch when already joined. Mirrors the community-tap
                // handler's logic so Sandbox works pre-join.
                if (fedimint.federationId) {
                  await actions.switchFederation(inviteCode, opts);
                } else {
                  await actions.initFedimint(inviteCode, opts);
                }
                setToast({ message: t("app.joined"), type: "success" });
              } catch (e: any) {
                setToast({ message: e?.message || t("app.joinFailedShort"), type: "error" });
                throw e;
              }
            }}
            onResetLocalWallet={async () => {
              try {
                setToast({ message: t("app.resettingLocalChama"), type: "info" });
                await actions.resetLocalWallet();
                setToast({ message: t("app.localChamaReset"), type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || t("app.resetFailed"), type: "error" });
              }
            }}
          />
        </div>
      ) : (
        <>
          {visibleAttentionTrade && (
            <ActiveTradePill
              trade={visibleAttentionTrade}
              activeTradeCount={activeCommitmentCount}
              activeTradeMsats={activeTradeMsats}
              actionMode={attentionActionMode}
              actionCount={needsYouCount}
              onTap={() => openEscrow(visibleAttentionTrade.id)}
            />
          )}
          {nativeLockResume && (
            <PendingLockCard
              entry={nativeLockResume}
              tradeDescription={escrows.get(nativeLockResume.escrowId)?.description ?? null}
              busy={pendingLockBusy}
              onFinishLock={handleFinishPendingLock}
              onOpenTrade={() => openEscrow(nativeLockResume.escrowId)}
            />
          )}
          {pendingPayoutCard && (
            <PendingPayoutCard
              entry={pendingPayoutCard}
              onOpenTrade={() => openEscrow(pendingPayoutCard.escrowId)}
            />
          )}
          {showRecoveryBanner ? (
            <RecoveryBanner
              balanceMsats={fedimint.balanceMsats ?? 0}
              source={strandedSource}
              genericResidue={strandedGenericResidue}
              fundsReturned={fundingReturned}
              fundingTrade={fundingTrade}
              fetchKind0Enabled={false}
              onRecover={() => {
                // v0.3.0 Phase 4: open RecoveryPayoutModal — no
                // queued follow-up since this path isn't gated by a
                // pending federation switch.
                setPendingRecovery({
                  title: t("app.recoverSatsTitle"),
                  traceContext: recoveryTraceContext,
                });
              }}
            />
          ) : (
            <BrowseView
              browseCategory={browseCategory}
              setBrowseCategory={setBrowseCategory}
              browseCommunity={routeCommunitySlug}
              amountDisplayMode={amountDisplayMode}
              matchingListings={matchingListings}
              nonMatchingListings={nonMatchingListings}
              stockByListing={stockByListing}
              orderIndicatorByListing={listingOrderIndicator}
              categoryCounts={browseCategoryCounts}
              fedimintJoined={fedimint.joined}
              listingsLoading={publicListingsLoading}
              isFirstTime={getUserCommunitySlugRaw() === null}
              onPasteCustomInvite={handlePasteCustomInvite}
              pubkey={pubkey!}
              kind0Enabled={kind0Enabled}
              profileNames={nostrProfiles}
              fetchRatingSummary={actions.fetchRatingSummary}
              onCreate={() => setCreateOverlayOpen(true)}
              onApplyAsArbiter={async (community, statement) => {
                await actions.applyAsArbiter(community, statement);
              }}
              onOpenGuided={() => setView("guided")}
              onOpenEscrow={openEscrow}
              onLoadById={async (id) => {
                try {
                  setToast({ message: t("app.loadingFromRelays"), type: "info" });
                  const state = await actions.loadEscrow(id);
                  if (state) {
                    setToast({ message: t("app.tradeLoaded"), type: "success" });
                    setDetailBackView("browse");
                    setSelectedId(id);
                    setView("detail");
                  } else {
                    setToast({ message: t("app.tradeNotFound"), type: "error" });
                  }
                } catch (e: any) {
                  setToast({ message: e.message || t("app.loadFailed"), type: "error" });
                }
              }}
            />
          )}
        </>
      )}

      {!detailMode && <BottomNav active={activeTab} onSelect={switchTab} badges={{ me: needsYouCount }} />}

      {/* v4.1 C1: one-time post-sign-in tour. Only on the Browse home screen
          (FABs mounted), never over the create sheet or a detail view. */}
      {coachReady && !coachSeen && !detailMode && !createOverlayOpen && view === "browse" && (
        <CoachMarkTour
          steps={COACH_STEPS}
          onDone={() => { setCoachSeen(true); setCoachReady(false); }}
        />
      )}

      {sellerManagedListing && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setSellerManageId(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 9994,
              background: "rgba(0,0,0,0.56)",
              backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)",
            }}
          />
          <div style={{
            position: "fixed", zIndex: 9995,
            left: 16, right: 16, top: "50%", transform: "translateY(-50%)",
            maxWidth: 460, margin: "0 auto", padding: 18,
            borderRadius: T.r, background: T.card,
            border: `1px solid ${T.border}`,
            boxShadow: "0 18px 54px rgba(0,0,0,0.72)",
          }}>
            <button
              type="button"
              onClick={() => setSellerManageId(null)}
              aria-label={t("common.close")}
              style={{
                position: "absolute", top: 12, right: 12,
                width: 32, height: 32, borderRadius: "50%",
                border: `1px solid ${T.border}`, background: T.surface,
                color: T.muted, cursor: "pointer", fontSize: 16,
              }}
            >×</button>
            <div style={{
              color: T.amber, fontFamily: T.mono, fontSize: 10,
              fontWeight: 800, letterSpacing: 1.1, textTransform: "uppercase",
              marginBottom: 8,
            }}><span style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 5 }}><VerticalIcon vertical="marketplace" size={15} /></span>Your listing</div>
            <div style={{
              color: T.text, fontFamily: T.sans, fontSize: 21,
              fontWeight: 850, lineHeight: 1.2, paddingRight: 38,
              marginBottom: 8,
            }}>{sellerManagedListing.description}</div>
            <div style={{
              color: T.muted, fontFamily: T.sans, fontSize: 13,
              lineHeight: 1.5, marginBottom: 18,
            }}>
              Buyers see the storefront. You manage it here; new orders appear separately in Me.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button
                type="button"
                onClick={() => editSellerListing(sellerManagedListing.id)}
                style={{
                  padding: "13px 14px", borderRadius: T.rs,
                  background: T.amberDim, border: `1px solid ${T.amber}66`,
                  color: T.amber, fontFamily: T.sans, fontSize: 15,
                  fontWeight: 800, cursor: "pointer",
                }}
              >✎ {t("me.edit")}</button>
              <button
                type="button"
                onClick={() => void deleteSellerListing(sellerManagedListing.id)}
                style={{
                  padding: "13px 14px", borderRadius: T.rs,
                  background: T.redDim, border: `1px solid ${T.red}66`,
                  color: T.red, fontFamily: T.sans, fontSize: 15,
                  fontWeight: 800, cursor: "pointer",
                }}
              >⌫ {t("me.delete")}</button>
            </div>
          </div>
        </>
      )}

      {editListingId && escrows.get(editListingId) && (
        <EditListingModal
          listing={escrows.get(editListingId)!}
          userPubkey={pubkey ?? null}
          onCancel={() => setEditListingId(null)}
          onSave={(edits) => saveListingEdits(editListingId, edits)}
        />
      )}

      {/* v3.2: the create flow opens from either the Browse floating-menu pencil
          or the old bottom-nav Create slot. CreateForm is self-contained (its own header /
          close × / step progress), so the sheet just frames it over a blurred
          Browse. Drafts persist to localStorage, so dismissing is non-destructive. */}
      {createOverlayOpen && (
        <>
          <div
            onClick={() => setCreateOverlayOpen(false)}
            aria-hidden="true"
            style={{
              position: "fixed", inset: 0, zIndex: 9994,
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)",
              animation: "fadeIn 0.2s ease",
            }}
          />
          <div style={{
            // Auto-height card sized to its content (like the arbiter toast),
            // NOT a full sheet — so the blurred Browse shows above AND below it
            // instead of an unblurrable black void. Only the drafts list grows
            // the content, so cap at the viewport (minus top+bottom blur margin)
            // and let extra drafts scroll inside.
            position: "fixed", left: 0, right: 0, top: 40,
            zIndex: 9995, maxWidth: 520, margin: "0 auto",
            maxHeight: "calc(100dvh - 80px)",
            background: T.bg, borderRadius: 18,
            border: `1px solid ${T.border}`,
            boxShadow: "0 12px 44px rgba(0,0,0,0.6)",
            overflowY: "auto", animation: "fadeIn 0.25s ease",
          }}>
            <CreateForm
              onCreate={async (params: any) => {
                await handleCreate(params);
                setCreateOverlayOpen(false);
                setDetailBackView("browse");
              }}
              onClose={() => setCreateOverlayOpen(false)}
              arbiterWarning={arbiterWarning}
              onGoToArbiterTrade={(escrowId) => { setCreateOverlayOpen(false); openEscrow(escrowId); }}
              canOfferSubscription={userCanSubscribe}
              userPubkey={pubkey ?? null}
              activeInvite={liveActiveInvite}
              amountDisplayMode={amountDisplayMode}
              communitySlug={browseCommunity}
              fetchCommunityBonds={actions.fetchCommunityBonds}
              fetchFaultExcludedArbiters={actions.fetchFaultExcludedArbiters}
              authorizeImageUpload={actions.authorizeImageUpload}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers — global CSS + login splash
// ══════════════════════════════════════════════════════════════════════════

// Function, not a const string: the template interpolates T (focus ring), and
// a module-scope capture would go stale when the palette swaps (#50). Called
// per render so it always reflects the active theme.
const globalCss = () => `
  /* Fonts are self-hosted via /fonts/fonts.css (linked in index.html, loaded
     before the bundle) — DM Sans + JetBrains Mono, offline/native-safe. The old
     Google Fonts @import lived here but was a render-blocking CDN call that
     failed on native (Tauri offline) → the system-font fallback this pass fixes. */
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes slideInDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
  /* v1.2.4: indeterminate progress strip used under the direct-NWC
     Fund / Claim buttons during action. A short bright bar sweeps
     left-to-right on a dim track, giving live feedback during the
     ~3-8s NWC pay window without forcing a percentage estimate. */
  @keyframes nwcProgressSweep{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
  /* v3.1 stage 4: progress-spine motion. spine-beam sweeps a bright energy beam
     rightward along the active connector (toward the next milestone) over a dim
     wire; spine-pulse is the soft glow ring breathing on the current node. Always
     rightward. Under reduced-motion the beam parks mid-wire and the glow goes static. */
  @keyframes spine-beam{0%{transform:translateX(-120%)}100%{transform:translateX(280%)}}
  @keyframes spine-pulse{0%{box-shadow:0 0 0 0 var(--spine-glow,transparent)}100%{box-shadow:0 0 0 7px transparent}}
  /* TradeView pager: gentle ‹ › nudge teaching the horizontal swipe gesture. */
  @keyframes pagerNudgeL{0%,100%{transform:translateX(0);opacity:.3}50%{transform:translateX(-3px);opacity:.65}}
  @keyframes pagerNudgeR{0%,100%{transform:translateX(0);opacity:.3}50%{transform:translateX(3px);opacity:.65}}
  /* TradeView gated money buttons: one tap ARMS (amber, pulsing) before the
     confirming second tap. */
  @keyframes armPulse{0%,100%{box-shadow:0 0 0 0 ${T.amber}00}50%{box-shadow:0 0 0 4px ${T.amber}22}}
  @media (prefers-reduced-motion: reduce){
    .spine-node-live{animation:none!important}
    .spine-beam{animation:none!important;transform:translateX(80%)!important}
    .td-pager-nudge{animation:none!important}
    .td-armed{animation:none!important}
  }
  /* Start9 split view gives each active-trade renderer a narrow viewport.
     Chrome 150 was observed driving one such renderer to a 3.5 GB physical
     footprint while two trade rooms continuously composited the glow/beam/
     nudge effects. Keep the exact static affordances at phone/split widths,
     but stop perpetual decorative compositor work. Trade state, chat, voting,
     and one-shot progress animations are unchanged. */
  @media (max-width:760px){
    .spine-node-live{animation:none!important}
    .spine-beam{animation:none!important;transform:translateX(80%)!important}
    .td-pager-nudge{animation:none!important}
    .td-armed{animation:none!important}
  }
  *{box-sizing:border-box;margin:0;padding:0}
  /* v2.5 polish: kill the browser's default tap-highlight (the blue/grey
     flash on Android taps) and the default blue focus halo on buttons/links.
     Keep accessibility intact: a subtle Chama focus ring still shows for
     KEYBOARD navigation via :focus-visible, just not on mouse/touch. */
  *{-webkit-tap-highlight-color:transparent}
  button:focus:not(:focus-visible),a:focus:not(:focus-visible),[role="button"]:focus:not(:focus-visible){outline:none}
  button:focus-visible,a:focus-visible,[role="button"]:focus-visible{outline:2px solid ${T.accent}aa;outline-offset:2px}
  input::placeholder{color:${T.muted}88}
  input:focus,select:focus{border-color:${T.accent}66!important}
  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:4px}
  .payment-rail-scroll::-webkit-scrollbar{display:none}
  .trade-detail-shell{padding:16px;max-width:520px;margin:0 auto}
  .trade-detail-layout{display:block}
  .trade-detail-listing-pane,.trade-room-card{min-width:0}
  .trade-detail-title{max-width:100%}
  @media (min-width: 980px){
    .trade-detail-shell{max-width:1040px;padding:28px 20px 48px}
    .trade-detail-layout{display:grid;grid-template-columns:minmax(0,.92fr) minmax(420px,1.08fr);gap:18px;align-items:start}
    .trade-room-card{position:sticky;top:20px}
    .trade-detail-title{font-size:26px!important}
    .trade-detail-amount .bitcoin-amount-number{font-size:40px!important}
    .trade-detail-amount .bitcoin-amount-glyph{font-size:36px!important}
    .trade-lock-ring{width:148px!important;height:148px!important}
  }
  @media (min-width: 1280px){
    .trade-detail-shell{max-width:1120px}
    .trade-detail-layout{grid-template-columns:minmax(0,480px) minmax(460px,1fr)}
  }
  /* TradeView UX pass: the redesigned trade screen is a single phone-width
     column at EVERY breakpoint (the approved mockups are phone-shaped). These
     trailing rules retire the old ≥980px two-column split + sticky room card —
     they come last so they win over the media rules above at equal specificity. */
  .trade-detail-shell{width:100%;max-width:480px;padding:14px 14px 18px;margin:0 auto;flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
  .trade-detail-layout{display:block!important}
  .trade-room-card{position:static!important}
  /* TradeView pager + anchored timeline. */
  .td-pager::-webkit-scrollbar,.td-pane::-webkit-scrollbar{display:none}
  .td-timeline summary{list-style:none}
  .td-timeline summary::-webkit-details-marker{display:none}
  .td-timeline[open] .td-tl-chev{transform:rotate(90deg);border-color:${T.accent};color:${T.accent}}
`;
