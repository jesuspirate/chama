// ══════════════════════════════════════════════════════════════════════════
// Chama — edit a live listing (A3)
// ══════════════════════════════════════════════════════════════════════════
//
// Deliberately small. An edit is a REPLACEMENT (listing-edit.ts), so every
// field this offers costs a fresh CREATE and a CANCEL on every relay — and the
// listing gets a NEW id, which any buyer who bookmarked the old one will lose.
// That is a fine trade for the two things sellers actually change (a typo, a
// price) and a poor one for re-shooting nine photos. Anything structural still
// goes through delete + re-create, where the full Create wizard already lives.
//
// The honest disclosures are the point of this sheet: the seller is told the
// listing gets a new id before they commit, and told when a buyer's hold is
// blocking the edit rather than being shown a button that fails.

import { useMemo, useState } from "react";
import { useT } from "../../i18n/index.js";
import type { EscrowState } from "../../escrow-engine/types.js";
import { canEditListing, type ListingEdits } from "../../escrow-engine/listing-edit.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { T, inputStyle } from "../theme.js";

export function EditListingModal({
  listing,
  userPubkey,
  onCancel,
  onSave,
}: {
  listing: EscrowState;
  userPubkey: string | null;
  onCancel: () => void;
  onSave: (edits: ListingEdits) => Promise<void>;
}) {
  const { t } = useT();
  const [description, setDescription] = useState(listing.description ?? "");
  const [sats, setSats] = useState(String(Math.round(listing.amountMsats / 1000)));
  const [fiat, setFiat] = useState(
    listing.fiatAmount !== undefined ? String(listing.fiatAmount) : "",
  );
  const [stock, setStock] = useState(
    listing.stock !== undefined ? String(listing.stock) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ⚠ The two price fields must move TOGETHER. Editing them independently is how
  // a seller ends up publishing 155,000 sats priced at last week's fiat — the
  // create form converts live, and an edit screen that does not is quietly a
  // different (and worse) tool for the same job.
  const btc = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const currency = (listing.fiatCurrency ?? "USD").toUpperCase();
  /** Sats → this listing's currency. Null when no live rate is available, in
   *  which case NOTHING is converted — a stale or invented rate on a price
   *  field is worse than an empty one. */
  const satsToFiat = useMemo(() => {
    const usdPerBtc = btc.usd;
    if (!usdPerBtc || usdPerBtc <= 0) return null;
    const usdPerUnit = currency === "USD" ? 1 : fiatRates.rates?.[currency];
    if (!usdPerUnit || usdPerUnit <= 0) return null;
    return (s: number) => (s / 100_000_000) * usdPerBtc * usdPerUnit;
  }, [btc.usd, fiatRates.rates, currency]);
  const fiatToSats = useMemo(() => {
    const usdPerBtc = btc.usd;
    if (!usdPerBtc || usdPerBtc <= 0) return null;
    const usdPerUnit = currency === "USD" ? 1 : fiatRates.rates?.[currency];
    if (!usdPerUnit || usdPerUnit <= 0) return null;
    return (f: number) => Math.round((f / usdPerUnit / usdPerBtc) * 100_000_000);
  }, [btc.usd, fiatRates.rates, currency]);

  const onSatsChange = (raw: string) => {
    const next = raw.replace(/[^0-9]/g, "");
    setSats(next);
    const n = Number(next);
    if (satsToFiat && Number.isFinite(n) && n > 0) setFiat(satsToFiat(n).toFixed(2));
    else if (!next) setFiat("");
  };
  const onFiatChange = (raw: string) => {
    const next = raw.replace(/[^0-9.]/g, "");
    setFiat(next);
    const n = Number(next);
    if (fiatToSats && Number.isFinite(n) && n > 0) setSats(String(fiatToSats(n)));
    else if (!next) setSats("");
  };

  // Prefill from a live conversion when the listing never stored a fiat amount,
  // so the field opens with the same number the card shows.
  const showFiatField = listing.fiatAmount !== undefined || !!listing.fiatCurrency;
  const [fiatPrefilled, setFiatPrefilled] = useState(listing.fiatAmount !== undefined);
  if (!fiatPrefilled && satsToFiat && Number(sats) > 0) {
    setFiatPrefilled(true);
    setFiat(satsToFiat(Number(sats)).toFixed(2));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const check = canEditListing(listing, userPubkey, nowSec);
  const blockedReason = check.ok ? null : check.reason;

  const submit = async () => {
    setError(null);
    const satsNum = Number(sats);
    if (!Number.isFinite(satsNum) || satsNum <= 0) {
      setError(t("edit.badAmount"));
      return;
    }
    const edits: ListingEdits = {
      description: description.trim(),
      amountMsats: Math.round(satsNum) * 1000,
      ...(fiat.trim() ? { fiatAmount: Number(fiat) } : {}),
      ...(stock.trim() ? { stock: Math.max(0, Math.round(Number(stock))) } : {}),
    };
    setSaving(true);
    try {
      await onSave(edits);
    } catch (e: any) {
      setError(e?.message || t("edit.failed"));
      setSaving(false);
    }
  };

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onCancel}
        style={{
          position: "fixed", inset: 0, zIndex: 9996,
          background: "rgba(0,0,0,0.56)",
          backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)",
        }}
      />
      <div style={{
        position: "fixed", zIndex: 9997,
        left: 16, right: 16, top: "50%", transform: "translateY(-50%)",
        maxWidth: 460, margin: "0 auto", padding: 18,
        borderRadius: T.r, background: T.card,
        border: `1px solid ${T.border}`,
        boxShadow: "0 18px 54px rgba(0,0,0,0.72)",
      }}>
        <div style={{
          color: T.amber, fontFamily: T.mono, fontSize: 10, fontWeight: 800,
          letterSpacing: 1.1, textTransform: "uppercase", marginBottom: 12,
        }}>✎ {t("edit.title")}</div>

        {blockedReason === "buyer-holding" ? (
          // A buyer reserved this offer at the terms they saw. Say so plainly
          // rather than letting them press Save into a rejection.
          <div style={{
            padding: "12px 14px", borderRadius: T.rs, marginBottom: 14,
            background: `${T.amber}12`, border: `1px solid ${T.amber}44`,
            color: T.amber, fontFamily: T.sans, fontSize: 13, lineHeight: 1.5,
          }}>{t("edit.buyerHolding")}</div>
        ) : blockedReason ? (
          <div style={{
            padding: "12px 14px", borderRadius: T.rs, marginBottom: 14,
            background: `${T.red}12`, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.sans, fontSize: 13, lineHeight: 1.5,
          }}>{t("edit.blocked")}</div>
        ) : null}

        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, letterSpacing: 1, marginBottom: 5 }}>
            {t("edit.description")}
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!!blockedReason || saving}
            rows={3}
            style={{ ...inputStyle, width: "100%", resize: "vertical" }}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <label>
            <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, letterSpacing: 1, marginBottom: 5 }}>
              {t("edit.priceSats")}
            </div>
            <input
              value={sats}
              onChange={(e) => onSatsChange(e.target.value)}
              inputMode="numeric"
              disabled={!!blockedReason || saving}
              style={{ ...inputStyle, width: "100%" }}
            />
          </label>
          {/* ⚠ Rendered whenever a currency is known, NOT only when a fiat
              amount was stored. Many listings carry a currency and a DERIVED
              price (the card's "USD 93.94"), so gating on a stored amount
              showed an empty field the seller could not use — which is what it
              looked like in the field report. */}
          {showFiatField && (
            <label>
              <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, letterSpacing: 1, marginBottom: 5 }}>
                {t("edit.priceFiat", { currency: listing.fiatCurrency ?? "" })}
              </div>
              <input
                value={fiat}
                onChange={(e) => onFiatChange(e.target.value)}
                inputMode="decimal"
                disabled={!!blockedReason || saving}
                style={{ ...inputStyle, width: "100%" }}
              />
            </label>
          )}
          {listing.stock !== undefined && (
            <label>
              <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, letterSpacing: 1, marginBottom: 5 }}>
                {t("edit.stock")}
              </div>
              <input
                value={stock}
                onChange={(e) => setStock(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                disabled={!!blockedReason || saving}
                style={{ ...inputStyle, width: "100%" }}
              />
            </label>
          )}
        </div>

        {/* The one thing a seller cannot discover on their own: saving mints a
            NEW listing id, because an edit is a replacement. Better said here
            than found out afterwards. */}
        <div style={{
          color: T.muted, fontFamily: T.sans, fontSize: 12, lineHeight: 1.5, marginBottom: 14,
        }}>{t("edit.replacesNote")}</div>

        {error && (
          <div style={{
            padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
            background: `${T.red}12`, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.sans, fontSize: 13, lineHeight: 1.45,
          }}>{error}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: "13px 14px", borderRadius: T.rs,
              background: T.surface, border: `1px solid ${T.border}`,
              color: T.muted, fontFamily: T.sans, fontSize: 15, fontWeight: 800,
              cursor: saving ? "default" : "pointer",
            }}
          >{t("common.cancel")}</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!!blockedReason || saving}
            style={{
              padding: "13px 14px", borderRadius: T.rs,
              background: blockedReason || saving ? T.surface : T.amberDim,
              border: `1px solid ${blockedReason || saving ? T.border : `${T.amber}66`}`,
              color: blockedReason || saving ? T.muted : T.amber,
              fontFamily: T.sans, fontSize: 15, fontWeight: 800,
              cursor: blockedReason || saving ? "default" : "pointer",
            }}
          >{saving ? t("edit.saving") : t("edit.save")}</button>
        </div>
      </div>
    </>
  );
}
