import { EcashCustody } from "../components/MoneyCustody.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { walletHome, isNativeAppShell } from "../wallet-location.js";
import { SettingsRow } from "../components/SettingsRow.js";
import { RecoveryKeyRow, RecoveryKeyReminder } from "../components/RecoveryKey.js";
import { useMoneySafety } from "../components/HeldSats.js";
import { UnverifiedHistory } from "../components/UnverifiedHistory.js";
import { PayoutTransactionDetails } from "../components/PayoutTransactionDetails.js";
import { MAINNET, SIGNET } from "../../bond-multisig/multisig.js";
import type { OnchainObservation } from '../../escrow-engine/onchain-attention.js';
import { arbiterWatchEligibility, canOfferClaim } from "../decisions.js";
import { testNativePush, nativePushStatus, type NativePushStatus } from "../../notifications/native-push.js";
import { avatarFromFile, type Avatar } from "../avatars.js";
import { ProfileAvatar } from "../components/ProfileAvatar.js";
// ══════════════════════════════════════════════════════════════════════════
// Chama — Me screen (v0.2.0 Phase 6 skeleton population)
// ══════════════════════════════════════════════════════════════════════════
//
// Consolidates: profile, ratings, Nostr Profile sub-section, settings
// entries, trade history. Per the v0.2.0 brief Me is fully accessible
// during active trades — users may need to update LN address, fetch
// counterparty kind:0, or check ratings/history as part of resolving
// recovery / arbitration.
//
// Ratings: minimal aggregator (count + %positive). v0.2.0 universally
// renders the "no ratings yet" placeholder because no rating events
// are being published until v0.2.1; the surface ships now to teach
// the user that reputation is the primitive.
//
// Nostr Profile: deliberately minimal. The kind:0 toggle (default off,
// privacy-preserving) opts into fetching counterparty names; v0.2.1
// wires the actual fetcher. Read-only display of the user's own kind:0
// is similarly v0.2.1+ territory. v0.2.0 ships the toggle + the
// "Chama doesn't manage your Nostr profile" educational copy so the
// doctrine is visible from day one.

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useDeferredValue, useCallback, memo, type ReactNode } from "react";
import { useStableCallback } from "../stable-list.js";
import { checkedTradeCreate, perfMeasure, perfTapStart, perfTapCommitted, perfAdd, PerfZone } from "../perf-probe.js";
import { createMeTabStore, useMePressedTab, useMeShownTab, type MeTabKey, type MeTabStore } from "../me-tab-store.js";
import { useT, translate, getCurrentLang } from "../../i18n/index.js";
import { LanguageRow } from "../components/LanguagePills.js";
import {
  type EscrowState,
  EscrowStatus,
  EscrowEventKind,
  Outcome,
  Role,
  type SelectedMenuItem,
  getEffectiveParticipantAt,
  getEffectiveParticipantsAt,
} from "../../escrow-engine/types.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { arbiterVotePriority, substitutionEligibleAt } from "../../escrow-engine/arbiter-substitution.js";
import { BLF_OFFICIAL_ARBITERS, isCabinetMember } from "../../arbiters/pool.js";
import { SHOW_BOND_CEREMONY } from "../panels/BondCeremonyModal.js";
import { LivenessSignal, useLiveness } from "../components/LivenessSignal.js";
import { isVerifiedArbiter, type ChamaLiveness } from "../../arbiters/live-chama.js";

/** How often the Me screen re-checks its own chama's liveness (a bond appearing
 *  or a rating landing shows up without a manual reload). Slow — liveness drifts
 *  on the scale of blocks, not seconds. */
