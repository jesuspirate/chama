import { useMemo, useState } from "react";
import { Role, type EscrowState } from "../../escrow-engine/types.js";
import {
  matchGuidedListings,
  recommendGuidedCandidates,
  validateGuidedTradeIntent,
  type GuidedMatchCandidate,
} from "../../guided/index.js";
import { useT } from "../../i18n/index.js";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getRailByKey, railsForCommunity } from "../../payments/rail-registry.js";
import type { AggregateRatings } from "../../reputation/ratings.js";
import { T, inputStyle } from "../theme.js";

type GuidedSurface = "home" | "need-sats" | "review";

export function GuidedHome({
  listings,
  stockByListing,
  browseCommunity,
  activeMintUrl,
  viewerPubkey,
  listingsLoading,
  attentionTrades,
  fetchRatingSummary,
  onBrowse,
  onCreate,
  onOpenTrade,
}: {
  listings: EscrowState[];
  stockByListing?: Map<string, number>;
  browseCommunity: string;
  activeMintUrl?: string | null;
  viewerPubkey: string;
  listingsLoading: boolean;
  attentionTrades: EscrowState[];
  fetchRatingSummary?: (ratee: string) => Promise<AggregateRatings>;
  onBrowse: (category: string) => void;
  onCreate: () => void;
  onOpenTrade: (id: string) => void;
}) {
  const { t } = useT();
  const community = getCommunityBySlug(browseCommunity);
  const fiatCurrency = defaultCurrencyForCommunity(browseCommunity);
  const [surface, setSurface] = useState<GuidedSurface>("home");
  const [amountSats, setAmountSats] = useState("");
  const [paymentRail, setPaymentRail] = useState("");
  const [maxFiat, setMaxFiat] = useState("");
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<GuidedMatchCandidate[]>([]);
  const [selected, setSelected] = useState<GuidedMatchCandidate | null>(null);

  const railChoices = useMemo(() => {
    const advertised = new Set(
      listings
        .filter(listing => listing.category === "p2p-trade")
        .flatMap(listing => listing.paymentMethods ?? [])
        .map(key => key.trim().toLowerCase())
        .filter(Boolean),
    );
    const local = railsForCommunity(browseCommunity);
    const ordered = [
      ...local.filter(rail => advertised.has(rail.key)),
      ...local.filter(rail => !advertised.has(rail.key)),
      ...[...advertised]
        .map(getRailByKey)
        .filter((rail): rail is NonNullable<typeof rail> => !!rail && !local.some(value => value.key === rail.key)),
    ];
    return ordered.slice(0, 12);
  }, [listings, browseCommunity]);

  const effectiveRail = paymentRail || railChoices[0]?.key || "";

  const startNeedSats = () => {
    setError(null);
    setMatches([]);
    setSelected(null);
    setSurface("need-sats");
  };

  const findMatches = async () => {
    setError(null);
    setMatches([]);
    setSelected(null);
    const raw = {
      version: 1 as const,
      direction: "buy_sats" as const,
      amountSats: Number(amountSats),
      paymentRails: effectiveRail ? [effectiveRail] : [],
      strategy: "available_now" as const,
      community: browseCommunity,
      ...(activeMintUrl ? { mintUrl: activeMintUrl } : {}),
      ...(maxFiat.trim()
        ? {
            maxFiatAmount: Number(maxFiat),
            fiatCurrency,
          }
        : {}),
    };
    const validated = validateGuidedTradeIntent(raw);
    if (!validated.ok) {
      setError(t("guided.checkRequest"));
      return;
    }

    setMatching(true);
    try {
      const baseInputs = listings.map(listing => ({
        listing,
        availableUnits: stockByListing?.get(listing.id),
      }));
      const initial = matchGuidedListings(validated.value, baseInputs, {
        viewerPubkey,
        limit: 20,
      });
      if (initial.candidates.length === 0) {
        setError(listingsLoading ? t("guided.stillChecking") : t("guided.noMatches"));
        return;
      }

      const ratings = new Map<string, AggregateRatings>();
      if (fetchRatingSummary) {
        await Promise.all(initial.candidates.map(async candidate => {
          if (ratings.has(candidate.sellerPubkey)) return;
          try {
            ratings.set(
              candidate.sellerPubkey,
              await fetchRatingSummary(candidate.sellerPubkey),
            );
          } catch {
            ratings.set(candidate.sellerPubkey, { count: 0, positive: 0, negative: 0 });
          }
        }));
      }
      const ranked = matchGuidedListings(
        validated.value,
        baseInputs.map(input => ({
          ...input,
          ...(ratings.has(input.listing.participants[Role.SELLER] ?? "")
            ? { ratings: ratings.get(input.listing.participants[Role.SELLER] ?? "") }
            : {}),
        })),
        { viewerPubkey, limit: 20 },
      );
      setMatches(ranked.candidates);
    } finally {
      setMatching(false);
    }
  };

  const recommendations = recommendGuidedCandidates(
    matches,
    fiatCurrency,
  );
  const recommendationCards = mergeRecommendationLanes([
    { label: t("guided.bestOverall"), candidate: recommendations.bestOverall },
    { label: t("guided.lowestPrice"), candidate: recommendations.lowestPrice },
    { label: t("guided.mostTrusted"), candidate: recommendations.mostTrusted },
  ]);

  if (surface === "review" && selected) {
    return (
      <div style={{ padding: "18px 16px 28px", animation: "fadeIn 0.25s ease" }}>
        <BackButton label={t("guided.backToMatches")} onClick={() => setSurface("need-sats")} />
        <div style={{ marginTop: 20 }}>
          <Kicker>{t("guided.reviewKicker")}</Kicker>
          <h1 style={titleStyle()}>{t("guided.reviewTitle")}</h1>
          <p style={subtitleStyle()}>{t("guided.reviewSubtitle")}</p>
        </div>
        <div style={{
          marginTop: 20, padding: 18, borderRadius: 18,
          border: `1px solid ${T.accent}55`, background: T.card,
          boxShadow: `0 16px 42px ${T.accentDim}`,
        }}>
          <ReviewRow label={t("guided.youReceive")} value={`${selected.amountSats.toLocaleString()} sats`} />
          <ReviewRow
            label={t("guided.youPay")}
            value={selected.fiatQuote
              ? `${selected.fiatQuote.amount.toLocaleString()} ${selected.fiatQuote.currency}`
              : t("guided.confirmWithSeller")}
          />
          <ReviewRow
            label={t("guided.paymentMethod")}
            value={getRailByKey(selected.paymentRail)?.displayName ?? selected.paymentRail}
          />
          <ReviewRow
            label={t("guided.seller")}
            value={shortKey(selected.sellerPubkey)}
          />
          <ReviewRow
            label={t("guided.advertisedFees")}
            value={`${Math.floor(selected.advertisedFeesMsats.total / 1000).toLocaleString()} sats`}
            last
          />
        </div>
        <div style={{
          marginTop: 14, padding: "12px 14px", borderRadius: T.r,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontSize: 12, lineHeight: 1.55,
        }}>
          {t("guided.reviewSafety")}
        </div>
        <button
          type="button"
          onClick={() => onOpenTrade(selected.listing.id)}
          style={primaryButtonStyle()}
        >
          {t("guided.reviewFullTrade")} <span aria-hidden="true">→</span>
        </button>
        <button
          type="button"
          onClick={() => setSurface("need-sats")}
          style={secondaryButtonStyle()}
        >
          {t("guided.chooseDifferent")}
        </button>
      </div>
    );
  }

  if (surface === "need-sats") {
    return (
      <div style={{ padding: "18px 16px 28px", animation: "fadeIn 0.25s ease" }}>
        <BackButton label={t("guided.backHome")} onClick={() => setSurface("home")} />
        <div style={{ marginTop: 20 }}>
          <Kicker>{t("guided.guidedExchange")}</Kicker>
          <h1 style={titleStyle()}>{t("guided.needSatsTitle")}</h1>
          <p style={subtitleStyle()}>{t("guided.needSatsSubtitle")}</p>
        </div>

        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={fieldLabelStyle()}>
            {t("guided.howManySats")}
            <div style={{ position: "relative", marginTop: 6 }}>
              <input
                autoFocus
                inputMode="numeric"
                value={amountSats}
                onChange={event => setAmountSats(event.target.value.replace(/[^\d]/g, ""))}
                placeholder="50,000"
                style={{ ...inputStyle, paddingRight: 58, fontSize: 20, fontWeight: 700 }}
              />
              <span style={{
                position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
                color: T.muted, fontFamily: T.mono, fontSize: 11,
              }}>SATS</span>
            </div>
          </label>

          <label style={fieldLabelStyle()}>
            {t("guided.howPay")}
            <select
              value={effectiveRail}
              onChange={event => setPaymentRail(event.target.value)}
              style={{ ...inputStyle, marginTop: 6, fontSize: 15 }}
            >
              {railChoices.map(rail => (
                <option key={rail.key} value={rail.key}>{rail.displayName}</option>
              ))}
            </select>
          </label>

          <label style={fieldLabelStyle()}>
            {t("guided.maxSpend")} <span style={{ color: T.muted, fontWeight: 400 }}>{t("guided.optional")}</span>
            <div style={{ position: "relative", marginTop: 6 }}>
              <input
                inputMode="decimal"
                value={maxFiat}
                onChange={event => setMaxFiat(event.target.value)}
                placeholder={t("guided.noMaximum")}
                style={{ ...inputStyle, paddingRight: 56 }}
              />
              <span style={{
                position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
                color: T.muted, fontFamily: T.mono, fontSize: 11,
              }}>{fiatCurrency}</span>
            </div>
          </label>

          <button
            type="button"
            disabled={matching}
            onClick={() => void findMatches()}
            style={{ ...primaryButtonStyle(), marginTop: 2, opacity: matching ? 0.7 : 1 }}
          >
            {matching ? t("guided.comparing") : t("guided.findMatches")}
          </button>
        </div>

        {error && (
          <div style={{
            marginTop: 14, padding: "12px 14px", borderRadius: T.r,
            color: T.red, background: T.redDim, border: `1px solid ${T.red}44`,
            fontSize: 13, lineHeight: 1.45,
          }}>{error}</div>
        )}

        {recommendationCards.length > 0 && (
          <div style={{ marginTop: 26 }}>
            <Kicker>{t("guided.matchesFound", { count: matches.length })}</Kicker>
            <h2 style={{ ...titleStyle(), fontSize: 23, marginTop: 7 }}>{t("guided.pickMatch")}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
              {recommendationCards.map(({ candidate, labels }) => (
                <MatchCard
                  key={candidate.listing.id}
                  candidate={candidate}
                  labels={labels}
                  onSelect={() => {
                    setSelected(candidate);
                    setSurface("review");
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "22px 16px 28px", animation: "fadeIn 0.25s ease" }}>
      <div style={{
        padding: "22px 18px", borderRadius: 22,
        background: `linear-gradient(145deg, ${T.card}, ${T.surface})`,
        border: `1px solid ${T.borderHi}`,
        boxShadow: "0 18px 45px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 12, background: T.accentDim,
            display: "grid", placeItems: "center", color: T.accent, fontSize: 18,
          }}>✦</div>
          <Kicker>{t("guided.assistant")}</Kicker>
        </div>
        <h1 style={{ ...titleStyle(), fontSize: 31 }}>{t("guided.homeTitle")}</h1>
        <p style={{ ...subtitleStyle(), marginTop: 10 }}>{t("guided.homeSubtitle")}</p>
        {community && (
          <div style={{
            marginTop: 16, display: "inline-flex", alignItems: "center", gap: 7,
            padding: "7px 10px", borderRadius: 999, background: T.bg,
            border: `1px solid ${T.border}`, color: T.muted,
            fontFamily: T.mono, fontSize: 10,
          }}>
            <span>{community.flagEmoji}</span>
            <span>{community.disambiguator ?? community.displayName}</span>
            <span>·</span>
            <span>{community.currency}</span>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
        <IntentCard
          icon="⚡"
          title={t("guided.needSats")}
          body={t("guided.needSatsBody")}
          emphasis
          onClick={startNeedSats}
        />
        <IntentCard
          icon="↗"
          title={t("guided.haveSats")}
          body={t("guided.haveSatsBody")}
          onClick={onCreate}
        />
        <IntentCard
          icon="◫"
          title={t("guided.marketplace")}
          body={t("guided.marketplaceBody")}
          onClick={() => onBrowse("marketplace")}
        />
        <IntentCard
          icon="✓"
          title={t("guided.payBill")}
          body={t("guided.payBillBody")}
          onClick={() => onBrowse("bill-pay")}
        />
      </div>

      {attentionTrades.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <Kicker>{t("guided.needsAttention")}</Kicker>
          <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 8 }}>
            {attentionTrades.slice(0, 3).map(trade => (
              <button
                type="button"
                key={trade.id}
                onClick={() => onOpenTrade(trade.id)}
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: T.r,
                  background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, display: "flex", alignItems: "center",
                  justifyContent: "space-between", gap: 12, textAlign: "left",
                  cursor: "pointer", fontFamily: T.sans,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {trade.description}
                  </span>
                  <span style={{ display: "block", color: T.muted, fontSize: 11, marginTop: 3 }}>
                    {t("guided.tradeStatus", { status: trade.status.toLowerCase() })}
                  </span>
                </span>
                <span style={{ color: T.accent, fontSize: 18 }}>→</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <button type="button" onClick={() => onBrowse("all")} style={{ ...secondaryButtonStyle(), marginTop: 22 }}>
        {t("guided.explore")} <span aria-hidden="true">→</span>
      </button>
      <div style={{ textAlign: "center", color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
        {t("guided.classicAlways")}
      </div>
    </div>
  );
}

function mergeRecommendationLanes(
  lanes: { label: string; candidate: GuidedMatchCandidate | null }[],
): { candidate: GuidedMatchCandidate; labels: string[] }[] {
  const merged = new Map<string, { candidate: GuidedMatchCandidate; labels: string[] }>();
  for (const lane of lanes) {
    if (!lane.candidate) continue;
    const current = merged.get(lane.candidate.listing.id);
    if (current) current.labels.push(lane.label);
    else merged.set(lane.candidate.listing.id, { candidate: lane.candidate, labels: [lane.label] });
  }
  return [...merged.values()];
}

function MatchCard({
  candidate,
  labels,
  onSelect,
}: {
  candidate: GuidedMatchCandidate;
  labels: string[];
  onSelect: () => void;
}) {
  const { t } = useT();
  const ratingCount = candidate.ratings?.count ?? 0;
  const positive = ratingCount > 0
    ? Math.round((candidate.ratings!.positive / Math.max(1, candidate.ratings!.positive + candidate.ratings!.negative)) * 100)
    : null;
  const premium = formatSignedPremium(candidate.listing.premiumBps);
  const lowestPrice = labels.includes(t("guided.lowestPrice"));
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: "100%", padding: 15, borderRadius: 17,
        border: `1px solid ${labels.includes(t("guided.bestOverall")) ? T.accent + "66" : T.border}`,
        background: T.card, color: T.text, textAlign: "left", cursor: "pointer",
        fontFamily: T.sans,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {labels.map(label => (
          <span key={label} style={{
            padding: "4px 7px", borderRadius: 999,
            color: T.accent, background: T.accentDim,
            fontFamily: T.mono, fontSize: 9, fontWeight: 700,
            textTransform: "uppercase",
          }}>{label}</span>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 11 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>
            {candidate.amountSats.toLocaleString()} sats
          </div>
          <div style={{ color: T.muted, fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {candidate.listing.description}
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: "right" }}>
          <div style={{ color: T.text, fontSize: 15, fontWeight: 800 }}>
            {candidate.fiatQuote
              ? `${candidate.fiatQuote.amount.toLocaleString()} ${candidate.fiatQuote.currency}`
              : t("guided.askSeller")}
          </div>
          <div style={{ color: T.muted, fontSize: 10, marginTop: 4 }}>
            {getRailByKey(candidate.paymentRail)?.displayName ?? candidate.paymentRail}
          </div>
        </div>
      </div>
      <div style={{
        marginTop: 10, padding: "8px 10px", borderRadius: 10,
        background: T.surface, color: T.muted, fontSize: 11, lineHeight: 1.4,
      }}>
        <span style={{ color: lowestPrice ? T.accent : T.text, fontWeight: 700 }}>
          {lowestPrice && candidate.fiatQuote
            ? t("guided.lowestPriceReason", {
                amount: candidate.fiatQuote.amount.toLocaleString(),
                currency: candidate.fiatQuote.currency,
              })
            : t("guided.sellerPremium")}
        </span>
        {" · "}
        {t("guided.premiumValue", { premium })}
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 10, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}`,
        color: T.muted, fontSize: 11,
      }}>
        <span>
          {positive === null
            ? t("guided.newSeller")
            : t("guided.ratingSummary", { percent: positive, count: ratingCount })}
        </span>
        <span style={{ color: T.accent, fontWeight: 700 }}>{t("guided.review")} →</span>
      </div>
    </button>
  );
}

function IntentCard({
  icon,
  title,
  body,
  emphasis = false,
  onClick,
}: {
  icon: string;
  title: string;
  body: string;
  emphasis?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 132, padding: 15, borderRadius: 17,
        background: emphasis ? T.accentDim : T.surface,
        border: `1px solid ${emphasis ? T.accent + "66" : T.border}`,
        color: T.text, textAlign: "left", cursor: "pointer", fontFamily: T.sans,
      }}
    >
      <span style={{ color: emphasis ? T.accent : T.muted, fontSize: 22 }}>{icon}</span>
      <span style={{ display: "block", marginTop: 14, fontSize: 15, fontWeight: 800 }}>{title}</span>
      <span style={{ display: "block", marginTop: 5, color: T.muted, fontSize: 11.5, lineHeight: 1.45 }}>{body}</span>
    </button>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: 0, border: "none", background: "transparent",
      color: T.muted, cursor: "pointer", fontFamily: T.sans, fontSize: 13,
    }}>← {label}</button>
  );
}

function Kicker({ children }: { children: string }) {
  return <div style={{ color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase" }}>{children}</div>;
}

function ReviewRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 16,
      padding: "12px 0", borderBottom: last ? "none" : `1px solid ${T.border}`,
    }}>
      <span style={{ color: T.muted, fontSize: 12 }}>{label}</span>
      <span style={{ color: T.text, fontWeight: 700, fontSize: 13, textAlign: "right" }}>{value}</span>
    </div>
  );
}

function shortKey(pubkey: string): string {
  return pubkey.length > 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}` : pubkey;
}

function formatSignedPremium(premiumBps: number | undefined): string {
  const bps = premiumBps ?? 0;
  const percent = bps / 100;
  const formatted = Number.isInteger(percent)
    ? percent.toFixed(0)
    : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${bps > 0 ? "+" : ""}${formatted}%`;
}

function titleStyle() {
  return {
  margin: "8px 0 0",
  color: T.text,
  fontFamily: T.sans,
  fontSize: 28,
  lineHeight: 1.12,
  fontWeight: 800,
  } as const;
}

function subtitleStyle() {
  return {
  margin: "9px 0 0",
  color: T.muted,
  fontFamily: T.sans,
  fontSize: 14,
  lineHeight: 1.55,
  } as const;
}

function fieldLabelStyle() {
  return {
  color: T.text,
  fontFamily: T.sans,
  fontSize: 13,
  fontWeight: 700,
  } as const;
}

function primaryButtonStyle() {
  return {
  width: "100%",
  marginTop: 18,
  padding: "13px 16px",
  border: "none",
  borderRadius: 13,
  background: T.accent,
  color: "#fff",
  fontFamily: T.sans,
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  } as const;
}

function secondaryButtonStyle() {
  return {
  width: "100%",
  marginTop: 10,
  padding: "12px 16px",
  border: `1px solid ${T.border}`,
  borderRadius: 13,
  background: T.surface,
  color: T.text,
  fontFamily: T.sans,
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  } as const;
}
