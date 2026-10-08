import { sameCommunity } from '../../guided/join-eligibility.js';
import { CommunityChip } from "../components/CommunityChip.js";
import { CommunityMismatchNudge } from "../components/CommunityMismatchNudge.js";
import { browseAtTop, scrollBrowseResults, useBrowseArrivals } from "../browse-live.js";
import { browseDiagnostics, type BrowseDiagnosticsContext } from "../browse-diagnostics.js";
import { CopyButton } from "../components/CopyButton.js";
import { filterListingsByCurrency, listingMatchesCurrency } from "../listing-currency.js";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { useMemo, useState, useEffect, useRef } from "react";
import { getScopedStorageItem, setScopedStorageItem } from "../../storage/user-scope.js";
import { type EscrowState } from "../../escrow-engine/types.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { T, ROLE_COLOR, BROWSE_CATS, inputStyle, fmtSats } from "../theme.js";
import { CHAMA_CIRCLES_ENABLED } from "../../escrow-engine/experimental-escrow-features.js";
import { TradeCard } from "../components/TradeCard.js";
import { RailHeader } from "../components/RailHeader.js";
import { groupBySettlementRail, railHeadersNeeded, settlementRailOf } from "../settlement-rail.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import { BOTTOM_NAV_HEIGHT } from "../components/BottomNav.js";
import { ArbiterApplyForm } from "../components/ArbiterApplyForm.js";
import { LoadTradeInput } from "../components/LoadTradeInput.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { type AmountDisplayMode } from "../amount-display.js";
import { getBrowseShowOwn, setBrowseShowOwn, filterOwnListings, countOwnListings } from "../browse-own-filter.js";
import { useT } from "../../i18n/index.js";
import { ReputationReadout } from "../components/ReputationReadout.js";
import type { AggregateRatings } from "../../reputation/ratings.js";
import { workOffersForWorker } from "../work-resume.js";
import { isWorkListing } from "../work-resume.js";

// v4.2.1: the arbiter / recruitment on-ramp is hidden for now — it pushes a
// leader decision at brand-new users before the bond exists. ArbiterApplyForm
// and all arbiter code stay intact; this just gates the FAB entry point. Flip
// back to true when the bond (Phase 2A) lands and the leader pitch is real.
const SHOW_ARBITER_FAB = false;
// v2 intentionally resets the launch defaults once: local Chama + grouped categories.
const BROWSE_SCOPE_KEY = "chama_browse_scope_v2";
const BROWSE_SORT_KEY = "chama_browse_sort_v2";
type BrowseScope = "local" | "all";
type BrowseSort = "default" | "cheapest" | "newest";

// ⭐ Per-npub, like every other Chama preference. These two used to read and
// write RAW localStorage, so a second identity on the same device inherited the
// first one's Browse scope and sort — the cross-identity bleed the user-scope
// module exists to prevent. `getScopedStorageItem` migrates an existing unscoped
// value onto the signed-in npub on first read, so nobody loses the setting they
// already chose; a different identity then starts from the defaults.
//
// ⚠ The DEFAULTS below are correct and deliberate: local Chama + grouped categories. A
// report of "Browse defaults to All" is a persisted tap, not a wrong default —
// do not "fix" it here.
//
// Read once via a lazy `useState` initializer, so there is no
// default-then-stored flicker even if the scope resolves late.
function getBrowseScope(): BrowseScope {
  try {
    const stored = getScopedStorageItem(BROWSE_SCOPE_KEY);
    if (stored === "local" || stored === "all") return stored;
    return "local";
  } catch { return "local"; }
}

function getBrowseSort(): BrowseSort {
  try {
    const stored = getScopedStorageItem(BROWSE_SORT_KEY);
    if (stored === "default" || stored === "cheapest" || stored === "newest") return stored;
    return "default";
  } catch { return "default"; }
}

function persistBrowsePreference(key: string, value: string): void {
  try { setScopedStorageItem(key, value); } catch { /* device-local preference */ }
}

/** Apples-to-apples price rank. Premium is the canonical Exchange quote;
 *  older listings fall back to fiat per sat, then sort after priced offers. */