const LIVENESS_POLL_MS = 90_000;
import { getCommunityBySlug } from "../../communities/registry.js";
import { countryMatchesSearch, countrySubline, resolveCountryCommunitySlug } from "../../communities/country-resolve.js";
import { getAllPickerCountries } from "../../communities/countries.js";
import {
  liveCommitmentForViewer,
  formatStepInCountdown,
  selectNeedsYouTrades,
  type AggregateRatings,
} from "../decisions.js";
import { AttentionQueue } from "../components/AttentionQueue.js";
import { latestParticipantTradePointer } from "../latest-trade.js";
import { buildMeTradeCounts, filterMeTrades, searchMeTrades, ME_TRADE_PAGE_SIZE, type MeTradeFilter, type MeTradeCounts } from "../me-trade-filters.js";
import { counterpartyToRate, type RatingThumb } from "../../reputation/ratings.js";
import { RatingTap } from "../components/RatingTap.js";
import type { SatsTraceEntry } from "../../payments/sats-trace.js";
import type { ReabsorbOutcome } from "../../fedimint/reabsorb-bearer-notes.js";
import type { StrandedRedemption } from "../../fedimint/pending-redemptions.js";
import type { PendingNativeLock } from "../../fedimint/pending-native-locks.js";
import { T, ROLE_COLOR, type ThemeMode } from "../theme.js";
import {
  notificationsEnabled,
  setNotificationsEnabled,
  ensureNotificationPermission,
  sendNotificationSelfTest,
  dmNotifyPref,
  setDmNotifyPref,
  type DmNotifyPref,
  newListingPref,
  setNewListingPref,
  tradeDmPref,
  setTradeDmPref,
} from "../../notifications/notify-service.js";
import { TradeCard } from "../components/TradeCard.js";
import { type AmountDisplayMode } from "../amount-display.js";
import { AmountDisplayProvider, TradeAmount } from "../components/TradeAmount.js";
import type { TradeIndexEntry } from "../../escrow-engine/trade-index.js";
import { readKind0Toggle, writeKind0Toggle, readLocalTradeName, writeLocalTradeName, sanitizeTradeName, generatedNameFor, profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { backgroundPushEnabled, enableBackgroundPush, disableBackgroundPush } from "../../notifications/watch-tags.js";
import { isWebPushSupported, iosNeedsInstallForPush } from "../../notifications/web-push-client.js";
import { expectedFederationIdForInvite, federationNameForInvite } from "../../fedimint/federation-config.js";
import { publishedFederationName } from "../../fedimint/federation-inspection.js";
import { useFederationInfo } from "../components/FederationDisclosure.js";
import { listArbiterFederationRoutes } from "../../fedimint/arbiter-federation-store.js";



// i18n: labels are DICTIONARY KEYS resolved with t() at render (module-level
// constants can't call hooks). The `id` values are compared — never translated.
const ME_TRADE_FILTERS: { id: MeTradeFilter; labelKey: string }[] = [
  { id: "all", labelKey: "me.filterAll" },
  { id: "needs", labelKey: "me.filterNeedsYou" },
  { id: "live", labelKey: "me.filterLive" },
  { id: "listings", labelKey: "me.filterListings" },
  { id: "done", labelKey: "me.filterDone" },
];

export function MeScreen({
  onOpenHome,
  pubkey,
  kind0Enabled,
  profileNames,
  requestTab,
  onKind0EnabledChange,
  themeMode,
  onThemeModeChange,
  storeAutoRenew,
  myTrades: discoveredTrades,
  hydratingTrades = false,
  allTrades,
  needsYouTrades,
  onchainObservations,
  suppressAttentionCount = false,
  archivedTrades,
  onOpenArchivedTrade,
  ratings,
  onOpenTrade,
  onRefreshTrades,
  onPublishProfileName,
  onPublishProfileAvatar,
  amountDisplayMode = "sats",
  quoteCurrency,
  onSellerEditListing,
  onSellerDeleteListing,
  onOpenSavedHandles,
  onOpenPayoutDestinations,
  unfundedListingCount,
  onClearUnfundedListings,
  onOpenAdvanced,
  onOpenHelp,
  balanceMsats,
  hasActiveCommitment,
  paidLockFederationId,
  satsTrace,
  onRecoverSats,
  onWithdrawEcash,
  onSignOut, loadActiveRecoveryKey,
  communitySlug,
  onSelectCommunity,
  onRateCounterparty,
  myGivenRatings,
  onExportStrandedClaim,
  onReabsorbBearerNotes,
  onOpenBondCeremony,
  loadLiveness,
  livenessBlocksPerDay,
  hasPendingNativeLock,
  hasPendingClaimPayout,
  stuckNativeLocks,
}: {
  /** Open Home, where the cards for sats Chama holds now live. */
  onOpenHome?: () => void;
  pubkey: string;
  kind0Enabled?: boolean;
  /** Fetched kind-0 display names. Me used to render every counterparty as
   *  their generated nym because the map never reached it (Jet, 2026-09-20:
   *  "I see their Quick Dikdik again, no rename reach those"). */
  profileNames?: NostrProfileNameMap;
  /** Which pill to land on. Coming back from a Settings sub-panel must return
   *  to SETTINGS, not to the default tab (Jet, 2026-09-20). Carries a nonce so
   *  asking for the SAME tab twice still lands. */
  requestTab?: { tab: "trades" | "seller" | "arbiter" | "profile" | "community" | "settings" | "live-trades"; n: number; country?: string };
  onKind0EnabledChange?: (enabled: boolean) => void;
  /** #50 dark/light theming — current mode + setter (App owns the state). */
  themeMode?: ThemeMode;
  onThemeModeChange?: (mode: ThemeMode) => void;
  /** "Keep my offers live" — shown as a toggle row in Settings › Trading. */
  storeAutoRenew?: { enabled: boolean; onChange: (enabled: boolean) => void };
  myTrades: EscrowState[];
  /** Participant chains are still converging from saved ids + relays. Hide
   * trade-derived summaries until the settled snapshot is available. */
  hydratingTrades?: boolean;
  allTrades?: EscrowState[];
  /** Canonical urgency-ranked queue from App. Includes chain-verified pending
   *  on-chain payouts in addition to ordinary reducer-derived work. */
  needsYouTrades?: EscrowState[];
  onchainObservations?: ReadonlyMap<string, OnchainObservation>;
  suppressAttentionCount?: boolean;
  /** Durable-index trades not currently loaded — the loss-proof "earlier
   *  trades" tail of the history list. Absent ⇒ section omitted. */
  archivedTrades?: TradeIndexEntry[];
  /** Rehydrate + open an archived trade (awaits the reload; stays put + toasts
   *  when the chain can't be rebuilt). Distinct from onOpenTrade, which assumes
   *  a loadable trade and would dump the user on Browse on a null load. */
  onOpenArchivedTrade?: (id: string) => void;
  /** Aggregate rating data. v0.2.0 always null (no rating events yet);
   *  v0.2.1 wires the aggregator. */
  ratings: AggregateRatings | null;
  /** Reputation (kind:38123): one-tap rate a counterparty on a settled trade,
   *  and the slots already rated (so a rated trade drops its history one-tap). */
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
  onOpenTrade: (id: string) => void;
  /** Manual "refresh my trades" pull — re-runs active relay discovery and
   *  hydrates any trades missing from the local list. Returns how many were
   *  added (for a toast). */
  onRefreshTrades?: () => Promise<number> | void;
  /** The shell's sats/fiat toggle. Me used to ignore it, so flipping the big
   *  header switch changed Browse but left every past trade in sats (Jet,
   *  2026-09-19). Threaded through to the trade cards and the queues. */
  amountDisplayMode?: AmountDisplayMode;
  quoteCurrency?: string | null;
  /** Publish the chosen profile name as kind 0, so a rename follows the key
   *  rather than the browser. Absent ⇒ the name stays device-local. */
  onPublishProfileName?: (name: string) => Promise<void>;
  onPublishProfileAvatar?: (avatar: Avatar) => Promise<void>;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
  onOpenSavedHandles: () => void;
  onOpenPayoutDestinations: () => void;
  /** #82: count of the user's own never-funded listings — drives the "Clear my
   *  unfunded listings" Settings row (hidden when 0). */
  unfundedListingCount?: number;
  /** #82: open the confirm dialog to retire ALL own unfunded listings. */
  onClearUnfundedListings?: () => void;
  onOpenAdvanced: () => void;
  onOpenHelp: () => void;
  balanceMsats: number;
  hasActiveCommitment: boolean;
  paidLockFederationId?: string;
  satsTrace?: SatsTraceEntry | null;
  onRecoverSats: () => void;
  /** v2.4 #56 — open the "withdraw as ecash" (fee-free Fedimint note) flow. */
  onWithdrawEcash?: () => void;
  /** v3.4.0 C13 — open the export modal for a stranded claim's bearer
   *  note (a pending-redemption entry automatic retry gave up on). */
  onExportStrandedClaim?: (entry: StrandedRedemption) => void;
  /** 6.0.2 liveness probe. Ask the federation whether a bearer note is still
   *  live by TAKING it back into this wallet, and act on the answer (App owns
   *  the storage resolution + the toast; this screen only triggers and
   *  re-reads). Resolves to the outcome so the card can re-render.
   *
   *  Deliberately a prop and not a render-time effect: reissuing a LIVE note
   *  takes it back from whoever was about to claim it, so it must never fire
   *  except on a user's tap. */
  onReabsorbBearerNotes?: (input: {
    oobNotes: string;
    expectedMsats: number;
    context: "pending-export" | "stranded-claim";
    escrowId?: string;
  }) => Promise<ReabsorbOutcome>;
  onSignOut: () => void;
  loadActiveRecoveryKey?: () => Promise<string | null>;
  /** v2.3.1: the user's current Chama. The Browse pill is now view-only;
   *  this screen is the deliberate place to CHANGE it. */
  communitySlug?: string | null;
  /** Bound to handleSelectCommunity — switches Chama (with the same funds-at-
   *  risk destroy-confirm guard the Browse pill used to trigger). */
  onSelectCommunity?: (slug: string) => void;
  /** Bond Phase 2A: open the cabinet-only "Post your bond" ceremony. Rendered
   *  only for a seated cabinet member behind SHOW_BOND_CEREMONY. */
  onOpenBondCeremony?: () => void;
  /** Compute the user's OWN chama liveness (getChamaLiveness) — post-auth the
   *  client is connected, so this is a single cheap fetch. Absent ⇒ the card just
   *  omits the signal. */
  loadLiveness?: (slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>;
  /** Blocks/day for the "~D-day" term readout (signet ~2880, mainnet ~144). */
  livenessBlocksPerDay?: number;
  /** #37: an actionable pending lock attempt exists — the balance belongs
   *  to a known trade mid-recovery, so the SATS RECOVERY drain card hides
   *  (the Browse-surface "Finish locking your trade" card owns the story). */
  hasPendingNativeLock?: boolean;
  /** Stranded-payout recovery: an unfinished claim payout explains the
   *  balance — the SATS RECOVERY drain card hides while the Browse-surface
   *  "Finish your payout" card owns the story (bounded upstream by
   *  PENDING_PAYOUT_SUPPRESS_MAX_MS). */
  hasPendingClaimPayout?: boolean;
  /** #37: lock-recovery entries whose automatic retries were exhausted —
   *  surfaced as a calm informational card (bearer notes are kept safe;
   *  re-opening the trade retries with a fresh budget). */
  stuckNativeLocks?: PendingNativeLock[];
}) {
  const bodyStart = typeof performance !== "undefined" ? performance.now() : 0;
  const { t, lang } = useT();
  // App passes fresh inline callbacks on every render. Stable wrappers let the
  // memoised Me tabs below skip redrawing unless their own data changed.
  const openTrade = useStableCallback(onOpenTrade)!;
  const refreshTrades = useStableCallback(onRefreshTrades);
  const rateCounterparty = useStableCallback(onRateCounterparty);
  const openArchivedTrade = useStableCallback(onOpenArchivedTrade);
  const sellerEditListing = useStableCallback(onSellerEditListing);
  const sellerDeleteListing = useStableCallback(onSellerDeleteListing);
  const myTrades = useMemo(() => discoveredTrades.filter(checkedTradeCreate), [discoveredTrades]);
  const unverifiedIds = useMemo(() => {
    const verifiedIds = new Set(myTrades.map(trade => trade.id));
    return [...new Set([...discoveredTrades.map(trade => trade.id), ...(archivedTrades ?? []).map(trade => trade.id)])]
      .filter(id => !verifiedIds.has(id));
  }, [discoveredTrades, myTrades, archivedTrades]);
  const npubShort = pubkey.slice(0, 8) + "…" + pubkey.slice(-4);
  const [localKind0On, setLocalKind0On] = useState<boolean>(() => readKind0Toggle(pubkey));
  const kind0On = kind0Enabled ?? localKind0On;
  const [tradeFilter, setTradeFilter] = useState<MeTradeFilter>("all");
  const [pillTargetAt, setPillTargetAt] = useState(0);
  useEffect(() => {
    setLocalKind0On(readKind0Toggle(pubkey));
  }, [pubkey]);
  useEffect(() => { writeKind0Toggle(pubkey, kind0On); }, [pubkey, kind0On]);
  const setKind0On = (enabled: boolean) => {
    setLocalKind0On(enabled);
    onKind0EnabledChange?.(enabled);
  };
  // The recovery cards moved to Home; Me only needs to know whether any of
  // them is showing, to point there instead of saying all is clear.
  const { hasVisibleMoneyAction } = useMoneySafety({
    balanceMsats, hasActiveCommitment, paidLockFederationId, satsTrace,
    onWithdrawEcash, onExportStrandedClaim, onReabsorbBearerNotes,
    hasPendingNativeLock, hasPendingClaimPayout, stuckNativeLocks,
  });
  // Minute-coarse clock so the memos below have a stable key: these
  // derivations walk every trade's event chain, and running them on EVERY
  // render made each tab-pill tap visibly laggy on phones (v6.3.1 field
  // report). Nothing here needs sub-minute freshness.
  const nowSec = Math.floor(Date.now() / 60_000) * 60;
  const rawDashboard = useMemo(
    () => perfMeasure("dashboard build", () => buildMeDashboard(myTrades, allTrades ?? myTrades, pubkey, nowSec)),
    [myTrades, allTrades, pubkey, nowSec],
  );
  // `arbiterVisible` turns on when the viewer appears in any hydrated trade's
  // `communityArbiters` pool — and `allTrades` grows, shrinks and reshuffles
  // continuously while Browse and history stream in. So the Arbiter tab blinked
  // in and out of the row about once a second (Jet, 2026-09-21), moving every
  // tab beside it each time.
  //
  // A navigation affordance is not allowed to flicker. Latch it for the session:
  // once this account has been seen as an arbiter, the tab stays. Cleared when
  // the key changes, because then it is a different person.
  const arbiterSeenFor = useRef<string | null>(null);
  const arbiterEverVisible = useRef(false);
  if (arbiterSeenFor.current !== pubkey) {
    arbiterSeenFor.current = pubkey;
    arbiterEverVisible.current = false;
  }
  if (rawDashboard.arbiterVisible) arbiterEverVisible.current = true;
  const dashboard = useMemo(
    () => (rawDashboard.arbiterVisible === arbiterEverVisible.current
      ? rawDashboard
      : { ...rawDashboard, arbiterVisible: arbiterEverVisible.current }),
    [rawDashboard, arbiterEverVisible.current],
  );
  // App owns the canonical attention queue because it merges reducer-derived
  // work with chain-verified pending on-chain payouts. Keep the Me hero, Needs
  // count, and Needs filter on that exact source so the inner and outer pills
  // cannot disagree. The fallback preserves standalone/test callers.
  // (The fallback lacks App's zombie-claim suppression set — it exists only
  // for standalone/test callers; the app always passes needsYouTrades.)
  const rankedNeedsYou = useMemo(
    () => (needsYouTrades
      ?? perfMeasure("needs-you build", () => selectNeedsYouTrades({ escrows: allTrades ?? myTrades, userPubkey: pubkey, nowSec }))).filter(checkedTradeCreate),
    [needsYouTrades, allTrades, myTrades, pubkey, nowSec],
  );
  const tradeCounts = useMemo(
    () => buildMeTradeCounts(myTrades, rankedNeedsYou),
    [myTrades, rankedNeedsYou],
  );
  const visibleTrades = useMemo(
    () => filterMeTrades(myTrades, rankedNeedsYou, tradeFilter),
    [myTrades, rankedNeedsYou, tradeFilter],
  );
  const latestTrade = useMemo(
    () => latestParticipantTradePointer(myTrades, []),
    [myTrades, archivedTrades],
  );
  const hasSellerDashboard = dashboard.sellerOpen.length > 0 || dashboard.sellerLive.length > 0;
  // v6.3 approved redesign: Browse-style pill tabs replace the accordions.
  // Money-safety cards stay ABOVE the tabs — never hidden behind one.
  // The open tab lives in a small store, not in Me's state: a tap highlights
  // its pill at once and swaps two panes on the next frame, without
  // re-rendering this screen or anything outside it (Jet, 6.4.24 rc).
  const tabStore = useRef<MeTabStore | null>(null);
  if (!tabStore.current) tabStore.current = createMeTabStore("trades");
  const tabs = tabStore.current;

  useEffect(() => {
    if (!requestTab) return;
    // "live-trades" is a destination, not a tab: land on Trades with the Live
    // filter already applied, which is what the active-trade pill promises.
    if (requestTab.tab === "live-trades") {
      tabs.set("trades");
      setTradeFilter("live");
      // Glow the live rows for a beat: together they ARE the amount the pill
      // quoted, so highlighting all of them is the honest answer to "which
      // trade?" — picking one would be a guess.
      setPillTargetAt(Date.now());
      return;
    }
    tabs.set(requestTab.tab);
  }, [requestTab?.tab, requestTab?.n]);
  const pressTab = useStableCallback((key: MeTabKey) => {
    perfTapStart(key);
    tabs.press(key);
  })!;

  if (bodyStart) perfAdd("Me screen logic", performance.now() - bodyStart);
  return (
    <AmountDisplayProvider value={{ mode: amountDisplayMode, currency: quoteCurrency ?? null }}>
    <div style={{ padding: 16, maxWidth: 760, margin: "0 auto" }}>
      {/* Profile header — HIDDEN (Jetty 2026-07-15): Me is "what needs attention
          + settings" right now, not a profile space, so we reclaim this real
          estate. The npub still lives in the Profile & Chama accordion below.
          Flip `false` → true to bring it back when a dedicated Profile surface
          is designed. */}
      {false && (
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        <div style={{
          fontSize: T.fs.secondary, fontWeight: 600, color: T.muted, fontFamily: T.sans, marginBottom: 10,
        }}>
          {t("me.profile")}
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.accent,
            flexShrink: 0,
          }}>
            {pubkey.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono, marginBottom: 4 }}>
              npub
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 13, color: T.text,
              wordBreak: "break-all" as const,
            }}>
              {npubShort}
            </div>
          </div>
        </div>
      </div>
      )}

      <RecoveryKeyReminder key={pubkey} pubkey={pubkey} loadKey={loadActiveRecoveryKey} />

      {/* ⭐ ATTENTION HERO — the single prioritized "needs your attention" queue.
          One source of truth with the Me-tab badge (selectNeedsYouTrades),
          pin/snooze triage on top. Everything else is collapsed below. */}
      {hydratingTrades ? (
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 18, marginBottom: 16,
          color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ display: "inline-block", animation: "spin 0.8s linear infinite" }}>↻</span>
          <span>{t("me.hydratingTrades")}</span>
        </div>
      ) : (
        <AttentionQueue
          profileNames={profileNames} kind0Enabled={kind0Enabled}
          ranked={rankedNeedsYou}
          onchainObservations={onchainObservations}
          pubkey={pubkey}
          onOpenTrade={onOpenTrade}
          latestTrade={latestTrade}
          suppressEmptyState={hasVisibleMoneyAction}
          suppressCount={suppressAttentionCount}
        />
      )}

      {/* The cards for sats Chama holds (failed claims, leftovers, paused
          lock recovery, a note being sent) live on Home now, the one place
          that answers "is Chama holding any of my sats?". Me points there. */}
      {hasVisibleMoneyAction && onOpenHome && (
        <button type="button" data-me-held-sats onClick={onOpenHome} style={{
          width: "100%", minHeight: T.size.touch, marginBottom: 16, padding: "14px 16px", borderRadius: T.r,
          background: T.amberDim, border: `1px solid ${T.amber}66`, color: T.amber, textAlign: "left",
          fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
        }}>
          {t("me.heldSatsOnHome")} ›
        </button>
      )}


      {/* ── PILL TABS (v6.3) — the whole Me surface behind Browse-style pills.
          Trades is home; Arbiter shows only for arbiters; Profile & Settings
          hold the rest. There is no Wallet tab: Chama is not a wallet, and the
          sats it holds for you are on Home (Jet, Oct 19). */}
      <MeTabPills
        store={tabs}
        items={[
          ["trades", t("me.accMyTrades"), myTrades.length || undefined],
          ...(hasSellerDashboard ? [["seller", t("me.sellerDashboard"), (dashboard.sellerOpen.length + dashboard.sellerLive.length) || undefined] as const] : []),
          ...(dashboard.arbiterVisible ? [["arbiter", t("me.accArbiter"), dashboard.arbiterDisputes.length || undefined] as const] : []),
          ["profile", t("me.tabProfile"), undefined],
          ["community", t("me.tabCommunity"), undefined],
          ["settings", t("me.accSettings"), undefined],
        ]}
        onPress={pressTab}
      />

      {/* ── TRADES — settlements ledger + seller queue + full history ─── */}
      {/* Selling has its own pill now (Jet, 2026-09-20: "so it's not in the
          way of legit simple trades") — the same treatment the arbiter view
          already had. Trades is history; Seller is inventory and orders. */}
      <MePane store={tabs} id="seller">{!hydratingTrades && hasSellerDashboard && (
        <SellerDashboardPanel
          dashboard={dashboard}
          onOpenTrade={openTrade}
          onSellerEditListing={sellerEditListing}
          onSellerDeleteListing={sellerDeleteListing}
        />
      )}</MePane>

      <MePane store={tabs} id="trades">{!hydratingTrades && <>
        <div>
          <MeTradeHistory
            trades={visibleTrades}
            totalCount={myTrades.length}
            counts={tradeCounts}
            activeFilter={tradeFilter}
            onFilter={setTradeFilter}
            pubkey={pubkey}
            onOpenTrade={openTrade}
            onRefreshTrades={refreshTrades}
            onRateCounterparty={rateCounterparty}
            myGivenRatings={myGivenRatings}
            unverifiedIds={unverifiedIds}
            onOpenArchivedTrade={openArchivedTrade}
            amountDisplayMode={amountDisplayMode}
            quoteCurrency={quoteCurrency}
            profileNames={profileNames}
            kind0Enabled={kind0On}
            highlightLive={pillTargetAt}
          />
        </div>
      </>}</MePane>

      {/* ── ARBITER — rendered only for an arbiter / pool member ── */}
      <MePane store={tabs} id="arbiter">{!hydratingTrades && dashboard.arbiterVisible && (
        <ArbiterDashboardPanel
          dashboard={dashboard}
          onOpenTrade={openTrade}
          viewerPubkey={pubkey}
        />
      )}</MePane>

      {/* ── SETTINGS ────────────────────────────────────────────── */}
      {/* ── PROFILE (Jet, 2026-09-19) ─────────────────────────────────────
          Changing your name is about to be common, so identity gets its own
          home instead of sitting on top of the notification rows: the name
          (published to your key), who everyone else sees you as, and the two
          presentation choices that are also "you" — appearance and language.
          Everything that is a SETTING (notifications, bonds, advanced, sign
          out) stays in Settings. */}
      <MePane store={tabs} id="profile">{<>
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 0, overflow: "hidden",
        }}>
          <TradeNameRow pubkey={pubkey} onPublishName={onPublishProfileName} onPublishAvatar={onPublishProfileAvatar} />
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
              {t("me.profileKnownAs")}
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2, lineHeight: 1.5 }}>
              {t("me.profileKnownAsHint", { name: generatedNameFor(pubkey, lang) })}
            </div>
            <div style={{
              marginTop: 8, fontFamily: T.mono, fontSize: 11, color: T.muted,
              wordBreak: "break-all" as const,
            }}>
              {npubShort}
            </div>
          </div>
          <NostrNamesRow on={kind0On} onToggle={() => setKind0On(!kind0On)} />
        </div>
      </>}</MePane>

      <MePane store={tabs} id="settings">{<>
        {/* v7 redesign (Jet): Settings in clear groups — each a labelled card,
            sign-out on its own. Same rows and handlers as before. */}
        {/* What used to sit under Wallet: where you get paid, and your key,
            which is your sign-in on any device and never your sats. */}
        <SettingsGroup label={t("me.groupGettingPaid")}>
          <SettingsRow label={t("me.paymentMethods")} hint={t("me.paymentMethodsHint")} onClick={onOpenSavedHandles} />
          <SettingsRow label={t("me.lightningAddresses")} hint={t("me.lightningAddressesHint")} onClick={onOpenPayoutDestinations} />
        </SettingsGroup>
        <SettingsGroup>
          <RecoveryKeyRow key={pubkey} pubkey={pubkey} loadKey={loadActiveRecoveryKey} />
        </SettingsGroup>
        <SettingsGroup label={t("me.groupDisplay")}>
          {themeMode && onThemeModeChange && <AppearanceRow themeMode={themeMode} onThemeModeChange={onThemeModeChange} />}
          <LanguageRow />
        </SettingsGroup>
        <SettingsGroup label={t("me.groupNotifications")}>
          <NotificationsRow />
          <BackgroundPushRow />
          <DmNotificationsRow />
          <CounterpartyDmRow />
          <NewListingNotificationsRow />
        </SettingsGroup>
        <SettingsGroup label={t("me.groupTrading")}>
          {storeAutoRenew && <StoreAutoRenewRow enabled={storeAutoRenew.enabled} onChange={storeAutoRenew.onChange} />}
          {onClearUnfundedListings && (unfundedListingCount ?? 0) > 0 && (
            <SettingsRow
              label={t("me.clearListings")}
              hint={t("me.clearListingsHint", { count: unfundedListingCount ?? 0 })}
              onClick={onClearUnfundedListings}
            />
          )}
        </SettingsGroup>
        {SHOW_BOND_CEREMONY && onOpenBondCeremony && (
          <SettingsGroup label={t("me.groupBond")}>
            <SettingsRow label={t("me.postYourBond")} hint={t("me.postYourBondHint")} onClick={onOpenBondCeremony} />
          </SettingsGroup>
        )}
        <SettingsGroup label={t("me.groupHelp")}>
          <SettingsRow label={t("me.helpFaq")} hint={t("me.helpFaqHint")} onClick={onOpenHelp} />
          <SettingsRow label={t("me.advanced")} hint={t("me.advancedHint")} onClick={onOpenAdvanced} />
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow label={t("me.signOut")} hint={null} onClick={onSignOut} danger />
        </SettingsGroup>
      </>}</MePane>

      {/* ── COMMUNITY — the chama switcher, alone. Ratings live on the
          Dashboard; the identity hex lives in the top banner; sign out lives
          in Settings. */}
      <MePane store={tabs} id="community">{<>
        {onSelectCommunity && (
          <YourChamaCard
            key={requestTab?.n ?? 0}
            suggestedCountry={requestTab?.tab === "community" ? requestTab.country : undefined}
            communitySlug={communitySlug ?? null}
            hasActiveCommitment={hasActiveCommitment}
            onSelectCommunity={onSelectCommunity}
            loadLiveness={loadLiveness}
            livenessBlocksPerDay={livenessBlocksPerDay}
            viewerPubkey={pubkey}
          />
        )}
      </>}</MePane>
    </div>
    </AmountDisplayProvider>
  );
}

