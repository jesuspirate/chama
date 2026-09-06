import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Role, type EscrowState } from "../../escrow-engine/types.js";
import { ChamaLoader } from "../components/ChamaLoader.js";
import {
  ASSISTED_CANVAS_ASSETS,
  assistedWantChoices,
  countCounterDemand,
  inferredAssistedWant,
  matchGuidedListings,
  matchMarketListings,
  recommendGuidedCandidates,
  validateGuidedTradeIntent,
  type AssistedCanvasAsset,
  type CanvasCreatePrefill,
  type GuidedMatchCandidate,
  type MarketMatch,
} from "../../guided/index.js";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { billTypeDisplay, billTypesForCountry } from "../../communities/bill-types.js";
import { saveIntent } from "../../guided/saved-intents.js";
import { registerCommunityWake } from "../../notifications/watch-tags.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getRailByKey, railsForCommunity, toRailKey } from "../../payments/rail-registry.js";
import {
  addSavedHandle,
  listSavedHandles,
  paymentHandleNeedsCountryCode,
  phonePlaceholderForCountryIso,
} from "../../payments/saved-handles.js";
import type { AggregateRatings } from "../../reputation/ratings.js";
import { estimateSatsForFiat } from "../amount-display.js";
import { shareTradeLink } from "../share-link.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import { T } from "../theme.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

// Render-time translation (same pattern as decisions.ts) — module-level so the
// pure copy helpers below (detailCopy, termsCopy, …) localize without threading
// a t() prop through every little presentational component.
const tr = (key: string, params?: Record<string, string | number>) =>
  translate(getCurrentLang(), key, params);

type Surface = "bring" | "want" | "detail" | "terms" | "rails" | "premium" | "matches" | "review" | "publish";

/** A point-in-time snapshot of the canvas conversation, written on unmount and
 *  replayed on the next mount so opening a trade (or hopping tabs) and coming
 *  BACK does not reset the user to "What are you bringing?". Held by the parent
 *  in a plain mutable ref — no storage, dies with the app session. */
export interface AssistedCanvasResume {
  at: number;
  surface: Surface;
  bring: AssistedCanvasAsset | null;
  want: AssistedCanvasAsset | null;
  detail: string;
  detailMax: string;
  terms: string;
  paymentRails: string[];
  matches: GuidedMatchCandidate[];
  goodsMatches: MarketMatch[];
  matchWhy: string | null;
  premiumBps: number;
  premiumMode: "preset" | "custom";
  premiumInput: string;
}

/** Results older than this replay as a fresh canvas — live offers move. */
const CANVAS_RESUME_MAX_AGE_MS = 10 * 60 * 1000;

