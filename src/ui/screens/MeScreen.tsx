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

import { useState, useEffect } from "react";
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
import type { ChamaLiveness } from "../../arbiters/live-chama.js";

/** How often the Me screen re-checks its own chama's liveness (a bond appearing
 *  or a rating landing shows up without a manual reload). Slow — liveness drifts
 *  on the scale of blocks, not seconds. */
const LIVENESS_POLL_MS = 90_000;
import { getCommunityBySlug } from "../../communities/registry.js";
import { countryMatchesSearch, countrySubline, resolveCountryCommunitySlug } from "../../communities/country-resolve.js";
import { getAllPickerCountries } from "../../communities/countries.js";
import {
  MAIN_SURFACE_RECOVERY_MIN_SATS,
  formatStepInCountdown,
  selectNeedsYouTrades,
  type AggregateRatings,
} from "../decisions.js";
import { AttentionQueue } from "../components/AttentionQueue.js";
import { latestParticipantTrade } from "../latest-trade.js";
import { counterpartyToRate, type RatingThumb } from "../../reputation/ratings.js";
import { RatingTap } from "../components/RatingTap.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";
import {
  describeSatsTrace,
  type SatsTraceEntry,
} from "../../payments/sats-trace.js";
import { getEcashExport } from "../../payments/ecash-exports.js";
import type { ReabsorbOutcome } from "../../fedimint/reabsorb-bearer-notes.js";
import {
  excludeStrandedRedemptionsOwnedByExport,
  listPendingRedemptions,
  listStrandedRedemptions,
  partitionStrandedClaims,
  reopenBalanceReconciledCredit,
  resolveUnresolvedCredit,
  type StrandedRedemption,
} from "../../fedimint/pending-redemptions.js";
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
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import type { TradeIndexEntry } from "../../escrow-engine/trade-index.js";
import { readKind0Toggle, writeKind0Toggle } from "../nostr-profiles.js";