function Accordion({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "14px 16px",
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: open ? `${T.r}px ${T.r}px 0 0` : T.r,
          cursor: "pointer", textAlign: "left" as const,
        }}
      >
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, color: T.muted,
        }}>
          {title}
          {count !== undefined && (
            <span style={{
              fontFamily: T.sans, color: T.text, fontSize: T.fs.secondary, fontWeight: 700,
              padding: "2px 7px", borderRadius: 999,
              background: T.surface, border: `1px solid ${T.border}`,
            }}>
              {count}
            </span>
          )}
        </span>
        <span aria-hidden="true" style={{
          color: T.muted, fontSize: 13, fontFamily: T.sans,
          transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s",
        }}>
          ›
        </span>
      </button>
      {open && (
        <div style={{
          border: `1px solid ${T.border}`, borderTop: "none",
          borderRadius: `0 0 ${T.r}px ${T.r}px`,
          padding: 12, background: T.bg,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}



const MeTradeHistory = memo(function MeTradeHistory({
  trades,
  totalCount,
  counts,
  activeFilter,
  onFilter,
  pubkey,
  onOpenTrade,
  onRefreshTrades,
  onRateCounterparty,
  myGivenRatings,
  unverifiedIds,
  onOpenArchivedTrade,
  amountDisplayMode,
  quoteCurrency,
  profileNames,
  kind0Enabled,
  highlightLive,
}: {
  trades: EscrowState[];
  totalCount: number;
  counts: MeTradeCounts;
  activeFilter: MeTradeFilter;
  onFilter: (filter: MeTradeFilter) => void;
  pubkey: string;
  onOpenTrade: (id: string) => void;
  onRefreshTrades?: () => Promise<number> | void;
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  myGivenRatings?: Array<{ tradeId: string; ratee: string; thumb: RatingThumb }>;
  unverifiedIds?: string[];
  onOpenArchivedTrade?: (id: string) => void;
  /** The shell's sats/fiat toggle, so history answers it too. */
  amountDisplayMode?: AmountDisplayMode;
  quoteCurrency?: string | null;
  profileNames?: NostrProfileNameMap;
  kind0Enabled?: boolean;
  /** Timestamp of the last "show me what the pill meant" request; non-zero
   *  briefly rings the live rows. */
  highlightLive?: number;
}) {
  const { t, lang } = useT();
  // Search covers every trade in the active filter; only the list on screen
  // is paged (30 at a time) so 100+ trades never render and animate at once.
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query);
  const [shownCount, setShownCount] = useState(ME_TRADE_PAGE_SIZE);
  useEffect(() => { setShownCount(ME_TRADE_PAGE_SIZE); }, [activeFilter, searchQuery]);
  const nameFor = useCallback(
    (pk: string) => profileNameFor(profileNames, pk, Boolean(kind0Enabled), lang),
    [profileNames, kind0Enabled, lang],
  );
  const matched = useMemo(() => searchMeTrades(trades, searchQuery, nameFor), [trades, searchQuery, nameFor]);
  const page = matched.length > shownCount ? matched.slice(0, shownCount) : matched;
  const remaining = matched.length - page.length;
  // One lookup for "already rated", instead of scanning every rating per row.
  const ratedKeys = useMemo(
    () => new Set((myGivenRatings ?? []).map(r => `${r.tradeId}:${r.ratee}`)),
    [myGivenRatings],
  );
  const activeFilterKey = ME_TRADE_FILTERS.find((filter) => filter.id === activeFilter)?.labelKey ?? "me.filterAll";
  const activeFilterLabel = t(activeFilterKey);
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (!onRefreshTrades || refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshTrades();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section>
      <div style={{
        display: "flex", alignItems: "flex-end", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontSize: T.fs.secondary, fontWeight: 700, color: T.muted, fontFamily: T.sans,
          }}>
            {t("me.myTrades")}
          </div>
          <div style={{
            marginTop: 4, color: T.text, fontFamily: T.sans,
            fontSize: 20, fontWeight: 800,
          }}>
            {activeFilterLabel}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
            whiteSpace: "nowrap" as const,
          }}>
            {trades.length} / {totalCount}
          </div>
          {onRefreshTrades && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title={t("me.refreshTitle")}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                background: "transparent", border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "4px 8px",
                color: refreshing ? T.muted : T.text,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
                cursor: refreshing ? "default" : "pointer",
                opacity: refreshing ? 0.6 : 1,
                whiteSpace: "nowrap" as const,
              }}
            >
              <span style={{
                display: "inline-block",
                animation: refreshing ? "spin 0.8s linear infinite" : "none",
              }}>↻</span>
              {refreshing ? t("me.syncing") : t("me.refresh")}
            </button>
          )}
        </div>
      </div>

      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        overflowX: "auto", scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as const, paddingBottom: 2,
      }}>
        {ME_TRADE_FILTERS.map((filter) => {
          const active = activeFilter === filter.id;
          const count = counts[filter.id];
          return (
            <button
              key={filter.id}
              onClick={() => onFilter(filter.id)}
              style={{
                flexShrink: 0,
                padding: "7px 12px", borderRadius: 18,
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                color: active ? T.accent : T.muted,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
                cursor: "pointer", whiteSpace: "nowrap" as const,
              }}
            >
              {t(filter.labelKey)} {count > 0 ? count : ""}
            </button>
          );
        })}
      </div>

      {totalCount > ME_TRADE_PAGE_SIZE && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("me.searchTradesPlaceholder")}
          aria-label={t("me.searchTradesPlaceholder")}
          data-me-trade-search
          style={{
            width: "100%", boxSizing: "border-box", minHeight: 44, marginBottom: 12,
            padding: "10px 14px", borderRadius: T.rs, border: `1px solid ${T.border}`,
            background: T.surface, color: T.text, fontFamily: T.sans, fontSize: T.fs.body,
          }}
        />
      )}

      {totalCount === 0 ? (
        <div style={{
          padding: 24, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
        }}>
          {t("me.noTradesYet")}
        </div>
      ) : trades.length === 0 ? (
        <div style={{
          padding: 18, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
        }}>
          {t("me.nothingInView")}
        </div>
      ) : matched.length === 0 ? (
        <div data-me-trade-no-match style={{
          padding: 18, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
        }}>
          {t("me.searchTradesNoMatch", { query: searchQuery.trim() })}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {page.map((s, i) => (
            <MeTradeRow
              key={s.id}
              trade={s}
              index={i}
              pubkey={pubkey}
              onOpenTrade={onOpenTrade}
              onRateCounterparty={onRateCounterparty}
              alreadyRatedKeys={ratedKeys}
              ringAt={highlightLive && activeFilter === "live" ? highlightLive : 0}
              amountDisplayMode={amountDisplayMode}
              quoteCurrency={quoteCurrency}
              profileNames={profileNames}
              kind0Enabled={kind0Enabled}
            />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              data-me-trade-show-more
              onClick={() => setShownCount(count => count + ME_TRADE_PAGE_SIZE)}
              style={{
                minHeight: 48, borderRadius: T.rs, border: `1px solid ${T.border}`,
                background: T.surface, color: T.text, fontFamily: T.sans,
                fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
              }}
            >
              {t("me.showMoreTrades", { count: Math.min(remaining, ME_TRADE_PAGE_SIZE) })}
            </button>
          )}
        </div>
      )}

      <UnverifiedHistory ids={unverifiedIds ?? []} onOpen={onOpenArchivedTrade ?? onOpenTrade} />

    </section>
  );
});

/** Me's tab pills. Subscribes to the pressed tab only, so a tap repaints this
 *  row at once while the pane behind it swaps on the next frame. */