export function AssistedCanvas({
  listings,
  stockByListing,
  browseCommunity,
  activeMintUrl,
  viewerPubkey,
  listingsLoading,
  fetchRatingSummary,
  onBrowse,
  onCreate,
  onMoreOptions,
  onOpenTrade,
  publishedInfo,
  onDismissPublished,
  resumeRef,
}: {
  listings: EscrowState[];
  stockByListing?: Map<string, number>;
  browseCommunity: string;
  activeMintUrl?: string | null;
  viewerPubkey: string;
  listingsLoading: boolean;
  fetchRatingSummary?: (ratee: string) => Promise<AggregateRatings>;
  onBrowse: (category: string) => void;
  onCreate: (intent: CanvasCreatePrefill) => void;
  onMoreOptions: () => void;
  onOpenTrade: (id: string) => void;
  publishedInfo?: { label: string; escrowId?: string } | null;
  onDismissPublished?: () => void;
  resumeRef?: { current: AssistedCanvasResume | null };
}) {
  const community = getCommunityBySlug(browseCommunity);
  const phoneExample = phonePlaceholderForCountryIso(community?.countries?.[0])
    ?? "+1 555 555 5555";
  const fiatCurrency = defaultCurrencyForCommunity(browseCommunity);
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  // Replay the last snapshot (if fresh) so back-from-a-trade lands on the same
  // step — usually the match results — instead of a blank canvas.
  const resume = resumeRef?.current && Date.now() - resumeRef.current.at <= CANVAS_RESUME_MAX_AGE_MS
    ? resumeRef.current
    : null;
  const [surface, setSurface] = useState<Surface>(resume?.surface ?? "bring");
  const [bring, setBring] = useState<AssistedCanvasAsset | null>(resume?.bring ?? null);
  const [want, setWant] = useState<AssistedCanvasAsset | null>(resume?.want ?? null);
  const [detail, setDetail] = useState(resume?.detail ?? "");
  // Second half of the Exchange sell RANGE (min = detail, max = detailMax).
  const [detailMax, setDetailMax] = useState(resume?.detailMax ?? "");
  const [terms, setTerms] = useState(resume?.terms ?? "");
  const [paymentRails, setPaymentRails] = useState<string[]>(resume?.paymentRails ?? []);
  // Why the nearest offers were rejected (debug + honest no-match copy).
  const [matchWhy, setMatchWhy] = useState<string | null>(resume?.matchWhy ?? null);
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<GuidedMatchCandidate[]>(resume?.matches ?? []);
  const [goodsMatches, setGoodsMatches] = useState<MarketMatch[]>(resume?.goodsMatches ?? []);
  const [selected, setSelected] = useState<GuidedMatchCandidate | null>(null);
  const [paymentDetailDrafts, setPaymentDetailDrafts] = useState<Record<string, string>>({});
  const [paymentDetailError, setPaymentDetailError] = useState<string | null>(null);
  const [savedHandlesRevision, setSavedHandlesRevision] = useState(0);
  const [notified, setNotified] = useState(false);
  const [premiumBps, setPremiumBps] = useState(resume?.premiumBps ?? 0);
  const [shareCopied, setShareCopied] = useState(false);
  const [premiumMode, setPremiumMode] = useState<"preset" | "custom">(resume?.premiumMode ?? "preset");
  const [premiumInput, setPremiumInput] = useState(resume?.premiumInput ?? "");

  // Snapshot every render into a plain ref; hand it to the parent on unmount.
  const snapshotRef = useRef<AssistedCanvasResume | null>(null);
  snapshotRef.current = {
    at: Date.now(), surface, bring, want, detail, detailMax, terms, paymentRails,
    matches, goodsMatches, matchWhy, premiumBps, premiumMode, premiumInput,
  };
  useEffect(() => () => {
    if (resumeRef) resumeRef.current = snapshotRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listingInputs = useMemo(() => listings.map(listing => ({
    listing,
    availableUnits: stockByListing?.get(listing.id),
  })), [listings, stockByListing]);
  const count = (from: AssistedCanvasAsset, to: AssistedCanvasAsset) => countCounterDemand(
    from,
    to,
    listingInputs,
    { viewerPubkey, community: browseCommunity, nowSec: Math.floor(Date.now() / 1000) },
  );
  const cashOffers = useMemo(() => count("cash", "sats").count, [listingInputs, viewerPubkey, browseCommunity]);
  const goodsOffers = useMemo(() => count("sats", "goods").count, [listingInputs, viewerPubkey, browseCommunity]);

  const railChoices = useMemo(() => {
    const advertised = new Set(
      listings
        .filter(listing => listing.category === "p2p-trade" || listing.category === "bill-pay")
        .flatMap(listing => listing.paymentMethods ?? [])
        .map(key => key.trim().toLowerCase())
        .filter(Boolean),
    );
    const local = railsForCommunity(browseCommunity);
    return [
      ...local.filter(rail => advertised.has(rail.key)),
      ...local.filter(rail => !advertised.has(rail.key)),
      ...[...advertised]
        .map(getRailByKey)
        .filter((rail): rail is NonNullable<typeof rail> => !!rail && !local.some(value => value.key === rail.key)),
    ].slice(0, 12);
  }, [listings, browseCommunity]);
  const effectiveRails = railChoices.map(rail => rail.key).filter(key => paymentRails.includes(key));
  const configuredRailKeys = useMemo(() => new Set(listSavedHandles().flatMap(handle => [
    toRailKey(handle.rail),
    ...(handle.networks ?? []).map(toRailKey),
  ])), [savedHandlesRevision]);
  // Who must have payment details on file BEFORE publishing? The party whose
  // LOCK will reveal them: the Exchange seller (where the fiat lands) and the
  // Bill Pay bill-owner (the account the volunteer pays). Captured here, saved
  // privately on-device, revealed only inside the locked trade (NIP-44).
  const collectsHandles = (bring === "sats" && want === "cash") || bring === "bill";
  const missingPaymentRails = collectsHandles
    ? effectiveRails.filter(key => !configuredRailKeys.has(toRailKey(key)))
    : [];
  const savePaymentDetail = (railKey: string) => {
    const value = paymentDetailDrafts[railKey]?.trim() ?? "";
    const rail = getRailByKey(railKey);
    if (!value) {
      setPaymentDetailError(tr("canvas.enterRailDetails", { rail: rail?.displayName ?? railKey }));
      return;
    }
    try {
      addSavedHandle(toRailKey(railKey), value);
      setPaymentDetailDrafts(current => {
        const next = { ...current };
        delete next[railKey];
        return next;
      });
      setPaymentDetailError(null);
      setSavedHandlesRevision(current => current + 1);
    } catch (cause) {
      setPaymentDetailError(cause instanceof Error ? cause.message : tr("canvas.detailsSaveFailed"));
    }
  };

  const toggleRail = (key: string) => setPaymentRails(current => current.includes(key) ? current.filter(k => k !== key) : [...current, key]);
  const routeLabel = bring && want ? `${assetLabel(bring, fiatCurrency)} → ${assetLabel(want, fiatCurrency)}` : "";
  const resetForward = () => {
    setDetail(""); setDetailMax(""); setTerms(""); setPaymentRails([]); setError(null);
    setMatches([]); setGoodsMatches([]); setSelected(null); setNotified(false);
    setPremiumBps(0); setPremiumMode("preset"); setPremiumInput("");
  };
  const chooseBring = (asset: AssistedCanvasAsset) => {
    resetForward();
    setBring(asset);
    const inferred = inferredAssistedWant(asset);
    if (inferred) {
      setWant(inferred);
      setSurface("detail");
    } else {
      setWant(null);
      setSurface("want");
    }
  };
  const chooseWant = (asset: AssistedCanvasAsset) => {
    resetForward();
    setWant(asset);
    setSurface("detail");
  };

  const renderHandleNudge = () => (
    missingPaymentRails.length > 0 ? (
      <div className="assisted-payment-nudge">
        <div className="assisted-payment-nudge-copy">
          <strong>{tr("canvas.detailsMissingFor", { rails: paymentRailLabels(missingPaymentRails) })}</strong>
          <span>{bring === "bill" ? tr("canvas.billDetailsSub") : tr("canvas.detailsMissingSub")}</span>
        </div>
        <div className="assisted-payment-fields">
          {missingPaymentRails.map(key => {
            const rail = getRailByKey(key);
            const draft = paymentDetailDrafts[key] ?? "";
            const showCountryCodeNudge = rail?.placeholder?.includes("+") === true
              && (!draft.trim() || paymentHandleNeedsCountryCode(key, draft));
            return <label key={key}>
              <span>{rail?.displayName ?? key}</span>
              <div>
                <input
                  value={draft}
                  onChange={event => {
                    setPaymentDetailDrafts(current => ({ ...current, [key]: event.target.value }));
                    setPaymentDetailError(null);
                  }}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      savePaymentDetail(key);
                    }
                  }}
                  placeholder={rail?.placeholderKey ? tr("canvas.yourPaymentDetails") : rail?.placeholder ?? tr("canvas.yourPaymentDetails")}
                  autoComplete="off"
                />
                <button type="button" onClick={() => savePaymentDetail(key)}>{tr("canvas.save")}</button>
              </div>
              {showCountryCodeNudge && (
                <small className="assisted-phone-hint">
                  {tr("canvas.phoneHint", { example: phoneExample })}
                </small>
              )}
            </label>;
          })}
        </div>
        {paymentDetailError && <div className="assisted-payment-error">{paymentDetailError}</div>}
      </div>
    ) : (
      <div className="assisted-payment-ready">{tr("canvas.detailsReady")}</div>
    )
  );

  const detailConfig = detailCopy(bring, want, fiatCurrency);
  const termsConfig = termsCopy(bring, want, fiatCurrency);
  // Jet 2026-09-05: sellers ALWAYS offer a range — no single offers, ever.
  const sellRange = bring === "sats" && want === "cash";
  const rangeMin = positiveNumber(detail);
  const rangeMax = positiveNumber(detailMax);
  const detailValid = detailConfig.kind === "text"
    ? detail.trim().length >= 2
    : sellRange
      ? rangeMin !== null && rangeMax !== null && rangeMax > rangeMin
      : positiveNumber(detail) !== null;
  const termsValid = termsConfig.kind === "rail"
    ? effectiveRails.length > 0
    : termsConfig.kind === "bill"
      ? !!terms
      : positiveNumber(terms) !== null;

  const continueFromDetail = () => {
    if (!detailValid) {
      setError(sellRange && rangeMin !== null && (rangeMax === null || rangeMax <= rangeMin)
        ? tr("canvas.rangeErr")
        : detailConfig.error);
      return;
    }
    setError(null);
    const soleRail = termsConfig.kind === "rail" && railChoices.length === 1 ? railChoices[0]! : null;
    if (soleRail) {
      setPaymentRails([soleRail.key]);
      // A lone rail normally skips the terms question. But a sats→cash seller
      // still needs their payment handle on file, so show terms (rail already
      // selected, nudge visible) when it's missing; otherwise advance straight.
      const needsHandle = bring === "sats" && want === "cash" && !configuredRailKeys.has(toRailKey(soleRail.key));
      if (needsHandle) { setSurface("terms"); return; }
      void finishRoute([soleRail.key]);
      return;
    }
    setSurface("terms");
  };

  const finishRoute = async (rails = effectiveRails) => {
    if (!bring || !want) return;
    if (bring === "cash" && want === "sats") {
      await findCashToSatsMatches(rails);
      return;
    }
    if (bring === "sats" && want === "goods") {
      const ids = new Set(count("sats", "goods").listingIds);
      setGoodsMatches(matchMarketListings(
        listings.filter(listing => ids.has(listing.id)),
        { query: detail, budgetSats: positiveNumber(terms) ?? 1, limit: 16 },
      ));
      setSurface("matches");
      return;
    }
    if (bring === "bill") { setSurface("rails"); return; }
    setSurface(bring === "sats" && want === "cash" ? "premium" : "publish");
  };

  const findCashToSatsMatches = async (rails: string[]) => {
    const budget = positiveNumber(detail);
    if (!budget || rails.length === 0) { setError(tr("canvas.enterAmountAndRail")); return; }
    setMatching(true); setError(null); setMatches([]);
    try {
      const candidateAmounts = [...new Set(listings
        .filter(listing => listing.category === "p2p-trade" || listing.category === "bill-pay")
        .flatMap(listing => [Math.floor(listing.amountMsats / 1000), ...(listing.items ?? []).map(item => Math.floor(item.amountMsats / 1000))])
        .filter(amount => Number.isFinite(amount) && amount > 0))];
      const deduped = new Map<string, GuidedMatchCandidate>();
      const rejByListing = new Map<string, string>();
      // Premium-priced Exchange listings publish with NO stored fiat quote (the
      // price is "market ± premium"), so the pure matcher rejects them with
      // FIAT_QUOTE_REQUIRED against any fiat budget. The matcher must never
      // invent quotes — so the CALLER supplies one: a live view-layer estimate
      // (sats × live price × premium) injected into a copy of the listing.
      // Non-menu p2p listings only; nothing on published state changes.
      const usdPerBtc = btcPrice.usd;
      const fxRate = fiatCurrency === "USD" ? 1 : fiatRates.rates?.[fiatCurrency];
      const inputs = listingInputs.map(input => {
        const l = input.listing;
        if (
          l.category !== "p2p-trade" || l.fiatAmount !== undefined || l.items?.length
          || !usdPerBtc || !fxRate
        ) return input;
        const est = Math.round(
          (l.amountMsats / 1000 / 1e8) * usdPerBtc * fxRate
          * (1 + (l.premiumBps ?? 0) / 10000) * 100,
        ) / 100;
        if (!Number.isFinite(est) || est <= 0) return input;
        return { ...input, listing: { ...l, fiatAmount: est, fiatCurrency } };
      });
      // Range listings (exchange-bracket items): probe each bracket at the
      // buyer's BEST-FIT amount for this budget — floor(budget / unit price,
      // premium included), clamped into the bracket — so a 10k–100k offer
      // meets a 3,000 TZS budget at the most sats that budget buys, not only
      // at the bracket's minimum.
      const pricePerSat = usdPerBtc && fxRate ? (usdPerBtc * fxRate) / 1e8 : null;
      const bracketFit: number[] = [];
      if (pricePerSat) {
        for (const { listing: l } of inputs) {
          if (l.category !== "p2p-trade" || !l.items?.length) continue;
          for (const item of l.items) {
            if (item.kind !== "exchange-bracket") continue;
            const minSats = Math.floor((item.minAmountMsats ?? item.amountMsats) / 1000);
            const maxSats = Math.floor((item.maxAmountMsats ?? item.amountMsats) / 1000);
            const perSat = pricePerSat * (1 + (l.premiumBps ?? 0) / 10000);
            const fit = Math.min(maxSats, Math.max(minSats, Math.floor(budget / perSat)));
            if (Number.isFinite(fit) && fit > 0) bracketFit.push(fit);
          }
        }
      }
      const allAmounts = [...new Set([...candidateAmounts, ...bracketFit])];
      for (const amountSats of allAmounts) {
        const validated = validateGuidedTradeIntent({
          version: 1,
          direction: "buy_sats",
          amountSats,
          paymentRails: rails,
          strategy: "available_now",
          community: browseCommunity,
          ...(activeMintUrl ? { mintUrl: activeMintUrl } : {}),
          maxFiatAmount: budget,
          fiatCurrency,
        });
        if (!validated.ok) continue;
        // Per-amount item quotes: a bracket item stores no fiat (premium
        // pricing), and the matcher must never invent quotes — so the caller
        // stamps est(amount) onto items whose range covers THIS amount.
        const inputsForAmount = pricePerSat
          ? inputs.map(input => {
              const l = input.listing;
              if (l.category !== "p2p-trade" || !l.items?.length) return input;
              let changed = false;
              const items = l.items.map(item => {
                if (item.kind !== "exchange-bracket" || item.fiatAmount !== undefined) return item;
                const msats = amountSats * 1000;
                if (msats < (item.minAmountMsats ?? item.amountMsats) || msats > (item.maxAmountMsats ?? item.amountMsats)) return item;
                const est = Math.round(amountSats * pricePerSat * (1 + (l.premiumBps ?? 0) / 10000) * 100) / 100;
                if (!Number.isFinite(est) || est <= 0) return item;
                changed = true;
                return { ...item, fiatAmount: est, fiatCurrency };
              });
              return changed ? { ...input, listing: { ...l, items } } : input;
            })
          : inputs;
        const result = matchGuidedListings(validated.value, inputsForAmount, { viewerPubkey, limit: 20 });
        for (const candidate of result.candidates) {
          const key = `${candidate.listing.id}:${candidate.selectedItem?.itemId ?? "single"}:${candidate.amountSats}`;
          if (!deduped.has(key)) deduped.set(key, candidate);
        }
        // The amount varies per candidate, so a persistent NON-amount code is the
        // real blocker — keep it over a transient AMOUNT_MISMATCH.
        for (const rej of result.rejected) {
          const prev = rejByListing.get(rej.listingId);
          if (!prev || prev === "AMOUNT_MISMATCH") rejByListing.set(rej.listingId, rej.code);
        }
      }
      let ranked = [...deduped.values()].sort((a, b) =>
        b.score.total - a.score.total || a.listing.id.localeCompare(b.listing.id)
      );
      if (fetchRatingSummary && ranked.length > 0) {
        const ratings = new Map<string, AggregateRatings>();
        await Promise.all(ranked.map(async candidate => {
          if (ratings.has(candidate.sellerPubkey)) return;
          try { ratings.set(candidate.sellerPubkey, await fetchRatingSummary(candidate.sellerPubkey)); }
          catch { ratings.set(candidate.sellerPubkey, { count: 0, positive: 0, negative: 0 }); }
        }));
        ranked = ranked.map(candidate => ({ ...candidate, ratings: ratings.get(candidate.sellerPubkey) }));
      }
      setMatches(ranked);
      if (ranked.length === 0) {
        const labelFor: Record<string, string> = {
          PAYMENT_RAIL_MISMATCH: tr("canvas.rejPaymentRail"), COMMUNITY_MISMATCH: tr("canvas.rejCommunity"),
          FEDERATION_MISMATCH: tr("canvas.rejFederation"), SELF_LISTING: tr("canvas.rejSelfListing"),
          OVER_MAX_FIAT: tr("canvas.rejOverBudget"), FIAT_CURRENCY_MISMATCH: tr("canvas.rejCurrency"),
          RESERVED: tr("canvas.rejReserved"), OUT_OF_STOCK: tr("canvas.rejSoldOut"),
          EXPIRED: tr("canvas.rejExpired"), AMOUNT_MISMATCH: tr("canvas.rejAmount"),
        };
        const counts = new Map<string, number>();
        for (const code of rejByListing.values()) {
          const label = labelFor[code] ?? code.toLowerCase().replace(/_/g, " ");
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        const seen = listings.filter(l => l.category === "p2p-trade" || l.category === "bill-pay").length;
        const why = [...counts.entries()].sort((a, b) => b[1] - a[1])
          .map(([label, n]) => `${label} (${n})`).join(" · ");
        setMatchWhy(`${tr(seen === 1 ? "canvas.sawOffer" : "canvas.sawOffers", { count: seen })}${why ? " · " + why : ""}`);
        setError(listingsLoading ? tr("canvas.stillCheckingOffers") : tr("canvas.noCompatibleOffers"));
      } else {
        setMatchWhy(null);
      }
      setSurface("matches");
    } finally {
      setMatching(false);
    }
  };

  // Late-hydration refresh: relays keep streaming listings after login, so a
  // search fired "too fast" honestly sees zero offers. While the user sits on
  // an EMPTY match result, quietly re-run the same search as listings arrive —
  // the empty screen upgrades itself the moment the market finishes loading.
  useEffect(() => {
    if (surface !== "matches") return;
    if (bring === "sats" && want === "goods") return;
    if (matching || matches.length > 0) return;
    if (!positiveNumber(detail) || effectiveRails.length === 0) return;
    void findCashToSatsMatches(effectiveRails);
    // Intentionally listings-only: state set by the search itself must not loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings]);

  // Refine-as-you-type: editing the budget on the results screen re-runs the
  // search after a short pause, so widening 1000 → 3000 pulls bigger offers
  // back in without hunting for the button. Narrowing is already instant via
  // the visibleMatches filter.
  useEffect(() => {
    if (surface !== "matches") return;
    if (bring === "sats" && want === "goods") return;
    if (!positiveNumber(detail) || effectiveRails.length === 0) return;
    const timer = setTimeout(() => {
      if (!matching) void findCashToSatsMatches(effectiveRails);
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  // Local money and a bill are both fiat-denominated inputs (amount + rate).
  const fiatBring = bring === "cash" || bring === "bill";
  const estimatedSats = fiatBring
    ? estimateSatsForFiat({
        fiatAmount: positiveNumber(detail) ?? 0,
        currency: fiatCurrency,
        usdPerBtc: btcPrice.usd,
        usdFiatRates: fiatRates.rates,
      })
    : null;

  const openPreparedOffer = () => {
    if (!bring || !want) return;
    if (bring === "bill") {
      onCreate({
        vertical: "bill-pay",
        emphasizePremium: true,
        emphasizePaymentMethods: true,
        fiatAmount: positiveNumber(detail) ?? undefined,
        amountSats: estimatedSats ?? undefined,
        fiatCurrency,
        billType: terms || undefined,
        paymentMethods: effectiveRails.length ? effectiveRails : undefined,
        premiumBps,
        autoPublish: true,
      });
      return;
    }
    if (bring === "goods") {
      onCreate({ vertical: "marketplace", description: detail.trim(), amountSats: positiveNumber(terms) ?? undefined, stock: 1, autoPublish: true });
      return;
    }
    onCreate({
      vertical: "p2p-trade",
      emphasizePremium: bring === "sats" && want === "cash",
      amountSats: positiveNumber(detail) ?? undefined,
      ...(sellRange && rangeMax !== null ? { maxAmountSats: rangeMax } : {}),
      fiatCurrency,
      paymentMethods: effectiveRails,
      premiumBps,
      autoPublish: true,
    });
  };

  const intentSummary = bring === "sats" && want === "goods"
    ? `“${detail.trim() || tr("canvas.that")}”`
    : tr("canvas.satsFor", { currency: fiatCurrency, amount: (positiveNumber(detail) ?? 0).toLocaleString() });
  const saveCurrentIntent = () => {
    if (!bring || !want) return;
    saveIntent({
      bring, want, community: browseCommunity, fiatCurrency,
      fiatAmount: bring === "cash" ? positiveNumber(detail) ?? undefined : undefined,
      query: bring === "sats" && want === "goods" ? (detail.trim() || undefined) : undefined,
      amountSats: bring === "sats" && want === "goods" ? positiveNumber(terms) ?? undefined : undefined,
      paymentRails: effectiveRails.length ? effectiveRails : undefined,
    }, viewerPubkey);
    void registerCommunityWake(browseCommunity);
    setNotified(true);
  };
  // Live budget guard: the refine bar edits `detail` faster than a re-search
  // lands, and a stale result list must NEVER show an offer above the number
  // the user is currently looking at ("Up to 1000" showing a 2,146 TZS card).
  // The debounced effect below re-searches to WIDEN; this filter instantly
  // NARROWS what is already on screen.
  const budgetNow = positiveNumber(detail);
  const visibleMatches = useMemo(
    () => matches.filter(candidate =>
      budgetNow === null || !candidate.fiatQuote || candidate.fiatQuote.amount <= budgetNow),
    [matches, detail],
  );
  const recommendations = recommendGuidedCandidates(visibleMatches, fiatCurrency);
  const billOpportunity = visibleMatches.find(candidate => candidate.listing.category === "bill-pay") ?? null;
  const recommended = uniqueCandidates([
    [tr("guided.bestOverall"), recommendations.bestOverall],
    [tr("guided.lowestPrice"), recommendations.lowestPrice],
    [tr("guided.mostTrusted"), recommendations.mostTrusted],
    [tr("browse.catBillPay"), billOpportunity],
  ]);

  if (publishedInfo) {
    return <CanvasShell community={community} step={3} onExit={() => { onDismissPublished?.(); onBrowse("all"); }} onMoreOptions={onMoreOptions}>
      <Kicker>{tr("canvas.liveKicker")}</Kicker>
      <h1 style={headingStyle()}>{tr("canvas.liveTitle")}</h1>
      <p style={subStyle()}>{tr("canvas.liveSub")}</p>
      <div style={reviewStyle()}>
        <ReviewRow label={tr("canvas.statusLabel")} value={tr("canvas.statusPublished")} />
        <ReviewRow label={tr("canvas.whatsNext")} value={tr("canvas.whatsNextValue")} last />
      </div>
      {publishedInfo.escrowId && (
        <div className="assisted-linky" style={{ marginBottom: 4 }}>
          <button
            type="button"
            onClick={() => {
              void shareTradeLink(publishedInfo.escrowId!).then(result => {
                if (result === "copied") { setShareCopied(true); setTimeout(() => setShareCopied(false), 2500); }
              });
            }}
          >
            {shareCopied ? tr("canvas.linkCopied") : tr("canvas.shareOffer")}
          </button>
        </div>
      )}
      <Primary onClick={() => { onDismissPublished?.(); resetForward(); setBring(null); setWant(null); setSurface("bring"); }}>{tr("canvas.postAnother")}</Primary>
      <div className="assisted-linky"><button type="button" onClick={() => { onDismissPublished?.(); onBrowse("all"); }}>{tr("canvas.seeMarket")}</button></div>
    </CanvasShell>;
  }

  if (surface === "rails") {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("terms")}>{tr("canvas.changeLast")}</Back>
      <Kicker>{tr("canvas.acceptedPayment")}</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{tr("canvas.volunteerPayQ")}</h1>
      <p style={subStyle()}>{tr("canvas.volunteerPaySub")}</p>
      <QuestionCard>
        <RailGrid railChoices={railChoices} effectiveRails={effectiveRails} onToggle={toggleRail} ariaLabel={tr("canvas.railsAria")} />
        <div className="assisted-rail-help">{effectiveRails.length > 0 ? tr("canvas.nSelected", { count: effectiveRails.length }) : tr("canvas.selectAtLeastOneAccept")}</div>
        {effectiveRails.length > 0 && renderHandleNudge()}
        <Primary disabled={effectiveRails.length === 0} onClick={() => setSurface("premium")}>{tr("canvas.continue")}</Primary>
      </QuestionCard>
    </CanvasShell>;
  }

  if (surface === "premium") {
    const isBill = bring === "bill";
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface(bring === "bill" ? "rails" : "terms")}>{tr("canvas.changeLast")}</Back>
      <Kicker>{isBill ? tr("canvas.volunteerBonus") : tr("canvas.yourRate")}</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{isBill ? tr("canvas.bonusQ") : tr("canvas.rateQ")}</h1>
      <p style={subStyle()}>{isBill ? tr("canvas.bonusSub") : tr("canvas.rateSub")}</p>
      <QuestionCard>
        <div className="assisted-premium-grid" role="group" aria-label={tr("canvas.premiumAria")}>
          {[{ bps: 0, label: tr("canvas.marketRate") }, { bps: 200, label: "+2%" }, { bps: 500, label: "+5%" }].map(preset => {
            const active = premiumMode === "preset" && premiumBps === preset.bps;
            return <button key={preset.bps} type="button" className={active ? "selected" : ""} aria-pressed={active} onClick={() => { setPremiumMode("preset"); setPremiumBps(preset.bps); }}>{preset.label}</button>;
          })}
          <button type="button" className={premiumMode === "custom" ? "selected" : ""} aria-pressed={premiumMode === "custom"} onClick={() => setPremiumMode("custom")}>{tr("canvas.custom")}</button>
        </div>
        {premiumMode === "custom" && <div style={amountLineStyle()}><span>+</span><input autoFocus inputMode="decimal" value={premiumInput} onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ""); setPremiumInput(v); setPremiumBps(Math.round((parseFloat(v) || 0) * 100)); }} placeholder="0" style={bareInputStyle()} /><span>{tr("canvas.overSpot")}</span></div>}
        <Primary onClick={() => setSurface("publish")}>{tr("canvas.continue")}</Primary>
      </QuestionCard>
    </CanvasShell>;
  }

  if (surface === "review" && selected) {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("matches")}>{tr("canvas.backToMatches")}</Back>
      <Kicker>{tr("canvas.exactPreview")}</Kicker>
      <h1 style={headingStyle()}>{tr("canvas.reviewMatch")}</h1>
      <p style={subStyle()}>{tr("canvas.reviewMatchSub")}</p>
      <div style={reviewStyle()}>
        <ReviewRow label={tr("canvas.youReceive")} value={tr("canvas.satsValue", { amount: selected.amountSats.toLocaleString() })} />
        <ReviewRow label={tr("canvas.youPay")} value={selected.fiatQuote ? `${selected.fiatQuote.amount.toLocaleString()} ${selected.fiatQuote.currency}` : tr("canvas.confirmWithSeller")} />
        <ReviewRow label={tr("canvas.paymentMethod")} value={getRailByKey(selected.paymentRail)?.displayName ?? selected.paymentRail} />
        <ReviewRow label={tr("canvas.seller")} value={shortKey(selected.sellerPubkey)} last />
      </div>
      <Primary onClick={() => onOpenTrade(selected.listing.id)}>{tr("canvas.reviewFullTrade")}</Primary>
      <Safety>{tr("canvas.reviewSafety")}</Safety>
    </CanvasShell>;
  }

  if (surface === "matches") {
    const isGoods = bring === "sats" && want === "goods";
    // Recommendation winners collapse onto one card when a single offer sweeps
    // Best/Lowest/Trusted — but every compatible offer must still be visible.
    // Loading is not failure: while the relays are still hydrating (or a search
    // is in flight) with nothing to show yet, spin calmly instead of the red box.
    const stillChecking = !isGoods && (matching || listingsLoading) && visibleMatches.length === 0;
    const shownKeys = new Set(recommended.map(({ candidate }) => `${candidate.listing.id}:${candidate.amountSats}`));
    const alsoCompatible = visibleMatches
      .filter(c => !shownKeys.has(`${c.listing.id}:${c.amountSats}`))
      .slice(0, 8);
    const noMatches = !matching && !listingsLoading && (isGoods ? goodsMatches.length === 0 : visibleMatches.length === 0);
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("terms")}>{tr("canvas.changeLast")}</Back>
      <Kicker>{isGoods ? tr("canvas.availableNow", { count: goodsMatches.length }) : tr("canvas.compatibleOffers", { count: visibleMatches.length })}</Kicker>
      <h1 style={headingStyle()}>{noMatches ? tr("canvas.noMatchTitle") : isGoods ? tr("canvas.goodsTitle") : tr("canvas.chooseTitle")}</h1>
      <p style={subStyle()}>{noMatches ? tr("canvas.noMatchSub") : isGoods ? tr("canvas.goodsSub") : tr("canvas.chooseSub")}</p>
      {!isGoods && (
        <div style={{ ...amountLineStyle(), marginBottom: 18, flexWrap: "wrap" }}>
          <span>{tr("canvas.upTo")}</span>
          <input
            inputMode="decimal"
            value={detail}
            onChange={e => setDetail(e.target.value.replace(/[^\d.]/g, ""))}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); if (!matching) void findCashToSatsMatches(effectiveRails); }
            }}
            placeholder="10"
            aria-label={tr("canvas.maxBudgetAria")}
            style={{
              ...bareInputStyle(),
              // Hug the currency: content-width, not a full-row stretch — and a
              // dashed underline so it reads as editable, not as static text.
              flex: "0 1 auto",
              width: `${Math.max(detail.length, 1) + 0.5}ch`,
              minWidth: "1.5ch",
              textAlign: "center",
              borderBottom: `3px dashed ${T.accent}88`,
              paddingBottom: 2,
            }}
          />
          <span>{fiatCurrency}</span>
          <button
            type="button"
            disabled={matching}
            onClick={() => { if (!matching) void findCashToSatsMatches(effectiveRails); }}
            style={{
              marginLeft: 10, padding: "8px 16px", borderRadius: 999,
              background: T.accentDim, border: `1px solid ${T.accent}66`,
              color: T.accent, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
              cursor: matching ? "default" : "pointer",
            }}
          >
            {matching ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span style={{
                  width: 12, height: 12, borderRadius: "50%",
                  border: `2px solid ${T.accent}`, borderTopColor: "transparent",
                  animation: "spin 0.8s linear infinite",
                }} />
                {tr("canvas.searching")}
              </span>
            ) : tr("canvas.searchAgain")}
          </button>
        </div>
      )}
      {stillChecking && (
        <div style={{ margin: "2px 0 20px" }}>
          <ChamaLoader size={32} label={tr("canvas.checkingLive")} />
        </div>
      )}
      {error && !noMatches && !stillChecking && <ErrorBox>{error}</ErrorBox>}
      <div className="assisted-result-grid">
        {isGoods
          ? goodsMatches.map(match => <GoodsMatch key={match.listing.id} match={match} onOpen={() => onOpenTrade(match.listing.id)} />)
          : <>
              {recommended.map(({ candidate, labels }) => <Match key={`${candidate.listing.id}:${candidate.amountSats}`} candidate={candidate} labels={labels} onOpen={() => { setSelected(candidate); setSurface("review"); }} />)}
              {alsoCompatible.map(candidate => <Match key={`${candidate.listing.id}:${candidate.amountSats}`} candidate={candidate} labels={[]} onOpen={() => { setSelected(candidate); setSurface("review"); }} />)}
            </>}
      </div>
      {noMatches && !isGoods && matchWhy && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, margin: "0 0 14px" }}>
          {tr("canvas.nearbyDidntFit", { why: matchWhy })}
        </div>
      )}
      {noMatches && <NoMatchRetention notified={notified} summary={intentSummary} onNotify={saveCurrentIntent} onWiden={() => setSurface("detail")} />}
    </CanvasShell>;
  }

  if (surface === "publish") {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface((bring === "sats" && want === "cash") || bring === "bill" ? "premium" : "terms")}>{tr("canvas.changeLast")}</Back>
      <Kicker>{tr("canvas.firstSide")}</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{tr("canvas.readyLive")}</h1>
      <p style={subStyle()}>{tr("canvas.readySub")}</p>
      <div style={reviewStyle()}>
        {bring === "goods" && <ReviewRow label={tr("canvas.offering")} value={detail.trim()} />}
        {bring === "bill" && <ReviewRow label={tr("canvas.bill")} value={billTypeDisplay(terms)?.label ?? terms} />}
        <ReviewRow
          label={bring === "goods" ? tr("canvas.price") : bring === "bill" ? tr("canvas.billTotal") : tr("canvas.amount")}
          value={bring === "bill"
            ? `${fiatCurrency} ${(positiveNumber(detail) ?? 0).toLocaleString()}`
            : sellRange && rangeMax !== null
              ? tr("canvas.satsRangeValue", { min: (rangeMin ?? 0).toLocaleString(), max: rangeMax.toLocaleString() })
              : tr("canvas.satsValue", { amount: (positiveNumber(bring === "goods" ? terms : detail) ?? 0).toLocaleString() })}
        />
        {bring === "bill" && estimatedSats && <ReviewRow label={tr("canvas.bitcoinOffered")} value={tr("canvas.aboutSats", { amount: estimatedSats.toLocaleString() })} />}
        {bring === "sats" && <ReviewRow label={tr("canvas.receiveThrough")} value={paymentRailLabels(effectiveRails)} />}
        {((bring === "sats" && want === "cash") || bring === "bill") && <ReviewRow label={bring === "bill" ? tr("canvas.volunteerBonus") : tr("canvas.yourRate")} value={premiumBps === 0 ? tr("canvas.marketRate") : `+${(premiumBps / 100).toLocaleString()}%`} />}
        <ReviewRow label={tr("canvas.visibleIn")} value={community?.displayName ?? browseCommunity} last />
      </div>
      <Primary onClick={openPreparedOffer}>{tr("canvas.publishIt")}</Primary>
      <Safety>{tr("canvas.publishSafety")}</Safety>
    </CanvasShell>;
  }

  if (surface === "terms") {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("detail")}>{tr("canvas.changeLast")}</Back>
      <Kicker>{tr("canvas.lastDetail")}</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{termsConfig.heading}</h1>
      <p style={subStyle()}>{termsConfig.sub}</p>
      <QuestionCard>
        {termsConfig.kind === "rail" ? (
          <div>
            <RailGrid railChoices={railChoices} effectiveRails={effectiveRails} onToggle={toggleRail} ariaLabel={termsConfig.heading} />
            <div className="assisted-rail-help">
              {effectiveRails.length > 0
                ? tr("canvas.selectedWillCheck", { count: effectiveRails.length })
                : tr("canvas.selectEveryUse")}
            </div>
            {bring === "sats" && want === "cash" && effectiveRails.length > 0 && renderHandleNudge()}
          </div>
        ) : termsConfig.kind === "bill" ? (
          <div className="assisted-rail-grid" role="group" aria-label={termsConfig.heading}>
            {billTypesForCountry(community?.country).map((type, index) => {
              const active = terms === type.id;
              return <button
                key={type.id}
                type="button"
                className={active ? "selected" : ""}
                aria-pressed={active}
                autoFocus={index === 0}
                onClick={() => setTerms(type.id)}
              >
                <span>{type.icon}</span>
                {type.label}
              </button>;
            })}
          </div>
        ) : (
          <div style={amountLineStyle()}><input autoFocus inputMode="numeric" value={terms} onChange={event => setTerms(digitsOnly(event.target.value))} placeholder="50,000" style={bareInputStyle()} /><span>SATS</span></div>
        )}
        <Primary disabled={!termsValid || matching} onClick={() => void finishRoute()}>{matching ? tr("canvas.checkingOffersBtn") : termsConfig.action}</Primary>
      </QuestionCard>
      {error && <ErrorBox>{error}</ErrorBox>}
    </CanvasShell>;
  }

  if (surface === "detail") {
    return <CanvasShell community={community} step={2} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface(bring === "sats" ? "want" : "bring")}>
        {bring === "sats" ? tr("canvas.changeWant") : tr("canvas.changeHave")}
      </Back>
      <Kicker>{tr("canvas.oneDetail")}</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{detailConfig.heading}</h1>
      <p style={subStyle()}>{detailConfig.sub}</p>
      <QuestionCard>
        {detailConfig.kind === "text" ? (
          <input autoFocus value={detail} onChange={event => setDetail(event.target.value)} placeholder={detailConfig.placeholder} style={fieldStyle()} />
        ) : sellRange ? (
          <div style={{ ...amountLineStyle(), flexWrap: "wrap" }}>
            <span>{tr("canvas.rangeFrom")}</span>
            <input autoFocus inputMode="numeric" value={detail} onChange={event => setDetail(digitsOnly(event.target.value))} placeholder="10,000" aria-label={tr("canvas.rangeMinAria")} style={{ ...bareInputStyle(), flex: "0 1 auto", width: `${Math.max(detail.length, 6) + 0.5}ch`, textAlign: "center", borderBottom: `3px dashed ${T.accent}88`, paddingBottom: 2 }} />
            <span>{tr("canvas.rangeTo")}</span>
            <input inputMode="numeric" value={detailMax} onChange={event => setDetailMax(digitsOnly(event.target.value))} placeholder="100,000" aria-label={tr("canvas.rangeMaxAria")} style={{ ...bareInputStyle(), flex: "0 1 auto", width: `${Math.max(detailMax.length, 7) + 0.5}ch`, textAlign: "center", borderBottom: `3px dashed ${T.accent}88`, paddingBottom: 2 }} />
            <span>SATS</span>
          </div>
        ) : (
          <div style={amountLineStyle()}><span>{detailConfig.prefix}</span><input autoFocus inputMode={fiatBring ? "decimal" : "numeric"} value={detail} onChange={event => setDetail(numberText(event.target.value, fiatBring))} placeholder={fiatBring ? "50.00" : "50,000"} style={bareInputStyle()} /><span>{detailConfig.suffix}</span></div>
        )}
        {sellRange && (
          <div style={{ color: T.muted, marginTop: 12, fontSize: 13 }}>{tr("canvas.rangeWhy")}</div>
        )}
        {estimatedSats && <div style={{ color: T.muted, marginTop: 12, fontSize: 13 }}>{tr("canvas.aboutSatsRate", { amount: estimatedSats.toLocaleString() })}</div>}
        <Primary disabled={!detailValid} onClick={continueFromDetail}>{tr("canvas.continue")}</Primary>
      </QuestionCard>
      {error && <ErrorBox>{error}</ErrorBox>}
    </CanvasShell>;
  }

  if (surface === "want" && bring) {
    return <CanvasShell community={community} step={1} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("bring")}>{tr("canvas.changeHave")}</Back>
      <Kicker>{tr("canvas.haveBitcoin")}</Kicker>
      <h1 style={headingStyle()}>{tr("canvas.whatInReturn")}</h1>
      <p style={subStyle()}>{tr("canvas.onlyProtected")}</p>
      <div className="assisted-choice-grid two">
        {assistedWantChoices(bring).map(asset => <AssetCard key={asset} asset={asset} fiatCurrency={fiatCurrency} note={asset === "goods" ? offerLabel(goodsOffers) : tr("canvas.beFirstSide")} onClick={() => chooseWant(asset)} />)}
      </div>
    </CanvasShell>;
  }

  return <CanvasShell community={community} step={0} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
    <Kicker>{tr("canvas.oneThing")}</Kicker>
    <h1 style={headingStyle()}>{tr("canvas.whatHave")}</h1>
    <p style={subStyle()}>{tr("canvas.whatHaveSub")}</p>
      <div className="assisted-choice-grid">
      {ASSISTED_CANVAS_ASSETS.map(asset => <AssetCard
        key={asset}
        asset={asset}
        fiatCurrency={fiatCurrency}
        note={asset === "cash" ? offerLabel(cashOffers) : asset === "goods" ? tr("canvas.youSetOffer") : asset === "bill" ? tr("canvas.youSetRequest") : tr("canvas.chooseComesBack")}
        onClick={() => chooseBring(asset)}
      />)}
    </div>
  </CanvasShell>;
}