type MeTradeFilter = "all" | "needs" | "live" | "listings" | "done";

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
  pubkey,
  kind0Enabled,
  onKind0EnabledChange,
  themeMode,
  onThemeModeChange,
  myTrades,
  allTrades,
  needsYouTrades,
  archivedTrades,
  onOpenArchivedTrade,
  ratings,
  onOpenTrade,
  onRefreshTrades,
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
  satsTrace,
  onRecoverSats,
  onWithdrawEcash,
  onSignOut,
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
  pubkey: string;
  kind0Enabled?: boolean;
  onKind0EnabledChange?: (enabled: boolean) => void;
  /** #50 dark/light theming — current mode + setter (App owns the state). */
  themeMode?: ThemeMode;
  onThemeModeChange?: (mode: ThemeMode) => void;
  myTrades: EscrowState[];
  allTrades?: EscrowState[];
  /** Canonical urgency-ranked queue from App. Includes chain-verified pending
   *  on-chain payouts in addition to ordinary reducer-derived work. */
  needsYouTrades?: EscrowState[];
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
  const { t } = useT();
  const npubShort = pubkey.slice(0, 8) + "…" + pubkey.slice(-4);
  const [localKind0On, setLocalKind0On] = useState<boolean>(() => readKind0Toggle(pubkey));
  const kind0On = kind0Enabled ?? localKind0On;
  const [tradeFilter, setTradeFilter] = useState<MeTradeFilter>("all");
  useEffect(() => {
    setLocalKind0On(readKind0Toggle(pubkey));
  }, [pubkey]);
  useEffect(() => { writeKind0Toggle(pubkey, kind0On); }, [pubkey, kind0On]);
  const setKind0On = (enabled: boolean) => {
    setLocalKind0On(enabled);
    onKind0EnabledChange?.(enabled);
  };
  const localRecoverySats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const localRecoverableSats = maxLightningPayoutSats(balanceMsats);
  const localReserveSats = lightningPayoutReserveSats(balanceMsats);
  // #37: while a pending lock attempt owns the balance story, the drain
  // card hides — recovering here would abandon a resumable live trade.
  // Stranded-payout recovery: same rule while an unfinished claim payout
  // owns it — the "Finish your payout" card is the honest surface.
  const showLocalRecovery =
    !hasActiveCommitment && localRecoverySats > 0
    && !hasPendingNativeLock && !hasPendingClaimPayout;
  const isSmallLeftover = localRecoverySats < MAIN_SURFACE_RECOVERY_MIN_SATS;
  // A leftover below the material dust line never offers an ACTIVE recover
  // button — recovering ~1 sat burns more than itself in Lightning fees (the
  // same line the switch guard and recovery banner use). The card stays as a
  // quiet "accumulating" note until the pile is worth the fees.
  const recoverWorthwhile = !isSmallLeftover && localRecoverableSats > 0;
  // v2.4 #56 — a pending ecash export (generated but not yet confirmed
  // imported). Surfaced even when the balance reads 0, so the user can always
  // get back to the bearer note they minted.
  const pendingEcashExport = getEcashExport();
  // v3.4.0 C13 — claims whose bearer notes automatic retry gave up on.
  // These sit in clearable localStorage while the chain reads COMPLETED;
  // without a loud surface, a data-clear or federation switch destroys
  // the only copy of the money. Rendered as the topmost alarm card.
  // v4.0.0: bump to force a re-read after a dismiss mutates the stash.
  const [, bumpStrandedTick] = useState(0);
  useEffect(() => {
    // A previous build treated the pending export's face value as proof that a
    // consumed claim had landed and archived its warning. An export is not
    // proof—the receiving wallet can reject it as already spent. Reopen only
    // those automatic archives while the unconfirmed export still exists.
    if (!pendingEcashExport) return;
    let reopened = false;
    for (const entry of listPendingRedemptions()) {
      if (reopenBalanceReconciledCredit(entry.escrowId)) reopened = true;
    }
    if (reopened) bumpStrandedTick((tick) => tick + 1);
  }, [pendingEcashExport?.createdAt]);
  const strandedClaims = excludeStrandedRedemptionsOwnedByExport(
    listStrandedRedemptions(),
    pendingEcashExport?.notes,
  );
  // Reconcile the "unresolved-credit" sliver against the wallet balance the
  // copy already invokes — covered → resolve silently; short → calm nudge;
  // poisoned / retries-exhausted stay loud (may be live money). See
  // partitionStrandedClaims.
  const { loud: loudClaims, calm: calmClaims, reconciledIds } =
    // A pending export is not proof of value: the receiver may find that note
    // already consumed. Only confirmed wallet balance can reconcile a failed
    // claim automatically.
    partitionStrandedClaims(strandedClaims, balanceMsats);
  const reconciledKey = reconciledIds.join(",");
  useEffect(() => {
    if (!reconciledKey) return;
    for (const id of reconciledKey.split(",")) resolveUnresolvedCredit(id, "balance-reconciled");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciledKey]);
  const dismissClaim = (escrowId: string) => {
    resolveUnresolvedCredit(escrowId, "user-dismissed");
    bumpStrandedTick((t) => t + 1);
  };
  // 6.0.2 liveness probe. Keyed by the exact bearer string so two cards
  // holding different notes stay independently tappable, and so a double-tap
  // on one card can't fire twice (the probe layer coalesces too, but a
  // disabled button is the honest surface).
  const [probingNotes, setProbingNotes] = useState<string | null>(null);
  const reabsorb = async (input: {
    oobNotes: string;
    expectedMsats: number;
    context: "pending-export" | "stranded-claim";
    escrowId?: string;
  }) => {
    if (!onReabsorbBearerNotes || probingNotes) return;
    setProbingNotes(input.oobNotes);
    try {
      await onReabsorbBearerNotes(input);
    } finally {
      setProbingNotes(null);
      // App has already resolved the storage records; re-read them. An
      // `unknown` outcome changes nothing, and the re-read shows exactly that.
      bumpStrandedTick((t) => t + 1);
    }
  };
  /** The one action shared by all three recovery cards. */
  const reabsorbButton = (
    input: {
      oobNotes: string;
      expectedMsats: number;
      context: "pending-export" | "stranded-claim";
      escrowId?: string;
    },
    opts: { label: string; accent: string },
  ) => {
    const busy = probingNotes === input.oobNotes;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); void reabsorb(input); }}
        disabled={probingNotes !== null}
        style={{
          width: "100%",
          minHeight: 40, padding: "11px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${opts.accent}66`,
          color: opts.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
          cursor: probingNotes === null ? "pointer" : "default",
          opacity: probingNotes !== null && !busy ? 0.5 : 1,
        }}
      >
        {busy ? t("me.reabsorbBusy") : opts.label}
      </button>
    );
  };
  const isClaimPayoutRecovery = !isSmallLeftover && Boolean(satsTrace?.escrowId);
  const traceCopy = describeSatsTrace(satsTrace ?? null);
  const nowSec = Math.floor(Date.now() / 1000);
  const dashboard = buildMeDashboard(myTrades, allTrades ?? myTrades, pubkey, nowSec);
  // App owns the canonical attention queue because it merges reducer-derived
  // work with chain-verified pending on-chain payouts. Keep the Me hero, Needs
  // count, and Needs filter on that exact source so the inner and outer pills
  // cannot disagree. The fallback preserves standalone/test callers.
  const rankedNeedsYou = needsYouTrades
    ?? selectNeedsYouTrades({ escrows: allTrades ?? myTrades, userPubkey: pubkey, nowSec });
  const tradeCounts = buildMeTradeCounts(myTrades, rankedNeedsYou);
  const visibleTrades = filterMeTrades(myTrades, rankedNeedsYou, tradeFilter);
  const latestTrade = latestParticipantTrade(myTrades);
  const hasSellerDashboard = dashboard.sellerOpen.length > 0 || dashboard.sellerLive.length > 0;
  const hasVisibleMoneyAction =
    loudClaims.length > 0
    || calmClaims.length > 0
    || (showLocalRecovery && !isSmallLeftover)
    || Boolean(stuckNativeLocks?.length)
    || Boolean(pendingEcashExport && onWithdrawEcash);

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
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
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 10,
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

      {/* ⭐ ATTENTION HERO — the single prioritized "needs your attention" queue.
          One source of truth with the Me-tab badge (selectNeedsYouTrades),
          pin/snooze triage on top. Everything else is collapsed below. */}
      <AttentionQueue
        ranked={rankedNeedsYou}
        pubkey={pubkey}
        onOpenTrade={onOpenTrade}
        latestTrade={latestTrade}
        suppressEmptyState={hasVisibleMoneyAction}
      />

      {/* ── MONEY-SAFETY, always visible (never collapsed) ──────────────────
          Recovery / stranded-claim / lock-recovery / pending-ecash cards are
          money-critical, so they sit right under the hero — never hidden in a
          closed accordion. */}

      {/* v3.4.0 C13 — stranded claim notes. INVARIANT(stranded-notes-surfaced):
          a bearer note the drain gave up on gets a persistent, actionable
          alarm — not a console line. Tap → EcashExportModal (preset mode)
          with QR + copy, so the user can move the money to safety. */}
      {/* LOUD: poisoned / retries-exhausted — the bearer note is (or may be)
          LIVE money the drain couldn't redeem. Stays a red, tap-to-export alarm;
          never balance-downgraded. */}
      {onExportStrandedClaim && loudClaims.map((entry) => (
        <div
          key={entry.escrowId}
          onClick={() => onExportStrandedClaim(entry)}
          style={{
            background: T.redDim, border: `1px solid ${T.red}88`,
            borderRadius: T.r, padding: 20, marginBottom: 16, cursor: "pointer",
            boxShadow: `0 0 30px ${T.red}22`,
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.red,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            {t("me.strandedClaimTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
            <BitcoinAmount sats={Math.floor(entry.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}{t("me.strandedClaimBody")}
          </div>
          {/* The honest alternative to exporting a note nobody has tested:
              ask the federation by taking it. Either the sats land in the
              balance or this card learns it was chasing nothing. */}
          {onReabsorbBearerNotes && (
            <div style={{ marginTop: 12 }}>
              {reabsorbButton(
                {
                  oobNotes: entry.oobNotes,
                  expectedMsats: entry.amountMsats,
                  context: "stranded-claim",
                  escrowId: entry.escrowId,
                },
                { label: t("me.reabsorbCta"), accent: T.text },
              )}
            </div>
          )}
        </div>
      ))}

      {/* CALM: unresolved-credit whose amount the wallet balance does NOT cover.
          The note was reported already-redeemed (so it's not live money to
          rescue) but this wallet is short. Honest, dismissible nudge; the note
          is archived (kept) on dismiss. The balance-covered case never reaches
          here — it auto-reconciles silently. */}
      {calmClaims.map((entry) => {
        // Two different states share this card, and only one has been tested.
        // Unprobed: where the sats went is NOT established — the copy names no
        // cause and points at the probe (the reabsorb CTA) as the way to find
        // out. Probed consumed-uncredited: the federation confirmed it took the
        // notes, and where the sats went is still NOT established, so neither
        // state ever asserts a location.
        const probedConsumed = entry.probeVerdict === "consumed-uncredited";
        return (
        <div
          key={entry.escrowId}
          style={{
            background: T.card, border: `1px solid ${T.amber}55`,
            borderRadius: T.r, padding: 18, marginBottom: 16,
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.amber,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            {probedConsumed ? t("me.probedConsumedTitle") : t("me.checkOtherDeviceTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 12 }}>
            <BitcoinAmount sats={Math.floor(entry.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}{probedConsumed ? t("me.probedConsumedBody") : t("me.checkOtherDeviceBody")}
          </div>
          {/* The unprobed card's whole claim is an inference; the probe is the
              only thing that can settle it. Once it HAS been settled, offering
              to probe again is offering to re-ask a question already answered
              — so the button goes away with the guess it replaced. */}
          {onReabsorbBearerNotes && !probedConsumed && (
            <div style={{ marginBottom: 8 }}>
              {reabsorbButton(
                {
                  oobNotes: entry.oobNotes,
                  expectedMsats: entry.amountMsats,
                  context: "stranded-claim",
                  escrowId: entry.escrowId,
                },
                { label: t("me.reabsorbCta"), accent: T.amber },
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {onExportStrandedClaim && (
              <button
                onClick={() => onExportStrandedClaim(entry)}
                style={{
                  flex: 1, minHeight: 40, borderRadius: T.rs,
                  background: "none", border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {t("me.viewNote")}
              </button>
            )}
            <button
              onClick={() => dismissClaim(entry.escrowId)}
              style={{
                flex: 1, minHeight: 40, borderRadius: T.rs,
                background: T.amberDim, border: `1px solid ${T.amber}66`,
                color: T.amber, fontFamily: T.sans, fontSize: 13, fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {t("me.dismiss")}
            </button>
          </div>
        </div>
        );
      })}

      {/* Only surface a leftover once it's worth acting on. Below the dust line it
          reads as "you're losing sats in limbo" — against Chama's no-wallet promise —
          so it stays hidden and silently accumulates until it crosses the threshold,
          when this card (and its fee-free ecash exit) reappears. A pending minted
          ecash note still shows below regardless. */}
      {showLocalRecovery && !isSmallLeftover && (
        <div style={{
          background: isClaimPayoutRecovery ? T.amberDim : T.card,
          border: `1px solid ${isSmallLeftover ? T.border : T.amber}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
          boxShadow: isClaimPayoutRecovery ? `0 0 30px ${T.amber}22` : "none",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: isSmallLeftover ? T.muted : T.amber,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 12,
          }}>
            {isClaimPayoutRecovery ? t("me.payoutRecoveryTitle") : t("me.satsRecoveryTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {isSmallLeftover ? (
              <>
                <BitcoinAmount sats={localRecoverySats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("me.smallLeftoverBody")}
              </>
            ) : (
              <>
                <BitcoinAmount sats={localRecoverySats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("me.recoverReadyBody")}
                {localReserveSats > 0 && (
                  <>
                    {" "}{t("me.reservedForFeesBefore")} <BitcoinAmount sats={localReserveSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("me.reservedForFeesAfter")}
                  </>
                )}
              </>
            )}
          </div>
          {traceCopy && (
            <div style={{
              marginTop: 10, padding: "9px 10px",
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: T.rs, color: T.muted,
              fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
            }}>
              {t("me.tracePrefix", { trace: traceCopy })}
              {satsTrace?.escrowId ? (
                <div style={{ wordBreak: "break-all" as const, marginTop: 4 }}>
                  {satsTrace.escrowId}
                </div>
              ) : null}
            </div>
          )}
          <button
            onClick={onRecoverSats}
            disabled={!recoverWorthwhile}
            style={{
              width: "100%", padding: "12px", marginTop: 14,
              background: recoverWorthwhile ? T.amberDim : T.surface,
              border: `1px solid ${recoverWorthwhile ? T.amber + "66" : T.border}`,
              borderRadius: T.rs,
              color: recoverWorthwhile ? T.amber : T.muted,
              fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: recoverWorthwhile ? "pointer" : "default",
            }}
          >
            {recoverWorthwhile
              ? <>{isClaimPayoutRecovery ? t("me.recoverPayout") : t("me.recover")} <BitcoinAmount sats={localRecoverableSats} size={12} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /></>
              : isSmallLeftover
                ? t("me.accumulatingTooSmall")
                : t("me.waitingEnoughSats")}
          </button>
          {/* v2.4 #56 — fee-free ecash exit. Available for ANY balance,
              including dust the LN "Recover" button can't economically move.
              Spends the balance into a Fedimint note importable into Fedi or
              any Fedimint wallet on this federation. */}
          {onWithdrawEcash && (
            <button
              onClick={onWithdrawEcash}
              style={{
                width: "100%", padding: "11px", marginTop: 8,
                background: T.surface, border: `1px solid ${T.teal}55`,
                borderRadius: T.rs, color: T.teal,
                fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer",
              }}
            >
              {t("me.withdrawEcash")}
            </button>
          )}
        </div>
      )}

      {/* #37 — lock-recovery entries whose automatic retries were exhausted.
          Calm + informational (the notes are kept safe, nothing is lost):
          re-opening the trade and tapping Fund/Finish retries recovery with
          a fresh budget. Deliberately NOT the loud red treatment — the
          value is bearer notes in localStorage, not maybe-live claim money. */}
      {stuckNativeLocks && stuckNativeLocks.length > 0 && stuckNativeLocks.map((entry) => (
        <div key={entry.escrowId} style={{
          background: T.card, border: `1px solid ${T.amber}55`,
          borderRadius: T.r, padding: 16, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.amber,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 10,
          }}>
            {t("me.lockRecoveryPausedTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {t("me.lockRecoveryBodyBefore")}{" "}
            <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
            {t("me.lockRecoveryBodyAfter")}
          </div>
          <div style={{
            marginTop: 8, fontFamily: T.mono, fontSize: 10, color: T.muted,
            wordBreak: "break-all" as const,
          }}>
            {entry.escrowId}
            {entry.lastError ? <div style={{ marginTop: 4 }}>{t("me.lastError", { error: entry.lastError.slice(0, 120) })}</div> : null}
          </div>
          <button
            onClick={() => onOpenTrade(entry.escrowId)}
            style={{
              width: "100%", padding: "11px", marginTop: 12,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: T.rs, color: T.text,
              fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer",
            }}
          >
            {t("me.openTrade")}
          </button>
        </div>
      ))}

      {/* v2.4 #56 — pending ecash export re-entry. After generating a note the
          balance reads 0, so the SATS RECOVERY card hides; this is how the user
          gets back to the bearer note they minted until they confirm import. */}
      {pendingEcashExport && onWithdrawEcash && (
        <div
          onClick={onWithdrawEcash}
          style={{
            background: T.tealDim, border: `1px solid ${T.teal}66`,
            borderRadius: T.r, padding: 20, marginBottom: 16, cursor: "pointer",
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.teal,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            {t("me.pendingEcashExportTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
            {t("me.mintedEcashBefore")}{" "}
            <BitcoinAmount sats={Math.floor(pendingEcashExport.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}{pendingEcashExport.federationLabel
              ? t("me.mintedEcashAfterOnFed", { federation: pendingEcashExport.federationLabel })
              : t("me.mintedEcashAfter")}
          </div>
          {/* The missing exit. Before this, onWithdrawEcash was the card's
              ONLY action, so a note the user knows is dead could not be
              cleared and assertEcashExportWritable then blocked every future
              export. This needs no "are you sure?" — nothing is being
              discarded. The user either gets the money back or learns there
              was none. It IS a cancel-send, so it says so. */}
          {onReabsorbBearerNotes && (
            <div style={{ marginTop: 12 }}>
              {reabsorbButton(
                {
                  oobNotes: pendingEcashExport.notes,
                  expectedMsats: pendingEcashExport.amountMsats,
                  context: "pending-export",
                  escrowId: pendingEcashExport.escrowId,
                },
                { label: t("me.reabsorbCancelCta"), accent: T.teal },
              )}
            </div>
          )}
        </div>
      )}

      {/* ── MY TRADES (collapsed by default) — seller queue + full history ─── */}
      <Accordion
        title={t("me.accMyTrades")}
        count={myTrades.length || undefined}
      >
        {hasSellerDashboard && (
          <SellerDashboardPanel
            dashboard={dashboard}
            onOpenTrade={onOpenTrade}
            onSellerEditListing={onSellerEditListing}
            onSellerDeleteListing={onSellerDeleteListing}
          />
        )}
        <div style={{ marginTop: hasSellerDashboard ? 16 : 0 }}>
          <MeTradeHistory
            trades={visibleTrades}
            totalCount={myTrades.length}
            counts={tradeCounts}
            activeFilter={tradeFilter}
            onFilter={setTradeFilter}
            pubkey={pubkey}
            onOpenTrade={onOpenTrade}
            onRefreshTrades={onRefreshTrades}
            onRateCounterparty={onRateCounterparty}
            myGivenRatings={myGivenRatings}
            archivedTrades={archivedTrades}
            onOpenArchivedTrade={onOpenArchivedTrade}
          />
        </div>
      </Accordion>

      {/* ── ARBITER (collapsed) — rendered only for an arbiter / pool member ── */}
      {dashboard.arbiterVisible && (
        <Accordion
          title={t("me.accArbiter")}
          count={dashboard.arbiterDisputes.length || undefined}
        >
          <ArbiterDashboardPanel
            dashboard={dashboard}
            onOpenTrade={onOpenTrade}
            viewerPubkey={pubkey}
          />
        </Accordion>
      )}

      {/* ── SETTINGS (collapsed) ────────────────────────────────────────────── */}
      <Accordion title={t("me.accSettings")}>
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 0, overflow: "hidden",
        }}>
          {themeMode && onThemeModeChange && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans }}>
                  {t("me.appearance")}
                </div>
                <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
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
                      onClick={() => onThemeModeChange(mode)}
                      style={{
                        padding: "6px 10px", borderRadius: 999,
                        border: `1px solid ${active ? T.accent + "66" : T.border}`,
                        background: active ? T.accentDim : T.surface,
                        color: active ? T.accent : T.muted,
                        fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <LanguageRow />
          <NotificationsRow />
          <DmNotificationsRow />
          <CounterpartyDmRow />
          <NewListingNotificationsRow />
          <NostrNamesRow on={kind0On} onToggle={() => setKind0On(!kind0On)} />
          {SHOW_BOND_CEREMONY && onOpenBondCeremony && (
            <SettingsRow label={t("me.postYourBond")} hint={t("me.postYourBondHint")} onClick={onOpenBondCeremony} />
          )}
          <SettingsRow label={t("me.paymentMethods")} hint={t("me.paymentMethodsHint")} onClick={onOpenSavedHandles} />
          <SettingsRow label={t("me.lightningAddresses")} hint={t("me.lightningAddressesHint")} onClick={onOpenPayoutDestinations} />
          {onClearUnfundedListings && (unfundedListingCount ?? 0) > 0 && (
            <SettingsRow
              label={t("me.clearListings")}
              hint={t("me.clearListingsHint", { count: unfundedListingCount ?? 0 })}
              onClick={onClearUnfundedListings}
            />
          )}
          <SettingsRow label={t("me.advanced")} hint={t("me.advancedHint")} onClick={onOpenAdvanced} />
          <SettingsRow label={t("me.helpFaq")} hint={t("me.helpFaqHint")} onClick={onOpenHelp} />
        </div>
      </Accordion>

      {/* ── PROFILE & CHAMA (collapsed) — your chama, reputation, sign out ──── */}
      <Accordion title={t("me.accProfileChama")}>
        {onSelectCommunity && (
          <YourChamaCard
            communitySlug={communitySlug ?? null}
            hasActiveCommitment={hasActiveCommitment}
            onSelectCommunity={onSelectCommunity}
            loadLiveness={loadLiveness}
            livenessBlocksPerDay={livenessBlocksPerDay}
          />
        )}

        {/* Ratings — reputation is the backbone primitive; the surface ships
            even before rating events do, so users learn the model. */}
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 12,
          }}>
            {t("me.ratingsTitle")}
          </div>
          {ratings && ratings.count > 0 ? (
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
                  {ratings.count}
                </span>
                <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
                  {ratings.count !== 1 ? t("me.ratingMany") : t("me.ratingOne")}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{
                  fontSize: 16, fontWeight: 700,
                  color: ratings.positive >= ratings.count - ratings.negative ? T.green : T.amber,
                  fontFamily: T.mono,
                }}>
                  {Math.round((ratings.positive / Math.max(ratings.count, 1)) * 100)}%
                </span>
                <span style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
                  {t("me.positive")}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10, fontFamily: T.mono, fontSize: 13 }}>
                <span style={{ color: T.green, fontWeight: 700 }}>👍 {ratings.positive}</span>
                <span style={{ color: T.amber, fontWeight: 700 }}>👎 {ratings.negative}</span>
                <span style={{ color: T.muted, fontSize: 11 }}>{ratings.count !== 1 ? t("me.ratingsFromTradesMany", { count: ratings.count }) : t("me.ratingsFromTradesOne", { count: ratings.count })}</span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, lineHeight: 1.55 }}>
              {t("me.noRatingsYet")}
            </div>
          )}
        </div>

        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 0, overflow: "hidden",
        }}>
          <SettingsRow label={t("me.signOut")} hint={null} onClick={onSignOut} danger />
        </div>
      </Accordion>
    </div>
  );
}

// Simple collapsible section. Closed by default — the Me screen keeps only the
// attention hero + money-safety cards open; everything else lives behind these.
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
          fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.muted,
          letterSpacing: 1, textTransform: "uppercase",
        }}>
          {title}
          {count !== undefined && (
            <span style={{
              fontFamily: T.mono, color: T.text, fontSize: 10, fontWeight: 900,
              padding: "2px 7px", borderRadius: 999,
              background: T.surface, border: `1px solid ${T.border}`,
            }}>
              {count}
            </span>
          )}
        </span>
        <span aria-hidden="true" style={{
          color: T.muted, fontSize: 13, fontFamily: T.mono,
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

type MeTradeCounts = Record<MeTradeFilter, number>;

function MeTradeHistory({
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
  archivedTrades,
  onOpenArchivedTrade,
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
  /** Durable-index trades NOT currently loaded (chain couldn't rehydrate this
   *  session). Rendered as compact "earlier trades" rows so history never
   *  silently shrinks; tapping rehydrates from the community relay. */
  archivedTrades?: TradeIndexEntry[];
  onOpenArchivedTrade?: (id: string) => void;
}) {
  const { t } = useT();
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
            fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, textTransform: "uppercase",
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
            color: T.muted, fontFamily: T.mono, fontSize: 11,
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
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
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
                fontFamily: T.mono, fontSize: 11, fontWeight: 800,
                cursor: "pointer", whiteSpace: "nowrap" as const,
                letterSpacing: 0,
              }}
            >
              {t(filter.labelKey)} {count > 0 ? count : ""}
            </button>
          );
        })}
      </div>

      {totalCount === 0 ? (
        <div style={{
          padding: 24, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11,
        }}>
          {t("me.noTradesYet")}
        </div>
      ) : trades.length === 0 ? (
        <div style={{
          padding: 18, textAlign: "center",
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11,
        }}>
          {t("me.nothingInView")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {trades.map((s, i) => {
            // v1 ratings: a settled-but-UNRATED trade keeps a one-tap thumb in
            // history (the "rate later" path for users who bolt with their sats).
            // Once rated, the tap drops — the slot is replaceable, so it reappears
            // nowhere and double-rating is impossible.
            const ratee = onRateCounterparty && s.status === EscrowStatus.COMPLETED
              ? counterpartyToRate(s, pubkey)
              : null;
            const alreadyRated = ratee
              ? (myGivenRatings ?? []).some(r => r.tradeId === s.id && r.ratee === ratee.toLowerCase())
              : false;
            return (
              <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.05}s both` }}>
                <TradeCard state={s} pubkey={pubkey} onSelect={() => onOpenTrade(s.id)} />
                {/* Safety net Jetty asked for: rate the counterparty straight from
                    history (👍/👎) if you forgot or backed out of the trade. */}
                {ratee && !alreadyRated && onRateCounterparty && (
                  <RatingTap tradeId={s.id} ratee={ratee} onRate={onRateCounterparty} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Loss-proof history: trades remembered in the durable index that the
          relays couldn't rebuild this session. Only under "All" (the full
          history view); compact rows, tappable to attempt rehydration. */}
      {activeFilter === "all" && (archivedTrades?.length ?? 0) > 0 && (
        <div style={{ marginTop: trades.length > 0 ? 16 : 0 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, textTransform: "uppercase", marginBottom: 8,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span>{t("me.earlierTrades")}</span>
            <span style={{ flex: 1, height: 1, background: T.border }} />
            <span style={{ opacity: 0.7 }}>{t("me.fromHistory", { count: archivedTrades!.length })}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {archivedTrades!.map((e) => (
              <ArchivedTradeRow
                key={e.id}
                entry={e}
                onOpen={() => (onOpenArchivedTrade ?? onOpenTrade)(e.id)}
              />
            ))}
          </div>
          <div style={{
            marginTop: 8, fontSize: 9, color: T.muted, fontFamily: T.mono,
            lineHeight: 1.5, opacity: 0.7,
          }}>
            {t("me.rememberedOnDevice")}
          </div>
        </div>
      )}
    </section>
  );
}

/** Compact row for a durable-index trade the relays couldn't rebuild. Shows
 *  the anchors needed to audit it — date, amount, last-known status, id — and
 *  rehydrates the full chain on tap (openEscrow background-loads by id). */
function ArchivedTradeRow({
  entry,
  onOpen,
}: {
  entry: TradeIndexEntry;
  onOpen: () => void;
}) {
  const { t } = useT();
  const when = entry.createdAt > 0
    ? new Date(entry.createdAt * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "—";
  // The compared values ("p2p-trade" etc.) are category ids — data, never
  // translated; only the displayed labels go through the dictionary.
  const cat = entry.category === "p2p-trade" ? t("me.categoryExchange")
    : entry.category === "bill-pay" ? t("me.categoryBillPay")
    : entry.category === "marketplace" ? t("me.categoryMarket")
    : entry.category === "lending" ? t("me.categoryLending")
    : entry.category;
  const statusLabel = entry.lastStatus.charAt(0) + entry.lastStatus.slice(1).toLowerCase();
  return (
    <div
      onClick={onOpen}
      title={t("me.tapToReload")}
      style={{
        display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        padding: "9px 11px", background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: T.rs,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6, marginBottom: 3,
        }}>
          <span style={{ fontFamily: T.sans, fontSize: 12, color: T.text, fontWeight: 600 }}>
            {cat}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
            · {statusLabel}
          </span>
        </div>
        {/* Date prominent (its own line, real weight) — the key audit anchor. */}
        <div style={{
          fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600, marginBottom: 2,
        }}>
          {when}
        </div>
        <div style={{
          fontFamily: T.mono, fontSize: 9, color: T.muted,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
        }}>
          {entry.id}
        </div>
      </div>
      <div style={{ flexShrink: 0, textAlign: "right" as const }}>
        <BitcoinAmount msats={entry.amountMsats} size={13} gap={3} glyphScale={1.15} color={T.text} glyphColor={T.muted} />
      </div>
      <span aria-hidden="true" style={{ flexShrink: 0, color: T.muted, opacity: 0.6, fontFamily: T.mono, fontSize: 12 }}>›</span>
    </div>
  );
}


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

function SellerDashboardPanel({
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
            fontFamily: T.mono, color: T.green, fontSize: 10,
            fontWeight: 900, letterSpacing: 1, textTransform: "uppercase",
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
          fontFamily: T.mono, color: T.muted, fontSize: 10,
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
          tone={T.accent}
          active={queue === "ready"}
          onClick={() => {
            if (dashboard.sellerReadyToLock.length === 0) return;
            setQueue("ready");
          }}
        />
        <DashboardMetric
          label={t("me.queueHolds")}
          value={dashboard.sellerWindowShoppers.length}
          tone={T.amber}
          active={queue === "holds"}
          onClick={() => {
            if (dashboard.sellerWindowShoppers.length === 0) return;
            setQueue("holds");
          }}
        />
        <DashboardMetric
          label={t("me.queueLive")}
          value={dashboard.sellerLive.length}
          tone={T.purple}
          active={queue === "live"}
          onClick={() => {
            if (dashboard.sellerLive.length === 0) return;
            setQueue("live");
          }}
        />
        <DashboardMetric
          label={t("me.queueStock")}
          value={dashboard.sellerInventory.length}
          tone={T.green}
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
}

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
        fontFamily: T.mono,
        color: disabled ? T.muted : tone,
        fontSize: 20,
        fontWeight: 900,
        lineHeight: 1,
        marginBottom: 5,
      }}>
        {value.toLocaleString()}
      </div>
      <div style={{
        fontFamily: T.mono,
        color: value > 0 ? T.text : T.muted,
        fontSize: 9,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: 0.6,
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
        fontFamily: T.mono,
        color: T.muted,
        fontSize: 10,
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
          fontFamily: T.mono,
          color: tone,
          fontSize: 10,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          {t("me.queueHeader", { label: t(SELLER_QUEUE_LABEL_KEY[queue]) })}
        </div>
        <div style={{
          fontFamily: T.mono,
          color: T.muted,
          fontSize: 10,
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
            fontFamily: T.mono,
            color: T.muted,
            fontSize: 10,
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
          <BitcoinAmount
            msats={trade.amountMsats}
            size={12}
            color={sellerQueueTone(queue)}
            gap={4}
            glyphScale={1.18}
          />
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
        fontFamily: T.mono,
        fontSize: 10,
        fontWeight: 900,
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

function ArbiterDashboardPanel({
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
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontFamily: T.mono, color: ROLE_COLOR.arbiter, fontSize: 10,
            fontWeight: 900, letterSpacing: 1, textTransform: "uppercase",
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
          fontFamily: T.mono, color: T.muted, fontSize: 10,
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
}

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
        fontFamily: T.mono,
        color: T.muted,
        fontSize: 10,
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
          fontFamily: T.mono,
          color: tone,
          fontSize: 10,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          {t(ARBITER_QUEUE_LABEL_KEY[queue])}
        </div>
        <div style={{
          fontFamily: T.mono,
          color: T.muted,
          fontSize: 10,
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
            fontFamily: T.mono,
            color: T.muted,
            fontSize: 10,
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
          <BitcoinAmount
            msats={trade.amountMsats}
            size={12}
            color={tone}
            gap={4}
            glyphScale={1.18}
          />
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
      fontFamily: T.mono,
      fontSize: 9,
      color: tone,
      textTransform: "uppercase",
      letterSpacing: 0.4,
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
          fontFamily: T.mono, fontSize: 10, color: T.muted,
          lineHeight: 1.45,
        }}>
          {hint}
        </div>
      </div>
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 7,
        color: tone, fontFamily: T.mono, fontSize: 11, fontWeight: 900,
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
  communitySlug,
  hasActiveCommitment,
  onSelectCommunity,
  loadLiveness,
  livenessBlocksPerDay = 144,
}: {
  communitySlug: string | null;
  hasActiveCommitment: boolean;
  onSelectCommunity: (slug: string) => void;
  loadLiveness?: (slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>;
  livenessBlocksPerDay?: number;
}) {
  const { t } = useT();
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedCountry, setExpandedCountry] = useState<string | null>(null);
  // Your own chama's chain-verified liveness — auto-refreshed (mount, focus, and a
  // gentle poll) so a bond appearing shows up without a manual reload. Fails soft.
  const { liveness, loading: livenessLoading, outcome: livenessOutcome } = useLiveness(communitySlug, loadLiveness, { intervalMs: LIVENESS_POLL_MS });
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
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1,
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
              fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
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
            fontFamily: T.mono, fontSize: 13, fontWeight: 900,
          }}>
            C
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, fontWeight: 600 }}>
            {currentCountryLabel}
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
            {currentCountrySubline}
          </div>
        </div>
        <div style={{ color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 900 }}>
          {t("me.current")}
        </div>
      </div>

      {loadLiveness && (
        <div style={{ marginTop: 12 }}>
          <LivenessSignal liveness={liveness} loading={livenessLoading} outcome={livenessOutcome} blocksPerDay={livenessBlocksPerDay} />
        </div>
      )}

      {hasActiveCommitment && (
        <div style={{
          marginTop: 12, padding: "9px 11px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
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
            color: T.muted, fontFamily: T.mono, marginBottom: 12,
          }}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>⌕</span>
            <input
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
            fontSize: 10, fontWeight: 800, color: T.muted,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
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
                color: T.muted, fontFamily: T.mono, fontSize: 11,
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
                      <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: T.mono, fontSize: 10, color: T.muted }}>
                        {choices.length > 1
                          ? t("me.chamasInCountry", { count: choices.length })
                          : countrySubline(country)}
                      </span>
                    </span>
                    <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 900 }}>
                      {choices.length > 1 ? (open ? "−" : "+") : t("me.switchAction")}
                    </span>
                  </button>
                  {open && choices.map((choice) => {
                    const isCurrent = choice.slug === communitySlug;
                    return (
                      <button
                        key={choice.slug}
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
                          <span style={{ display: "block", marginTop: 2, color: T.muted, fontFamily: T.mono, fontSize: 9 }}>
                            {[choice.disambiguator, choice.currency].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 900 }}>
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
  const arbiterSettled: EscrowState[] = [];
  let arbiterVisible = BLF_OFFICIAL_ARBITERS.includes(lowerPubkey);

  for (const trade of allTrades) {
    const isPoolArbiter = trade.communityArbiters.some((pk) => pk.toLowerCase() === lowerPubkey);
    if (isPoolArbiter) {
      arbiterVisible = true;
    }
    const role = getUserRoleForTrade(trade, pubkey, nowSec);
    const isAssignedArbiter = role === Role.ARBITER;
    const watchesAsArbiter = isAssignedArbiter || isPoolArbiter;

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
    arbiterSettled,
  };
}

function getSellerOrderState(
  trade: EscrowState,
  nowSec: number,
): "inventory" | "hold" | "ready" {
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
    return getWinner(trade)?.pubkey === pubkey;
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

function buildMeTradeCounts(
  trades: EscrowState[],
  needsYou: EscrowState[],
): MeTradeCounts {
  return {
    all: trades.length,
    needs: needsYou.length,
    live: trades.filter(isLiveTrade).length,
    listings: trades.filter(isOpenListing).length,
    done: trades.filter(isDoneTrade).length,
  };
}

function filterMeTrades(
  trades: EscrowState[],
  needsYou: EscrowState[],
  filter: MeTradeFilter,
): EscrowState[] {
  const needsYouIds = new Set(needsYou.map((trade) => trade.id));
  if (filter === "needs") return trades.filter((trade) => needsYouIds.has(trade.id));
  if (filter === "live") return trades.filter(isLiveTrade);
  if (filter === "listings") return trades.filter(isOpenListing);
  if (filter === "done") return trades.filter(isDoneTrade);
  return trades;
}

function isLiveTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.LOCKED ||
    trade.status === EscrowStatus.APPROVED ||
    trade.status === EscrowStatus.CLAIMED
  );
}

function isOpenListing(trade: EscrowState): boolean {
  return trade.status === EscrowStatus.CREATED;
}

function isDoneTrade(trade: EscrowState): boolean {
  return (
    trade.status === EscrowStatus.COMPLETED ||
    trade.status === EscrowStatus.EXPIRED ||
    trade.status === EscrowStatus.CANCELLED
  );
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
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
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
          borderRadius: T.rs, padding: "5px 8px", fontFamily: T.mono, fontSize: 10,
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
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
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
                fontFamily: T.mono, fontSize: 10, fontWeight: 800,
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
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
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
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
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
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
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

function SettingsRow({ label, hint, onClick, danger }: {
  label: string; hint: string | null; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "14px 16px",
        background: "none", border: "none", borderBottom: `1px solid ${T.border}`,
        color: danger ? T.red : T.text,
        cursor: "pointer", textAlign: "left" as const,
        fontFamily: T.sans,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <span style={{ color: T.muted, fontSize: 16 }}>›</span>
    </button>
  );
}