const MeTabPills = memo(function MeTabPills({ store, items, onPress }: {
  store: MeTabStore;
  items: ReadonlyArray<readonly [MeTabKey, string, number | undefined]>;
  onPress: (key: MeTabKey) => void;
}) {
  const pressed = useMePressedTab(store);
  return (
    <PerfZone id="Me tab pills">
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "2px 0 16px" }}>
      {items.map(([key, label, count]) => {
        const on = pressed === key;
        return (
          <button key={key} type="button" aria-pressed={on} onClick={() => onPress(key)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              // v7 redesign: ink pill for the open tab, quiet outline otherwise.
              minHeight: T.size.touch, padding: "0 16px", borderRadius: 999, cursor: "pointer",
              border: `1px solid ${on ? T.ink : T.line}`,
              background: on ? T.ink : "transparent",
              color: on ? T.onInk : T.ink,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: on ? 700 : 500,
            }}>
            {label}
            {count !== undefined && (
              <span style={{ fontSize: T.fs.secondary, fontWeight: 700, padding: "0 7px", borderRadius: 999, background: on ? T.onInk : T.raised, color: on ? T.ink : T.ink2 }}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
    </PerfZone>
  );
});

/** One Me tab's content. Mounts on its first visit and then stays mounted.
 *  It subscribes to the shown tab itself, so switching tabs re-renders only
 *  the two gates that swap; their content (`children`, created by the last Me
 *  render) is the same element, so React skips it entirely.
 *
 *  A tab that is not shown keeps its finished layout. With `hidden`
 *  (display:none) the browser threw the layout away, so returning to My
 *  trades re-laid out every card. content-visibility skips rendering the pane
 *  but keeps its layout; browsers without it (older Safari) keep display:none. */
function MePane({ store, id, children }: { store: MeTabStore; id: MeTabKey; children: ReactNode }) {
  const shown = useMeShownTab(store);
  const on = shown === id;
  // Timing readout (?perf=1): the tapped tab's content is on screen.
  useLayoutEffect(() => { if (on) perfTapCommitted(id); }, [on, id]);
  if (!on && !store.isVisited(id)) return null;
  const attrs = KEEP_PANE_LAYOUT
    ? { "data-me-pane": id, "aria-hidden": !on || undefined, style: on ? undefined : PANE_OFF_STYLE }
    : { "data-me-pane": id, hidden: !on };
  return <PerfZone id={`Me: ${id}`}><div {...attrs}>{children}</div></PerfZone>;
}

/** Kept-mounted Me tabs hide with content-visibility where supported, so
 *  their layout survives a tab switch (see paneProps in MeScreen). */
const KEEP_PANE_LAYOUT = typeof CSS !== "undefined" && typeof CSS.supports === "function"
  && CSS.supports("content-visibility", "hidden");
const PANE_OFF_STYLE = { contentVisibility: "hidden" } as const;
/** Trade rows below the screen skip layout and paint until scrolled near.
 *  The size is a placeholder until the row's real height is remembered. */
export const ME_ROW_STYLE_OFFSCREEN = { contentVisibility: "auto", containIntrinsicSize: "auto 240px" } as const;

/** Only the first rows fade in, with a short stagger. With 150 trades the old
 *  0.05s-per-row stagger left the last row invisible for 7.5s and ran every
 *  animation at once on each filter switch. */
export const ME_ROW_ANIMATED = 8;
export function meRowAnimation(index: number, ringing: boolean): string | undefined {
  const delay = index < ME_ROW_ANIMATED ? `${index * 0.04}s` : "0s";
  const fade = index < ME_ROW_ANIMATED ? `fadeIn 0.3s ease ${delay} both` : "";
  const ring = ringing ? `chamaPillTarget 2.6s ease-out ${delay} 2` : "";
  return [fade, ring].filter(Boolean).join(", ") || undefined;
}

/** One row of Me's trade history. Memoised: a row redraws only when its own
 *  trade, the viewer, its rating state or the display settings change. */
const MeTradeRow = memo(function MeTradeRow({
  trade: s,
  index: i,
  pubkey,
  onOpenTrade,
  onRateCounterparty,
  alreadyRatedKeys,
  ringAt,
  amountDisplayMode,
  quoteCurrency,
  profileNames,
  kind0Enabled,
}: {
  trade: EscrowState;
  index: number;
  pubkey: string;
  onOpenTrade: (id: string) => void;
  onRateCounterparty?: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  alreadyRatedKeys: ReadonlySet<string>;
  /** Non-zero while the Live pill's "which trades?" ring is requested. */
  ringAt: number;
  amountDisplayMode?: AmountDisplayMode;
  quoteCurrency?: string | null;
  profileNames?: NostrProfileNameMap;
  kind0Enabled?: boolean;
}) {
  // v1 ratings: a settled-but-UNRATED trade keeps a one-tap thumb in
  // history (the "rate later" path for users who bolt with their sats).
  // Once rated, the tap drops — the slot is replaceable, so it reappears
  // nowhere and double-rating is impossible.
  // Chama shares never prompt for a rating: a savings circle has no
  // counterparty performance to judge — punctuality standing is the
  // circle's reputation, chain-derived and automatic (Jet, launch
  // night review).
  const ratee = onRateCounterparty && s.status === EscrowStatus.COMPLETED && !s.chamaPolicy
    ? counterpartyToRate(s, pubkey)
    : null;
  const alreadyRated = ratee ? alreadyRatedKeys.has(`${s.id}:${ratee.toLowerCase()}`) : false;
  // The pill's number is the sum of the viewer's live commitments,
  // which is narrower than this tab. So ring exactly those rows:
  // the tab stays a complete list of what is in flight, and the
  // glow answers "which of these is the pill talking about?".
  const ringing = Boolean(ringAt)
    && liveCommitmentForViewer(s, pubkey, Math.floor(Date.now() / 1000));
  const open = useCallback(() => onOpenTrade(s.id), [onOpenTrade, s.id]);
  return (
    <div
      /* The pill's glow never fired: this row's INLINE animation
         (fadeIn) outranks the .chama-pill-target class rule, so the
         ring was declared and then immediately overridden. Compose
         both on the inline property instead, and key the row on the
         request timestamp so a SECOND tap of the pill remounts it
         and replays the ring rather than finding the class already
         applied and doing nothing. */
      key={ringing ? `${s.id}:${ringAt}` : s.id}
      className={ringing ? "chama-pill-target" : undefined}
      data-me-trade-row
      style={{ ...(ringing ? null : ME_ROW_STYLE_OFFSCREEN), animation: meRowAnimation(i, ringing) }}
    >
      <TradeCard state={s} pubkey={pubkey} onSelect={open} amountDisplayMode={amountDisplayMode} quoteCurrency={quoteCurrency} profileNames={profileNames} kind0Enabled={kind0Enabled} />
      {s.status === EscrowStatus.COMPLETED && s.escrowMode === "onchain" && s.onchainPayoutTxid && (
        <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono, padding: "4px 12px" }}>
          <PayoutTransactionDetails txid={s.onchainPayoutTxid} depositTxid={s.lock.onchain?.fundingTxid} network={s.lock.onchain?.network === "signet" ? SIGNET : MAINNET} />
        </div>
      )}
      {/* Safety net Jetty asked for: rate the counterparty straight from
          history (👍/👎) if you forgot or backed out of the trade. */}
      {ratee && !alreadyRated && onRateCounterparty && (
        <RatingTap tradeId={s.id} ratee={ratee} onRate={onRateCounterparty} />
      )}
    </div>
  );
});

type MeDashboardModel = {
  needsYou: EscrowState[];
  sellerOpen: EscrowState[];
  sellerLive: EscrowState[];
  sellerInventory: EscrowState[];
  sellerWindowShoppers: EscrowState[];
  sellerReadyToLock: EscrowState[];
  arbiterVisible: boolean;
  arbiterDisputes: EscrowState[];
  arbiterWatching: EscrowState[];
  arbiterConflicts: EscrowState[];
  arbiterSettled: EscrowState[];
};

type SellerQueueKey = "ready" | "holds" | "live" | "stock";

// i18n: dictionary KEYS resolved with t() at render (module-level constants
// can't call hooks). The SellerQueueKey ids are compared — never translated.
const SELLER_QUEUE_LABEL_KEY: Record<SellerQueueKey, string> = {
  ready: "me.queueReady",
  holds: "me.queueHolds",
  live: "me.queueLive",
  stock: "me.queueStock",
};

const SellerDashboardPanel = memo(function SellerDashboardPanel({
  dashboard,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
}: {
  dashboard: MeDashboardModel;
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
}) {
  const { t } = useT();
  const [queue, setQueue] = useState<SellerQueueKey>(() => firstSellerQueue(dashboard));
  useEffect(() => {
    if (sellerQueueTrades(dashboard, queue).length > 0) return;
    setQueue(firstSellerQueue(dashboard));
  }, [dashboard, queue]);
  const activeTrades = sellerQueueTrades(dashboard, queue);

  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontFamily: T.sans, color: T.green, fontSize: T.fs.secondary,
            fontWeight: 900,
          }}>
            {t("me.sellerDashboard")}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.sans, color: T.text, fontSize: 15,
            fontWeight: 800,
          }}>
            {t("me.inventoryAndOrders")}
          </div>
        </div>
        <div style={{
          fontFamily: T.sans, color: T.muted, fontSize: T.fs.secondary,
          lineHeight: 1.35, textAlign: "right" as const,
        }}>
          {t("me.openCount", { count: dashboard.sellerOpen.length.toLocaleString() })}<br />
          {t("me.liveCount", { count: dashboard.sellerLive.length.toLocaleString() })}
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 6,
        marginBottom: 12,
      }}>
        <DashboardMetric
          label={t("me.queueReady")}
          value={dashboard.sellerReadyToLock.length}
          tone={T.muted}
          active={queue === "ready"}
          onClick={() => {
            if (dashboard.sellerReadyToLock.length === 0) return;
            setQueue("ready");
          }}
        />
        <DashboardMetric
          label={t("me.queueHolds")}
          value={dashboard.sellerWindowShoppers.length}
          tone={T.muted}
          active={queue === "holds"}
          onClick={() => {
            if (dashboard.sellerWindowShoppers.length === 0) return;
            setQueue("holds");
          }}
        />
        <DashboardMetric
          label={t("me.queueLive")}
          value={dashboard.sellerLive.length}
          tone={T.muted}
          active={queue === "live"}
          onClick={() => {
            if (dashboard.sellerLive.length === 0) return;
            setQueue("live");
          }}
        />
        <DashboardMetric
          label={t("me.queueStock")}
          value={dashboard.sellerInventory.length}
          tone={T.muted}
          active={queue === "stock"}
          onClick={() => {
            if (dashboard.sellerInventory.length === 0) return;
            setQueue("stock");
          }}
        />
      </div>

      <SellerQueueList
        queue={queue}
        trades={activeTrades}
        onOpenTrade={onOpenTrade}
        onSellerEditListing={onSellerEditListing}
        onSellerDeleteListing={onSellerDeleteListing}
      />
    </div>
  );
});