function CanvasShell({ community: _community, step, onExit, onMoreOptions, children }: { community: ReturnType<typeof getCommunityBySlug>; step: number; onExit: () => void; onMoreOptions: () => void; children: ReactNode }) {
  return <div className="assisted-canvas">
    <style>{canvasCss()}</style>
    {step === 0 && <button type="button" data-chama-shortcut="back" onClick={onExit} tabIndex={-1} aria-hidden="true" style={{ display: "none" }} />}
    <main className="assisted-canvas-main">{children}</main>
    <footer className="assisted-canvas-footer">
      <button type="button" onClick={onMoreOptions}>{tr("canvas.knowWhatDoing")}</button>
      <div>{[0, 1, 2].map(index => <span key={index} className={index === step ? "on" : ""} />)}</div>
      <small>{tr("canvas.nothingWithoutConfirm")}</small>
    </footer>
  </div>;
}

function RailGrid({ railChoices, effectiveRails, onToggle, ariaLabel }: { railChoices: { key: string; displayName: string }[]; effectiveRails: string[]; onToggle: (key: string) => void; ariaLabel: string }) {
  return <div className="assisted-rail-grid" role="group" aria-label={ariaLabel}>
    {railChoices.map((rail, index) => {
      const on = effectiveRails.includes(rail.key);
      return <button key={rail.key} type="button" className={on ? "selected" : ""} aria-pressed={on} autoFocus={index === 0} onClick={() => onToggle(rail.key)}>
        <span>{on ? "✓" : "+"}</span>
        {rail.displayName}
      </button>;
    })}
  </div>;
}