export function sortListingsCheapestFirst(listings: readonly EscrowState[]): EscrowState[] {
  const rank = (listing: EscrowState): number => {
    if (typeof listing.premiumBps === "number" && Number.isFinite(listing.premiumBps)) {
      return listing.premiumBps;
    }
    if (
      typeof listing.fiatAmount === "number" && Number.isFinite(listing.fiatAmount)
      && listing.amountMsats > 0
    ) return 10_000 + listing.fiatAmount / (listing.amountMsats / 1_000);
    return Number.POSITIVE_INFINITY;
  };
  return [...listings].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export function sortListingsNewestFirst(listings: readonly EscrowState[]): EscrowState[] {
  return [...listings].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

// Browse tab content — category filters, collapsed Chama selector, and card list.
// Per PHILOSOPHY.md §2.3, the community pills are the user's identity
// affordance: tapping one updates chama_community, switches/joins the
// backing federation. v0.1.87 retired the "All communities" pill and
// the per-community filter — pills are identity-only now.
//
// v0.2.0 item 4: two-section layout per chama_browse_amber_tint_sorted.
// Matching listings (on the user's active route) render first as normal
// cards; non-matching listings render below an "N LISTINGS ON OTHER
// ROUTES" divider with amber tint. Tapping a non-matching listing
// triggers the listing-tap dispatch in App.tsx (silent re-init when
// balance==0; destroy-confirm modal when balance>0).
export function BrowseView({
  browseCategory, setBrowseCategory,
  browseCommunity, subscribeListings, onOpenCommunity, suppressCommunityNudge,
  amountDisplayMode,
  matchingListings: suppliedMatching, nonMatchingListings: suppliedNonMatching, allEscrows, circleChildrenLoaded,
  diagnosticsContext,
  stockByListing,
  orderIndicatorByListing,
  fedimintJoined, listingsLoading, pubkey,
  kind0Enabled = false, profileNames,
  isFirstTime, onPasteCustomInvite,
  onOpenEscrow, onLoadById,
  fetchRatingSummary,
  onCreate, onGuided, onApplyAsArbiter,
}: {
  diagnosticsContext?: BrowseDiagnosticsContext;
  browseCategory: string;
  setBrowseCategory: (s: string) => void;
  browseCommunity: string;
  onOpenCommunity?: (country?: string) => void;
  suppressCommunityNudge?: boolean;
  subscribeListings?: (scope: { community?: string; category?: string }) => () => void;
  amountDisplayMode: AmountDisplayMode;
  allEscrows?: readonly EscrowState[];
  circleChildrenLoaded?: ReadonlySet<string>;
  matchingListings: EscrowState[];
  nonMatchingListings: EscrowState[];
  /** #7 Stage 3: derived "N left" per multi-unit parent listing id. */
  stockByListing?: Map<string, number>;
  /** #70 per-parent live child-order count + aggregated unread chat, so a
   *  seller's storefront card surfaces ALL its orders, not just its own chat. */
  orderIndicatorByListing?: Map<string, { orders: number; unread: number; viewerOrderId?: string }>;
  fedimintJoined: boolean;
  listingsLoading: boolean;
  pubkey: string;
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  isFirstTime: boolean;
  onPasteCustomInvite: (invite: string) => void | Promise<void>;
  onOpenEscrow: (id: string) => void;
  onLoadById: (id: string) => void | Promise<void>;
  fetchRatingSummary?: (ratee: string) => Promise<AggregateRatings>;
  /** S4: the primary pencil opens Assisted Chama. The full editor remains
   *  reachable from the canvas through its explicit More options door. */
  onCreate: () => void;
  /** v7 redesign: leave the advanced "All listings" view for the guided canvas. */
  onGuided?: () => void;
  onApplyAsArbiter: (community: string, statement: string) => Promise<void>;
}) {
  const resultsHeader = useRef<HTMLDivElement>(null);
  const emptyResult = useRef<HTMLDivElement>(null);
  const userFilterTap = useRef(false);
  const [lastFilterLabel, setLastFilterLabel] = useState<string | null>(null);
  const [otherCurrencies, setOtherCurrencies] = useState(false);
  const viewerCurrency = defaultCurrencyForCommunity(browseCommunity);
  const matchingListings = useMemo(() => filterListingsByCurrency(suppliedMatching, viewerCurrency, otherCurrencies), [suppliedMatching, viewerCurrency, otherCurrencies]);
  const nonMatchingListings = useMemo(() => filterListingsByCurrency(suppliedNonMatching, viewerCurrency, otherCurrencies), [suppliedNonMatching, viewerCurrency, otherCurrencies]);
  const { t } = useT();
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showRecruit, setShowRecruit] = useState(false);
  const [customInviteInput, setCustomInviteInput] = useState("");
  const [resumePubkey, setResumePubkey] = useState<string | null>(null);
  // Mutually-exclusive Browse modes: public listings (default, mine hidden) or
  // My listings only. Selecting owner mode intentionally hides everything else.
  const [showOwn, setShowOwnState] = useState<boolean>(() => getBrowseShowOwn());
  const toggleShowOwn = () => setShowOwnState((v) => { const next = !v; setBrowseShowOwn(next); return next; });
  // The category the user was on when they entered owner mode, so leaving it
  // returns them to that shelf instead of dumping them in "all". A category
  // chip clears owner mode itself (it is the same mutually-exclusive row), so
  // this is only read by the ★ chip's own off-tap.
  const [categoryBeforeOwn, setCategoryBeforeOwn] = useState<string>("all");
  const [browseScope, setBrowseScopeState] = useState<BrowseScope>(() => getBrowseScope());
  const [browseSort, setBrowseSortState] = useState<BrowseSort>(() => getBrowseSort());
  const setBrowseScope = (scope: BrowseScope) => {
    userFilterTap.current = scope !== browseScope;
    setLastFilterLabel(t(scope === "local" ? "browse.scopeLocal" : "browse.scopeAll"));
    setBrowseScopeState(scope);
    persistBrowsePreference(BROWSE_SCOPE_KEY, scope);
  };
  const setBrowseSort = (sort: BrowseSort) => {
    userFilterTap.current = sort !== browseSort;
    setLastFilterLabel(t(sort === "cheapest" ? "browse.sortCheapest" : sort === "newest" ? "browse.sortNewest" : "browse.sortDefault"));
    setBrowseSortState(sort);
    persistBrowsePreference(BROWSE_SORT_KEY, sort);
  };

  // v3.1.1: fade the floating action menu down while the list is scrolling so it
  // never sits opaque over a card the user is reading; back to full ~300ms after
  // they stop. `capture: true` makes window receive the scroll event no matter
  // which element actually scrolls (scroll doesn't bubble but DOES capture), so
  // the fade is robust whether the window or some inner container is the scroller.
  const [menuScrolling, setMenuScrolling] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      setMenuScrolling(true);
      if (t) clearTimeout(t);
      t = setTimeout(() => setMenuScrolling(false), 300);
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => { window.removeEventListener("scroll", onScroll, true); if (t) clearTimeout(t); };
  }, []);

  // Own-listing hide (default) happens BEFORE search/section grouping so counts
  // and empty-states reflect what the viewer actually sees.
  const search = searchQuery.trim().toLowerCase();
  const otherCurrencyCount = ([...suppliedMatching, ...suppliedNonMatching].filter(l => browseScope !== "local" || sameCommunity(l.community, browseCommunity)))
    .filter(l => !listingMatchesCurrency(l, viewerCurrency) && listingMatchesSearch(l, search)).length;
  const scopedMatching = [...matchingListings, ...nonMatchingListings].filter(l => sameCommunity(l.community, browseCommunity) && listingMatchesSearch(l, search));
  const scopedNonMatching = [...matchingListings, ...nonMatchingListings].filter(l => !sameCommunity(l.community, browseCommunity) && listingMatchesSearch(l, search));
  const hasOwnListings = countOwnListings(matchingListings, pubkey) + countOwnListings(nonMatchingListings, pubkey) > 0;
  const ownListingCount = countOwnListings(scopedMatching, pubkey)
    + (browseScope === "all" ? countOwnListings(scopedNonMatching, pubkey) : 0);
  const categoryMatching = filterOwnListings(scopedMatching, pubkey, false);
  const categoryNonMatching = browseScope === "all" ? filterOwnListings(scopedNonMatching, pubkey, false) : [];
  const visibleCategoryChips = BROWSE_CATS.filter(c => c.id !== "all" && (CHAMA_CIRCLES_ENABLED || c.id !== "chama"))
    .filter(c => countListingsByCategory(categoryMatching, categoryNonMatching, c.id) > 0);
  const showCategoryChips = visibleCategoryChips.length + (ownListingCount > 0 ? 1 : 0) > 1;

  // A persisted Mine preference should not strand a returning user on an empty
  // feed. Wait until discovery settles, then fall back to All when they own 0.
  useEffect(() => {
    if (!listingsLoading && showOwn && !hasOwnListings) {
      setShowOwnState(false);
      setBrowseShowOwn(false);
    }
  }, [listingsLoading, showOwn, hasOwnListings]);
  const ownHiddenCount = showOwn ? 0 : ownListingCount;
  const ownFilteredMatching = useMemo(
    () => filterOwnListings(matchingListings, pubkey, showOwn),
    [matchingListings, pubkey, showOwn],
  );
  const ownFilteredNonMatching = useMemo(
    () => filterOwnListings(nonMatchingListings, pubkey, showOwn),
    [nonMatchingListings, pubkey, showOwn],
  );
  const routedMatching = useMemo(
    () => browseSort === "default" ? ownFilteredMatching : browseSort === "cheapest"
      ? sortListingsCheapestFirst(ownFilteredMatching)
      : sortListingsNewestFirst(ownFilteredMatching),
    [browseSort, ownFilteredMatching],
  );
  const routedNonMatching = useMemo(
    () => browseScope === "local"
      ? []
      : browseSort === "default" ? ownFilteredNonMatching : browseSort === "cheapest"
        ? sortListingsCheapestFirst(ownFilteredNonMatching)
        : sortListingsNewestFirst(ownFilteredNonMatching),
    [browseScope, browseSort, ownFilteredNonMatching],
  );
  const localScopeCount = scopedMatching.length;
  const allScopeCount = localScopeCount + scopedNonMatching.length;
  const totalListings = routedMatching.length + routedNonMatching.length;
  const homeCommunity = getCommunityBySlug(browseCommunity);
  useEffect(() => setOtherCurrencies(false), [browseCommunity, pubkey]);
  const candidateMatchingListings = useMemo(
    () => routedMatching.filter((listing) => listingMatchesSearch(listing, search) && (showOwn || browseCategory === "all" || countListingsByCategory([listing], [], browseCategory) > 0)),
    [routedMatching, search, browseCategory, showOwn],
  );
  const candidateNonMatchingListings = useMemo(
    () => routedNonMatching.filter((listing) => listingMatchesSearch(listing, search) && (showOwn || browseCategory === "all" || countListingsByCategory([listing], [], browseCategory) > 0)),
    [routedNonMatching, search, browseCategory, showOwn],
  );
  const filterKey = JSON.stringify([pubkey, browseCommunity, browseCategory, browseScope, browseSort, showOwn, search, otherCurrencies]);
  const live = useBrowseArrivals(filterKey, [...candidateMatchingListings, ...candidateNonMatchingListings], resultsHeader);
  const matchingIds = new Set(candidateMatchingListings.map(l => l.id));
  const filteredMatchingListings = live.visible.filter(l => matchingIds.has(l.id));
  const filteredNonMatchingListings = live.visible.filter(l => !matchingIds.has(l.id));
  // The app-wide feed keeps off-filter counts current. This mounted scope has
  // its own subscription lifetime; all events still use the engine's validators.
  const subscribeRef = useRef(subscribeListings);
  subscribeRef.current = subscribeListings;
  useEffect(() => subscribeRef.current?.({ community: browseScope === "local" ? browseCommunity : undefined,
    category: showOwn || browseCategory === "all" ? undefined : browseCategory }), [browseCommunity, browseCategory, browseScope, showOwn, !!subscribeListings]);
  useEffect(() => {
    if (!userFilterTap.current) return;
    userFilterTap.current = false;
    scrollBrowseResults(emptyResult.current ?? resultsHeader.current);
  }, [filterKey]);
  useEffect(() => {
    if (live.pending.length === 0) return;
    const revealAtTop = () => { if (browseAtTop(resultsHeader.current)) live.flush(); };
    window.addEventListener("scroll", revealAtTop, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", revealAtTop, true);
  }, [live.pending.length]);
  // Explicit orders span every visible category AND route. Grouping after
  // sorting would silently undo the user's choice (even one card per category).
  const orderedVisibleListings = useMemo(() => {
    const visible = [...filteredMatchingListings, ...filteredNonMatchingListings];
    return browseSort === "cheapest" ? sortListingsCheapestFirst(visible) : sortListingsNewestFirst(visible);
  }, [browseSort, filteredMatchingListings, filteredNonMatchingListings]);
  const nonMatchingIds = new Set(filteredNonMatchingListings.map(listing => listing.id));
  // Runway #15: settlement-rail grouping for the flat (per-category) lists.
  // The "all" shelves group inside BrowseSection instead.
  const matchingRailGroups = useMemo(
    () => groupBySettlementRail(filteredMatchingListings, l => settlementRailOf(l.escrowMode)),
    [filteredMatchingListings],
  );
  const nonMatchingRailGroups = useMemo(
    () => groupBySettlementRail(filteredNonMatchingListings, l => settlementRailOf(l.escrowMode)),
    [filteredNonMatchingListings],
  );
  const matchingSections = useMemo(
    () => groupListingsByVertical(filteredMatchingListings),
    [filteredMatchingListings],
  );
  const nonMatchingSections = useMemo(
    () => groupListingsByVertical(filteredNonMatchingListings),
    [filteredNonMatchingListings],
  );
  const filteredTotal = filteredMatchingListings.length + filteredNonMatchingListings.length;
  const emptyFilter = filteredTotal === 0 && live.pending.length === 0 && !!(search || lastFilterLabel || browseCategory !== "all" || showOwn || otherCurrencies);
  const browseSummary = totalListings === 0
    ? (listingsLoading ? t("browse.verifyingOffers") : t("browse.noOpenOffers"))
    : t(totalListings === 1 ? "browse.openOfferSummaryOne" : "browse.openOfferSummaryMany", {
        filtered: filteredTotal.toLocaleString(),
        total: totalListings.toLocaleString(),
      });
  const quoteCurrency = homeCommunity?.currency ?? null;
  const resumeOffers = useMemo(() => {
    if (!resumePubkey) return [];
    return workOffersForWorker([...matchingListings, ...nonMatchingListings], resumePubkey);
  }, [matchingListings, nonMatchingListings, resumePubkey]);

  return (
    // Same readable column as Me: wide enough to use a desktop, capped so a
    // listing row never becomes a stretched line of text.
    <div style={{ padding: 16, maxWidth: 760, margin: "0 auto" }}>
      {onOpenCommunity && <CommunityMismatchNudge key={browseCommunity} slug={browseCommunity} suppressed={suppressCommunityNudge} onOpen={onOpenCommunity} />}
      {resumePubkey && (
        <WorkerResume
          pubkey={resumePubkey}
          offers={resumeOffers}
          name={profileNameFor(profileNames, resumePubkey, kind0Enabled)}
          fetchRatingSummary={fetchRatingSummary}
          onClose={() => setResumePubkey(null)}
          onOpenOffer={(id) => {
            setResumePubkey(null);
            onOpenEscrow(id);
          }}
        />
      )}
      {/* v3.1.1: blur the listings behind the menu while the arbiter application
          form is open, to focus attention on it. The FAB stack (zIndex 80) and
          the toast sit ABOVE this backdrop (79) and stay crisp; tapping the
          backdrop dismisses the form. */}
      {showRecruit && (
        <div
          onClick={() => setShowRecruit(false)}
          aria-hidden="true"
          style={{
            position: "fixed", inset: 0, zIndex: 79,
            background: "rgba(0,0,0,0.35)",
            backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
            animation: "fadeIn 0.2s ease",
          }}
        />
      )}
      {/* v3.1.1 floating action menu — a vertical FAB stack pinned to the
          listings column's bottom-right, floating OVER the cards (never in the
          header) and clear of the 64px bottom tab bar. `right` is column-edge
          aware (hugs the 520px column on wide viewports, 16px on mobile).
          Fades to half opacity while scrolling so it never hides a listing. */}
      <div style={{
        position: "fixed", zIndex: 80,
        right: "calc((100vw - min(100vw, 520px)) / 2 + 16px)",
        bottom: `calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px) + 16px)`,
        display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 14,
        // fade while scrolling — but never while the application form is open.
        opacity: (menuScrolling && !showRecruit) ? 0.35 : 1,
        transition: "opacity 0.2s ease",
      }}>
        {SHOW_ARBITER_FAB && showRecruit && (
          <div style={{
            width: 300, maxWidth: "calc(100vw - 32px)", marginBottom: 2,
            padding: "14px 16px", maxHeight: "min(72vh, 480px)", overflowY: "auto",
            background: T.card, border: `1px solid ${ROLE_COLOR.arbiter}55`,
            borderRadius: T.r, boxShadow: "0 12px 34px rgba(0,0,0,0.6)",
            textAlign: "left",
          }}>
            {/* v3.1.1: the arbiter application form lives inline here — apply
                without leaving Browse (it no longer exists in Me). */}
            <ArbiterApplyForm
              communitySlug={browseCommunity}
              onApply={onApplyAsArbiter}
              onClose={() => setShowRecruit(false)}
            />
          </div>
        )}
        {/* arbiter recruitment (secondary) — v4.2.1: hidden until the bond
            (Phase 2A) makes the leader pitch real; gate flips it back on. */}
        {SHOW_ARBITER_FAB && (
        <button
          type="button" onClick={() => setShowRecruit(s => !s)}
          data-coach="fab-arbiter"
          title={t("browse.becomeArbiterTitle")} aria-label={t("browse.arbiterRecruitment")}
          style={{
            width: 50, height: 50, borderRadius: "50%", flexShrink: 0,
            background: ROLE_COLOR.arbiter, border: "none", color: "#fff",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: showRecruit
              ? `0 0 0 4px ${ROLE_COLOR.arbiter}44, 0 8px 20px rgba(0,0,0,0.5)`
              : "0 8px 20px rgba(0,0,0,0.5)",
            transition: "box-shadow 0.2s ease",
          }}
        >
          <svg width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 20l10 0" /><path d="M6 6l6 -1l6 1" /><path d="M12 3l0 17" />
            <path d="M9 12l-3 -6l-3 6a3 3 0 0 0 6 0" /><path d="M21 12l-3 -6l-3 6a3 3 0 0 0 6 0" />
          </svg>
        </button>
        )}
        {/* v7 redesign: Create moved to the shell — "+" in the top bar, an
            extended FAB on Android, the sidebar button on wide screens. */}
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        marginBottom: 16,
        gap: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{
            margin: 0, color: T.ink, fontFamily: T.sans,
            fontSize: T.fs.largeTitle, lineHeight: 1.15, fontWeight: 700, letterSpacing: "-0.02em",
          }}>
            {t("browse.allListings")}
          </h1>
          {onGuided && (
            <button type="button" onClick={onGuided} style={{
              marginTop: 6, minHeight: 40, padding: 0, background: "none", border: "none", cursor: "pointer",
              color: T.ink2, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
              textDecoration: "underline", textUnderlineOffset: 3,
            }}>{t("browse.guidedView")}</button>
          )}

        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {/* v3.1.1: the create + arbiter on-ramps moved out of the header into
              the floating action menu (FAB stack) rendered at the screen root. */}
          <CommunityChip slug={browseCommunity} onOpen={onOpenCommunity ? () => onOpenCommunity() : undefined} />
        </div>
      </div>

      {/* (arbiter-recruitment card now lives in the floating menu at the root) */}

      <div style={{
        display: "flex", gap: 8, alignItems: "center",
        marginBottom: 10,
      }}>
        <label style={{
          flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8,
          padding: "10px 12px", borderRadius: T.rs, background: T.surface,
          border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.sans,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>⌕</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("browse.searchPlaceholder")}
            style={{
              flex: 1, minWidth: 0, background: "transparent", border: "none",
              outline: "none", color: T.text, fontFamily: T.sans,
              fontSize: 14, letterSpacing: 0,
            }}
          />
        </label>
      </div>

      <div style={{ minHeight: 42 }}>
      {(otherCurrencyCount > 0 || otherCurrencies) && <button type="button" aria-pressed={otherCurrencies}
        onClick={() => { userFilterTap.current = true; setLastFilterLabel(t("browse.otherCurrencies", { count: otherCurrencyCount })); setOtherCurrencies(value => !value); }}
        style={{ marginBottom: 12, padding: "7px 11px", borderRadius: 18, cursor: "pointer",
          background: otherCurrencies ? T.accentDim : T.surface, color: otherCurrencies ? T.accent : T.muted,
          border: `1px solid ${T.border}`, fontFamily: T.sans, fontSize: T.fs.secondary }}>
        {t("browse.otherCurrencies", { count: otherCurrencyCount })}
      </button>}
      </div>
      <div style={{
        // Side by side where they fit; stacked on phones at the larger type.
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginBottom: 12,
      }} data-coach="browse-preferences">
        <BrowsePreferenceControl
          label={t("browse.scope")}
          value={browseScope}
          options={[["local", t("browse.scopeLocal"), localScopeCount], ["all", t("browse.scopeAll"), allScopeCount]]}
          onChange={(value) => setBrowseScope(value as BrowseScope)}
        />
        <BrowsePreferenceControl
          label={t("browse.sort")}
          value={browseSort}
          options={[["default", t("browse.sortDefault")], ["cheapest", t("browse.sortCheapest")], ["newest", t("browse.sortNewest")]]}
          onChange={(value) => setBrowseSort(value as BrowseSort)}
        />
      </div>

      {browseScope === "all" && <p style={{fontSize:11, color:T.muted, marginTop:0}}>{t("browse.allExcludesMine")}</p>}

      <div style={{ minHeight: 52 }}>
      {showCategoryChips && <div data-browse-category-row style={{
        display: "flex", gap: 6, marginBottom: 12,
        overflowX: "auto",
        scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as const,
        paddingBottom: 2,
      }}>
        {ownListingCount > 0 && (
          <button
            type="button"
            onClick={() => {
              userFilterTap.current = true;
              setLastFilterLabel(t(showOwn ? BROWSE_CATS.find(c => c.id === categoryBeforeOwn)?.l ?? "browse.catAll" : "browse.mine"));
              // The chip advertises toggle semantics (aria-pressed, and it lights
              // up like the category chips beside it), so a second tap has to turn
              // owner mode OFF. Turning it on stashes the shelf we came from;
              // turning it off restores it.
              if (showOwn) {
                toggleShowOwn();
                setBrowseCategory(categoryBeforeOwn);
              } else {
                setCategoryBeforeOwn(browseCategory);
                toggleShowOwn();
                setBrowseCategory("all");
              }
            }}
            data-browse-category="mine" data-count={ownListingCount}
            aria-pressed={showOwn}
            style={{
              order: -1,
              flexShrink: 0,
              padding: "7px 11px", borderRadius: 18,
              background: showOwn ? T.accentDim : T.surface,
              border: `1px solid ${showOwn ? T.accent + "66" : T.border}`,
              color: showOwn ? T.accent : T.muted,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
              cursor: "pointer", transition: "all 0.15s",
              whiteSpace: "nowrap" as const,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            <span>★</span>
            <span>{t("browse.mine")}</span>
            <span style={{
              color: showOwn ? T.bg : T.muted,
              background: showOwn ? T.accent : T.card,
              border: `1px solid ${showOwn ? T.accent : T.border}`,
              borderRadius: 999, padding: "1px 5px", fontSize: 9, lineHeight: 1.2,
            }}>{ownListingCount}</span>
          </button>
        )}
        {visibleCategoryChips.map(c => {
          const active = !showOwn && browseCategory === c.id;
          // Mine and the public shelves partition the scoped search results.
          const count = countListingsByCategory(categoryMatching, categoryNonMatching, c.id);
          return (
            <button
              key={c.id} data-browse-category={c.id} data-count={count}
              onClick={() => {
                userFilterTap.current = true;
                setLastFilterLabel(t(active ? "browse.catAll" : c.l));
                if (showOwn) toggleShowOwn();
                setBrowseCategory(active ? "all" : c.id);
              }}
              style={{
                order: 1,
                flexShrink: 0,
                padding: "7px 11px", borderRadius: 18,
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                color: active ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: "pointer", transition: "all 0.15s",
                whiteSpace: "nowrap" as const,
                letterSpacing: 0,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              <VerticalIcon vertical={c.id} size={18} />
              <span>{t(c.l)}</span>
              <span style={{
                color: active ? T.bg : T.muted,
                background: active ? T.accent : T.card,
                border: `1px solid ${active ? T.accent : T.border}`,
                borderRadius: 999,
                padding: "1px 5px",
                fontSize: 9,
                lineHeight: 1.2,
              }}>
                {count}
              </span>
            </button>
          );
        })}

      </div>}

      </div>
      <style>{`@keyframes browse-arrive { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } } .browse-arrival-card { animation: browse-arrive .2s ease-out; } @media (prefers-reduced-motion: reduce) { .browse-arrival-card { animation: none; } }`}</style>
      <div ref={resultsHeader} data-browse-results style={{ scrollMarginTop: 12, minHeight: 42, display: "flex", alignItems: "center" }}>
        {live.pending.length > 0 ? <button type="button" data-new-listings onClick={() => { live.flush(); scrollBrowseResults(resultsHeader.current, true); }} style={{ padding: "7px 12px", borderRadius: 999, border: `1px solid ${T.accent}`, background: T.accentDim, color: T.accent, cursor: "pointer" }}>
          {t(live.pending.length === 1 ? "browse.newListingOne" : "browse.newListingMany", { n: live.pending.length })}
        </button> : <span style={{ color: T.muted, fontSize: 12 }}>{browseSummary}</span>}
      </div>
      {emptyFilter && <div ref={emptyResult} data-browse-empty style={{ padding: 24, background: T.surface, color: T.muted, borderRadius: T.rs, marginBottom: 14 }}>
        {t("browse.emptyFilter", { filter: [lastFilterLabel ?? (showOwn ? t("browse.mine") : t(BROWSE_CATS.find(c => c.id === browseCategory)?.l ?? "browse.scopeAll")), searchQuery.trim()].filter(Boolean).join(" · ") })}
      </div>}

      {totalListings === 0 && !emptyFilter ? (
        <div style={{
          textAlign: "center", padding: "44px 20px", fontFamily: T.sans,
        }}>
          {listingsLoading ? (
            <>
              <div style={{
                width: 30, height: 30, margin: "0 auto 16px", borderRadius: "50%",
                border: `3px solid ${T.border}`, borderTopColor: T.accent,
                animation: "spin 0.8s linear infinite",
              }} />
              <div style={{ fontSize: 16, fontWeight: 800, color: T.text, marginBottom: 8 }}>
                {t("browse.verifyingOffers")}
              </div>
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6, maxWidth: 300, margin: "0 auto" }}>
                {t("browse.verifyingOffersBody")}
              </div>
            </>
          ) : fedimintJoined ? (
            !showOwn && ownHiddenCount > 0 ? (
              // #75: the only offers here are the viewer's OWN, hidden by
              // default — don't claim the community is empty. Point them at the
              // reveal toggle instead of "be the first to post".
              <>
                <div style={{ fontSize: 40, marginBottom: 14, lineHeight: 1 }}>🙈</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: T.text, marginBottom: 8 }}>
                  {t("browse.ownHiddenTitle")}
                </div>
                <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6, maxWidth: 300, margin: "0 auto" }}>
                  {t("browse.ownHiddenBody", { count: ownHiddenCount })}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 40, marginBottom: 14, lineHeight: 1 }}>🤝</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: T.text, marginBottom: 8 }}>
                  {t("browse.beFirstTitle")}
                </div>
                <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6, maxWidth: 300, margin: "0 auto" }}>
                  {t("browse.beFirstBodyBefore")}{" "}
                  <strong style={{ color: T.accent }}>{t("browse.beFirstCreate")}</strong>{" "}
                  {t("browse.beFirstBodyAfter")}
                </div>
              </>
            )
          ) : (
            <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
              {homeCommunity
                ? t("browse.reconnectTo", { community: homeCommunity.disambiguator ?? homeCommunity.displayName })
                : t("browse.pickChama")}
            </div>
          )}
        </div>
      ) : browseSort !== "default" ? (
        <div data-browse-order={browseSort} style={{display:"flex",flexDirection:"column",gap:10}}>
          {orderedVisibleListings.map(listing => <div key={listing.id} data-listing-id={listing.id}>
            <TradeCard state={listing} pubkey={pubkey} allEscrows={allEscrows}
              circleChildrenLoaded={circleChildrenLoaded}
              onSelect={() => onOpenEscrow(listing.id)}
              variant={nonMatchingIds.has(listing.id) ? "non-matching" : "matching"}
              kind0Enabled={kind0Enabled} profileNames={profileNames}
              amountDisplayMode={amountDisplayMode} quoteCurrency={quoteCurrency}
              stockLeft={stockByListing?.get(listing.id)}
              orderIndicator={orderIndicatorByListing?.get(listing.id)}
              onResumeOrder={onOpenEscrow} onOpenWorkerProfile={setResumePubkey}
              showCommunityChip={browseScope === "all"} />
          </div>)}
        </div>
      ) : (
        <>
          {/* Matching listings — normal styling */}
          {filteredMatchingListings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {browseCategory === "all" ? (
                matchingSections.map(section => (
                  <BrowseSection
                    key={section.id}
                    section={section}
                    pubkey={pubkey}
                    onOpenEscrow={onOpenEscrow}
                    kind0Enabled={kind0Enabled}
                    profileNames={profileNames}
                    amountDisplayMode={amountDisplayMode}
                    quoteCurrency={quoteCurrency}
                    stockByListing={stockByListing}
                    allEscrows={allEscrows}
                    circleChildrenLoaded={circleChildrenLoaded}
                    orderIndicatorByListing={orderIndicatorByListing}
                    onOpenWorkerProfile={setResumePubkey}
                    showCommunityChip={browseScope === "all"}
                  />
                ))
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Runway #15: results read in settlement-rail groups, never
                      mixed flat, the moment more than one world is present. */}
                  {matchingRailGroups.flatMap(group => [
                    ...(railHeadersNeeded(matchingRailGroups)
                      ? [<RailHeader key={`rail-${group.rail}`} rail={group.rail} count={group.items.length} />]
                      : []),
                    ...group.items.map((s, i) => (
                    <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                      <TradeCard
                        allEscrows={allEscrows}
                        circleChildrenLoaded={circleChildrenLoaded}
                        state={s}
                        pubkey={pubkey}
                        onSelect={() => onOpenEscrow(s.id)}
                        kind0Enabled={kind0Enabled}
                        profileNames={profileNames}
                        amountDisplayMode={amountDisplayMode}
                        quoteCurrency={quoteCurrency}
                        stockLeft={stockByListing?.get(s.id)}
                        orderIndicator={orderIndicatorByListing?.get(s.id)}
                        onResumeOrder={onOpenEscrow}
                        onOpenWorkerProfile={setResumePubkey}
                        showCommunityChip={browseScope === "all"}
                      />
                    </div>
                    )),
                  ])}
                </div>
              )}
            </div>
          )}

          {/* "N LISTINGS ON OTHER FEDERATIONS" divider + amber-tinted
              non-matching cards. Tap → listing-tap dispatch handles
              the silent switch (or destroy-confirm modal). */}
          {filteredNonMatchingListings.length > 0 && (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                margin: "16px 0 12px",
              }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <div style={{
                  fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
                  whiteSpace: "nowrap" as const,
                }}>
                  {t(filteredNonMatchingListings.length === 1 ? "browse.otherCommunitiesOne" : "browse.otherCommunitiesMany", { count: filteredNonMatchingListings.length })}
                </div>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
              {browseCategory === "all" ? (
                nonMatchingSections.map(section => (
                  <BrowseSection
                    key={section.id}
                    section={section}
                    pubkey={pubkey}
                    onOpenEscrow={onOpenEscrow}
                    variant="non-matching"
                    kind0Enabled={kind0Enabled}
                    profileNames={profileNames}
                    amountDisplayMode={amountDisplayMode}
                    quoteCurrency={quoteCurrency}
                    stockByListing={stockByListing}
                    allEscrows={allEscrows}
                    circleChildrenLoaded={circleChildrenLoaded}
                    orderIndicatorByListing={orderIndicatorByListing}
                    onOpenWorkerProfile={setResumePubkey}
                    showCommunityChip={browseScope === "all"}
                  />
                ))
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {nonMatchingRailGroups.flatMap(group => [
                    ...(railHeadersNeeded(nonMatchingRailGroups)
                      ? [<RailHeader key={`rail-${group.rail}`} rail={group.rail} count={group.items.length} />]
                      : []),
                    ...group.items.map((s, i) => (
                    <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                      <TradeCard
                        allEscrows={allEscrows}
                        circleChildrenLoaded={circleChildrenLoaded}
                        state={s}
                        pubkey={pubkey}
                        onSelect={() => onOpenEscrow(s.id)}
                        variant="non-matching"
                        kind0Enabled={kind0Enabled}
                        profileNames={profileNames}
                        amountDisplayMode={amountDisplayMode}
                        quoteCurrency={quoteCurrency}
                        stockLeft={stockByListing?.get(s.id)}
                        orderIndicator={orderIndicatorByListing?.get(s.id)}
                        onResumeOrder={onOpenEscrow}
                        onOpenWorkerProfile={setResumePubkey}
                        showCommunityChip={browseScope === "all"}
                      />
                    </div>
                    )),
                  ])}
                </div>
              )}
            </>
          )}
        </>
      )}

      <div style={{ marginTop: 20, fontFamily: T.sans }}>
        <button
          onClick={() => setShowAdvancedTools((v) => !v)}
          style={{
            background: "none", border: "none", padding: 0,
            color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {showAdvancedTools ? "▲" : "▼"} {t("browse.advancedTools")}
        </button>
        {showAdvancedTools && (
          <div style={{
            marginTop: 10, padding: 12, background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.border}`,
          }}>
            {diagnosticsContext && <CopyButton label={t("browse.copyDiagnostics")} copiedLabel={t("common.copied")}
              value={JSON.stringify(browseDiagnostics({...diagnosticsContext, viewer:pubkey, community:browseCommunity,
                currency:viewerCurrency, scope:browseScope, category:browseCategory, search:searchQuery,
                otherCurrencies, mine:showOwn, states:allEscrows ?? [...suppliedMatching,...suppliedNonMatching],
                visibleIds:new Set([...filteredMatchingListings,...filteredNonMatchingListings].map(l=>l.id)),
                matchingIds:new Set(suppliedMatching.map(l=>l.id)), currencyIds:new Set([...matchingListings,...nonMatchingListings].map(l=>l.id)),
                searchIds:new Set([...scopedMatching,...scopedNonMatching].map(l=>l.id))}),null,2)} />}
            {isFirstTime && (
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <input
                  type="text"
                  placeholder="fed1…"
                  value={customInviteInput}
                  onChange={(e) => setCustomInviteInput(e.target.value)}
                  style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                />
                <button
                  disabled={!customInviteInput.trim().startsWith("fed1")}
                  onClick={() => {
                    const v = customInviteInput.trim();
                    if (!v) return;
                    setCustomInviteInput("");
                    setShowAdvancedTools(false);
                    void onPasteCustomInvite(v);
                  }}
                  style={{
                    padding: "8px 14px", borderRadius: T.rs,
                    background: customInviteInput.trim().startsWith("fed1") ? T.accentDim : T.surface,
                    border: `1px solid ${customInviteInput.trim().startsWith("fed1") ? T.accent + "44" : T.border}`,
                    color: customInviteInput.trim().startsWith("fed1") ? T.accent : T.muted,
                    fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
                    cursor: customInviteInput.trim().startsWith("fed1") ? "pointer" : "not-allowed",
                    whiteSpace: "nowrap" as const,
                  }}
                >
                  {t("browse.join")}
                </button>
              </div>
            )}
            <LoadTradeInput onLoad={onLoadById} />
            <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, lineHeight: 1.7, textAlign: "center" }}>
              {t("browse.advancedFooterLine1")}<br />
              {t("browse.advancedFooterLine2")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function listingMatchesSearch(listing: EscrowState, query: string): boolean {
  if (!query) return true;
  const community = listing.community ? getCommunityBySlug(listing.community) : null;
  const haystack = [
    listing.description,
    listing.category,
    listing.fulfillment,
    listing.fiatCurrency,
    listing.fiatAmount?.toString(),
    community?.displayName,
    community?.disambiguator,
    community?.currency,
    Math.floor(listing.amountMsats / 1000).toString(),
    ...(listing.items ?? []).flatMap(item => [
      item.label,
      item.description,
      item.fiatCurrency,
      item.fiatAmount?.toString(),
      item.kind,
      item.fulfillment,
      item.minAmountMsats ? Math.floor(item.minAmountMsats / 1000).toString() : undefined,
      item.maxAmountMsats ? Math.floor(item.maxAmountMsats / 1000).toString() : undefined,
      item.dueAt ? new Date(item.dueAt * 1000).toLocaleDateString() : undefined,
      item.termDays?.toString(),
      item.trustTier?.toString(),
      Math.floor(item.amountMsats / 1000).toString(),
    ]),
  ]
    .filter((part): part is string => !!part)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

interface BrowseListingSection {
  id: string;
  label: string;
  listings: EscrowState[];
}

/** Shelves in pole-position order: the vertical holding the most live offers
 *  leads (ties keep BROWSE_CATS order), and empty ones were already dropped.
 *  Same instinct as the chip row — what is alive is what you see first. */
function groupListingsByVertical(listings: EscrowState[]): BrowseListingSection[] {
  return BROWSE_CATS
    .filter(c => c.id !== "all" && (CHAMA_CIRCLES_ENABLED || c.id !== "chama"))
    .map(c => ({
      id: c.id,
      label: c.l,
      listings: listings.filter(listing =>
        c.id === "work"
          ? isWorkListing(listing)
          : c.id === "marketplace"
            ? listing.category === "marketplace" && !isWorkListing(listing)
            : listing.category === c.id),
    }))
    .filter(section => section.listings.length > 0)
    .map((section, index) => ({ section, index }))
    .sort((a, b) =>
      b.section.listings.length - a.section.listings.length || a.index - b.index)
    .map(({ section }) => section);
}

function countListingsByCategory(
  matchingListings: EscrowState[],
  nonMatchingListings: EscrowState[],
  category: string,
): number {
  return [...matchingListings, ...nonMatchingListings]
    .filter(listing =>
      category === "work"
        ? isWorkListing(listing)
        : category === "marketplace"
          ? listing.category === "marketplace" && !isWorkListing(listing)
          : listing.category === category)
    .length;
}

function WorkerResume({
  pubkey,
  name,
  offers,
  fetchRatingSummary,
  onClose,
  onOpenOffer,
}: {
  pubkey: string;
  name?: string | null;
  offers: EscrowState[];
  fetchRatingSummary?: (ratee: string) => Promise<AggregateRatings>;
  onClose: () => void;
  onOpenOffer: (id: string) => void;
}) {
  const { t } = useT();
  const displayName = name ?? `${pubkey.slice(0, 12)}…`;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("browse.workerResumeTitle")}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 120,
        background: "rgba(0,0,0,0.68)",
        backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)",
        display: "flex", alignItems: "flex-end", justifyContent: "center",
        padding: 12,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: "min(100%, 520px)", maxHeight: "88vh", overflowY: "auto",
          padding: 18, borderRadius: `${T.r}px ${T.r}px 0 0`,
          background: T.card, border: `1px solid ${T.green}55`,
          boxShadow: "0 -16px 48px rgba(0,0,0,.55)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            display: "grid", placeItems: "center", flexShrink: 0,
            background: `${T.green}18`, border: `1px solid ${T.green}55`,
            fontSize: 23,
          }}>👤</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: T.green, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,}}>
              {t("browse.workerResumeEyebrow")}
            </div>
            <div style={{
              color: T.text, fontFamily: T.sans, fontSize: 20, fontWeight: 850,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{displayName}</div>
            <div style={{
              color: T.muted, fontFamily: T.mono, fontSize: 10,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{pubkey}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            style={{
              border: "none", background: T.surface, color: T.muted,
              borderRadius: "50%", width: 32, height: 32, cursor: "pointer",
              fontSize: 18,
            }}
          >×</button>
        </div>

        {fetchRatingSummary && (
          <ReputationReadout pubkey={pubkey} name={name} fetchSummary={fetchRatingSummary} />
        )}

        <div style={{
          marginTop: 18, marginBottom: 8, color: T.text,
          fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
        }}>
          {t(offers.length === 1 ? "browse.workerOfferCountOne" : "browse.workerOfferCountMany", { count: offers.length })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {offers.map(offer => (
            <button
              key={offer.id}
              type="button"
              onClick={() => onOpenOffer(offer.id)}
              style={{
                width: "100%", textAlign: "left", padding: "12px 13px",
                borderRadius: T.rs, border: `1px solid ${T.border}`,
                background: T.surface, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 10,
              }}
            >
              <VerticalIcon vertical="work" size={24} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: "block", color: T.text, fontFamily: T.sans,
                  fontSize: 13, fontWeight: 750,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{offer.description}</span>
                <span style={{ display: "block", marginTop: 3, color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary }}>
                  ₿ {fmtSats(offer.amountMsats)}
                </span>
              </span>
              <span style={{ color: T.green, fontSize: 17 }}>›</span>
            </button>
          ))}
        </div>
        <div style={{ marginTop: 14, color: T.muted, fontFamily: T.sans, fontSize: 11, lineHeight: 1.5 }}>
          {t("browse.workerResumeFootnote")}
        </div>
      </div>
    </div>
  );
}

function BrowsePreferenceControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string, number?])[];
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary, marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ display: "flex", padding: 3, gap: 3, background: T.raised, borderRadius: T.r }}>
        {options.map(([optionValue, optionLabel, optionCount]) => {
          const active = value === optionValue;
          return (
            <button
              key={optionValue}
              data-browse-preference={optionValue}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(optionValue)}
              style={{
                // v7 redesign: a segmented control — the active segment is a
                // surface tile with ink text; labels wrap rather than overlap.
                flex: 1, minWidth: 0, minHeight: T.size.touch, padding: "6px 6px", borderRadius: T.r - 3,
                background: active ? T.surface : "transparent",
                border: "none",
                boxShadow: active ? `0 0 0 1px ${T.line}` : "none",
                color: active ? T.ink : T.ink2,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: active ? 700 : 500,
                cursor: "pointer", overflowWrap: "anywhere", lineHeight: 1.2,
              }}
            >
              {optionLabel}
              {optionCount != null && (
                <span style={{ marginLeft: 5, opacity: active ? 1 : 0.7 }}>{optionCount}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BrowseSection({
  section, allEscrows, circleChildrenLoaded,
  pubkey,
  onOpenEscrow,
  variant = "matching",
  kind0Enabled = false,
  profileNames,
  amountDisplayMode,
  quoteCurrency,
  stockByListing,
  orderIndicatorByListing,
  onOpenWorkerProfile,
  showCommunityChip = false,
}: {
  allEscrows?: readonly EscrowState[];
  circleChildrenLoaded?: ReadonlySet<string>;
  section: BrowseListingSection;
  pubkey: string;
  onOpenEscrow: (id: string) => void;
  variant?: "matching" | "non-matching";
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  amountDisplayMode: AmountDisplayMode;
  quoteCurrency?: string | null;
  stockByListing?: Map<string, number>;
  orderIndicatorByListing?: Map<string, { orders: number; unread: number; viewerOrderId?: string }>;
  onOpenWorkerProfile?: (pubkey: string) => void;
  showCommunityChip?: boolean;
}) {
  const { t } = useT();
  const railGroups = groupBySettlementRail(section.listings, l => settlementRailOf(l.escrowMode));
  return (
    <section style={{ marginBottom: 16 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        marginBottom: 8,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          color: T.text,
          fontFamily: T.sans,
          fontSize: T.fs.secondary,
          fontWeight: 800,
        }}>
          <VerticalIcon vertical={section.id} size={17} />
          {t(section.label)}
        </div>
        <div style={{
          color: T.muted,
          fontFamily: T.sans,
          fontSize: T.fs.secondary,
        }}>
          {t("browse.sectionOpenCount", { count: section.listings.length })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Runway #15: inside a shelf too, rails never mix flat. */}
        {railGroups.flatMap(group => [
          ...(railHeadersNeeded(railGroups)
            ? [<RailHeader key={`rail-${group.rail}`} rail={group.rail} count={group.items.length} />]
            : []),
          ...group.items.map((s, i) => (
          <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
            <TradeCard
                        allEscrows={allEscrows}
                        circleChildrenLoaded={circleChildrenLoaded}
              state={s}
              pubkey={pubkey}
              onSelect={() => onOpenEscrow(s.id)}
              variant={variant}
              kind0Enabled={kind0Enabled}
              profileNames={profileNames}
              amountDisplayMode={amountDisplayMode}
              quoteCurrency={quoteCurrency}
              stockLeft={stockByListing?.get(s.id)}
              orderIndicator={orderIndicatorByListing?.get(s.id)}
              onResumeOrder={onOpenEscrow}
              onOpenWorkerProfile={onOpenWorkerProfile}
              showCommunityChip={showCommunityChip}
            />
          </div>
          )),
        ])}
      </div>
    </section>
  );
}
