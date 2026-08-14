import { useEffect, useMemo, useState } from "react";
import type { EscrowState, SelectedMenuItem } from "../../escrow-engine/types.js";
import {
  matchGuidedListings,
  validateGuidedTradeIntent,
  type GuidedMatchCandidate,
  type GuidedMatchReason,
} from "../../guided/index.js";
import { useT } from "../../i18n/index.js";
import { railsForCommunity } from "../../payments/rail-registry.js";
import { T, fmtSats, inputStyle } from "../theme.js";

export type GuidedConfirmPayload = {
  listingId: string;
  amountMsats: number;
  selectedItems?: SelectedMenuItem[];
};

const REASON_KEY: Record<GuidedMatchReason, string> = {
  available_now: "browse.guidedReasonAvailable",
  exact_amount: "browse.guidedReasonExact",
  amount_in_range: "browse.guidedReasonRange",
  compatible_payment_rail: "browse.guidedReasonRail",
  same_community: "browse.guidedReasonCommunity",
  same_federation: "browse.guidedReasonFed",
  lowest_fiat_quote: "browse.guidedReasonPrice",
  positive_trade_history: "browse.guidedReasonReputation",
};

/** Confirm-only buy-sats matcher. Never joins or spends by itself. */
export function GuidedBuyPanel({
  listings,
  stockByListing,
  browseCommunity,
  viewerPubkey,
  busy = false,
  onConfirm,
}: {
  listings: EscrowState[];
  stockByListing?: Map<string, number>;
  browseCommunity: string;
  viewerPubkey: string;
  busy?: boolean;
  onConfirm: (payload: GuidedConfirmPayload) => void | Promise<void>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [amountSats, setAmountSats] = useState("");
  const [rail, setRail] = useState("");
  const [maxFiat, setMaxFiat] = useState("");
  const [fiatCurrency, setFiatCurrency] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<GuidedMatchCandidate[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const railChoices = useMemo(() => {
    const locals = railsForCommunity(browseCommunity).slice(0, 8);
    return locals.length > 0 ? locals : railsForCommunity(null).slice(0, 8);
  }, [browseCommunity]);

  useEffect(() => {
    if (!rail && railChoices[0]) setRail(railChoices[0].key);
  }, [rail, railChoices]);

  const runMatch = () => {
    setError(null);
    setCandidates([]);
    setConfirmingId(null);
    const sats = Math.floor(Number(amountSats));
    const maxFiatNum = maxFiat.trim() ? Number(maxFiat) : undefined;
    const raw = {
      version: 1 as const,
      direction: "buy_sats" as const,
      amountSats: sats,
      paymentRails: rail ? [rail] : [],
      strategy: "available_now" as const,
      community: browseCommunity || undefined,
      ...(maxFiatNum !== undefined ? { maxFiatAmount: maxFiatNum } : {}),
      ...(fiatCurrency.trim()
        ? { fiatCurrency: fiatCurrency.trim().toUpperCase() }
        : {}),
    };
    const validated = validateGuidedTradeIntent(raw);
    if (!validated.ok) {
      setError(validated.issues[0]?.message ?? t("browse.guidedInvalid"));
      return;
    }
    const inputs = listings.map(listing => ({
      listing,
      availableUnits: stockByListing?.get(listing.id),
    }));
    const result = matchGuidedListings(validated.value, inputs, {
      viewerPubkey,
      limit: 5,
    });
    if (result.candidates.length === 0) {
      setError(t("browse.guidedNoMatch"));
      return;
    }
    setCandidates(result.candidates);
  };

  const confirm = async (candidate: GuidedMatchCandidate) => {
    if (busy || confirmingId) return;
    setConfirmingId(candidate.listing.id);
    try {
      await onConfirm({
        listingId: candidate.listing.id,
        amountMsats: candidate.amountSats * 1000,
        selectedItems: candidate.selectedItem ? [candidate.selectedItem] : undefined,
      });
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <div style={{
      marginBottom: 14,
      border: `1px solid ${T.border}`,
      borderRadius: T.r,
      background: T.surface,
      overflow: "hidden",
    }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          background: "transparent",
          border: "none",
          color: T.text,
          cursor: "pointer",
          fontFamily: T.sans,
          textAlign: "left",
        }}
      >
        <span>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{t("browse.guidedTitle")}</div>
          <div style={{ marginTop: 2, fontSize: 12, color: T.muted }}>{t("browse.guidedSubtitle")}</div>
        </span>
        <span style={{ color: T.accent, fontWeight: 700, fontSize: 13 }}>
          {open ? t("browse.guidedHide") : t("browse.guidedShow")}
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
            {t("browse.guidedAmount")}
            <input
              inputMode="numeric"
              value={amountSats}
              onChange={e => setAmountSats(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="50000"
              style={{ ...inputStyle, marginTop: 4, width: "100%" }}
            />
          </label>

          <label style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
            {t("browse.guidedRail")}
            <select
              value={rail}
              onChange={e => setRail(e.target.value)}
              style={{ ...inputStyle, marginTop: 4, width: "100%" }}
            >
              {railChoices.map(r => (
                <option key={r.key} value={r.key}>{r.displayName}</option>
              ))}
            </select>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8 }}>
            <label style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
              {t("browse.guidedMaxFiat")}
              <input
                inputMode="decimal"
                value={maxFiat}
                onChange={e => setMaxFiat(e.target.value)}
                placeholder={t("browse.guidedOptional")}
                style={{ ...inputStyle, marginTop: 4, width: "100%" }}
              />
            </label>
            <label style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
              {t("browse.guidedFiatCur")}
              <input
                value={fiatCurrency}
                onChange={e => setFiatCurrency(e.target.value.toUpperCase().slice(0, 3))}
                placeholder="KES"
                style={{ ...inputStyle, marginTop: 4, width: "100%" }}
              />
            </label>
          </div>

          <button
            type="button"
            onClick={runMatch}
            disabled={busy}
            style={{
              padding: "11px 14px",
              borderRadius: T.r,
              border: "none",
              background: T.accent,
              color: "#fff",
              fontWeight: 800,
              cursor: busy ? "wait" : "pointer",
              fontFamily: T.sans,
            }}
          >
            {t("browse.guidedFind")}
          </button>

          {error && (
            <div style={{ fontSize: 12, color: T.red, fontFamily: T.sans }}>{error}</div>
          )}

          {candidates.map(candidate => (
            <div
              key={candidate.listing.id}
              style={{
                padding: 12,
                borderRadius: T.r,
                border: `1px solid ${T.border}`,
                background: T.card,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>
                    {candidate.listing.description?.slice(0, 72) || candidate.listing.id}
                  </div>
                  <div style={{ marginTop: 3, fontSize: 12, color: T.muted, fontFamily: T.mono }}>
                    {fmtSats(candidate.amountSats)} · {candidate.paymentRail}
                    {candidate.fiatQuote
                      ? ` · ${candidate.fiatQuote.amount} ${candidate.fiatQuote.currency}`
                      : ""}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: T.accent, fontFamily: T.mono, flexShrink: 0 }}>
                  {candidate.score.total}
                </div>
              </div>
              <div style={{ fontSize: 11, color: T.muted }}>
                {candidate.reasons.map(r => t(REASON_KEY[r])).join(" · ")}
              </div>
              <button
                type="button"
                disabled={busy || confirmingId === candidate.listing.id}
                onClick={() => void confirm(candidate)}
                style={{
                  padding: "10px 12px",
                  borderRadius: T.r,
                  border: `1px solid ${T.accent}`,
                  background: "transparent",
                  color: T.accent,
                  fontWeight: 800,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {confirmingId === candidate.listing.id
                  ? t("browse.guidedJoining")
                  : t("browse.guidedConfirm")}
              </button>
            </div>
          ))}

          <div style={{ fontSize: 11, color: T.muted }}>{t("browse.guidedFootnote")}</div>
        </div>
      )}
    </div>
  );
}
