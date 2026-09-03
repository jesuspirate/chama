import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Role, type EscrowState } from "../../escrow-engine/types.js";
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
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import { T } from "../theme.js";

type Surface = "bring" | "want" | "detail" | "terms" | "matches" | "review" | "publish";

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
}) {
  const community = getCommunityBySlug(browseCommunity);
  const phoneExample = phonePlaceholderForCountryIso(community?.countries?.[0])
    ?? "+1 555 555 5555";
  const fiatCurrency = defaultCurrencyForCommunity(browseCommunity);
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const [surface, setSurface] = useState<Surface>("bring");
  const [bring, setBring] = useState<AssistedCanvasAsset | null>(null);
  const [want, setWant] = useState<AssistedCanvasAsset | null>(null);
  const [detail, setDetail] = useState("");
  const [terms, setTerms] = useState("");
  const [paymentRails, setPaymentRails] = useState<string[]>([]);
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<GuidedMatchCandidate[]>([]);
  const [goodsMatches, setGoodsMatches] = useState<MarketMatch[]>([]);
  const [selected, setSelected] = useState<GuidedMatchCandidate | null>(null);
  const [paymentDetailDrafts, setPaymentDetailDrafts] = useState<Record<string, string>>({});
  const [paymentDetailError, setPaymentDetailError] = useState<string | null>(null);
  const [savedHandlesRevision, setSavedHandlesRevision] = useState(0);
  const [notified, setNotified] = useState(false);

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
  const missingPaymentRails = bring === "sats" && want === "cash"
    ? effectiveRails.filter(key => !configuredRailKeys.has(toRailKey(key)))
    : [];
  const savePaymentDetail = (railKey: string) => {
    const value = paymentDetailDrafts[railKey]?.trim() ?? "";
    const rail = getRailByKey(railKey);
    if (!value) {
      setPaymentDetailError(`Enter your ${rail?.displayName ?? railKey} payment details.`);
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
      setPaymentDetailError(cause instanceof Error ? cause.message : "Those payment details could not be saved.");
    }
  };

  const routeLabel = bring && want ? `${assetLabel(bring, fiatCurrency)} → ${assetLabel(want, fiatCurrency)}` : "";
  const resetForward = () => {
    setDetail(""); setTerms(""); setPaymentRails([]); setError(null);
    setMatches([]); setGoodsMatches([]); setSelected(null); setNotified(false);
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

  const detailConfig = detailCopy(bring, want, fiatCurrency);
  const termsConfig = termsCopy(bring, want, fiatCurrency);
  const detailValid = detailConfig.kind === "text" ? detail.trim().length >= 2 : positiveNumber(detail) !== null;
  const termsValid = termsConfig.kind === "rail"
    ? effectiveRails.length > 0
    : termsConfig.kind === "bill"
      ? !!terms
      : positiveNumber(terms) !== null;

  const continueFromDetail = () => {
    if (!detailValid) { setError(detailConfig.error); return; }
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
    setSurface("publish");
  };

  const findCashToSatsMatches = async (rails: string[]) => {
    const budget = positiveNumber(detail);
    if (!budget || rails.length === 0) { setError("Enter an amount and choose at least one way to pay."); return; }
    setMatching(true); setError(null); setMatches([]);
    try {
      const candidateAmounts = [...new Set(listings
        .filter(listing => listing.category === "p2p-trade" || listing.category === "bill-pay")
        .flatMap(listing => [Math.floor(listing.amountMsats / 1000), ...(listing.items ?? []).map(item => Math.floor(item.amountMsats / 1000))])
        .filter(amount => Number.isFinite(amount) && amount > 0))];
      const deduped = new Map<string, GuidedMatchCandidate>();
      for (const amountSats of candidateAmounts) {
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
        const result = matchGuidedListings(validated.value, listingInputs, { viewerPubkey, limit: 20 });
        for (const candidate of result.candidates) {
          const key = `${candidate.listing.id}:${candidate.selectedItem?.itemId ?? "single"}:${candidate.amountSats}`;
          if (!deduped.has(key)) deduped.set(key, candidate);
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
      if (ranked.length === 0) setError(listingsLoading ? "Chama is still checking live offers." : "No compatible offers fit that budget right now.");
      setSurface("matches");
    } finally {
      setMatching(false);
    }
  };

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
      });
      return;
    }
    if (bring === "goods") {
      onCreate({ vertical: "marketplace", description: detail.trim(), amountSats: positiveNumber(terms) ?? undefined });
      return;
    }
    onCreate({
      vertical: "p2p-trade",
      emphasizePremium: bring === "sats" && want === "cash",
      amountSats: positiveNumber(detail) ?? undefined,
      fiatCurrency,
      paymentMethods: effectiveRails,
    });
  };

  const intentSummary = bring === "sats" && want === "goods"
    ? `“${detail.trim() || "that"}”`
    : `sats for ${fiatCurrency} ${(positiveNumber(detail) ?? 0).toLocaleString()}`;
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
  const recommendations = recommendGuidedCandidates(matches, fiatCurrency);
  const billOpportunity = matches.find(candidate => candidate.listing.category === "bill-pay") ?? null;
  const recommended = uniqueCandidates([
    ["Best overall", recommendations.bestOverall],
    ["Lowest price", recommendations.lowestPrice],
    ["Most trusted", recommendations.mostTrusted],
    ["Community Bill Pay", billOpportunity],
  ]);

  if (surface === "review" && selected) {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("matches")}>Back to matches</Back>
      <Kicker>Exact trade preview</Kicker>
      <h1 style={headingStyle()}>Review this match.</h1>
      <p style={subStyle()}>Nothing has been joined, signed, or funded.</p>
      <div style={reviewStyle()}>
        <ReviewRow label="You receive" value={`${selected.amountSats.toLocaleString()} sats`} />
        <ReviewRow label="You pay" value={selected.fiatQuote ? `${selected.fiatQuote.amount.toLocaleString()} ${selected.fiatQuote.currency}` : "Confirm with seller"} />
        <ReviewRow label="Payment method" value={getRailByKey(selected.paymentRail)?.displayName ?? selected.paymentRail} />
        <ReviewRow label="Seller" value={shortKey(selected.sellerPubkey)} last />
      </div>
      <Primary onClick={() => onOpenTrade(selected.listing.id)}>Review full trade →</Primary>
      <Safety>Opening the trade moves no money. Joining and funding remain separate explicit actions.</Safety>
    </CanvasShell>;
  }

  if (surface === "matches") {
    const isGoods = bring === "sats" && want === "goods";
    const noMatches = !matching && !listingsLoading && (isGoods ? goodsMatches.length === 0 : matches.length === 0);
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("terms")}>Change the last answer</Back>
      <Kicker>{isGoods ? `${goodsMatches.length} available now` : `${matches.length} compatible offers`}</Kicker>
      <h1 style={headingStyle()}>{noMatches ? "No match yet — so let’s catch the next one." : isGoods ? "Here’s what your Chama has." : "Choose the person, not the machinery."}</h1>
      <p style={subStyle()}>{noMatches ? "People arrive all the time. Save this and Chama pings you the moment a match appears — even with the app closed." : isGoods ? "Closest prices come first. Spelling is forgiving, and near-budget alternatives stay visible." : "Each result fits your payment method and budget. Nothing is reserved yet."}</p>
      {error && !noMatches && <ErrorBox>{error}</ErrorBox>}
      <div className="assisted-result-grid">
        {isGoods
          ? goodsMatches.map(match => <GoodsMatch key={match.listing.id} match={match} onOpen={() => onOpenTrade(match.listing.id)} />)
          : recommended.map(({ candidate, labels }) => <Match key={`${candidate.listing.id}:${candidate.amountSats}`} candidate={candidate} labels={labels} onOpen={() => { setSelected(candidate); setSurface("review"); }} />)}
      </div>
      {noMatches && <NoMatchRetention notified={notified} summary={intentSummary} onNotify={saveCurrentIntent} onWiden={() => setSurface("detail")} />}
    </CanvasShell>;
  }

  if (surface === "publish") {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("terms")}>Change the last answer</Back>
      <Kicker>You’re the first side</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>Your offer is ready for the exact details.</h1>
      <p style={subStyle()}>Chama filled only what you already answered. The full editor remains the final review and publish boundary.</p>
      <div style={reviewStyle()}>
        {bring === "goods" && <ReviewRow label="Offering" value={detail.trim()} />}
        {bring === "bill" && <ReviewRow label="Bill" value={billTypeDisplay(terms)?.label ?? terms} />}
        <ReviewRow
          label={bring === "goods" ? "Price" : bring === "bill" ? "Bill total" : "Amount"}
          value={bring === "bill"
            ? `${fiatCurrency} ${(positiveNumber(detail) ?? 0).toLocaleString()}`
            : `${(positiveNumber(bring === "goods" ? terms : detail) ?? 0).toLocaleString()} sats`}
        />
        {bring === "bill" && estimatedSats && <ReviewRow label="Bitcoin offered" value={`about ${estimatedSats.toLocaleString()} sats`} />}
        {bring === "sats" && <ReviewRow label="Receive through" value={paymentRailLabels(effectiveRails)} />}
        <ReviewRow label="Visible in" value={community?.displayName ?? browseCommunity} last />
      </div>
      <Primary onClick={openPreparedOffer}>Continue to final review →</Primary>
      <Safety>Nothing is published until you review and confirm it in the existing Create flow.</Safety>
    </CanvasShell>;
  }

  if (surface === "terms") {
    return <CanvasShell community={community} step={3} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("detail")}>Change the last answer</Back>
      <Kicker>One last useful detail</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{termsConfig.heading}</h1>
      <p style={subStyle()}>{termsConfig.sub}</p>
      <QuestionCard>
        {termsConfig.kind === "rail" ? (
          <div>
            <div className="assisted-rail-grid" role="group" aria-label={termsConfig.heading}>
              {railChoices.map((rail, index) => {
                const selected = effectiveRails.includes(rail.key);
                return <button
                  key={rail.key}
                  type="button"
                  className={selected ? "selected" : ""}
                  aria-pressed={selected}
                  autoFocus={index === 0}
                  onClick={() => setPaymentRails(current => current.includes(rail.key)
                    ? current.filter(key => key !== rail.key)
                    : [...current, rail.key])}
                >
                  <span>{selected ? "✓" : "+"}</span>
                  {rail.displayName}
                </button>;
              })}
            </div>
            <div className="assisted-rail-help">
              {effectiveRails.length > 0
                ? `${effectiveRails.length} selected · Chama will check every compatible method.`
                : "Select every method you can actually use."}
            </div>
            {bring === "sats" && want === "cash" && effectiveRails.length > 0 && (
              missingPaymentRails.length > 0 ? (
                <div className="assisted-payment-nudge">
                  <div className="assisted-payment-nudge-copy">
                    <strong>Payment details missing for {paymentRailLabels(missingPaymentRails)}</strong>
                    <span>Add them here once. Chama saves them privately on this device for future offers.</span>
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
                            placeholder={rail?.placeholderKey ? "Your payment details" : rail?.placeholder ?? "Your payment details"}
                            autoComplete="off"
                          />
                          <button type="button" onClick={() => savePaymentDetail(key)}>Save</button>
                        </div>
                        {showCountryCodeNudge && (
                          <small className="assisted-phone-hint">
                            Using a phone number? Include the country code, for example {phoneExample}.
                          </small>
                        )}
                      </label>;
                    })}
                  </div>
                  {paymentDetailError && <div className="assisted-payment-error">{paymentDetailError}</div>}
                </div>
              ) : (
                <div className="assisted-payment-ready">✓ Payment details ready</div>
              )
            )}
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
        <Primary disabled={!termsValid || matching} onClick={() => void finishRoute()}>{matching ? "Checking live offers…" : termsConfig.action}</Primary>
      </QuestionCard>
      {error && <ErrorBox>{error}</ErrorBox>}
    </CanvasShell>;
  }

  if (surface === "detail") {
    return <CanvasShell community={community} step={2} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface(bring === "sats" ? "want" : "bring")}>
        {bring === "sats" ? "Change what I want" : "Change what I have"}
      </Back>
      <Kicker>One useful detail</Kicker>
      <RouteCue>{routeLabel}</RouteCue>
      <h1 style={headingStyle()}>{detailConfig.heading}</h1>
      <p style={subStyle()}>{detailConfig.sub}</p>
      <QuestionCard>
        {detailConfig.kind === "text" ? (
          <input autoFocus value={detail} onChange={event => setDetail(event.target.value)} placeholder={detailConfig.placeholder} style={fieldStyle()} />
        ) : (
          <div style={amountLineStyle()}><span>{detailConfig.prefix}</span><input autoFocus inputMode={fiatBring ? "decimal" : "numeric"} value={detail} onChange={event => setDetail(numberText(event.target.value, fiatBring))} placeholder={fiatBring ? "50.00" : "50,000"} style={bareInputStyle()} /><span>{detailConfig.suffix}</span></div>
        )}
        {estimatedSats && <div style={{ color: T.muted, marginTop: 12, fontSize: 13 }}>About {estimatedSats.toLocaleString()} sats at the current rate. Matches use each seller’s actual price.</div>}
        <Primary disabled={!detailValid} onClick={continueFromDetail}>Continue →</Primary>
      </QuestionCard>
      {error && <ErrorBox>{error}</ErrorBox>}
    </CanvasShell>;
  }

  if (surface === "want" && bring) {
    return <CanvasShell community={community} step={1} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
      <Back onClick={() => setSurface("bring")}>Change what I have</Back>
      <Kicker>You have Bitcoin</Kicker>
      <h1 style={headingStyle()}>What would you like in return?</h1>
      <p style={subStyle()}>Only markets Chama can protect appear here.</p>
      <div className="assisted-choice-grid two">
        {assistedWantChoices(bring).map(asset => <AssetCard key={asset} asset={asset} fiatCurrency={fiatCurrency} note={asset === "goods" ? offerLabel(goodsOffers) : "Be the first side"} onClick={() => chooseWant(asset)} />)}
      </div>
    </CanvasShell>;
  }

  return <CanvasShell community={community} step={0} onExit={() => onBrowse("all")} onMoreOptions={onMoreOptions}>
    <Kicker>One thing at a time</Kicker>
    <h1 style={headingStyle()}>What do you have?</h1>
    <p style={subStyle()}>Choose what is already yours. Chama will work out the market from there.</p>
      <div className="assisted-choice-grid">
      {ASSISTED_CANVAS_ASSETS.map(asset => <AssetCard
        key={asset}
        asset={asset}
        fiatCurrency={fiatCurrency}
        note={asset === "cash" ? offerLabel(cashOffers) : asset === "goods" ? "You set the offer" : asset === "bill" ? "You set the request" : "Choose what comes back"}
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
      <button type="button" onClick={onMoreOptions}>I know what I’m doing →</button>
      <div>{[0, 1, 2].map(index => <span key={index} className={index === step ? "on" : ""} />)}</div>
      <small>Nothing moves without confirmation</small>
    </footer>
  </div>;
}

function AssetCard({ asset, fiatCurrency, note, onClick }: { asset: AssistedCanvasAsset; fiatCurrency: string; note: string; onClick: () => void }) {
  return <button type="button" className="assisted-choice" onClick={onClick}>
    <AssetMark asset={asset} />
    <strong>{assetLabel(asset, fiatCurrency)}</strong>
    <small>{asset === "sats" ? "Sats you want to trade or spend" : asset === "cash" ? `${fiatCurrency} via cash, bank, or mobile money` : asset === "bill" ? "Something you need paid" : "Something you make, sell, or provide"}</small>
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
    return <span className="assisted-glyph"><img src="/icons/bitcoin-mark-64.png" alt="" width={34} height={34} /></span>;
  }
  const vertical = asset === "goods" ? "marketplace" : asset === "bill" ? "bill-pay" : asset === "cash" ? "local-money" : "p2p-trade";
  return <span className="assisted-glyph"><VerticalIcon vertical={vertical} size={40} /></span>;
}