function DashboardMetric({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  // Empty queues aren't selectable — clicking them used to flash the empty
  // state then snap back via the panel's "prefer a non-empty queue" effect.
  const disabled = value === 0 && !active;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      style={{
        minWidth: 0,
        padding: "10px 6px",
        background: active ? `${tone}22` : T.surface,
        border: `1px solid ${active ? tone : value > 0 ? tone + "44" : T.border}`,
        borderRadius: T.rs,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div style={{
        fontFamily: T.sans,
        color: disabled ? T.muted : tone,
        fontSize: 20,
        fontWeight: 700,
        lineHeight: 1,
        marginBottom: 5,
      }}>
        {value.toLocaleString()}
      </div>
      <div style={{
        fontFamily: T.sans,
        color: value > 0 ? T.text : T.muted,
        fontSize: T.fs.secondary,
        fontWeight: 800,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap" as const,
      }}>
        {label}
      </div>
    </button>
  );
}

function SellerQueueList({
  queue,
  trades,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
}: {
  queue: SellerQueueKey;
  trades: EscrowState[];
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
}) {
  const { t } = useT();
  const tone = sellerQueueTone(queue);
  const emptyCopy = queue === "stock"
    ? t("me.emptyStock")
    : queue === "live"
      ? t("me.emptyLive")
      : queue === "holds"
        ? t("me.emptyHolds")
        : t("me.emptyReady");

  if (trades.length === 0) {
    return (
      <div style={{
        padding: 12,
        background: T.surface,
        border: `1px dashed ${T.border}`,
        borderRadius: T.rs,
        fontFamily: T.sans,
        color: T.muted,
        fontSize: T.fs.secondary,
        textAlign: "center" as const,
      }}>
        {emptyCopy}
      </div>
    );
  }

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: T.rs,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 12px",
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{
          fontFamily: T.sans,
          color: T.muted,
          fontSize: T.fs.secondary,
          fontWeight: 900,
        }}>
          {t("me.queueHeader", { label: t(SELLER_QUEUE_LABEL_KEY[queue]) })}
        </div>
        <div style={{
          fontFamily: T.sans,
          color: T.muted,
          fontSize: T.fs.secondary,
        }}>
          {trades.length === 1
            ? t("me.itemCountOne", { count: trades.length.toLocaleString() })
            : t("me.itemCountMany", { count: trades.length.toLocaleString() })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {trades.map((trade, index) => (
          <SellerQueueItem
            key={trade.id}
            trade={trade}
            queue={queue}
            last={index === trades.length - 1}
            onOpenTrade={onOpenTrade}
            onSellerEditListing={onSellerEditListing}
            onSellerDeleteListing={onSellerDeleteListing}
          />
        ))}
      </div>
    </div>
  );
}

function SellerQueueItem({
  trade,
  queue,
  last,
  onOpenTrade,
  onSellerEditListing,
  onSellerDeleteListing,
}: {
  trade: EscrowState;
  queue: SellerQueueKey;
  last: boolean;
  onOpenTrade: (id: string) => void;
  onSellerEditListing?: (id: string) => void;
  onSellerDeleteListing?: (id: string) => void | Promise<void>;
}) {
  const { t } = useT();
  const isSellerListing = trade.status === EscrowStatus.CREATED
    && trade.initiator.role === Role.SELLER
    && trade.parent === undefined;
  const canDelete = isSellerListing && Boolean(onSellerDeleteListing);
  const canEdit = isSellerListing && Boolean(onSellerEditListing);

  return (
    <div style={{
      padding: "12px",
      borderBottom: last ? "none" : `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: T.sans,
            color: T.text,
            fontSize: 13,
            fontWeight: 850,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {trade.description}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.sans,
            color: T.muted,
            fontSize: T.fs.secondary,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {sellerQueueStatus(queue, trade)}
          </div>
        </div>
        <div style={{
          flexShrink: 0,
        }}>
          <TradeAmount msats={trade.amountMsats} size={12} color={sellerQueueTone(queue)} />
        </div>
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: isSellerListing ? "repeat(2, minmax(0, 1fr))" : "1fr",
        gap: 6,
      }}>
        {isSellerListing ? <>
          <SellerActionButton
            label={t("me.edit")}
            tone={T.amber}
            disabled={!canEdit}
            onClick={() => onSellerEditListing?.(trade.id)}
          />
          <SellerActionButton
            label={t("me.delete")}
            tone={T.red}
            disabled={!canDelete}
            onClick={() => onSellerDeleteListing?.(trade.id)}
          />
        </> : (
          <SellerActionButton label={t("me.view")} tone={T.text} onClick={() => onOpenTrade(trade.id)} />
        )}
      </div>
    </div>
  );
}

function SellerActionButton({
  label,
  tone,
  disabled = false,
  onClick,
}: {
  label: string;
  tone: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 6px",
        borderRadius: T.rs,
        background: disabled ? T.bg : T.card,
        border: `1px solid ${disabled ? T.border : tone + "55"}`,
        color: disabled ? T.muted : tone,
        fontFamily: T.sans,
        fontSize: T.fs.secondary,
        fontWeight: 700,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {label}
    </button>
  );
}

type ArbiterQueueKey = "needs" | "watching" | "settled";

// i18n: dictionary KEYS resolved with t() at render (module-level constants
// can't call hooks). The ArbiterQueueKey ids are compared — never translated.
const ARBITER_QUEUE_LABEL_KEY: Record<ArbiterQueueKey, string> = {
  needs: "me.needsDecision",
  watching: "me.queueWatching",
  settled: "me.queueSettled",
};

const ArbiterDashboardPanel = memo(function ArbiterDashboardPanel({
  dashboard,
  onOpenTrade,
  viewerPubkey,
}: {
  dashboard: MeDashboardModel;
  onOpenTrade: (id: string) => void;
  viewerPubkey: string;
}) {
  const { t } = useT();
  const [queue, setQueue] = useState<ArbiterQueueKey>(() => firstArbiterQueue(dashboard));
  useEffect(() => {
    if (arbiterQueueTrades(dashboard, queue).length > 0) return;
    setQueue(firstArbiterQueue(dashboard));
  }, [dashboard, queue]);
  const activeTrades = arbiterQueueTrades(dashboard, queue);

  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${T.border}`,
    }}>
      {dashboard.arbiterConflicts.map(trade => <div key={trade.id} role="alert" style={{ color: T.red, border: `1px solid ${T.red}`, padding: 12, marginBottom: 12 }}>
        {t("me.arbiterSeatConflict")} <button onClick={() => onOpenTrade(trade.id)}>{trade.id}</button>
      </div>)}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontFamily: T.sans, color: ROLE_COLOR.arbiter, fontSize: T.fs.secondary,
            fontWeight: 900,
          }}>
            {t("me.arbiterDashboard")}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.sans, color: T.text, fontSize: 15,
            fontWeight: 800,
          }}>
            {t("me.disputesAndWatched")}
          </div>
        </div>
        <div style={{
          fontFamily: T.sans, color: T.muted, fontSize: T.fs.secondary,
          lineHeight: 1.35, textAlign: "right" as const,
        }}>
          {t("me.listedArbiter")}<br />
          {t("me.blfPool")}
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 6,
        marginBottom: 12,
      }}>
        <DashboardMetric
          label={t("me.queueNeeds")}
          value={dashboard.arbiterDisputes.length}
          tone={T.red}
          active={queue === "needs"}
          onClick={() => {
            if (dashboard.arbiterDisputes.length === 0) return;
            setQueue("needs");
          }}
        />
        <DashboardMetric
          label={t("me.queueWatching")}
          value={dashboard.arbiterWatching.length}
          tone={ROLE_COLOR.arbiter}
          active={queue === "watching"}
          onClick={() => {
            if (dashboard.arbiterWatching.length === 0) return;
            setQueue("watching");
          }}
        />
        <DashboardMetric
          label={t("me.queueSettled")}
          value={dashboard.arbiterSettled.length}
          tone={T.green}
          active={queue === "settled"}
          onClick={() => {
            if (dashboard.arbiterSettled.length === 0) return;
            setQueue("settled");
          }}
        />
      </div>

      <ArbiterQueueList
        queue={queue}
        trades={activeTrades}
        onOpenTrade={onOpenTrade}
        viewerPubkey={viewerPubkey}
      />
    </div>
  );
});

function ArbiterQueueList({
  queue,
  trades,
  onOpenTrade,
  viewerPubkey,
}: {
  queue: ArbiterQueueKey;
  trades: EscrowState[];
  onOpenTrade: (id: string) => void;
  viewerPubkey: string;
}) {
  const { t } = useT();
  const tone = arbiterQueueTone(queue);
  const emptyCopy = queue === "needs"
    ? t("me.emptyDisputes")
    : queue === "watching"
      ? t("me.emptyWatching")
      : t("me.emptySettled");

  if (trades.length === 0) {
    return (
      <div style={{
        padding: 12,
        background: T.surface,
        border: `1px dashed ${T.border}`,
        borderRadius: T.rs,
        fontFamily: T.sans,
        color: T.muted,
        fontSize: T.fs.secondary,
        textAlign: "center" as const,
      }}>
        {emptyCopy}
      </div>
    );
  }

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${tone}44`,
      borderRadius: T.rs,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 12px",
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{
          fontFamily: T.sans,
          color: tone,
          fontSize: T.fs.secondary,
          fontWeight: 900,
        }}>
          {t(ARBITER_QUEUE_LABEL_KEY[queue])}
        </div>
        <div style={{
          fontFamily: T.sans,
          color: T.muted,
          fontSize: T.fs.secondary,
        }}>
          {trades.length === 1
            ? t("me.tradeCountOne", { count: trades.length.toLocaleString() })
            : t("me.tradeCountMany", { count: trades.length.toLocaleString() })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {trades.map((trade, index) => (
          <ArbiterQueueItem
            key={trade.id}
            trade={trade}
            queue={queue}
            last={index === trades.length - 1}
            onOpenTrade={onOpenTrade}
            viewerPubkey={viewerPubkey}
          />
        ))}
      </div>
    </div>
  );
}

function ArbiterQueueItem({
  trade,
  queue,
  last,
  onOpenTrade,
  viewerPubkey,
}: {
  trade: EscrowState;
  queue: ArbiterQueueKey;
  last: boolean;
  onOpenTrade: (id: string) => void;
  viewerPubkey: string;
}) {
  const { t } = useT();
  const tone = arbiterQueueTone(queue);
  const participants = getEffectiveParticipantsAt(trade);

  return (
    <div style={{
      padding: "12px",
      borderBottom: last ? "none" : `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: T.sans,
            color: T.text,
            fontSize: 13,
            fontWeight: 850,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {trade.description}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: T.sans,
            color: T.muted,
            fontSize: T.fs.secondary,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {arbiterQueueStatus(queue, trade, viewerPubkey)}
          </div>
        </div>
        <div style={{
          flexShrink: 0,
        }}>
          <TradeAmount msats={trade.amountMsats} size={12} color={tone} />
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 6,
        marginBottom: 8,
      }}>
        <VoteChip label={t("me.buyer")} outcome={trade.votes[Role.BUYER]} />
        <VoteChip label={t("me.seller")} outcome={trade.votes[Role.SELLER]} />
        <VoteChip label={t("me.you")} outcome={trade.votes[Role.ARBITER]} />
      </div>

      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}>
        <div style={{
          minWidth: 0,
          fontFamily: T.mono,
          color: T.muted,
          fontSize: 9,
          whiteSpace: "nowrap" as const,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {t("me.partiesShort", { buyer: shortPubkey(participants[Role.BUYER]), seller: shortPubkey(participants[Role.SELLER]) })}
        </div>
        <SellerActionButton
          label={queue === "needs" ? t("me.decide") : t("me.view")}
          tone={tone}
          onClick={() => onOpenTrade(trade.id)}
        />
      </div>
    </div>
  );
}

function VoteChip({ label, outcome }: { label: string; outcome?: Outcome }) {
  const { t } = useT();
  const tone = outcome === Outcome.RELEASE
    ? T.green
    : outcome === Outcome.REFUND
      ? T.amber
      : T.muted;
  const text = outcome === Outcome.RELEASE
    ? t("me.voteRelease")
    : outcome === Outcome.REFUND
      ? t("me.voteRefund")
      : t("me.votePending");

  return (
    <div style={{
      minWidth: 0,
      padding: "6px 6px",
      borderRadius: T.rs,
      background: T.card,
      border: `1px solid ${outcome ? tone + "55" : T.border}`,
      fontFamily: T.sans,
      fontSize: T.fs.secondary,
      color: tone,
      whiteSpace: "nowrap" as const,
      overflow: "hidden",
      textOverflow: "ellipsis",
      textAlign: "center" as const,
    }}>
      {label} · {text}
    </div>
  );
}

function DashboardRow({
  label,
  value,
  hint,
  tone,
  onClick,
  last = false,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
  onClick?: () => void;
  last?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        width: "100%",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, padding: "12px 0",
        background: "none", border: "none",
        borderBottom: last ? "none" : `1px solid ${T.border}`,
        cursor: onClick ? "pointer" : "default", textAlign: "left" as const,
        color: T.text,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontFamily: T.sans, fontSize: 14, fontWeight: 800,
          color: T.text, marginBottom: 3,
        }}>
          {label}
        </div>
        <div style={{
          fontFamily: T.sans, fontSize: T.fs.secondary, color: T.muted,
          lineHeight: 1.45,
        }}>
          {hint}
        </div>
      </div>
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 7,
        color: tone, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
      }}>
        {value}
        {onClick && <span style={{ color: T.muted, fontSize: 14 }}>›</span>}
      </div>
    </button>
  );
}

function firstSellerQueue(dashboard: MeDashboardModel): SellerQueueKey {
  if (dashboard.sellerReadyToLock.length > 0) return "ready";
  if (dashboard.sellerWindowShoppers.length > 0) return "holds";
  if (dashboard.sellerLive.length > 0) return "live";
  return "stock";
}

function sellerQueueTrades(dashboard: MeDashboardModel, queue: SellerQueueKey): EscrowState[] {
  if (queue === "ready") return dashboard.sellerReadyToLock;
  if (queue === "holds") return dashboard.sellerWindowShoppers;
  if (queue === "live") return dashboard.sellerLive;
  return dashboard.sellerInventory;
}

function sellerQueueTone(queue: SellerQueueKey): string {
  if (queue === "ready") return T.accent;
  if (queue === "holds") return T.amber;
  if (queue === "live") return T.purple;
  return T.green;
}

function sellerQueueStatus(queue: SellerQueueKey, trade: EscrowState): string {
  // Pure helper (no hooks) — resolved via translate() at call time (render).
  const lang = getCurrentLang();
  const itemSummary = selectedOrMenuSummary(trade);
  if (queue === "ready") {
    return `${itemSummary ?? translate(lang, "me.orderFinalized")} · ${translate(lang, "me.waitingForYourLock")}`;
  }
  if (queue === "holds") {
    return `${itemSummary ?? translate(lang, "me.buyerBrowsing")} · ${translate(lang, "me.waitingForCheckout")}`;
  }
  if (queue === "live") {
    return `${trade.status.toLowerCase()} · ${itemSummary ?? translate(lang, "me.moneyMoving")}`;
  }
  return itemSummary ?? translate(lang, "me.singleListing");
}

function firstArbiterQueue(dashboard: MeDashboardModel): ArbiterQueueKey {
  if (dashboard.arbiterDisputes.length > 0) return "needs";
  if (dashboard.arbiterWatching.length > 0) return "watching";
  return "settled";
}

function arbiterQueueTrades(dashboard: MeDashboardModel, queue: ArbiterQueueKey): EscrowState[] {
  if (queue === "needs") return dashboard.arbiterDisputes;
  if (queue === "watching") return dashboard.arbiterWatching;
  return dashboard.arbiterSettled;
}

function arbiterQueueTone(queue: ArbiterQueueKey): string {
  if (queue === "needs") return T.red;
  if (queue === "watching") return ROLE_COLOR.arbiter;
  return T.green;
}

function arbiterQueueStatus(queue: ArbiterQueueKey, trade: EscrowState, viewerPubkey?: string): string {
  // Pure helper (no hooks) — resolved via translate() at call time (render).
  const lang = getCurrentLang();
  if (queue === "needs") {
    if (trade.status === EscrowStatus.EXPIRED) {
      return `${arbiterDisputeLine(trade)} · ${translate(lang, "me.expiredUnresolvedSuffix")}`;
    }
    // Arbiter substitution: a BACKUP viewing a pooled-lock dispute sees the
    // assigned arbiter's floor countdown, then the step-in invitation.
    const assigned = getEffectiveParticipantsAt(trade)[Role.ARBITER];
    if (
      viewerPubkey && trade.lock.arbiterPoolShare && assigned !== viewerPubkey
    ) {
      const eligibleAt = substitutionEligibleAt(trade);
      const nowSec = Math.floor(Date.now() / 1000);
      if (eligibleAt !== null && nowSec < eligibleAt) {
        return `${arbiterDisputeLine(trade)} · ${translate(lang, "me.arbiterHasFloor")} · ${translate(lang, "me.stepInCountdown", { countdown: formatStepInCountdown(eligibleAt - nowSec) })}`;
      }
      return `${arbiterDisputeLine(trade)} · ${translate(lang, "me.arbiterAbsentStepIn")}`;
    }
    return `${arbiterDisputeLine(trade)} · ${translate(lang, "me.decisionNeeded")}`;
  }
  if (queue === "watching") {
    return `${arbiterDisputeLine(trade)} · ${trade.status.toLowerCase()}`;
  }
  return `${trade.status.toLowerCase()} · ${trade.resolvedOutcome ?? translate(lang, "me.noOutcome")}`;
}

