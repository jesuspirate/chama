// ══════════════════════════════════════════════════════════════════════════
// Chama — "Your store lapsed — renew?" card (store permanence #49, Tier 1)
// ══════════════════════════════════════════════════════════════════════════
//
// The manual-renew surface for the case auto-renew didn't catch (seller was
// offline when the store lapsed, or is unbonded so auto-renew never ran). It
// lists the seller's own listings that LAPSED UNFUNDED and offers a one-tap
// re-publish (a fresh CREATE, new 24h window) via `onRenew`. Money-safe: renew
// re-lists a browse offer, it never moves sats.

import { type EscrowState } from "../../escrow-engine/types.js";
import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { useT } from "../../i18n/index.js";

export function LapsedStoreCard({
  listings,
  bonded,
  showAutoRenew,
  autoRenewEnabled,
  onAutoRenewChange,
  renewingId,
  onRenew,
  onSnooze,
}: {
  /** The seller's lapsed-unfunded listings (from lapsedRenewableListings). */
  listings: EscrowState[];
  /** Tier 3 copy: a bonded seller's store auto-renews while online; this card
   *  is the offline/unbonded fallback. Only changes the subtitle wording. */
  bonded: boolean;
  /** Show the explicit preference whenever the seller has a bonded storefront
   *  or owns an unfunded listing. */
  showAutoRenew: boolean;
  autoRenewEnabled: boolean;
  onAutoRenewChange: (enabled: boolean) => void;
  /** The listing id a renew is currently in-flight for (disables its button). */
  renewingId: string | null;
  onRenew: (id: string) => void;
  /** Hide the resurfaced lapsed-store reminder for 24 hours. */
  onSnooze: () => void;
}) {
  const { t } = useT();
  if (listings.length === 0 && !showAutoRenew) return null;
  return (
    <div
      style={{
        width: "calc(100% - 32px)",
        margin: "12px 16px 0",
        padding: "12px 14px",
        background: T.purpleDim,
        border: `1px solid ${T.purple}66`,
        borderRadius: T.r,
        fontFamily: T.sans,
      }}
    >
      {showAutoRenew && (
        <button
          type="button"
          onClick={() => onAutoRenewChange(!autoRenewEnabled)}
          aria-pressed={autoRenewEnabled}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: 0, border: "none", background: "none", textAlign: "left",
            cursor: bonded ? "pointer" : "default", fontFamily: T.sans,
          }}
          disabled={!bonded}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12, color: T.text, fontWeight: 700 }}>
              {t("me.storeAutoRenew")}
            </span>
            <span style={{ display: "block", fontSize: 10.5, color: bonded ? T.muted : T.amber, marginTop: 2, lineHeight: 1.4 }}>
              {bonded ? t("me.storeAutoRenewHint") : t("me.storeAutoRenewBondRequired")}
            </span>
          </span>
          <span aria-hidden="true" style={{
            flexShrink: 0, width: 40, height: 22, borderRadius: 999, position: "relative",
            background: autoRenewEnabled && bonded ? T.purple : T.border,
          }}>
            <span style={{
              position: "absolute", top: 2, left: autoRenewEnabled && bonded ? 20 : 2,
              width: 18, height: 18, borderRadius: "50%", background: "#fff",
              transition: "left .2s",
            }} />
          </span>
        </button>
      )}
      {listings.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: showAutoRenew ? 14 : 0 }}>
            <div
              style={{
                flex: 1, minWidth: 0,
                fontSize: 11, color: T.purple, fontFamily: T.mono,
                letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 700,
              }}
            >
              {listings.length === 1
                ? t("me.storeLapsedTitleOne")
                : t("me.storeLapsedTitleMany", { count: listings.length })}
            </div>
            <button
              type="button"
              onClick={onSnooze}
              title={t("me.storeLapsedSnoozeHint")}
              style={{
                flexShrink: 0, padding: "4px 8px", borderRadius: 999,
                border: `1px solid ${T.purple}55`, background: "transparent",
                color: T.purple, fontFamily: T.mono, fontSize: 9,
                fontWeight: 800, cursor: "pointer",
              }}
            >
              {t("me.storeLapsedSnooze")}
            </button>
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
            {bonded ? t("me.storeLapsedSubtitleBonded") : t("me.storeLapsedSubtitleUnbonded")}
          </div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {listings.map((l) => (
          <div
            key={l.id}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13, color: T.text,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                }}
              >
                {l.description}
              </div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 1 }}>
                <BitcoinAmount msats={l.amountMsats} size={12} gap={3} glyphScale={1.18} />
              </div>
            </div>
            <button
              onClick={() => onRenew(l.id)}
              disabled={renewingId === l.id}
              style={{
                flexShrink: 0,
                padding: "7px 14px",
                background: renewingId === l.id ? T.purpleDim : T.purple,
                color: renewingId === l.id ? T.muted : "#fff",
                border: "none", borderRadius: T.r,
                fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                cursor: renewingId === l.id ? "default" : "pointer",
              }}
            >
              {renewingId === l.id ? t("me.storeRenewing") : t("me.storeRenew")}
            </button>
          </div>
        ))}
          </div>
        </>
      )}
    </div>
  );
}
