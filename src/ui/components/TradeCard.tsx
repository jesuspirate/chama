import { useState } from "react";
import {
  type EscrowState,
  EscrowStatus,
  Role,
  getEffectiveParticipantAt,
  getEffectiveParticipantsAt,
  getJoinHoldRemainingSeconds,
} from "../../escrow-engine/types.js";
import { getCommunityBySlug, flagEmojiForCountry } from "../../communities/registry.js";
import { pickPreferredArbiter } from "../../arbiters/pool.js";
import { T, CAT_ICON, ROLE_COLOR, ROLE_ICON, STATUS, TRINITY_RING_ORDER, fmtSats } from "../theme.js";
import { copyTextRobust } from "./CopyButton.js";
import { listingPremiumLine } from "../listing-metrics.js";
import { unreadChatForTrade } from "../../chat/unread.js";
import { billTypeDisplay } from "../../communities/bill-types.js";
import { payoutRecipientFor } from "../../escrow-engine/recipients.js";
import { isParentStorefront, isChildOrder } from "../../escrow-engine/storefront.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { STORE_WATERMARK } from "../assets/store-watermark.js";
import {
  estimateFiatForMsats,
  formatEstimatedFiatForMsats,
  formatFiatAmount,
  normalizeFiatCurrency,
  resolveEstimatedFiatCurrency,
  shouldQuoteEstimatedFiat,
  type AmountDisplayMode,
} from "../amount-display.js";
import { useT, type TFunc } from "../../i18n/index.js";
import { SwipeImageGallery } from "./SwipeImageGallery.js";
import { isWorkListing, isWorkOffer, isWorkRequest } from "../work-resume.js";
import { ESCROW_NETWORK_LABEL } from "../../bond-multisig/onchain-escrow.js";