function arbiterDisputeLine(trade: EscrowState): string {
  const buyer = voteText(trade.votes[Role.BUYER]);
  const seller = voteText(trade.votes[Role.SELLER]);
  return translate(getCurrentLang(), "me.disputeLine", { buyer, seller });
}

function voteText(outcome?: Outcome): string {
  if (outcome === Outcome.RELEASE) return translate(getCurrentLang(), "me.voteRelease");
  if (outcome === Outcome.REFUND) return translate(getCurrentLang(), "me.voteRefund");
  return translate(getCurrentLang(), "me.votePending");
}

// v2.3.1 — the deliberate "change your Chama" surface. The Browse pill is now
// view-only; switching lives here so it's an intentional, between-trades act.
// While the user is party to a live trade, switching is held back with a clear
// reason (their locked shares live on the current Chama; a switch would strand
// the claim until they switch back — the data-layer gate is tracked as a
// follow-up). Idle → pick freely; the same funds-at-risk destroy-confirm guard
// the pill used to fire still applies downstream via onSelectCommunity.
function YourChamaCard({
  suggestedCountry, communitySlug,
  hasActiveCommitment,
  onSelectCommunity,
  loadLiveness,
  livenessBlocksPerDay = 144,
  viewerPubkey,
}: {
  viewerPubkey?: string;
  suggestedCountry?: string;
  communitySlug: string | null;
  hasActiveCommitment: boolean;
  onSelectCommunity: (slug: string) => void;
  loadLiveness?: (slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>;
  livenessBlocksPerDay?: number;
}) {
  const { t } = useT();
  const suggestion = getAllPickerCountries().find(country => country.code === suggestedCountry);
  const [changing, setChanging] = useState(!!suggestion && !hasActiveCommitment);
  const [query, setQuery] = useState(suggestion?.name ?? "");
  const [expandedCountry, setExpandedCountry] = useState<string | null>(suggestion?.code ?? null);
  // Your own chama's chain-verified liveness — auto-refreshed (mount, focus, and a
  // gentle poll) so a bond appearing shows up without a manual reload. Fails soft.
  const { liveness, loading: livenessLoading, outcome: livenessOutcome, retry: retryLiveness } = useLiveness(communitySlug, loadLiveness, { intervalMs: LIVENESS_POLL_MS });
  // Jet (6.4.23 RC): a bonded viewer should not be invited to "bond first" —
  // but only when THIS key is one of this chama's chain-verified arbiters. A
  // bond held on this phone for another key or another chama says nothing here.
  const viewerBonded = isVerifiedArbiter(liveness, viewerPubkey);
  const current = communitySlug ? getCommunityBySlug(communitySlug) : null;
  const countries = getAllPickerCountries();
  const currentCountry = current?.country
    ? countries.find((country) => country.code === current.country) ?? null
    : null;
  const currentCountryCode = currentCountry?.code ?? current?.country ?? null;
  const currentCountryLabel = current?.displayName ?? currentCountry?.name ?? current?.country ?? t("me.globalRegion");
  const currentCountryFlag = currentCountry?.flag ?? (current?.country ? current.flagEmoji : null);
  const currentCountrySubline = current
    ? [current.disambiguator, current.pickerLabel, current.currency].filter(Boolean).join(" · ")
    : currentCountry ? countrySubline(currentCountry) : "USD";
  const search = query.trim().toLowerCase();
  const filteredCountries = search
    ? countries.filter((country) => countryMatchesSearch(country, search))
    : countries;
  // Keep the current country visible when it contains another Chama. This is
  // what makes GBF → BLF possible: the old country-only list removed USA as
  // "already selected" and accidentally hid every alternate federation in it.
  const switchCountries = filteredCountries.filter((country) =>
    country.code !== currentCountryCode
    || country.chamas.some((chama) => chama.slug !== communitySlug),
  );

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 20, marginBottom: 16,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: T.fs.secondary, fontWeight: 600, color: T.muted, fontFamily: T.sans,
        }}>
          {t("me.yourChama")}
        </div>
        {!hasActiveCommitment && (
          <button
            onClick={() => {
              setChanging((v) => !v);
              setQuery("");
              setExpandedCountry(null);
            }}
            style={{
              background: changing ? T.surface : T.accentDim,
              border: `1px solid ${changing ? T.border : T.accent + "66"}`,
              color: changing ? T.muted : T.accent,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
              padding: "5px 10px", borderRadius: T.rs, cursor: "pointer",
            }}
          >
            {changing ? t("common.cancel") : t("me.switch")}
          </button>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "11px 12px", borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
      }}>
        {currentCountryFlag ? (
          <span style={{ fontSize: 24, lineHeight: 1 }}>{currentCountryFlag}</span>
        ) : (
          <span style={{
            width: 34, height: 34, borderRadius: "50%",
            background: T.accentDim, color: T.accent,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.sans, fontSize: 13, fontWeight: 700,
          }}>
            C
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, fontWeight: 600 }}>
            {currentCountryLabel}
          </div>
          <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans }}>
            {currentCountrySubline}
          </div>
        </div>
        <div style={{ color: T.accent, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700 }}>
          {t("me.current")}
        </div>
      </div>

      {loadLiveness && (
        <div style={{ marginTop: 12 }}>
          <LivenessSignal onRetry={retryLiveness} liveness={liveness} loading={livenessLoading} outcome={livenessOutcome} blocksPerDay={livenessBlocksPerDay}
            viewerBonded={viewerBonded} />
        </div>
      )}

      {hasActiveCommitment && (
        <div style={{
          marginTop: 12, padding: "9px 11px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, lineHeight: 1.5,
        }}>
          {t("me.liveTradeNoSwitch")}
        </div>
      )}

      {changing && !hasActiveCommitment && (
        <div style={{
          marginTop: 12,
        }}>
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.sans, marginBottom: 12,
          }}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>⌕</span>
            <input
              data-community-country-search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("me.searchCountriesPlaceholder")}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, background: "transparent", border: "none",
                outline: "none", color: T.text, fontFamily: T.sans,
                fontSize: 14, letterSpacing: 0,
              }}
            />
          </label>

          <div style={{
            fontSize: T.fs.secondary, fontWeight: 700, color: T.muted,
            fontFamily: T.sans, marginBottom: 8,
          }}>
            {search
              ? (switchCountries.length === 1
                ? t("me.countryMatchOne", { count: switchCountries.length })
                : t("me.countryMatchMany", { count: switchCountries.length }))
              : t("me.otherCountries")}
          </div>
          <div style={{ display: "grid", gap: 8, maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
            {switchCountries.length === 0 ? (
              <div style={{
                padding: "14px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px dashed ${T.border}`,
                color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
                textAlign: "center" as const,
              }}>
                {t("me.noCountriesMatch")}
              </div>
            ) : switchCountries.map((country) => {
              const choices = country.chamas.length > 1 ? country.chamas : [];
              const open = expandedCountry === country.code;
              return (
                <div key={country.code} style={{ display: "grid", gap: 6 }}>
                  <button
                    data-community-country={country.code}
                    aria-expanded={choices.length > 1 ? open : undefined}
                    onClick={() => {
                      if (choices.length > 1) {
                        setExpandedCountry(open ? null : country.code);
                        return;
                      }
                      setChanging(false);
                      setQuery("");
                      onSelectCommunity(resolveCountryCommunitySlug(country));
                    }}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 11,
                      padding: "11px 12px", borderRadius: T.rs,
                      background: T.surface, border: `1px solid ${open ? T.accent + "66" : T.border}`,
                      color: T.text, fontFamily: T.sans, cursor: "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{country.flag}</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 800, color: T.text }}>
                        {country.name}
                      </span>
                      <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: T.sans, fontSize: T.fs.secondary, color: T.muted }}>
                        {choices.length > 1
                          ? t("me.chamasInCountry", { count: choices.length })
                          : countrySubline(country)}
                      </span>
                    </span>
                    <span style={{ color: T.accent, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700 }}>
                      {choices.length > 1 ? (open ? "−" : "+") : t("me.switchAction")}
                    </span>
                  </button>
                  {open && choices.map((choice) => {
                    const isCurrent = choice.slug === communitySlug;
                    return (
                      <button
                        key={choice.slug}
                        data-community-choice={choice.slug}
                        disabled={isCurrent}
                        onClick={() => {
                          setChanging(false);
                          setQuery("");
                          setExpandedCountry(null);
                          onSelectCommunity(choice.slug);
                        }}
                        style={{
                          marginLeft: 18, width: "calc(100% - 18px)", display: "flex", alignItems: "center", gap: 10,
                          padding: "9px 11px", borderRadius: T.rs, textAlign: "left",
                          background: isCurrent ? T.accentDim : T.card,
                          border: `1px solid ${isCurrent ? T.accent + "55" : T.border}`,
                          color: isCurrent ? T.accent : T.text,
                          cursor: isCurrent ? "default" : "pointer",
                        }}
                      >
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: "block", fontFamily: T.sans, fontSize: 12, fontWeight: 800 }}>
                            {choice.pickerLabel ?? choice.displayName}
                          </span>
                          <span style={{ display: "block", marginTop: 2, color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary }}>
                            {[choice.disambiguator, choice.currency].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700 }}>
                          {isCurrent ? t("me.current") : t("me.switchAction")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}


function buildMeDashboard(
  myTrades: EscrowState[],
  allTrades: EscrowState[],
  pubkey: string,
  nowSec: number,
): MeDashboardModel {
  const lowerPubkey = pubkey.toLowerCase();
  const needsYou: EscrowState[] = [];
  const sellerOpen: EscrowState[] = [];
  const sellerLive: EscrowState[] = [];
  const sellerInventory: EscrowState[] = [];
  const sellerWindowShoppers: EscrowState[] = [];
  const sellerReadyToLock: EscrowState[] = [];
  const arbiterDisputes: EscrowState[] = [];
  const arbiterWatching: EscrowState[] = [];
  const arbiterConflicts: EscrowState[] = [];
  const arbiterSettled: EscrowState[] = [];
  let arbiterVisible = BLF_OFFICIAL_ARBITERS.includes(lowerPubkey);

  for (const trade of allTrades) {
    const eligibility = arbiterWatchEligibility(trade, pubkey, nowSec);
    const isAssignedArbiter = eligibility.assigned;
    if (eligibility.pool || isAssignedArbiter) arbiterVisible = true;
    if (eligibility.conflict) arbiterConflicts.push(trade);
    const watchesAsArbiter = eligibility.watches;

    if (watchesAsArbiter) {
      // Arbiter substitution: a pool BACKUP also lands in "needs" on a
      // pooled-share lock with a live dispute and an open arbiter slot —
      // first showing the assigned arbiter's floor countdown, then the
      // step-in affordance once it lapses (decideVotePrompt gates the
      // actual buttons; the reducer re-enforces everything).
      const substitutionCandidate =
        !isAssignedArbiter &&
        trade.status === EscrowStatus.LOCKED &&
        trade.lock.arbiterPoolShare === true &&
        tradeHasBuyerSellerDispute(trade) &&
        trade.votes[Role.ARBITER] === undefined &&
        arbiterVotePriority(trade, pubkey) !== null;
      // The field-found visibility gap: an EXPIRED-but-unresolved trade is the
      // MOST arbiter-needing state there is (funds blocked until a healing
      // vote), yet the LOCKED-only check above dropped it to WATCHING — zero
      // red anywhere while sats sat in limbo. Surface healable trades in NEEDS
      // for the assigned arbiter and (on pooled locks) for pool backups whose
      // own vote isn't already in the chain. Opening the trade auto-heals.
      const healableExpired =
        (trade.status === EscrowStatus.EXPIRED ||
          (trade.status === EscrowStatus.LOCKED &&
            trade.expiresAt > 0 &&
            nowSec > trade.expiresAt)) &&
        !trade.eventChain.some((e) => e.kind === EscrowEventKind.RESOLVE);
      const canHealIt =
        healableExpired &&
        (isAssignedArbiter
          ? !trade.eventChain.some(
              (e) => e.kind === EscrowEventKind.VOTE && e.pubkey === pubkey,
            )
          : trade.lock.arbiterPoolShare === true &&
            arbiterVotePriority(trade, pubkey) !== null &&
            !trade.eventChain.some(
              (e) => e.kind === EscrowEventKind.VOTE && e.pubkey === pubkey,
            ));
      if (
        (isAssignedArbiter &&
          trade.status === EscrowStatus.LOCKED &&
          tradeHasBuyerSellerDispute(trade) &&
          !trade.votes[Role.ARBITER]) ||
        substitutionCandidate ||
        canHealIt
      ) {
        arbiterDisputes.push(trade);
      } else if (isArbiterSettledTrade(trade)) {
        arbiterSettled.push(trade);
      } else {
        arbiterWatching.push(trade);
      }
    }
  }

  for (const trade of myTrades) {
    const role = getUserRoleForTrade(trade, pubkey, nowSec);
    if (role === Role.SELLER && trade.status === EscrowStatus.CREATED) {
      sellerOpen.push(trade);
      const sellerOrderState = getSellerOrderState(trade, nowSec);
      if (sellerOrderState === "ready") {
        sellerReadyToLock.push(trade);
      } else if (sellerOrderState === "hold") {
        sellerWindowShoppers.push(trade);
      } else {
        sellerInventory.push(trade);
      }
    }
    if (
      role === Role.SELLER &&
      (trade.status === EscrowStatus.LOCKED ||
        trade.status === EscrowStatus.APPROVED ||
        trade.status === EscrowStatus.CLAIMED)
    ) {
      sellerLive.push(trade);
    }

    if (tradeNeedsUser(trade, pubkey, role)) {
      needsYou.push(trade);
    }
  }

  return {
    needsYou,
    sellerOpen,
    sellerLive,
    sellerInventory,
    sellerWindowShoppers,
    sellerReadyToLock,
    arbiterVisible,
    arbiterDisputes,
    arbiterWatching,
    arbiterConflicts,
    arbiterSettled,
  };
}

/** How long a buyer seat WITHOUT a recorded hold stays credible. Generous
 *  enough that a real buyer who joined before holds existed can still come
 *  back the same day; decisive enough that a ghost clears. */
const UNHELD_ORDER_GRACE_SEC = 86_400;

function isStaleUnheldOrder(trade: EscrowState, nowSec: number): boolean {
  if (trade.status !== EscrowStatus.CREATED) return false;
  if (!trade.participants[Role.BUYER]) return false;
  if (trade.joinHolds?.[Role.BUYER]) return false; // a real reservation expires on its own
  if (trade.tranchePlan) return false;             // a signed plan freezes the seats on purpose
  const joinedAt = trade.eventChain
    .filter(event => event.kind === EscrowEventKind.JOIN)
    .reduce((newest, event) => Math.max(newest, event.timestamp ?? 0), 0);
  // No JOIN in view: the seat may predate what this client can replay, so
  // fall back to the listing's own age rather than guessing it is live.
  const since = joinedAt > 0 ? joinedAt : trade.createdAt;
  return since > 0 && nowSec > since + UNHELD_ORDER_GRACE_SEC;
}

function getSellerOrderState(
  trade: EscrowState,
  nowSec: number,
): "inventory" | "hold" | "ready" {
  // ── Ghost guard (Jet, 2026-09-19: "I caught ghost trades again") ─────────
  // A CREATED listing whose buyer seat has NO recorded reservation never
  // lapses: getEffectiveParticipantAt only expires a seat it can find a hold
  // for. So a legacy or partial JOIN pins a listing in the READY queue
  // forever — "order finalized · waiting for your lock" on a buyer who left
  // long ago. Age those seats out from the JOIN itself; a real buyer has a
  // hold (or comes back inside the day), a ghost never does. Display-layer
  // only: the chain is untouched, the listing simply returns to stock where
  // it can be edited or deleted.
  if (isStaleUnheldOrder(trade, nowSec)) return "inventory";
  // Circles run their own clock: seats fill, the HOST locks LAST from the
  // circle screen once the group is in. A member taking a seat registers as
  // a buyer here, which read as "order finalized, waiting for your lock" on
  // the host's Seller Dashboard while the circle was still filling (Jet,
  // prod sighting 2026-09-18). Circles and shares stay in quiet inventory.
  if (trade.category === "chama" || trade.chamaPolicy === "share-v1" || trade.chamaPolicy === "share-v2") {
    return "inventory";
  }
  const buyer = getEffectiveParticipantAt(trade, Role.BUYER, nowSec);
  if (!buyer) return "inventory";
  const hold = trade.joinHolds?.[Role.BUYER];
  if (trade.items && trade.items.length > 0) {
    return hold?.orderFinalizedAt ? "ready" : "hold";
  }
  return "ready";
}

function selectedOrMenuSummary(trade: EscrowState): string | null {
  const selectedItems = trade.joinHolds?.[Role.BUYER]?.selectedItems
    ?? trade.lock.selectedItems
    ?? [];
  if (selectedItems.length > 0) return selectedItemsSummary(selectedItems);
  const menuCount = trade.items?.length ?? 0;
  if (menuCount === 0) return null;
  // Pure helper (no hooks) — resolved via translate() at call time (render).
  // The compared category values are data ids, never translated.
  const lang = getCurrentLang();
  const one = menuCount === 1;
  if (trade.category === "bill-pay") return translate(lang, one ? "me.billCountOne" : "me.billCountMany", { count: menuCount });
  if (trade.category === "lending") return translate(lang, one ? "me.loanCountOne" : "me.loanCountMany", { count: menuCount });
  if (trade.category === "marketplace") return translate(lang, one ? "me.itemCountOne" : "me.itemCountMany", { count: menuCount });
  return translate(lang, one ? "me.optionCountOne" : "me.optionCountMany", { count: menuCount });
}

function selectedItemsSummary(items: SelectedMenuItem[]): string {
  if (items.length === 1) {
    const item = items[0];
    return `${item.label}${item.quantity > 1 ? ` ${translate(getCurrentLang(), "me.timesQuantity", { quantity: item.quantity })}` : ""}`;
  }
  return translate(getCurrentLang(), "me.selectedCount", { count: items.length });
}


function getUserRoleForTrade(
  trade: EscrowState,
  pubkey: string,
  nowSec: number,
): Role | null {
  const lowerPubkey = pubkey.toLowerCase();
  const participants = getEffectiveParticipantsAt(trade, nowSec);
  if (participants[Role.BUYER]?.toLowerCase() === lowerPubkey) return Role.BUYER;
  if (participants[Role.SELLER]?.toLowerCase() === lowerPubkey) return Role.SELLER;
  if (participants[Role.ARBITER]?.toLowerCase() === lowerPubkey) return Role.ARBITER;
  return null;
}

function tradeNeedsUser(trade: EscrowState, pubkey: string, role: Role | null): boolean {
  if (trade.status === EscrowStatus.APPROVED) {
    return canOfferClaim(trade) && getWinner(trade)?.pubkey === pubkey;
  }
  if (trade.status !== EscrowStatus.LOCKED || role === null) return false;
  if ((role === Role.BUYER || role === Role.SELLER) && !trade.votes[role]) return true;
  return role === Role.ARBITER && tradeHasBuyerSellerDispute(trade) && !trade.votes[Role.ARBITER];
}

function tradeHasBuyerSellerDispute(trade: EscrowState): boolean {
  const buyerVote = trade.votes[Role.BUYER];
  const sellerVote = trade.votes[Role.SELLER];
  return (
    (buyerVote === Outcome.RELEASE || buyerVote === Outcome.REFUND) &&
    (sellerVote === Outcome.RELEASE || sellerVote === Outcome.REFUND) &&
    buyerVote !== sellerVote
  );
}

function isArbiterSettledTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.APPROVED ||
    trade.status === EscrowStatus.CLAIMED ||
    trade.status === EscrowStatus.COMPLETED ||
    trade.status === EscrowStatus.EXPIRED ||
    trade.status === EscrowStatus.CANCELLED
  );
}

function shortPubkey(pubkey: string | null | undefined): string {
  if (!pubkey) return translate(getCurrentLang(), "me.emptyPubkey");
  return pubkey.slice(0, 6) + "…";
}

// #88: single on/off for trade-event notifications (locked / claim ready /
// dispute / settled). Default on; the OS permission is the real gate, so
// flipping it on proactively asks. Self-contained — no prop threading.
function NotificationsRow() {
  const { t } = useT();
  const [on, setOn] = useState<boolean>(() => notificationsEnabled());
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "blocked">("idle");
  const toggle = () => {
    const next = !on;
    setOn(next);
    setNotificationsEnabled(next);
    if (next) void ensureNotificationPermission();
  };
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.notifications")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {t("me.notificationsHint")}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {on && <button
        type="button"
        onClick={() => {
          setTestState("sending");
          void sendNotificationSelfTest().then(ok => setTestState(ok ? "sent" : "blocked"));
        }}
        style={{
          border: `1px solid ${testState === "blocked" ? T.red + "66" : T.border}`,
          background: T.surface, color: testState === "sent" ? T.green : testState === "blocked" ? T.red : T.muted,
          borderRadius: T.rs, padding: "5px 8px", fontFamily: T.sans, fontSize: T.fs.secondary,
          fontWeight: 700, cursor: "pointer",
        }}
      >
        {testState === "sending" ? "Sending…" : testState === "sent" ? "Sent ✓" : testState === "blocked" ? "Blocked" : "Test"}
      </button>}
      <button
        onClick={toggle}
        role="switch"
        aria-checked={on}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.green + "66" : T.border}`,
          background: on ? T.green + "33" : T.surface,
          cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.green : T.muted, transition: "left 0.15s",
        }} />
      </button>
      </div>
    </div>
  );
}

/** Where the wallet behind "Withdraw as ecash" lives decides what can erase
 *  it: browser data in a browser, the app's storage in the Android or
 *  desktop app, nothing here at all on a Chama node. */
export function withdrawEcashHintKey(): string {
  const home = walletHome();
  return home === "app" ? "me.withdrawEcashBackupHintApp"
    : home === "node" ? "me.withdrawEcashBackupHintNode"
    : "me.withdrawEcashBackupHint";
}

function BackgroundPushRow() {
  const [testState, setTestState] = useState<"idle" | "waiting" | "received" | "failed">("idle");
  const { t } = useT();
  const [nativeStatus, setNativeStatus] = useState<NativePushStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => { void nativePushStatus().then(status => { if (active) setNativeStatus(status); }); };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const supported = isWebPushSupported();
  const needsInstall = iosNeedsInstallForPush();
  const [on, setOn] = useState<boolean>(() => backgroundPushEnabled());
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const disabled = !supported || needsInstall || busy;

  const toggle = () => {
    if (disabled) return;
    if (on) {
      setOn(false);
      setBlocked(false);
      void disableBackgroundPush();
      return;
    }
    setBusy(true);
    setBlocked(false);
    // enableBackgroundPush asks OS permission + subscribes; false = it couldn't
    // (denied, or the VPS/VAPID key isn't live yet). Reflect that honestly.
    void enableBackgroundPush().then(ok => {
      setBusy(false);
      setOn(ok);
      setBlocked(!ok);
    });
  };

  const hint =
    nativeStatus?.lane === "unavailable" ? t("me.bgPushNativeSetup")
    : needsInstall ? t("me.bgPushInstall")
    : !supported ? t(isNativeAppShell() ? "me.bgPushUnsupportedApp" : "me.bgPushUnsupported")
    : blocked ? t(nativeStatus || isNativeAppShell() ? "me.bgPushBlockedApp" : "me.bgPushBlocked")
    : nativeStatus?.lane === "fcm" ? t("me.bgPushFcm")
    : nativeStatus?.lane === "unifiedpush" ? t("me.bgPushUnified")
    : t("me.bgPushHint");

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
      opacity: (!supported || needsInstall) ? 0.6 : 1,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.bgPush")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {hint}
          {nativeStatus && <p>{t("me.bgPushForceStop")}</p>}
          {nativeStatus?.ntfy && <p>{t("me.bgPushNtfy")}</p>}
          {nativeStatus && <details style={{ margin: "8px 0", overflowWrap: "anywhere" }}>
            <summary>Alert log</summary>
            <p>Last 50 wakes on this device. Notifications: {nativeStatus.notificationsEnabled ? "allowed" : "disabled"}; Chama activity channel: {nativeStatus.channelEnabled ? "allowed" : "muted"}.</p>
            <p>Registered tags ({nativeStatus.registeredTags?.length ?? 0}), HTTP {nativeStatus.registerHttpStatus || "no response"}: {nativeStatus.registeredTags?.length ? nativeStatus.registeredTags.map(tag => tag.slice(0, 8)).join(", ") : "none recorded"}.</p>
            {!nativeStatus.alertLog?.length && <p>No alerts received yet.</p>}
            <ol style={{ paddingLeft: 18 }}>
              {[...(nativeStatus.alertLog ?? [])].reverse().map(entry => <li key={entry.id} style={{ marginBottom: 10 }}>
                <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleString()}</time>
                {` · ${entry.transport} · ${entry.verdict} · ${entry.job}`}
                <div>{entry.foregroundBranch ? `${entry.foregroundBranch} · ` : ""}{entry.tradeCount != null ? `${entry.tradeCount} trades · ` : ""}Matched tag: {entry.matchedTags?.length ? entry.matchedTags.map(tag => tag.slice(0, 8)).join(", ") : "not recorded"}{entry.elapsedMs != null ? ` · ${entry.elapsedMs} ms` : ""}{entry.jobResult ? ` · ${entry.jobResult}` : ""}</div>
                {entry.notificationsEnabled === false && <div>Android notifications were disabled.</div>}
                {entry.channelEnabled === false && <div>Chama activity channel was muted.</div>}
                {entry.posts.map((post, i) => <div key={i}>{post.reason}: {post.verdict}{post.notificationId != null ? ` · notification ${post.notificationId}` : " · no notification posted"}</div>)}
              </li>)}
            </ol>
          </details>}
          {nativeStatus && on && <>
            <button type="button" disabled={testState === "waiting"} onClick={() => {
              setTestState("waiting");
              void Promise.race([testNativePush(), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000))])
                .then(ok => setTestState(ok ? "received" : "failed"));
            }}>{t("me.bgPushTest")}</button>
            <div role="status">{testState === "waiting" ? t("me.bgPushTesting") : testState === "received" ? t("me.bgPushReceived") : testState === "failed" ? (nativeStatus.testHttpStatus && nativeStatus.testHttpStatus >= 400 ? "Alert server rejected the test" : t("me.bgPushNoReply")) : ""}{testState !== "idle" && nativeStatus.testHttpNonce && ` · ${nativeStatus.testHttpStatus ? `HTTP ${nativeStatus.testHttpStatus}` : "No HTTP response"}`}</div>
          </>}
        </div>
      </div>
      <button
        onClick={toggle}
        role="switch"
        aria-checked={on}
        disabled={disabled}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.green + "66" : T.border}`,
          background: on ? T.green + "33" : T.surface,
          cursor: disabled ? "default" : "pointer", transition: "background 0.15s, border-color 0.15s",
          flexShrink: 0,
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.green : T.muted, transition: "left 0.15s",
        }} />
      </button>
    </div>
  );
}