function AssetCard({ asset, fiatCurrency, note, onClick }: { asset: AssistedCanvasAsset; fiatCurrency: string; note: string; onClick: () => void }) {
  return <button type="button" className="assisted-choice" onClick={onClick}>
    <AssetMark asset={asset} />
    <strong>{assetLabel(asset, fiatCurrency)}</strong>
    <small>{asset === "sats" ? tr("canvas.satsSmall") : asset === "cash" ? tr("canvas.cashSmall", { currency: fiatCurrency }) : asset === "bill" ? tr("canvas.billSmall") : tr("canvas.goodsSmall")}</small>
    <em>{note}</em>
  </button>;
}

/** Reuse Chama's real visual language instead of introducing a second set of
 *  throwaway asset glyphs. Local money enters through Exchange, while the
 *  remaining concrete starting points use the mark people will see again in
 *  Create. Bitcoin keeps the same mark embedded in the Exchange logo without
 *  pretending that Bitcoin itself is a separate vertical. */
function AssetMark({ asset }: { asset: AssistedCanvasAsset }) {
  if (asset === "sats") {
    return <span className="assisted-glyph"><img src="/icons/bitcoin-mark-64.png" alt="" width={40} height={40} /></span>;
  }
  const vertical = asset === "goods" ? "marketplace" : asset === "bill" ? "bill-pay" : asset === "cash" ? "local-money" : "p2p-trade";
  return <span className="assisted-glyph"><VerticalIcon vertical={vertical} size={40} /></span>;
}