// v0.2.0 item 4: variant="non-matching" applies an amber tint per
// chama_browse_amber_tint_sorted. Quiet, not alarmist — it's a
// teaching affordance, not a warning. Tapping a non-matching listing
// triggers the listing-tap dispatch in App.tsx (silent switch when
// balance==0; destroy-confirm modal when balance>0). The community
// flag/name appears inline so users can see at a glance which fed
// they'd be switching to.
export function TradeCard({
  state,
  pubkey,
  onSelect,
  variant = "matching",
  kind0Enabled = false,
  profileNames,
  amountDisplayMode = "sats",
  quoteCurrency,
  stockLeft,
  orderIndicator,
  onResumeOrder,
  onOpenWorkerProfile,
  showCommunityChip = false,
}: {
  state: EscrowState;
  pubkey: string;
  onSelect: () => void;
  variant?: "matching" | "non-matching";
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  amountDisplayMode?: AmountDisplayMode;
  quoteCurrency?: string | null;
  /** #7 Stage 3: derived remaining units for a multi-unit parent listing.
   *  Undefined for single-unit listings (no badge). */
  stockLeft?: number;
  /** #70 aggregated live child-order signal for a seller's parent storefront:
   *  the count of open orders + unread chat summed across them. Non-zero only on
   *  the seller's own listings; drives the "N orders · M unread" indicator so
   *  EVERY joined order surfaces, not just the parent's own chat. */
  orderIndicator?: { orders: number; unread: number; viewerOrderId?: string };
  /** Buyer-only shortcut from the parent listing to their spawned child order. */
  onResumeOrder?: (id: string) => void;
  /** Work offers turn the author into a live public résumé. Kept separate
   *  from onSelect so tapping the identity never starts the hire flow. */
  onOpenWorkerProfile?: (pubkey: string) => void;
  /** Browse "All" context only: show which Chama/country owns the listing. */
  showCommunityChip?: boolean;
}) {
  const { t } = useT();
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const nowSec = Math.floor(Date.now() / 1000);
  const participants = getEffectiveParticipantsAt(state, nowSec);
  const isAmber = variant === "non-matching";
  const cardBg = isAmber ? T.amberDim : T.card;
  const cardBorder = isAmber ? T.amber + "44" : T.border;
  const listingCommunity = state.community
    ? getCommunityBySlug(state.community)
    : null;
  const sellerPubkey = state.participants[Role.SELLER]
    ?? (state.initiator.role === Role.SELLER ? state.initiator.pubkey : null);
  const sellerName = profileNameFor(profileNames, sellerPubkey, kind0Enabled);
  const communityChipLabel = listingCommunity
    ? (listingCommunity.disambiguator ?? listingCommunity.displayName)
    : null;
  // v2.3.1 — history/audit presentation. On your OWN trade (the Me list) you
  // already know your role — you have the seller dashboard, and arbiters get
  // their own view — so the card shows just the COUNTERPARTY (the other side),
  // never "· You". Identical-looking orders (same npub, same title) are still
  // told apart by the public trade ID, which is shown on every card. On Browse (non-
  // participant) we keep the single "Seller · X" context line. This also fixes
  // the v2.3 double-"Seller" line: a buyer-viewer rendered the counterparty line
  // ("Seller · X") AND the seller-context line ("Seller · X").
  const viewerRole = pubkey === state.participants[Role.SELLER] ? Role.SELLER
    : pubkey === state.participants[Role.BUYER] ? Role.BUYER : null;
  const isParticipant = viewerRole !== null;
  const counterpartyPk = viewerRole === Role.SELLER ? participants[Role.BUYER]
    : viewerRole === Role.BUYER ? sellerPubkey : null;
  const counterpartyLine = counterpartyPk
    ? t(viewerRole === Role.SELLER ? "card.buyerLine" : "card.sellerLine", {
        name: profileNameFor(profileNames, counterpartyPk, kind0Enabled) ?? shortPubkey(counterpartyPk),
      })
    : null;
  const sellerContextLine = !isParticipant && sellerPubkey && state.category !== "marketplace"
    ? t("card.sellerLine", { name: sellerName ?? shortPubkey(sellerPubkey) })
    : null;
  const status = STATUS[state.status] ?? STATUS.CREATED;
  // v4.1 (#15) unread badge: count messages from the other party since this device
  // last opened the trade's Chat pane. Covers all three seats (incl. arbiter, who
  // is intentionally excluded from viewerRole's display logic above); non-
  // participants get 0, so the badge only ever shows on the owner's own trades.
  const myRoleForUnread: Role | null =
    pubkey === state.participants[Role.SELLER] ? Role.SELLER
    : pubkey === state.participants[Role.BUYER] ? Role.BUYER
    : pubkey === state.participants[Role.ARBITER] ? Role.ARBITER
    : null;
  const chatUnread = unreadChatForTrade(state, myRoleForUnread);
  // #70 On a seller's PARENT storefront, child orders never render as their own
  // Browse cards, so fold every live child order's unread chat into this card's
  // badge (and surface the live-order count) — otherwise the seller sees a
  // single indicator no matter how many orders are open.
  const childOrderUnread = orderIndicator?.unread ?? 0;
  const liveOrderCount = orderIndicator?.orders ?? 0;
  const viewerOrderId = orderIndicator?.viewerOrderId;
  // A buyer with an active child order has one canonical destination from the
  // parent tile: every tap resumes that order. The small chip is reinforcement,
  // not the only discoverable hit target.
  const primarySelect = viewerOrderId && onResumeOrder
    ? () => onResumeOrder(viewerOrderId)
    : onSelect;
  const combinedUnread = chatUnread + childOrderUnread;
  // v4.1 (#12): CBP bill type, resolved for display (icon + label). Null elsewhere.
  const billTypeChip = state.category === "bill-pay" ? billTypeDisplay(state.billType) : null;
  const timeLine = compactJoinHoldRemaining(state, nowSec, t) ?? compactTimeRemaining(state, nowSec, t);
  const fiatLine = state.fiatAmount != null && state.fiatCurrency
    ? formatFiatAmount(state.fiatAmount, state.fiatCurrency)
    : null;
  const menuItems = state.items ?? [];
  const hasMenu = menuItems.length > 0;
  const isStorefrontTile = !!sellerPubkey
    && !isAmber
    && (state.category === "marketplace" || (state.category === "p2p-trade" && hasMenu));
  const fiatFloor = menuFiatFloor(menuItems);
  const exchangeRange = state.category === "p2p-trade"
    ? exchangeBracketRange(menuItems)
    : null;
  const exchangeBrackets = state.category === "p2p-trade"
    ? exchangeBracketLabels(menuItems)
    : [];
  const satsLabel = exchangeRange ? satsRangeLabel(exchangeRange) : fmtSats(state.amountMsats);
  const storefrontImages = isStorefrontTile
    ? [
        ...(state.imageUrls?.length ? state.imageUrls : state.imageDataUrl ? [state.imageDataUrl] : []),
        ...menuItems.flatMap(item => {
          const leadImage = item.imageUrls?.[0] ?? item.imageDataUrl;
          return leadImage ? [leadImage] : [];
        }),
      ]
    : [];
  const menuCountLine = hasMenu ? menuSummary(state.category, menuItems.length, null, t) : null;
  const menuLine = hasMenu ? menuSummary(state.category, menuItems.length, fiatFloor, t) : null;
  const listingCurrency = listingFiatCurrency(state, fiatFloor, listingCommunity?.currency);
  const estimatedCurrency = resolveEstimatedFiatCurrency({
    viewerCurrency: quoteCurrency,
    listingCurrency,
  });
  const quoteViewerFiat = shouldQuoteEstimatedFiat({
    viewerCurrency: quoteCurrency,
    listingCurrency,
  });
  const fiatPrimary = fiatLine
    ?? (fiatFloor
      ? (hasMenu
          ? t("card.fromFiat", { amount: formatFiatAmount(fiatFloor.amount, fiatFloor.currency) })
          : formatFiatAmount(fiatFloor.amount, fiatFloor.currency))
      : null);
  const estimatedFiatPrimary = (quoteViewerFiat || !fiatPrimary) && estimatedCurrency
    ? estimatedFiatPrimaryLabel({
        amountMsats: state.amountMsats,
        currency: estimatedCurrency,
        exchangeRange,
        menuItems,
        hasMenu,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
        t,
      })
    : null;
  const displayFiatPrimary = exchangeRange
    ? estimatedFiatPrimary ?? fiatPrimary
    : quoteViewerFiat
    ? estimatedFiatPrimary ?? fiatPrimary
    : fiatPrimary ?? estimatedFiatPrimary;
  const showFiatPrimary = amountDisplayMode === "fiat" && !!displayFiatPrimary;
  const paymentMethodsLine = paymentMethodsSummary(state.paymentMethods);
  const premiumLine = listingPremiumLine(state, btcPrice.usd);
  const secondaryLine = showFiatPrimary
    ? [`₿ ${satsLabel}`, menuCountLine].filter(Boolean).join(" · ")
    : fiatLine ?? (
      hasMenu
        ? menuLine
        : state.category === "marketplace" ? fulfillmentLabel(state.fulfillment, t) : null
    );
  const previewArbiterPk = state.status === EscrowStatus.CREATED
    && !participants[Role.ARBITER]
    && state.communityArbiters.length > 0
    ? (pickPreferredArbiter(state.communityArbiters, state.bondedArbiters, state.id, [
        participants[Role.BUYER],
        participants[Role.SELLER],
      ]) ?? null)
    : null;

  return (
    <div onClick={primarySelect} style={{
      background: cardBg, border: `1px solid ${cardBorder}`,
      borderRadius: T.r, padding: 14, cursor: "pointer",
      transition: "border-color 0.2s",
      overflow: "hidden",
      position: "relative", isolation: "isolate",
    }}>
      {combinedUnread > 0 && (
        <span aria-label={combinedUnread === 1 ? t("card.unreadMessageOne") : t("card.unreadMessageMany", { count: combinedUnread })} style={{
          position: "absolute", top: 8, right: 8, zIndex: 2,
          display: "inline-flex", alignItems: "center", gap: 3,
          minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box",
          borderRadius: 999, background: T.accent, color: "#fff",
          fontFamily: T.mono, fontSize: 9.5, fontWeight: 800, lineHeight: "18px",
        }}>
          💬 {combinedUnread > 9 ? "9+" : combinedUnread}
        </span>
      )}
      {/* Storefront media stays on own-route Store/Exchange-menu tiles. External
          amber cards remain compact so route context stays the strongest signal. */}
      {isStorefrontTile && storefrontImages.length === 0 && (
        <div aria-hidden="true" style={{
          position: "absolute", inset: 0, zIndex: -1,
          backgroundImage: `url(${STORE_WATERMARK})`,
          backgroundRepeat: "no-repeat",
          // Storefront-with-₿ emblem in the tile's right zone, vertically centred
          // and clear of the left-aligned title/price. Fixed size so it reads the
          // same on wide and narrow cards. The asset's dark field is already
          // transparent, so contrast() now just punches up the neon; `screen`
          // lets only the storefront (and the Bitcoin glyph) glow over the card.
          backgroundPosition: "right 20px center",
          backgroundSize: "auto 128px",
          filter: "contrast(1.4)",
          mixBlendMode: "screen",
          opacity: 0.65,
          pointerEvents: "none",
        }} />
      )}
      {storefrontImages.length > 0 && (
        <SwipeImageGallery images={storefrontImages} height={156} edgeToEdge />
      )}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "stretch",
        gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            marginBottom: 5, flexWrap: "wrap",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 10, padding: "3px 8px", borderRadius: 999,
              background: isParentStorefront(state) ? `${T.teal}18` : T.surface,
              color: isParentStorefront(state) ? T.teal : T.muted,
              border: `1px solid ${isParentStorefront(state) ? `${T.teal}55` : T.border}`,
              fontFamily: T.mono, fontWeight: 700,
              lineHeight: 1.2,
            }}>
              {/* #63 storefront-vs-order clarity: a multi-unit parent reads as a
                  🏪 Storefront, a spawned child purchase as a 🛒 Order — so a
                  seller can tell the persistent shopfront apart from a live sale
                  in the trade list. The emoji rides the label; other verticals
                  keep the CAT_ICON glyph. */}
              {isWorkListing(state) ? t("card.categoryWork")
                : isParentStorefront(state) ? t("card.categoryStorefront")
                : isChildOrder(state) ? t("card.categoryOrder")
                : state.category === "marketplace" ? t("card.categorySingleListing")
                : <>
                    <span style={{ fontSize: 11, lineHeight: 1 }}>{CAT_ICON[state.category] || "📦"}</span>
                    {shortCategoryLabel(state.category, t)}
                  </>}
            </span>
            {/* ⛓ Which substrate holds this trade's money. Shown on the CARD
                because a tester (and a trader) should be able to tell an
                on-chain escrow from an ecash one without opening it — and
                because on a signet build, "which network is this?" is the first
                question anyone asks. */}
            {state.escrowMode === "onchain" && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: ESCROW_NETWORK_LABEL === "signet" ? `${T.amber}1e` : `${T.accent}1e`,
                color: ESCROW_NETWORK_LABEL === "signet" ? T.amber : T.accent,
                border: `1px solid ${ESCROW_NETWORK_LABEL === "signet" ? T.amber : T.accent}55`,
                fontFamily: T.mono, fontWeight: 800, lineHeight: 1.2,
              }}>
                <span style={{ fontSize: 11, lineHeight: 1 }}>⛓</span>
                {ESCROW_NETWORK_LABEL === "signet" ? "SIGNET" : "ON-CHAIN"}
              </span>
            )}
            {(state.escrowMode ?? "ecash") === "ecash" && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: `${T.teal}18`, color: T.teal,
                border: `1px solid ${T.teal}55`,
                fontFamily: T.mono, fontWeight: 800, lineHeight: 1.2,
              }}>
                <span style={{ fontSize: 11, lineHeight: 1 }}>⚡</span>
                ECASH
              </span>
            )}
            {billTypeChip && billTypeChip.label !== state.description && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.surface, color: T.text,
                border: `1px solid ${T.border}`,
                fontFamily: T.mono, fontWeight: 700, lineHeight: 1.2,
              }}>
                <span style={{ fontSize: 11, lineHeight: 1 }}>{billTypeChip.icon}</span>
                {billTypeChip.label}
              </span>
            )}
            {state.subscription && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.purpleDim, color: T.purple,
                border: `1px solid ${T.purple}33`,
                fontFamily: T.mono, fontWeight: 700,
              }}>
                🔄 {state.subscription.releasedCount}/{state.subscription.totalPeriods}
              </span>
            )}
            {hasMenu && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.accentDim, color: T.accent,
                border: `1px solid ${T.accent}33`,
                fontFamily: T.mono, fontWeight: 800,
              }}>
                {menuBadgeLabel(state.category, t)}
              </span>
            )}
            {/* #7 Stage 3: derived stock on a multi-unit listing. >0 → "N left";
                0 (all units currently held/locked but not fully sold) → reserved. */}
            {stockLeft !== undefined && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: stockLeft > 0 ? `${T.green}22` : `${T.amber}22`,
                color: stockLeft > 0 ? T.green : T.amber,
                border: `1px solid ${(stockLeft > 0 ? T.green : T.amber)}55`,
                fontFamily: T.mono, fontWeight: 800,
              }}>
                {stockLeft > 0 ? t("card.stockLeft", { count: stockLeft }) : t("card.reserved")}
              </span>
            )}
            {/* #70 seller's storefront: every live child order aggregated into one
                honest "N orders · M unread" chip (children never render as their
                own Browse cards, so this is where the seller sees all of them). */}
            {!viewerOrderId && liveOrderCount > 0 && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: `${T.accent}1c`, color: T.accent,
                border: `1px solid ${T.accent}55`,
                fontFamily: T.mono, fontWeight: 800,
                display: "inline-flex", alignItems: "center", gap: 4,
              }}>
                {t(liveOrderCount === 1 ? "card.liveOrdersOne" : "card.liveOrdersMany", { count: liveOrderCount })}
                {combinedUnread > 0 && ` · 💬 ${combinedUnread > 9 ? "9+" : combinedUnread}`}
              </span>
            )}
          </div>

          {/* Identity and location are context, not listing type or activity.
              Keep them on their own predictable row so storefront/single,
              stock, and live-order state remain instantly scannable above. */}
          {((state.category === "marketplace" && !!sellerPubkey)
            || (showCommunityChip && (!!listingCommunity || !!state.country))) && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            marginBottom: 8, flexWrap: "wrap",
          }}>
            {state.category === "marketplace" && sellerPubkey && (
              <span
                role={isWorkOffer(state) && onOpenWorkerProfile ? "button" : undefined}
                tabIndex={isWorkOffer(state) && onOpenWorkerProfile ? 0 : undefined}
                onClick={isWorkOffer(state) && onOpenWorkerProfile
                  ? (event) => {
                      event.stopPropagation();
                      onOpenWorkerProfile(sellerPubkey);
                    }
                  : undefined}
                onKeyDown={isWorkOffer(state) && onOpenWorkerProfile
                  ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenWorkerProfile(sellerPubkey);
                    }
                  : undefined}
                title={isWorkOffer(state) ? t("card.viewWorkerProfile") : undefined}
                style={{
                fontSize: 10, padding: "3px 9px", borderRadius: 999,
                background: isParentStorefront(state) ? `${T.teal}12` : T.surface,
                color: isWorkListing(state) ? T.green : isParentStorefront(state) ? T.teal : T.muted,
                border: `1px solid ${isParentStorefront(state) ? `${T.teal}3d` : T.border}`,
                fontFamily: T.mono, fontWeight: 800,
                display: "inline-flex", alignItems: "center", gap: 4,
                maxWidth: "100%",
                cursor: isWorkOffer(state) && onOpenWorkerProfile ? "pointer" : "default",
              }}>
                <span aria-hidden="true">{isWorkListing(state) ? "👤" : "★"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t(isWorkOffer(state) ? "card.workerLine" : isWorkRequest(state) ? "card.clientLine" : isParentStorefront(state) ? "card.storeLine" : "card.sellerLine", {
                    name: sellerName ?? shortPubkey(sellerPubkey),
                  })}
                </span>
              </span>
            )}
            {showCommunityChip && listingCommunity && (() => {
              // Per-fed chip accent (registry-driven). Amber "off-route" state
              // wins — that's routing info, more important than which fed.
              // On-route/neutral: use the community's accent if it has one,
              // else the legacy neutral grey.
              const accent = !isAmber ? (listingCommunity.chipAccent ?? null) : null;
              const chipColor = isAmber ? T.amber : (accent ?? T.muted);
              const chipBorder = isAmber ? T.amber + "33" : (accent ? accent + "55" : T.border);
              const chipBg = accent ? accent + "1a" : T.surface;
              return (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: chipBg, color: chipColor,
                border: `1px solid ${chipBorder}`,
                fontFamily: T.mono, fontWeight: 700,
                display: "inline-flex", alignItems: "center", gap: 3,
                maxWidth: "100%",
              }}>
                <span style={{ fontSize: 10, lineHeight: 1 }}>{listingCommunity.flagEmoji}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {communityChipLabel}
                </span>
              </span>
              );
            })()}
            {/* v3.1 (B3): self-describing fallback — when the community slug isn't
                resolvable on this device, show the stamped country's flag + currency
                so a custom/not-yet-curated community (the Canada bug) still reads. */}
            {showCommunityChip && !listingCommunity && state.country && (
              <span style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 999,
                background: T.surface, color: T.muted,
                border: `1px solid ${T.border}`,
                fontFamily: T.mono, fontWeight: 700,
                display: "inline-flex", alignItems: "center", gap: 3,
                maxWidth: "100%",
              }}>
                <span style={{ fontSize: 10, lineHeight: 1 }}>{flagEmojiForCountry(state.country)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {listingCurrency ?? state.country}
                </span>
              </span>
            )}
          </div>
          )}

          <div style={{
            fontSize: 17, fontWeight: 800, color: T.text,
            fontFamily: T.sans, lineHeight: 1.2, marginBottom: 10,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {state.description}
          </div>

          {counterpartyLine && (
            <div style={{
              marginTop: -4,
              marginBottom: 6,
              color: viewerRole === Role.SELLER ? T.purple : T.amber,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 700,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {counterpartyLine}
            </div>
          )}

          <TradeIdLine id={state.id} />
          <TradeTimeLine createdAt={state.createdAt} />

          {sellerContextLine && (
            <div style={{
              marginTop: -4,
              marginBottom: 9,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {sellerContextLine}
            </div>
          )}

          <div style={{
            display: "flex", alignItems: "baseline", gap: 7,
            minWidth: 0, flexWrap: "wrap",
            marginBottom: 12,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              color: T.accent, fontFamily: T.mono, lineHeight: 1,
            }}>
              {hasMenu && !exchangeRange && !showFiatPrimary && (
                <span style={{ fontSize: 10, color: T.muted, fontWeight: 800, lineHeight: 1 }}>
                  {t("card.from")}
                </span>
              )}
              {showFiatPrimary ? (
                <span style={{
                  fontSize: 24,
                  fontWeight: 900,
                  letterSpacing: 0,
                  color: T.accent,
                }}>
                  {displayFiatPrimary}
                </span>
              ) : exchangeRange ? (
                <BitcoinAmount label={satsRangeLabel(exchangeRange)} size={24} />
              ) : (
                <BitcoinAmount msats={state.amountMsats} size={24} />
              )}
            </span>
            {secondaryLine && (
              <span style={{
                fontSize: 11,
                color: T.muted,
                fontFamily: T.mono,
                lineHeight: 1.4,
              }}>
                · {secondaryLine}
              </span>
            )}
          </div>
          {exchangeBrackets.length > 0 && (
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 6,
              marginTop: -4, marginBottom: 11,
            }}>
              {exchangeBrackets.map(bracket => (
                <span key={`${bracket.id}:${bracket.label}`} style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "4px 7px", borderRadius: 999,
                  border: `1px solid ${T.purple}55`, background: `${T.purple}12`,
                  color: T.text, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700,
                }}>
                  <span style={{ color: T.muted }}>{bracket.name}</span>
                  <span style={{ color: T.accent }}>₿ {bracket.label}</span>
                </span>
              ))}
            </div>
          )}
          {paymentMethodsLine && (
            <div style={{
              marginTop: -5,
              marginBottom: premiumLine ? 4 : 11,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {t("card.accepts", { methods: paymentMethodsLine })}
            </div>
          )}
          {premiumLine && (
            <div style={{
              marginTop: paymentMethodsLine ? 0 : -5,
              marginBottom: 11,
              color: T.amber,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}>
              {premiumLine}
            </div>
          )}
          <MiniTrinityRing
            state={state}
            pubkey={pubkey}
            previewArbiterPk={previewArbiterPk}
          />
        </div>

        <div style={{
          width: 86, flexShrink: 0,
          display: "flex", flexDirection: "column",
          alignItems: "flex-end", justifyContent: "space-between",
          textAlign: "right", gap: 10,
        }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "4px 8px", borderRadius: 999,
            background: status.bg, color: status.c,
            border: `1px solid ${status.c}33`,
            fontSize: 10, fontWeight: 800,
            fontFamily: T.mono, textTransform: "uppercase",
            lineHeight: 1.2,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: status.c, boxShadow: `0 0 8px ${status.c}66`,
            }} />
            {compactStatusLabel(state, nowSec, pubkey, t)}
          </span>
          {timeLine && (
            <div style={{
              fontSize: 10, color: timeLine.tone, fontFamily: T.mono,
              lineHeight: 1.35,
            }}>
              {timeLine.label}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function shortPubkey(pubkey: string): string {
  return pubkey.length > 13 ? `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}` : pubkey;
}

// v2.3.1 — the unique trade ID, surfaced on the user's own trade cards for
// audit. Two same-npub, same-title trades are still distinct by this id. Tap to
// copy (stopPropagation so it doesn't open the trade). Display is the point;
// copy is the bonus that makes it shareable for a dispute or support thread.
function TradeIdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useT();
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        copyTextRobust(id); // robust in Tauri/Capacitor webviews (execCommand fallback)
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={t("card.tapToCopyTradeId")}
      style={{
        marginTop: -2, marginBottom: 9,
        display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%",
        color: T.muted, fontFamily: T.mono, fontSize: 9, lineHeight: 1.4,
        cursor: "pointer",
      }}
    >
      <span style={{ color: copied ? T.green : T.muted, flexShrink: 0 }}>
        {copied ? t("card.copied") : t("card.idLabel")}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, opacity: 0.85 }}>
        {id}
      </span>
      <span aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6 }}>⧉</span>
    </div>
  );
}