// DM / trade-chat notifications. Tri-state, mirroring the Appearance control:
// Auto follows your role ON EACH TRADE (arbiters are the responders, so they
// buzz; buyers/sellers stay quiet), On/Off are explicit global overrides.
// Self-contained — reads/writes the pref directly. Auto or On proactively asks
// OS permission (the real gate).
function DmNotificationsRow() {
  const { t } = useT();
  const [pref, setPref] = useState<DmNotifyPref>(() => dmNotifyPref());
  const pick = (next: DmNotifyPref) => {
    setPref(next);
    setDmNotifyPref(next);
    if (next !== "off") void ensureNotificationPermission();
  };
  const sublabel =
    pref === "auto" ? t("me.dmAutoHint")
    : pref === "on" ? t("me.dmOnHint")
    : t("me.dmOffHint");
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.dmNotifications")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {sublabel}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {(["auto", "on", "off"] as DmNotifyPref[]).map(opt => {
          const active = pref === opt;
          const label = opt === "auto" ? t("me.auto") : opt === "on" ? t("me.on") : t("me.off");
          return (
            <button
              key={opt}
              onClick={() => pick(opt)}
              role="radio"
              aria-checked={active}
              style={{
                padding: "6px 10px", borderRadius: 999,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                background: active ? T.accentDim : T.surface,
                color: active ? T.accent : T.muted,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// #79: always-on "DM my counterparty on Nostr when I take a trade-critical
// action" — so their external client (Damus/Amethyst) alerts them like an email,
// standing in for the web-push Chama can't do serverlessly. Default ON; this is
// the mute. Self-contained. No OS permission involved (it's an outbound Nostr DM,
// not a local OS notification).
function CounterpartyDmRow() {
  const { t } = useT();
  const [on, setOn] = useState<boolean>(() => tradeDmPref());
  const toggle = () => {
    const next = !on;
    setOn(next);
    setTradeDmPref(next);
  };
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.tradeDm")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {t("me.tradeDmHint")}
        </div>
      </div>
      <button
        onClick={toggle}
        role="switch"
        aria-checked={on}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.green + "66" : T.border}`,
          background: on ? T.green + "33" : T.surface,
          cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
          flexShrink: 0,
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.green : T.muted, transition: "left 0.15s",
        }} />
      </button>
    </div>
  );
}

// Part ②: opt-in "buzz me when a fresh listing appears in my home chama."
// Default OFF (explicit opt-in, non-spammy). Whole-community for now; the pref
// is stored as a structure so a later per-vertical version is a value change.
// Self-contained — reads/writes the pref directly. Turning it on asks OS
// permission (the real gate).
function NewListingNotificationsRow() {
  const { t } = useT();
  const [on, setOn] = useState<boolean>(() => newListingPref().enabled);
  const toggle = () => {
    const next = !on;
    setOn(next);
    // Preserve any (future) per-vertical selection; today verticals stays "all".
    setNewListingPref({ ...newListingPref(), enabled: next });
    if (next) void ensureNotificationPermission();
  };
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.newListingNotifications")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {t("me.newListingNotificationsHint")}
        </div>
      </div>
      <button
        onClick={toggle}
        role="switch"
        aria-checked={on}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.green + "66" : T.border}`,
          background: on ? T.green + "33" : T.surface,
          cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
          flexShrink: 0,
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.green : T.muted, transition: "left 0.15s",
        }} />
      </button>
    </div>
  );
}

