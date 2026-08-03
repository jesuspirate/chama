import { useMemo, useState, useEffect } from "react";
import { type EscrowState } from "../../escrow-engine/types.js";
import { getCommunityBySlug, type Community } from "../../communities/registry.js";
import { T, ROLE_COLOR, BROWSE_CATS, inputStyle, fmtSats } from "../theme.js";
import { TradeCard } from "../components/TradeCard.js";
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
  browseCommunity,
  amountDisplayMode,
  matchingListings, nonMatchingListings,
  stockByListing,
  orderIndicatorByListing,
  categoryCounts,
  fedimintJoined, listingsLoading, pubkey,
  kind0Enabled = false, profileNames,
  isFirstTime, onPasteCustomInvite,
  onOpenEscrow, onLoadById,
  fetchRatingSummary,
  onCreate, onApplyAsArbiter,
  onOpenGuided,
}: {
  browseCategory: string;
  setBrowseCategory: (s: string) => void;
  browseCommunity: string;
  amountDisplayMode: AmountDisplayMode;
  matchingListings: EscrowState[];
  nonMatchingListings: EscrowState[];
  /** #7 Stage 3: derived "N left" per multi-unit parent listing id. */
  stockByListing?: Map<string, number>;
  /** #70 per-parent live child-order count + aggregated unread chat, so a
   *  seller's storefront card surfaces ALL its orders, not just its own chat. */
  orderIndicatorByListing?: Map<string, { orders: number; unread: number; viewerOrderId?: string }>;
  categoryCounts?: Record<string, number>;
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
  /** v3.1.1: floating-menu on-ramps — pencil opens Create; the ⚖️ FAB opens the
   *  arbiter application form inline (no bounce to Me). */
  onCreate: () => void;
  onApplyAsArbiter: (community: string, statement: string) => Promise<void>;
  onOpenGuided: () => void;
}) {
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
  const ownListingCount = useMemo(
    () => countOwnListings(matchingListings, pubkey) + countOwnListings(nonMatchingListings, pubkey),
    [matchingListings, nonMatchingListings, pubkey],
  );
  // A persisted Mine preference should not strand a returning user on an empty
  // feed. Wait until discovery settles, then fall back to All when they own 0.
  useEffect(() => {
    if (!listingsLoading && showOwn && ownListingCount === 0) {
      setShowOwnState(false);
      setBrowseShowOwn(false);
    }
  }, [listingsLoading, showOwn, ownListingCount]);
  const ownHiddenCount = showOwn ? 0 : ownListingCount;
  const ownFilteredMatching = useMemo(
    () => filterOwnListings(matchingListings, pubkey, showOwn),
    [matchingListings, pubkey, showOwn],
  );
  const ownFilteredNonMatching = useMemo(
    () => filterOwnListings(nonMatchingListings, pubkey, showOwn),
    [nonMatchingListings, pubkey, showOwn],
  );
  const totalListings = ownFilteredMatching.length + ownFilteredNonMatching.length;
  const homeCommunity = getCommunityBySlug(browseCommunity);
  const search = searchQuery.trim().toLowerCase();
  const filteredMatchingListings = useMemo(
    () => ownFilteredMatching.filter((listing) => listingMatchesSearch(listing, search)),
    [ownFilteredMatching, search],
  );
  const filteredNonMatchingListings = useMemo(
    () => ownFilteredNonMatching.filter((listing) => listingMatchesSearch(listing, search)),
    [ownFilteredNonMatching, search],
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
    <div style={{ padding: 16 }}>
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
        {/* create a trade (primary) */}
        <button
          type="button" onClick={onCreate}
          data-coach="fab-create"
          title={t("browse.createTrade")} aria-label={t("browse.createTrade")}
          style={{
            width: 58, height: 58, borderRadius: "50%", flexShrink: 0,
            background: T.accent, border: "none", color: "#fff",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 8px 22px ${T.accent}66, 0 8px 20px rgba(0,0,0,0.5)`,
          }}
        >
          <svg width="31" height="31" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />
            <path d="M13.5 6.5l4 4" />
          </svg>
        </button>
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        marginBottom: 16,
        gap: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{
            margin: 0, color: T.text, fontFamily: T.sans,
            fontSize: 30, lineHeight: 1.05, fontWeight: 800,
          }}>
            {t("browse.listings")}
          </h1>
          <div style={{
            marginTop: 6, fontSize: 12, color: T.muted,
            fontFamily: T.mono, whiteSpace: "nowrap" as const,
            overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {browseSummary}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            onClick={onOpenGuided}
            title={t("guided.assistant")}
            aria-label={t("guided.assistant")}
            style={{
              width: 34, height: 34, borderRadius: 12,
              background: T.accentDim, border: `1px solid ${T.accent}44`,
              color: T.accent, cursor: "pointer", fontSize: 16,
              display: "grid", placeItems: "center",
            }}
          >✦</button>
          {/* v3.1.1: the create + arbiter on-ramps moved out of the header into
              the floating action menu (FAB stack) rendered at the screen root. */}
          {homeCommunity && (
          // v2.3.1: view-only identity chip. The community SWITCHER moved to
          // Me › Your Chama so switching is a deliberate, between-trades act
          // (and reclaims the Browse real estate the dropdown used to eat).
          // This just tells you which Chama you're browsing as.
          <div
            title={browseCommunityButtonLabel(homeCommunity)}
            style={{
              padding: "7px 10px", borderRadius: 18,
              background: T.surface, border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 11,
              display: "flex", alignItems: "center", gap: 6,
              color: T.text, minWidth: 0,
              maxWidth: 174, flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{homeCommunity.flagEmoji}</span>
            <span style={{
              minWidth: 0, display: "flex", flexDirection: "column",
              alignItems: "flex-start", lineHeight: 1.1,
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 132 }}>
                {homeCommunity.disambiguator ?? homeCommunity.displayName}
              </span>
              <span style={{ color: T.muted, fontSize: 9 }}>{homeCommunity.currency}</span>
            </span>
          </div>
        )}
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
          color: T.muted, fontFamily: T.mono,
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

      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        overflowX: "auto",
        scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as const,
        paddingBottom: 2,
      }}>
        {BROWSE_CATS.map(c => {
          const active = !showOwn && browseCategory === c.id;
          // #75: counts must reflect what the viewer actually SEES — the
          // own-hidden + retired filtering already applied to ownFiltered* — not
          // the raw prop (which still counts own/hidden listings). Fall back to
          // the prop only when no viewer-scoped set is available.
          const count = c.id === "all"
            ? totalListings
            : countListingsByCategory(ownFilteredMatching, ownFilteredNonMatching, c.id);
          return (
            <button
              key={c.id}
              onClick={() => { if (showOwn) toggleShowOwn(); setBrowseCategory(c.id); }}
              style={{
                order: c.id === "all" ? 0 : 2,
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
              {c.i && <span>{c.i}</span>}
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
        {(ownListingCount > 0 || showOwn) && (
          <button
            type="button"
            onClick={() => { if (!showOwn) toggleShowOwn(); setBrowseCategory("all"); }}
            aria-pressed={showOwn}
            style={{
              order: 1,
              flexShrink: 0,
              padding: "7px 11px", borderRadius: 18,
              background: showOwn ? T.accentDim : T.surface,
              border: `1px solid ${showOwn ? T.accent + "66" : T.border}`,
              color: showOwn ? T.accent : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              cursor: "pointer", transition: "all 0.15s",
              whiteSpace: "nowrap" as const, letterSpacing: 0,
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
      </div>

      {search && totalListings > 0 && filteredTotal === 0 && (
        <div style={{
          textAlign: "center", padding: "24px 16px",
          color: T.muted, fontFamily: T.mono, fontSize: 12, lineHeight: 1.6,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          marginBottom: 14,
        }}>
          {t("browse.noListingsMatch", { query: searchQuery.trim() })}
        </div>
      )}

      {totalListings === 0 ? (
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
                    orderIndicatorByListing={orderIndicatorByListing}
                    onOpenWorkerProfile={setResumePubkey}
                  />
                ))
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredMatchingListings.map((s, i) => (
                    <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                      <TradeCard
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
                      />
                    </div>
                  ))}
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
                  fontSize: 9, color: T.muted, fontFamily: T.mono,
                  letterSpacing: 0, textTransform: "uppercase",
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
                    orderIndicatorByListing={orderIndicatorByListing}
                    onOpenWorkerProfile={setResumePubkey}
                  />
                ))
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredNonMatchingListings.map((s, i) => (
                    <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                      <TradeCard
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
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      <div style={{ marginTop: 20, fontFamily: T.mono }}>
        <button
          onClick={() => setShowAdvancedTools((v) => !v)}
          style={{
            background: "none", border: "none", padding: 0,
            color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            cursor: "pointer", letterSpacing: 0, textTransform: "uppercase",
          }}
        >
          {showAdvancedTools ? "▲" : "▼"} {t("browse.advancedTools")}
        </button>
        {showAdvancedTools && (
          <div style={{
            marginTop: 10, padding: 12, background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.border}`,
          }}>
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
                    fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                    cursor: customInviteInput.trim().startsWith("fed1") ? "pointer" : "not-allowed",
                    whiteSpace: "nowrap" as const,
                  }}
                >
                  {t("browse.join")}
                </button>
              </div>
            )}
            <LoadTradeInput onLoad={onLoadById} />
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.7, textAlign: "center" }}>
              {t("browse.advancedFooterLine1")}<br />
              {t("browse.advancedFooterLine2")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function browseCommunityButtonLabel(community: Community): string {
  return community.disambiguator
    ? `${community.displayName} · ${community.disambiguator}`
    : community.displayName;
}

function listingMatchesSearch(listing: EscrowState, query: string): boolean {
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
  icon: string;
  listings: EscrowState[];
}

function groupListingsByVertical(listings: EscrowState[]): BrowseListingSection[] {
  return BROWSE_CATS
    .filter(c => c.id !== "all")
    .map(c => ({
      id: c.id,
      label: c.l,
      icon: c.i,
      listings: listings.filter(listing =>
        c.id === "work"
          ? isWorkListing(listing)
          : c.id === "marketplace"
            ? listing.category === "marketplace" && !isWorkListing(listing)
            : listing.category === c.id),
    }))
    .filter(section => section.listings.length > 0);
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
            <div style={{ color: T.green, fontFamily: T.mono, fontSize: 9, fontWeight: 800, letterSpacing: 1 }}>
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
          fontFamily: T.mono, fontSize: 11, fontWeight: 800, letterSpacing: .7,
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
              <span style={{ fontSize: 18 }}>🛠️</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: "block", color: T.text, fontFamily: T.sans,
                  fontSize: 13, fontWeight: 750,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{offer.description}</span>
                <span style={{ display: "block", marginTop: 3, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>
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

function BrowseSection({
  section,
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
}: {
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
}) {
  const { t } = useT();
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
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.8,
          textTransform: "uppercase",
        }}>
          <span style={{ fontSize: 13 }}>{section.icon}</span>
          {t(section.label)}
        </div>
        <div style={{
          color: T.muted,
          fontFamily: T.mono,
          fontSize: 10,
        }}>
          {t("browse.sectionOpenCount", { count: section.listings.length })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {section.listings.map((s, i) => (
          <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
            <TradeCard
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
            />
          </div>
        ))}
      </div>
    </section>
  );
}