/** Compact created date+time under the trade ID. History auditing needs a
 *  "when did this happen" anchor to correlate with wallet/LN records; a listing's
 *  age is useful in Browse too. createdAt is Unix SECONDS; guard the 0/absent case. */
function TradeTimeLine({ createdAt }: { createdAt: number }) {
  if (!createdAt || createdAt <= 0) return null;
  const when = new Date(createdAt * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  // Prominent by request: date+time is the second-most-regarded field after
  // price for auditing history, so give it real weight (not a 9px whisper).
  return (
    <div style={{
      marginTop: -4, marginBottom: 10,
      color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 600, lineHeight: 1.4,
    }}>
      {when}
    </div>
  );
}

function shortCategoryLabel(category: string, t: TFunc): string {
  if (category === "p2p-trade") return t("card.categoryExchange");
  if (category === "bill-pay") return t("card.categoryBillPay");
  if (category === "marketplace") return t("card.categoryMarket");
  if (category === "lending") return t("card.categoryLending");
  if (category === "raw-escrow") return t("card.categoryRaw");
  return category;
}

function fulfillmentLabel(fulfillment: EscrowState["fulfillment"], t: TFunc): string {
  if (fulfillment === "physical") return t("card.fulfillmentPhysical");
  if (fulfillment === "digital") return t("card.fulfillmentDigital");
  return t("card.fulfillmentService");
}

function menuBadgeLabel(category: string, t: TFunc): string {
  if (category === "p2p-trade") return t("card.menuBadgeOptions");
  if (category === "bill-pay") return t("card.menuBadgeBills");
  if (category === "lending") return t("card.menuBadgeLoans");
  return t("card.menuBadgeStore");
}

function menuSummary(
  category: string,
  count: number,
  fiatFloor: { amount: number; currency: string } | null,
  t: TFunc,
): string {
  const base = category === "p2p-trade"
    ? (count === 1 ? t("card.menuOptionOne") : t("card.menuOptionMany", { count }))
    : category === "bill-pay"
    ? (count === 1 ? t("card.menuBillOne") : t("card.menuBillMany", { count }))
    : category === "lending"
    ? (count === 1 ? t("card.menuLoanOne") : t("card.menuLoanMany", { count }))
    : (count === 1 ? t("card.menuItemOne") : t("card.menuItemMany", { count }));
  return fiatFloor
    ? `${base} · ${t("card.fromAmount", {
        currency: fiatFloor.currency,
        amount: fiatFloor.amount.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      })}`
    : base;
}

function menuFiatFloor(items: NonNullable<EscrowState["items"]>): { amount: number; currency: string } | null {
  const fiatItems = items.filter((item) => item.fiatAmount !== undefined && item.fiatCurrency);
  if (fiatItems.length === 0) return null;
  const currencies = new Set(fiatItems.map((item) => item.fiatCurrency));
  if (currencies.size !== 1) return null;
  const amount = Math.min(...fiatItems.map((item) => item.fiatAmount ?? Number.POSITIVE_INFINITY));
  const currency = fiatItems[0]?.fiatCurrency;
  return Number.isFinite(amount) && currency ? { amount, currency } : null;
}

function listingFiatCurrency(
  state: EscrowState,
  fiatFloor: { amount: number; currency: string } | null,
  communityCurrency: string | null | undefined,
): string | null {
  return normalizeFiatCurrency(state.fiatCurrency)
    ?? normalizeFiatCurrency(fiatFloor?.currency)
    ?? normalizeFiatCurrency(communityCurrency);
}

function estimatedFiatPrimaryLabel({
  amountMsats,
  currency,
  exchangeRange,
  menuItems,
  hasMenu,
  usdPerBtc,
  usdFiatRates,
  t,
}: {
  amountMsats: number;
  currency: string;
  exchangeRange: { minMsats: number; maxMsats: number } | null;
  menuItems: NonNullable<EscrowState["items"]>;
  hasMenu: boolean;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
  t: TFunc;
}): string | null {
  const normalizedCurrency = normalizeFiatCurrency(currency);
  if (!normalizedCurrency) return null;

  if (exchangeRange) {
    return estimatedFiatRangeLabel({
      minMsats: exchangeRange.minMsats,
      maxMsats: exchangeRange.maxMsats,
      currency: normalizedCurrency,
      usdPerBtc,
      usdFiatRates,
    });
  }

  const displayMsats = hasMenu && menuItems.length > 0
    ? Math.min(...menuItems.map(item => item.amountMsats))
    : amountMsats;
  const label = formatEstimatedFiatForMsats({
    amountMsats: displayMsats,
    currency: normalizedCurrency,
    usdPerBtc,
    usdFiatRates,
  });
  return label && hasMenu ? t("card.fromFiat", { amount: label }) : label;
}

function estimatedFiatRangeLabel({
  minMsats,
  maxMsats,
  currency,
  usdPerBtc,
  usdFiatRates,
}: {
  minMsats: number;
  maxMsats: number;
  currency: string;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): string | null {
  const min = estimateFiatForMsats({ amountMsats: minMsats, currency, usdPerBtc, usdFiatRates });
  const max = estimateFiatForMsats({ amountMsats: maxMsats, currency, usdPerBtc, usdFiatRates });
  if (min === null || max === null) return null;
  const minLabel = formatFiatAmount(min, currency);
  const maxLabel = formatFiatAmount(max, currency);
  return minLabel === maxLabel ? minLabel : `${minLabel}-${maxLabel.replace(`${currency} `, "")}`;
}

function exchangeBracketRange(items: NonNullable<EscrowState["items"]>): { minMsats: number; maxMsats: number } | null {
  const brackets = items
    .filter((item) => item.kind === "exchange-bracket")
    .map((item) => ({
      minMsats: item.minAmountMsats ?? item.amountMsats,
      maxMsats: item.maxAmountMsats ?? item.amountMsats,
    }))
    .filter((range) => range.minMsats > 0 && range.maxMsats >= range.minMsats);
  if (brackets.length === 0) return null;
  return {
    minMsats: Math.min(...brackets.map((range) => range.minMsats)),
    maxMsats: Math.max(...brackets.map((range) => range.maxMsats)),
  };
}

function satsRangeLabel(range: { minMsats: number; maxMsats: number }): string {
  const min = fmtSats(range.minMsats);
  const max = fmtSats(range.maxMsats);
  return min === max ? min : `${min}-${max}`;
}

function exchangeBracketLabels(items: NonNullable<EscrowState["items"]>): Array<{ id: string; name: string; label: string }> {
  return items
    .filter(item => item.kind === "exchange-bracket")
    .map(item => ({
      id: item.id,
      name: item.label,
      label: satsRangeLabel({
        minMsats: item.minAmountMsats ?? item.amountMsats,
        maxMsats: item.maxAmountMsats ?? item.amountMsats,
      }),
    }));
}

function paymentMethodsSummary(methods: string[] | undefined): string | null {
  const cleaned = (methods ?? []).map((method) => method.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const visible = cleaned.slice(0, 3).join(" · ");
  const extra = cleaned.length > 3 ? ` · +${cleaned.length - 3}` : "";
  return `${visible}${extra}`;
}

function compactStatusLabel(state: EscrowState, nowSec: number, viewerPubkey: string | undefined, t: TFunc): string {
  const { status } = state;
  if (
    status === EscrowStatus.CREATED &&
    TRINITY_RING_ORDER.some(role =>
      role !== state.initiator.role &&
      !!getEffectiveParticipantAt(state, role, nowSec)
    )
  ) {
    return t("card.statusJoined");
  }
  if (status === EscrowStatus.CREATED) return t("card.statusOpen");
  if (status === EscrowStatus.LOCKED) return t("card.statusEscrow");
  if (status === EscrowStatus.APPROVED) {
    // Resolved for someone else → the viewer's part is done; only the
    // winner still has a claim to make. Their chip reads Done, not Claim.
    if (viewerPubkey && state.resolvedOutcome) {
      const winner = payoutRecipientFor(state, state.resolvedOutcome);
      if (winner && winner.pubkey !== viewerPubkey) return t("card.statusDone");
    }
    return t("card.statusClaim");
  }
  if (status === EscrowStatus.CLAIMED) return t("card.statusSettling");
  if (status === EscrowStatus.COMPLETED) return t("card.statusDone");
  if (status === EscrowStatus.EXPIRED) return t("card.statusTimedOut");
  if (status === EscrowStatus.CANCELLED) return t("card.statusClosed");
  return status;
}

function MiniTrinityRing({
  state,
  pubkey,
  previewArbiterPk,
}: {
  state: EscrowState;
  pubkey: string;
  previewArbiterPk: string | null;
}) {
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      minWidth: 0,
    }}>
      {TRINITY_RING_ORDER.map((role, index) => {
        const previousRole = TRINITY_RING_ORDER[index - 1];
        const realPk = getEffectiveParticipantAt(state, role);
        const autoAssigned = role === Role.ARBITER && !realPk && !!previewArbiterPk;
        const pk = realPk ?? (autoAssigned ? previewArbiterPk : null);
        const filled = !!pk;
        const color = ROLE_COLOR[role] ?? T.muted;
        const isYou = pk === pubkey;
        const connectorRole = role === Role.ARBITER || previousRole === Role.ARBITER
          ? Role.ARBITER
          : role;
        const connectorColor = ROLE_COLOR[connectorRole] ?? T.muted;
        const connectorFilled = connectorRole === Role.ARBITER
          ? !!(getEffectiveParticipantAt(state, Role.ARBITER) ?? previewArbiterPk)
          : filled;
        return (
          <div key={role} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {index > 0 && (
              <span style={{
                width: 12, height: 1,
                background: connectorFilled ? `${connectorColor}55` : T.border,
                display: "inline-block",
              }} />
            )}
            <span
              title={filled
                ? t("card.ringRoleTaken", { role, who: isYou ? t("card.you") : (pk ?? "") })
                : t("card.ringRoleOpen", { role })}
              style={{
                width: 22, height: 22, borderRadius: "50%",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                border: `1px ${filled ? "solid" : "dashed"} ${filled ? color : T.border}`,
                background: filled ? (autoAssigned ? `${color}12` : `${color}22`) : T.surface,
                color: filled ? color : T.muted,
                fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                opacity: autoAssigned ? 0.78 : 1,
                boxShadow: isYou ? `0 0 0 2px ${color}22` : "none",
              }}
            >
              {ROLE_ICON[role] ?? "?"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function compactJoinHoldRemaining(state: EscrowState, nowSec: number, t: TFunc): { label: string; tone: string } | null {
  if (state.status !== EscrowStatus.CREATED) return null;
  const activeHoldRoles = TRINITY_RING_ORDER
    .filter(role => role !== state.initiator.role)
    .map(role => [role, getJoinHoldRemainingSeconds(state, role, nowSec)] as const)
    .filter(([, remaining]) => remaining !== null && remaining > 0);
  if (!activeHoldRoles.length) return null;

  const remaining = Math.min(...activeHoldRoles.map(([, r]) => r ?? Infinity));
  const minutes = Math.max(1, Math.ceil(remaining / 60));
  const tone = remaining < 120 ? T.red : remaining < 300 ? T.amber : T.muted;
  return { label: t("card.lockCountdown", { minutes }), tone };
}

function compactTimeRemaining(state: EscrowState, nowSec: number, t: TFunc): { label: string; tone: string } | null {
  if (!state.expiresAt) return null;
  if (
    state.status === EscrowStatus.COMPLETED
    || state.status === EscrowStatus.CANCELLED
    || state.status === EscrowStatus.CLAIMED
  ) {
    return null;
  }
  const remaining = state.expiresAt - nowSec;
  if (remaining <= 0) return { label: t("card.expired"), tone: T.red };
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const tone = remaining < 600 ? T.red : remaining < 3600 ? T.amber : T.muted;
  const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return {
    label: state.status === EscrowStatus.CREATED ? t("card.listingCountdown", { time: label }) : label,
    tone,
  };
}