/** Appearance lives with identity now (Profile tab): dark / light / auto. */
function AppearanceRow({ themeMode, onThemeModeChange }: {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.appearance")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {t("me.appearanceHint")}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {(["dark", "light", "system"] as ThemeMode[]).map(mode => {
          const active = themeMode === mode;
          const label = mode === "system" ? t("me.auto") : mode === "dark" ? t("me.dark") : t("me.light");
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => onThemeModeChange(mode)}
              style={{
                padding: "7px 11px", borderRadius: 999, cursor: "pointer",
                border: `1px solid ${active ? T.accent : T.border}`,
                background: active ? T.accentDim : "transparent",
                color: active ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** v6.3.1: quick in-app trade name — no Nostr profile setup required.
 *  Stored per active npub on this device; empty falls back to the
 *  deterministic generated name every client derives from the pubkey. */
function TradeNameRow({ pubkey, onPublishName, onPublishAvatar }: {
  onPublishAvatar?: (avatar: Avatar) => Promise<void>;
  pubkey: string;
  /** Publishes the name as kind 0 so it travels with the KEY, not the browser
   *  (Jet, 2026-09-19: a device-only rename is "pointless"). */
  onPublishName?: (name: string) => Promise<void>;
}) {
  const { t, lang } = useT();
  const [draft, setDraft] = useState<string>(() => readLocalTradeName() ?? "");
  const [savedTick, setSavedTick] = useState(false);
  const [publishState, setPublishState] = useState<"idle" | "publishing" | "published" | "local-only">("idle");
  useEffect(() => {
    const adopt = () => setDraft(previous => previous || readLocalTradeName() || "");
    window.addEventListener("chama-profile-name-adopted", adopt);
    return () => window.removeEventListener("chama-profile-name-adopted", adopt);
  }, [pubkey]);
  const [avatarError, setAvatarError] = useState(false);
  const generated = generatedNameFor(pubkey, lang);
  const save = () => {
    // Write locally FIRST so the name is never lost to a relay problem, then
    // publish. Failure downgrades honestly to "this device only".
    writeLocalTradeName(draft);
    const saved = readLocalTradeName() ?? "";
    setDraft(saved);
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 2000);
    if (!onPublishName || !saved) { setPublishState("idle"); return; }
    setPublishState("publishing");
    void onPublishName(saved)
      .then(() => setPublishState("published"))
      .catch(() => setPublishState("local-only"));
  };
  return (
    <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
        <ProfileAvatar pubkey={pubkey} fallback={null} />
        {onPublishAvatar && <label style={{ display: "block" }}>{t("me.avatarUpload")}
          <input type="file" accept="image/gif,image/png,image/webp,image/jpeg" onChange={async event => {
            const file = event.target.files?.[0]; if (!file) return;
            setAvatarError(false);
            try { await onPublishAvatar(await avatarFromFile(file)); }
            catch { setAvatarError(true); }
          }} />
          {avatarError && <span>{t(isSimModeOn() ? "me.sandboxProfileLocal" : "me.avatarFailed")}</span>}
        </label>}
        {t("me.tradeName")}
      </div>
      <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
        {t("me.tradeNameHint", { name: generated })}
      </div>
      {publishState !== "idle" && (
        <div style={{
          fontSize: T.fs.secondary, marginTop: 6, fontFamily: T.sans, lineHeight: 1.5,
          color: publishState === "local-only" ? T.amber : publishState === "published" ? T.green : T.muted,
        }}>
          {t(publishState === "publishing" ? "me.tradeNamePublishing"
            : publishState === "published" ? "me.tradeNamePublished"
            : isSimModeOn() ? "me.sandboxProfileLocal" : "me.tradeNameLocalOnly")}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") save(); }}
          placeholder={generated}
          maxLength={24}
          style={{
            flex: 1, minWidth: 0, padding: "9px 11px", borderRadius: T.rs,
            border: `1px solid ${T.border}`, outline: "none",
            background: T.surface, color: T.text, fontFamily: T.sans, fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={save}
          disabled={sanitizeTradeName(draft) === (readLocalTradeName() ?? "")}
          style={{
            padding: "9px 14px", borderRadius: 999, border: 0, cursor: "pointer",
            background: savedTick ? T.greenDim : T.accent,
            color: savedTick ? T.green : T.bg,
            fontFamily: T.sans, fontSize: 12, fontWeight: 800,
          }}
        >
          {savedTick ? t("me.tradeNameSaved") : t("me.tradeNameSave")}
        </button>
      </div>
    </div>
  );
}

function NostrNamesRow({ on, onToggle }: {
  on: boolean; onToggle: () => void;
}) {
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
          {t("me.nostrNames")}
        </div>
        <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
          {t("me.nostrNamesHint")}
        </div>
      </div>
      <button
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        style={{
          width: 46, height: 26, borderRadius: 999, position: "relative",
          border: `1px solid ${on ? T.accent + "66" : T.border}`,
          background: on ? T.accentDim : T.surface,
          cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
          flexShrink: 0,
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: on ? 22 : 2,
          width: 20, height: 20, borderRadius: "50%",
          background: on ? T.accent : T.muted, transition: "left 0.15s",
        }} />
      </button>
    </div>
  );
}


export function WalletBalance({ balanceMsats, known = true, invite }: { balanceMsats: number; known?: boolean; invite?: string }) {
  const { t } = useT();
  return <div data-wallet-balance style={{ padding: 16, color: T.text, fontFamily: T.sans }}>{t("me.walletBalance")} {known ? <TradeAmount msats={balanceMsats} interactive /> : "—"}<EcashCustody key={invite} invite={invite} /></div>;
}

/** H4: the wallets ParkedWallets lists. Home reads the same list, so it never
 *  says Chama holds nothing while a kept wallet still holds sats. */
export function parkedWalletRoutes(pubkey: string | null | undefined, activeInvite?: string) {
  if (!pubkey) return [];
  const activeFed = expectedFederationIdForInvite(activeInvite)?.toLowerCase();
  return listArbiterFederationRoutes(pubkey).filter((route) =>
    route.inviteCode !== activeInvite?.trim() && route.federationId !== activeFed && (route.lastBalanceMsats ?? 0) >= 1000);
}

/** H4: wallets kept on this device for other federations. The amount is the
 *  balance seen when the person last left that federation, so it says so. */
export function ParkedWallets({ pubkey, activeInvite }: { pubkey: string | null | undefined; activeInvite?: string }) {
  const { t } = useT();
  const parked = parkedWalletRoutes(pubkey, activeInvite);
  if (parked.length === 0) return null;
  return (
    <div data-parked-wallets style={{ padding: "0 16px 16px", color: T.text, fontFamily: T.sans }}>
      <div style={{ fontSize: T.fs.secondary, color: T.ink2, marginBottom: 6 }}>{t("me.parkedWalletsTitle")}</div>
      {parked.map((route) => (
        <div key={route.federationId} style={{ fontSize: T.fs.body, lineHeight: 1.45, marginBottom: 4 }}>
          <ParkedWalletLine sats={Math.floor((route.lastBalanceMsats ?? 0) / 1000)} invite={route.inviteCode} />
        </div>
      ))}
      <div style={{ fontSize: T.fs.secondary, color: T.ink2, lineHeight: 1.4, marginTop: 4 }}>{t("me.parkedWalletsHint")}</div>
    </div>
  );
}

/** Jet (6.4.26-rc.6): a kept wallet on an unlisted federation is named by
 *  the name that federation publishes, marked unlisted, so each balance
 *  says whose it is. */
function ParkedWalletLine({ sats, invite }: { sats: number; invite: string }) {
  const { t } = useT();
  const listed = federationNameForInvite(invite);
  const { info } = useFederationInfo(listed ? "" : invite.trim());
  const published = publishedFederationName(info);
  return <>{t("me.parkedWalletLine", {
    sats: sats.toLocaleString(),
    name: listed ?? (published ? t("recovery.barUnlistedNamed", { name: published }) : t("me.parkedWalletUnlisted")),
  })}</>;
}

/** v7 redesign: a labelled settings group (canvas "Me": Money / Community / App). */
function SettingsGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      {label && <div style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600, color: T.ink3, padding: "0 4px 8px" }}>{label}</div>}
      <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.rCard, overflow: "hidden" }}>{children}</div>
    </section>
  );
}

/** "Keep my offers live" as a settings row with a switch. */
function StoreAutoRenewRow({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useT();
  return (
    <button type="button" role="switch" aria-checked={enabled} onClick={() => onChange(!enabled)} style={{
      width: "100%", minHeight: T.size.touch, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
      background: "none", border: "none", borderBottom: `1px solid ${T.line}`, textAlign: "left", cursor: "pointer", fontFamily: T.sans,
    }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: T.fs.body, color: T.ink }}>{t("me.storeAutoRenew")}</span>
        <span style={{ display: "block", fontSize: T.fs.secondary, color: T.ink2, marginTop: 2, lineHeight: 1.4 }}>{t("me.storeAutoRenewHint")}</span>
      </span>
      <span aria-hidden="true" style={{ flexShrink: 0, width: 44, height: 26, borderRadius: 999, position: "relative", background: enabled ? T.pos : T.line }}>
        <span style={{ position: "absolute", top: 3, left: enabled ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#FFFFFF", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .2s" }} />
      </span>
    </button>
  );
}