function RouteCue({ children }: { children: string }) { return <div className="assisted-route">{children}</div>; }
function Kicker({ children }: { children: string }) { return <div style={{ color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase" }}>{children}</div>; }
function Back({ onClick, children }: { onClick: () => void; children: string }) { return <button type="button" data-chama-shortcut="back" onClick={onClick} style={{ border: 0, padding: 0, marginBottom: 28, background: "transparent", color: T.muted, cursor: "pointer" }}>← {children}</button>; }
function QuestionCard({ children }: { children: ReactNode }) { return <div className="assisted-question-card">{children}</div>; }
function Primary({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) { return <button type="button" data-chama-shortcut="enter" disabled={disabled} onClick={onClick} className="assisted-primary">{children}</button>; }
function Safety({ children }: { children: ReactNode }) { return <div style={{ marginTop: 14, color: T.muted, fontSize: 12, lineHeight: 1.5 }}>{children}</div>; }
function ErrorBox({ children }: { children: ReactNode }) { return <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: T.r, color: T.red, background: T.redDim, border: `1px solid ${T.red}44` }}>{children}</div>; }

function Match({ candidate, labels, onOpen }: { candidate: GuidedMatchCandidate; labels: string[]; onOpen: () => void }) {
  return <button type="button" className="assisted-match" onClick={onOpen}>
    <div className="assisted-tags">{labels.map(label => <span key={label}>{label}</span>)}</div>
    <div className="assisted-match-row"><div><strong>{candidate.amountSats.toLocaleString()} sats</strong><small>{candidate.listing.description}</small></div><b>{candidate.fiatQuote ? `${candidate.fiatQuote.amount.toLocaleString()} ${candidate.fiatQuote.currency}` : "Ask seller"}</b></div>
    <div className="assisted-match-foot"><span>{getRailByKey(candidate.paymentRail)?.displayName ?? candidate.paymentRail}</span><b>Review →</b></div>
  </button>;
}

function GoodsMatch({ match, onOpen }: { match: MarketMatch; onOpen: () => void }) {
  const { listing } = match;
  const seller = listing.participants[Role.SELLER] ?? listing.initiator?.pubkey ?? "Seller";
  return <button type="button" className="assisted-match" onClick={onOpen}>
    <div className="assisted-tags">{match.reasons.slice(0, 2).map(reason => <span key={reason}>{marketReasonLabel(reason, match.overBudgetSats)}</span>)}</div>
    <div className="assisted-match-row"><div><strong>{match.matchedItem?.label ?? listing.description}</strong><small>{match.matchedItem ? listing.description : shortKey(seller)}</small></div><b>{match.amountSats.toLocaleString()} sats</b></div>
    <div className="assisted-match-foot"><span>In your Chama</span><b>Review →</b></div>
  </button>;
}

function NoMatchRetention({ notified, summary, onNotify, onWiden }: { notified: boolean; summary: string; onNotify: () => void; onWiden: () => void }) {
  return <div className="assisted-empty">
    <strong>Nothing compatible is open right now.</strong>
    <span>No one is offering {summary} this minute — but the market moves fast.</span>
    <div className="assisted-empty-actions">
      {notified
        ? <div className="assisted-notified">✓ Saved — Chama will check new offers for a match</div>
        : <button type="button" className="assisted-notify" onClick={onNotify}>Watch for a match</button>}
      <button type="button" onClick={onWiden}>Widen my search</button>
    </div>
  </div>;
}
function ReviewRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) { return <div style={{ display: "flex", justifyContent: "space-between", gap: 20, padding: "15px 0", borderBottom: last ? 0 : `1px solid ${T.border}` }}><span style={{ color: T.muted }}>{label}</span><strong style={{ textAlign: "right" }}>{value}</strong></div>; }

function detailCopy(bring: AssistedCanvasAsset | null, want: AssistedCanvasAsset | null, currency: string) {
  if (bring === "bill") return { kind: "amount" as const, heading: "How much is the bill?", sub: `Enter the amount due in ${currency}.`, prefix: currency === "USD" ? "$" : "", suffix: currency === "USD" ? "" : currency, placeholder: "50.00", error: "Enter a positive bill amount." };
  if (bring === "cash") return { kind: "amount" as const, heading: `How much ${currency} do you have?`, sub: `Chama checks direct Bitcoin offers and ${currency} bills you can pay.`, prefix: currency === "USD" ? "$" : "", suffix: currency === "USD" ? "" : currency, placeholder: "50.00", error: "Enter a positive amount." };
  if (bring === "goods") return { kind: "text" as const, heading: "What are you offering?", sub: "A short, ordinary name is enough to begin.", prefix: "", suffix: "", placeholder: "Bike repair, coffee beans, a used phone…", error: "Describe what you are offering." };
  if (want === "goods") return { kind: "text" as const, heading: "What are you looking for?", sub: "Describe it the way you would ask another person.", prefix: "", suffix: "", placeholder: "Fresh produce, a laptop, help moving…", error: "Describe what you are looking for." };
  return { kind: "amount" as const, heading: "How much Bitcoin are you selling?", sub: "Use the amount you are comfortable selling.", prefix: "", suffix: "SATS", placeholder: "50,000", error: "Enter a positive sats amount." };
}

function termsCopy(bring: AssistedCanvasAsset | null, want: AssistedCanvasAsset | null, currency: string) {
  if (bring === "bill") return { kind: "bill" as const, heading: "What kind of bill is it?", sub: "Choose the closest type. You can confirm the private payment details before publishing.", action: "Prepare my request →" };
  if ((bring === "cash" && want === "sats") || (bring === "sats" && want === "cash")) return { kind: "rail" as const, heading: bring === "cash" ? `How will you pay the ${currency}?` : `How should the ${currency} reach you?`, sub: bring === "cash" ? `Choose every ${currency} payment method you can actually use.` : `Choose every ${currency} payment method you can accept.`, action: bring === "cash" ? "Find matches →" : "Prepare my offer →" };
  return { kind: "amount" as const, heading: bring === "goods" ? "What price do you want?" : "What is your sats budget?", sub: bring === "goods" ? "Set the sats price. You can refine the rest before publishing." : "Chama puts the closest prices first and clearly marks anything slightly over.", action: bring === "goods" ? "Prepare my offer →" : "Find matches →" };
}

function marketReasonLabel(reason: MarketMatch["reasons"][number], overBudgetSats: number) {
  if (reason === "close-name") return "Close name match";
  if (reason === "related-words") return "Related words";
  if (reason === "within-budget") return "Within budget";
  if (reason === "near-budget") return `${overBudgetSats.toLocaleString()} sats over`;
  return "Available alternative";
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

function assetLabel(asset: AssistedCanvasAsset, fiatCurrency: string) { return asset === "sats" ? "Bitcoin" : asset === "cash" ? fiatCurrency : asset === "bill" ? "A bill" : "Goods or services"; }
function paymentRailLabels(keys: string[]) { return keys.map(key => getRailByKey(key)?.displayName ?? key).join(", ") || "Not selected"; }
function offerLabel(count: number) { return count > 0 ? `${count} available now` : "None open yet"; }
function positiveNumber(value: string): number | null { const n = Number(value.replace(/,/g, "").trim()); return Number.isFinite(n) && n > 0 ? n : null; }
function digitsOnly(value: string) { return value.replace(/[^\d]/g, ""); }
function numberText(value: string, decimals: boolean) { return value.replace(decimals ? /[^\d.]/g : /[^\d]/g, "").replace(decimals ? /(\..*)\./g : /$^/, "$1"); }
function shortKey(pubkey: string) { return pubkey.length > 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}` : pubkey; }
function headingStyle(): CSSProperties { return { margin: "14px 0 0", maxWidth: 900, color: T.text, fontSize: "clamp(42px, 5vw, 76px)", lineHeight: .98, letterSpacing: "-.055em", fontWeight: 650 }; }
function subStyle(): CSSProperties { return { margin: "24px 0 0", maxWidth: 680, color: T.muted, fontSize: "clamp(17px, 1.7vw, 22px)", lineHeight: 1.5 }; }
function reviewStyle(): CSSProperties { return { maxWidth: 760, marginTop: 42, padding: "20px 28px", borderRadius: 22, background: T.card, border: `1px solid ${T.borderHi}`, boxShadow: "0 22px 65px rgba(0,0,0,.12)" }; }
function fieldStyle(): CSSProperties { return { width: "100%", padding: "17px 0", border: 0, borderBottom: `1px solid ${T.border}`, outline: 0, background: "transparent", color: T.text, font: `600 clamp(23px, 3vw, 38px)/1.2 ${T.sans}` }; }
function bareInputStyle(): CSSProperties { return { minWidth: 0, flex: 1, border: 0, outline: 0, background: "transparent", color: T.text, font: `600 clamp(25px, 4vw, 45px)/1.1 ${T.sans}` }; }
function amountLineStyle(): CSSProperties { return { display: "flex", alignItems: "baseline", gap: 12, paddingBottom: 15, borderBottom: `1px solid ${T.border}`, color: T.accent, fontFamily: T.mono, fontWeight: 700 }; }

function canvasCss() { return `
  .assisted-canvas{min-height:calc(100dvh - 360px);display:grid;grid-template-rows:1fr auto;padding:clamp(24px,3.5vh,48px) clamp(22px,5vw,70px) 18px;animation:fadeIn .25s ease}
  .assisted-canvas-main{width:100%;max-width:1080px;margin:0 auto;align-self:center}
  .assisted-canvas-footer{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px;color:${T.muted};font-size:12px}
  .assisted-canvas-footer button{justify-self:start;border:0;background:transparent;color:${T.muted};cursor:pointer}
  .assisted-canvas-footer small{justify-self:end}.assisted-canvas-footer div{display:flex;gap:7px}.assisted-canvas-footer div span{width:7px;height:7px;border-radius:9px;background:${T.borderHi}}.assisted-canvas-footer div span.on{width:24px;background:${T.accent}}
  .assisted-choice-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:clamp(26px,4vh,42px)}.assisted-choice-grid.two{grid-template-columns:repeat(2,minmax(0,1fr));max-width:800px}
  .assisted-choice{min-height:155px;padding:22px;border:1px solid ${T.borderHi};border-radius:23px;background:${T.card};color:${T.text};text-align:left;cursor:pointer;transition:.18s ease}.assisted-choice:hover{transform:translateY(-4px);border-color:${T.accent};box-shadow:0 22px 55px rgba(0,0,0,.15)}
  .assisted-choice strong{display:block;margin-top:24px;font-size:22px}.assisted-choice small{display:block;margin-top:7px;color:${T.muted};line-height:1.45}.assisted-choice em{display:inline-block;margin-top:13px;padding:6px 8px;border-radius:999px;background:${T.greenDim};color:${T.green};font:700 9px/1 ${T.mono};font-style:normal;text-transform:uppercase;letter-spacing:.06em}
  .assisted-glyph{width:44px;height:44px;display:grid;place-items:center;color:${T.accent}}
  .assisted-glyph img{display:block;object-fit:contain}
  .assisted-route{display:inline-flex;margin-top:18px;padding:8px 11px;border:1px solid ${T.border};border-radius:999px;background:${T.greenDim};color:${T.green};font:700 10px/1 ${T.mono}}
  .assisted-question-card{max-width:780px;margin-top:42px;padding:30px;border:1px solid ${T.borderHi};border-radius:24px;background:${T.card};box-shadow:0 22px 65px rgba(0,0,0,.12)}
  .assisted-rail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .assisted-rail-grid button{display:flex;align-items:center;gap:10px;min-height:54px;padding:13px 15px;border:1px solid ${T.borderHi};border-radius:15px;background:${T.bg};color:${T.text};text-align:left;cursor:pointer;font-weight:700;transition:.16s ease}
  .assisted-rail-grid button:hover{border-color:${T.accent}}.assisted-rail-grid button.selected{border-color:${T.accent};background:${T.accentDim};color:${T.accent}}
  .assisted-rail-grid button span{display:grid;place-items:center;width:22px;height:22px;flex:0 0 22px;border:1px solid currentColor;border-radius:7px;font:800 12px/1 ${T.mono}}
  .assisted-rail-help{margin-top:12px;color:${T.muted};font-size:12px;line-height:1.45}
  .assisted-payment-nudge{margin-top:15px;padding:13px 14px;border:1px solid ${T.amber}55;border-radius:15px;background:${T.amberDim}}
  .assisted-payment-nudge-copy strong{display:block;color:${T.text};font-size:13px}.assisted-payment-nudge-copy>span{display:block;margin-top:4px;color:${T.muted};font-size:11px;line-height:1.45}
  .assisted-payment-fields{display:grid;gap:9px;margin-top:12px}.assisted-payment-fields label>span{display:block;margin:0 0 5px;color:${T.muted};font:700 10px/1.2 ${T.mono}}
  .assisted-payment-fields label>div{display:flex;gap:7px}.assisted-payment-fields input{min-width:0;flex:1;padding:10px 11px;border:1px solid ${T.borderHi};border-radius:11px;outline:0;background:${T.bg};color:${T.text};font:600 13px/1.2 ${T.sans}}
  .assisted-phone-hint{display:block;margin-top:6px;color:${T.amber};font-size:10px;line-height:1.4}
  .assisted-payment-fields input:focus{border-color:${T.amber}}.assisted-payment-fields button{flex:0 0 auto;padding:9px 13px;border:1px solid ${T.amber}77;border-radius:11px;background:${T.amber};color:${T.bg};font-weight:900;cursor:pointer}
  .assisted-payment-error{margin-top:9px;color:${T.red};font-size:11px;line-height:1.4}
  .assisted-payment-ready{margin-top:15px;padding:10px 12px;border:1px solid ${T.green}44;border-radius:13px;background:${T.greenDim};color:${T.green};font-size:12px;font-weight:800}
  .assisted-primary{width:100%;margin-top:27px;padding:14px 22px;border:0;border-radius:999px;background:${T.accent};color:${T.bg};cursor:pointer;font-weight:800}.assisted-primary:disabled{opacity:.38;cursor:default}
  .assisted-result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:38px}
  .assisted-match{padding:20px;border:1px solid ${T.borderHi};border-radius:20px;background:${T.card};color:${T.text};text-align:left;cursor:pointer}.assisted-match:hover{border-color:${T.accent}}
  .assisted-tags{display:flex;gap:6px;flex-wrap:wrap}.assisted-tags span{padding:5px 7px;border-radius:999px;background:${T.accentDim};color:${T.accent};font:700 9px/1 ${T.mono};text-transform:uppercase}
  .assisted-match-row{display:flex;justify-content:space-between;gap:18px;margin-top:16px}.assisted-match-row strong{font-size:18px}.assisted-match-row small{display:block;margin-top:6px;color:${T.muted}}.assisted-match-row>b{text-align:right;white-space:nowrap}
  .assisted-match-foot{display:flex;justify-content:space-between;margin-top:17px;padding-top:13px;border-top:1px solid ${T.border};color:${T.muted};font-size:12px}.assisted-match-foot b{color:${T.accent}}
  .assisted-empty{grid-column:1/-1;padding:30px;border:1px solid ${T.border};border-radius:20px;color:${T.muted}}.assisted-empty strong{display:block;color:${T.text}}.assisted-empty span{display:block;margin-top:7px}.assisted-empty button{margin-top:16px;border:0;background:transparent;color:${T.accent};cursor:pointer;padding:0}
  .assisted-empty-actions{display:flex;flex-wrap:wrap;align-items:center;gap:13px;margin-top:20px}
  .assisted-empty-actions .assisted-notify{margin:0;padding:12px 20px;border-radius:999px;background:${T.accent};color:${T.bg};font-weight:800;border:0;cursor:pointer}
  .assisted-empty-actions>button:not(.assisted-notify){margin:0}
  .assisted-notified{margin:0;padding:11px 16px;border-radius:13px;background:${T.greenDim};color:${T.green};font-weight:800;font-size:13px}
  @media(max-width:760px){.assisted-canvas{min-height:calc(100dvh - 116px);padding:48px 18px 20px}.assisted-choice-grid,.assisted-choice-grid.two{grid-template-columns:1fr}.assisted-choice{min-height:120px}.assisted-choice strong{margin-top:18px}.assisted-result-grid{grid-template-columns:1fr}.assisted-rail-grid{grid-template-columns:1fr}.assisted-canvas-footer{grid-template-columns:1fr auto}.assisted-canvas-footer small{display:none}}
`; }