function RouteCue({ children }: { children: string }) { return <div className="assisted-route">{children}</div>; }
function Kicker({ children }: { children: string }) { return <div style={{ color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase" }}>{children}</div>; }
function Back({ onClick, children }: { onClick: () => void; children: string }) { return <button type="button" data-chama-shortcut="back" onClick={onClick} style={{ border: 0, padding: 0, marginBottom: "clamp(10px, 2vh, 28px)", background: "transparent", color: T.muted, cursor: "pointer" }}>← {children}</button>; }
function QuestionCard({ children }: { children: ReactNode }) { return <div className="assisted-question-card">{children}</div>; }
function Primary({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) { return <button type="button" data-chama-shortcut="enter" disabled={disabled} onClick={onClick} className="assisted-primary">{children}</button>; }
function Safety({ children }: { children: ReactNode }) { return <div style={{ marginTop: 14, color: T.muted, fontSize: 12, lineHeight: 1.5 }}>{children}</div>; }
function ErrorBox({ children }: { children: ReactNode }) { return <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: T.r, color: T.red, background: T.redDim, border: `1px solid ${T.red}44` }}>{children}</div>; }

function Match({ candidate, labels, onOpen }: { candidate: GuidedMatchCandidate; labels: string[]; onOpen: () => void }) {
  return <button type="button" className="assisted-match" onClick={onOpen}>
    <div className="assisted-tags">{labels.map(label => <span key={label}>{label}</span>)}</div>
    <div className="assisted-match-row"><div><strong>{candidate.amountSats.toLocaleString()} sats</strong><small>{candidate.listing.description}</small></div><b>{candidate.fiatQuote ? `${candidate.fiatQuote.amount.toLocaleString()} ${candidate.fiatQuote.currency}` : tr("canvas.askSeller")}</b></div>
    <div className="assisted-match-foot"><span>{getRailByKey(candidate.paymentRail)?.displayName ?? candidate.paymentRail}</span><b>{tr("canvas.review")}</b></div>
  </button>;
}

function GoodsMatch({ match, onOpen }: { match: MarketMatch; onOpen: () => void }) {
  const { listing } = match;
  const seller = listing.participants[Role.SELLER] ?? listing.initiator?.pubkey ?? tr("canvas.seller");
  return <button type="button" className="assisted-match" onClick={onOpen}>
    <div className="assisted-tags">{match.reasons.slice(0, 2).map(reason => <span key={reason}>{marketReasonLabel(reason, match.overBudgetSats)}</span>)}</div>
    <div className="assisted-match-row"><div><strong>{match.matchedItem?.label ?? listing.description}</strong><small>{match.matchedItem ? listing.description : shortKey(seller)}</small></div><b>{tr("canvas.satsValue", { amount: match.amountSats.toLocaleString() })}</b></div>
    <div className="assisted-match-foot"><span>{tr("canvas.inYourChama")}</span><b>{tr("canvas.review")}</b></div>
  </button>;
}

function NoMatchRetention({ notified, summary, onNotify, onWiden }: { notified: boolean; summary: string; onNotify: () => void; onWiden: () => void }) {
  return <div className="assisted-empty">
    <strong>{tr("canvas.nothingOpen")}</strong>
    <span>{tr("canvas.noOneOffering", { summary })}</span>
    <div className="assisted-empty-actions">
      {notified
        ? <div className="assisted-notified">{tr("canvas.savedWatch")}</div>
        : <button type="button" className="assisted-notify" onClick={onNotify}>{tr("canvas.watchForMatch")}</button>}
      <button type="button" onClick={onWiden}>{tr("canvas.widenSearch")}</button>
    </div>
  </div>;
}
function ReviewRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) { return <div style={{ display: "flex", justifyContent: "space-between", gap: 20, padding: "clamp(10px, 1.6vh, 15px) 0", borderBottom: last ? 0 : `1px solid ${T.border}` }}><span style={{ color: T.muted }}>{label}</span><strong style={{ textAlign: "right" }}>{value}</strong></div>; }

function detailCopy(bring: AssistedCanvasAsset | null, want: AssistedCanvasAsset | null, currency: string) {
  if (bring === "bill") return { kind: "amount" as const, heading: tr("canvas.billHowMuch"), sub: tr("canvas.billAmountSub", { currency }), prefix: currency === "USD" ? "$" : "", suffix: currency === "USD" ? "" : currency, placeholder: "50.00", error: tr("canvas.billAmountErr") };
  if (bring === "cash") return { kind: "amount" as const, heading: tr("canvas.cashHowMuch", { currency }), sub: tr("canvas.cashSub", { currency }), prefix: currency === "USD" ? "$" : "", suffix: currency === "USD" ? "" : currency, placeholder: "50.00", error: tr("canvas.positiveAmountErr") };
  if (bring === "goods") return { kind: "text" as const, heading: tr("canvas.goodsWhatOffering"), sub: tr("canvas.goodsOfferSub"), prefix: "", suffix: "", placeholder: tr("canvas.goodsPlaceholder"), error: tr("canvas.goodsOfferErr") };
  if (want === "goods") return { kind: "text" as const, heading: tr("canvas.lookingFor"), sub: tr("canvas.lookingSub"), prefix: "", suffix: "", placeholder: tr("canvas.lookingPlaceholder"), error: tr("canvas.lookingErr") };
  return { kind: "amount" as const, heading: tr("canvas.sellRangeQ"), sub: tr("canvas.sellRangeSub"), prefix: "", suffix: "SATS", placeholder: "50,000", error: tr("canvas.satsAmountErr") };
}

function termsCopy(bring: AssistedCanvasAsset | null, want: AssistedCanvasAsset | null, currency: string) {
  if (bring === "bill") return { kind: "bill" as const, heading: tr("canvas.billKind"), sub: tr("canvas.billKindSub"), action: tr("canvas.prepareRequest") };
  if ((bring === "cash" && want === "sats") || (bring === "sats" && want === "cash")) return { kind: "rail" as const, heading: bring === "cash" ? tr("canvas.howPayCurrency", { currency }) : tr("canvas.howReachCurrency", { currency }), sub: bring === "cash" ? tr("canvas.chooseUse", { currency }) : tr("canvas.chooseAccept", { currency }), action: bring === "cash" ? tr("canvas.findMatches") : tr("canvas.prepareOffer") };
  return { kind: "amount" as const, heading: bring === "goods" ? tr("canvas.whatPrice") : tr("canvas.satsBudget"), sub: bring === "goods" ? tr("canvas.priceSub") : tr("canvas.budgetSub"), action: bring === "goods" ? tr("canvas.prepareOffer") : tr("canvas.findMatches") };
}

function marketReasonLabel(reason: MarketMatch["reasons"][number], overBudgetSats: number) {
  if (reason === "close-name") return tr("canvas.closeName");
  if (reason === "related-words") return tr("canvas.relatedWords");
  if (reason === "within-budget") return tr("canvas.withinBudget");
  if (reason === "near-budget") return tr("canvas.satsOver", { amount: overBudgetSats.toLocaleString() });
  return tr("canvas.availableAlt");
}

function uniqueCandidates(lanes: Array<[string, GuidedMatchCandidate | null]>) {
  const out = new Map<string, { candidate: GuidedMatchCandidate; labels: string[] }>();
  for (const [label, candidate] of lanes) {
    if (!candidate) continue;
    const key = `${candidate.listing.id}:${candidate.amountSats}`;
    const current = out.get(key);
    if (current) current.labels.push(label); else out.set(key, { candidate, labels: [label] });
  }
  return [...out.values()];
}

function assetLabel(asset: AssistedCanvasAsset, fiatCurrency: string) { return asset === "sats" ? tr("canvas.assetBitcoin") : asset === "cash" ? fiatCurrency : asset === "bill" ? tr("canvas.assetBill") : tr("canvas.assetGoods"); }
function paymentRailLabels(keys: string[]) { return keys.map(key => getRailByKey(key)?.displayName ?? key).join(", ") || tr("canvas.notSelected"); }
function offerLabel(count: number) { return count > 0 ? tr("canvas.availableNow", { count }) : tr("canvas.noneOpenYet"); }
function positiveNumber(value: string): number | null { const n = Number(value.replace(/,/g, "").trim()); return Number.isFinite(n) && n > 0 ? n : null; }
function digitsOnly(value: string) { return value.replace(/[^\d]/g, ""); }
function numberText(value: string, decimals: boolean) { return value.replace(decimals ? /[^\d.]/g : /[^\d]/g, "").replace(decimals ? /(\..*)\./g : /$^/, "$1"); }
function shortKey(pubkey: string) { return pubkey.length > 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}` : pubkey; }
// Jet 6.3 fit-the-window pass: every question surface must land in one
// non-scrolling viewport on laptop AND phone. Whitespace compresses first
// (vh-driven clamps below); the hero heading yields a few px only on short
// windows (the 8vh term) and never drops below readable. Content that is
// legitimately tall (match lists, dashboards) still scrolls naturally.
function headingStyle(): CSSProperties { return { margin: "clamp(8px, 1.2vh, 14px) 0 0", maxWidth: 900, color: T.text, fontSize: "clamp(36px, min(5vw, 8vh), 76px)", lineHeight: .98, letterSpacing: "-.055em", fontWeight: 650 }; }
function subStyle(): CSSProperties { return { margin: "clamp(10px, 1.8vh, 24px) 0 0", maxWidth: 680, color: T.muted, fontSize: "clamp(16px, 1.7vw, 22px)", lineHeight: 1.45 }; }
function reviewStyle(): CSSProperties { return { maxWidth: 760, marginTop: "clamp(16px, 3vh, 42px)", padding: "clamp(12px, 1.8vh, 20px) 28px", borderRadius: 22, background: T.card, border: `1px solid ${T.borderHi}`, boxShadow: "0 22px 65px rgba(0,0,0,.12)" }; }
function fieldStyle(): CSSProperties { return { width: "100%", padding: "17px 0", border: 0, borderBottom: `1px solid ${T.border}`, outline: 0, background: "transparent", color: T.text, font: `600 clamp(23px, 3vw, 38px)/1.2 ${T.sans}` }; }
function bareInputStyle(): CSSProperties { return { minWidth: 0, flex: 1, border: 0, outline: 0, background: "transparent", color: T.text, font: `600 clamp(25px, 4vw, 45px)/1.1 ${T.sans}` }; }
function amountLineStyle(): CSSProperties { return { display: "flex", alignItems: "baseline", gap: 12, paddingBottom: 15, borderBottom: `1px solid ${T.border}`, color: T.accent, fontFamily: T.mono, fontWeight: 700 }; }

function canvasCss() { return `
  .assisted-canvas{min-height:calc(100dvh - 360px);display:grid;grid-template-rows:1fr auto;padding:clamp(14px,2.5vh,48px) clamp(22px,5vw,70px) 12px;animation:fadeIn .25s ease}
  .assisted-canvas-main{width:100%;max-width:1080px;margin:0 auto;align-self:center}
  .assisted-canvas-footer{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px;color:${T.muted};font-size:12px}
  .assisted-canvas-footer button{justify-self:start;border:0;background:transparent;color:${T.muted};cursor:pointer}
  .assisted-canvas-footer small{justify-self:end}.assisted-canvas-footer div{display:flex;gap:7px}.assisted-canvas-footer div span{width:7px;height:7px;border-radius:9px;background:${T.borderHi}}.assisted-canvas-footer div span.on{width:24px;background:${T.accent}}
  .assisted-choice-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:clamp(14px,3vh,42px)}.assisted-choice-grid.two{grid-template-columns:repeat(2,minmax(0,1fr));max-width:800px}
  .assisted-choice{min-height:clamp(112px,16vh,155px);padding:clamp(14px,2vh,22px) 22px;border:1px solid ${T.borderHi};border-radius:23px;background:${T.card};color:${T.text};text-align:left;cursor:pointer;transition:.18s ease;display:flex;flex-direction:column;align-items:flex-start}.assisted-choice:hover{transform:translateY(-4px);border-color:${T.accent};box-shadow:0 22px 55px rgba(0,0,0,.15)}
  .assisted-choice strong{display:block;margin-top:clamp(10px,2vh,24px);font-size:22px}.assisted-choice small{display:block;margin-top:7px;color:${T.muted};line-height:1.45}.assisted-choice em{display:inline-block;margin-top:auto;padding-top:13px;padding:6px 8px;border-radius:999px;background:${T.greenDim};color:${T.green};font:700 9px/1 ${T.mono};font-style:normal;text-transform:uppercase;letter-spacing:.06em}
  .assisted-glyph{width:44px;height:44px;display:grid;place-items:center;color:${T.accent}}
  .assisted-glyph img{display:block;object-fit:contain}
  .assisted-route{display:inline-flex;margin-top:clamp(8px,1.5vh,18px);padding:8px 11px;border:1px solid ${T.border};border-radius:999px;background:${T.greenDim};color:${T.green};font:700 10px/1 ${T.mono}}
  .assisted-question-card{max-width:780px;margin-top:clamp(14px,3vh,42px);padding:clamp(16px,2.4vh,30px) clamp(18px,2.4vw,30px);border:1px solid ${T.borderHi};border-radius:24px;background:${T.card};box-shadow:0 22px 65px rgba(0,0,0,.12)}
  .assisted-rail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .assisted-rail-grid button{display:flex;align-items:center;gap:10px;min-height:54px;padding:13px 15px;border:1px solid ${T.borderHi};border-radius:15px;background:${T.bg};color:${T.text};text-align:left;cursor:pointer;font-weight:700;transition:.16s ease}
  .assisted-rail-grid button:hover{border-color:${T.accent}}.assisted-rail-grid button.selected{border-color:${T.accent};background:${T.accentDim};color:${T.accent}}
  .assisted-rail-grid button span{display:grid;place-items:center;width:22px;height:22px;flex:0 0 22px;border:1px solid currentColor;border-radius:7px;font:800 12px/1 ${T.mono}}
  .assisted-rail-help{margin-top:clamp(7px,1.1vh,12px);color:${T.muted};font-size:12px;line-height:1.45}
  .assisted-payment-nudge{margin-top:clamp(9px,1.4vh,15px);padding:clamp(9px,1.4vh,13px) 14px;border:1px solid ${T.amber}55;border-radius:15px;background:${T.amberDim}}
  .assisted-payment-nudge-copy strong{display:block;color:${T.text};font-size:13px}.assisted-payment-nudge-copy>span{display:block;margin-top:4px;color:${T.muted};font-size:11px;line-height:1.45}
  .assisted-payment-fields{display:grid;gap:9px;margin-top:12px}.assisted-payment-fields label>span{display:block;margin:0 0 5px;color:${T.muted};font:700 10px/1.2 ${T.mono}}
  .assisted-payment-fields label>div{display:flex;gap:7px}.assisted-payment-fields input{min-width:0;flex:1;padding:10px 11px;border:1px solid ${T.borderHi};border-radius:11px;outline:0;background:${T.bg};color:${T.text};font:600 13px/1.2 ${T.sans}}
  .assisted-phone-hint{display:block;margin-top:6px;color:${T.amber};font-size:10px;line-height:1.4}
  .assisted-payment-fields input:focus{border-color:${T.amber}}.assisted-payment-fields button{flex:0 0 auto;padding:9px 13px;border:1px solid ${T.amber}77;border-radius:11px;background:${T.amber};color:${T.bg};font-weight:900;cursor:pointer}
  .assisted-payment-error{margin-top:9px;color:${T.red};font-size:11px;line-height:1.4}
  .assisted-payment-ready{margin-top:15px;padding:10px 12px;border:1px solid ${T.green}44;border-radius:13px;background:${T.greenDim};color:${T.green};font-size:12px;font-weight:800}
  .assisted-primary{width:100%;margin-top:clamp(12px,2.2vh,27px);padding:14px 22px;border:0;border-radius:999px;background:${T.accent};color:${T.bg};cursor:pointer;font-weight:800}.assisted-primary:disabled{opacity:.38;cursor:default}
  .assisted-result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:clamp(16px,3vh,38px)}
  .assisted-match{padding:20px;border:1px solid ${T.borderHi};border-radius:20px;background:${T.card};color:${T.text};text-align:left;cursor:pointer}.assisted-match:hover{border-color:${T.accent}}
  .assisted-tags{display:flex;gap:6px;flex-wrap:wrap}.assisted-tags span{padding:5px 7px;border-radius:999px;background:${T.accentDim};color:${T.accent};font:700 9px/1 ${T.mono};text-transform:uppercase}
  .assisted-match-row{display:flex;justify-content:space-between;gap:18px;margin-top:16px}.assisted-match-row strong{font-size:18px}.assisted-match-row small{display:block;margin-top:6px;color:${T.muted}}.assisted-match-row>b{text-align:right;white-space:nowrap}
  .assisted-match-foot{display:flex;justify-content:space-between;margin-top:17px;padding-top:13px;border-top:1px solid ${T.border};color:${T.muted};font-size:12px}.assisted-match-foot b{color:${T.accent}}
  .assisted-empty{grid-column:1/-1;padding:30px;border:1px solid ${T.border};border-radius:20px;color:${T.muted}}.assisted-empty strong{display:block;color:${T.text}}.assisted-empty span{display:block;margin-top:7px}.assisted-empty button{margin-top:16px;border:0;background:transparent;color:${T.accent};cursor:pointer;padding:0}
  .assisted-empty-actions{display:flex;flex-wrap:wrap;align-items:center;gap:13px;margin-top:20px}
  .assisted-empty-actions .assisted-notify{margin:0;padding:12px 20px;border-radius:999px;background:${T.accent};color:${T.bg};font-weight:800;border:0;cursor:pointer}
  .assisted-empty-actions>button:not(.assisted-notify){margin:0}
  .assisted-notified{margin:0;padding:11px 16px;border-radius:13px;background:${T.greenDim};color:${T.green};font-weight:800;font-size:13px}
  .assisted-premium-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .assisted-premium-grid button{min-height:52px;padding:12px;border:1px solid ${T.borderHi};border-radius:15px;background:${T.bg};color:${T.text};font-weight:700;cursor:pointer;transition:.16s ease}
  .assisted-premium-grid button:hover{border-color:${T.accent}}.assisted-premium-grid button.selected{border-color:${T.accent};background:${T.accentDim};color:${T.accent}}
  .assisted-linky{margin-top:16px}.assisted-linky button{border:0;background:transparent;color:${T.accent};cursor:pointer;padding:0;font-weight:700;font-size:14px}
  @media(max-height:760px){.assisted-rail-grid button{min-height:46px;padding:10px 13px}.assisted-premium-grid button{min-height:46px;padding:10px}.assisted-payment-fields{gap:7px}.assisted-canvas-footer{font-size:11px}}
  @media(max-width:760px){.assisted-canvas{min-height:calc(100dvh - 116px);padding:clamp(16px,2.5vh,48px) 18px 14px}.assisted-choice-grid,.assisted-choice-grid.two{grid-template-columns:1fr}.assisted-choice{min-height:120px}.assisted-choice strong{margin-top:18px}.assisted-result-grid{grid-template-columns:1fr}.assisted-rail-grid,.assisted-premium-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.assisted-canvas-footer{grid-template-columns:1fr auto}.assisted-canvas-footer small{display:none}}
`; }
