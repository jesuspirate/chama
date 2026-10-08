// ══════════════════════════════════════════════════════════════════════════
// Chama — Home hero (v7 redesign, canvas "Home")
// ══════════════════════════════════════════════════════════════════════════
//
// The top of the Home tab: where your money is, then what needs you, then
// what else is running. Presentation only — every number comes from the same
// selectors the status bar and Me already use (wallet balance, the live
// escrow commitment, selectNeedsYouTrades), so Home can never disagree with
// them. "Ready to collect" is a COUNT of claimable trades, not a summed
// amount: the payout of each is shown on its own card, where fees and splits
// are already resolved.

import { useState, type ReactNode } from "react";
import type { EscrowState } from "../../escrow-engine/types.js";
import type { OnchainObservation } from "../../escrow-engine/onchain-attention.js";
import { useT } from "../../i18n/index.js";
import { T, fmtSats } from "../theme.js";
import { AttentionQueue } from "./AttentionQueue.js";
import { Badge, LockGlyph } from "./Badge.js";
import { estimateFiatForMsats, formatFiatAmount, normalizeFiatCurrency } from "../amount-display.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import type { NostrProfileNameMap } from "../nostr-profiles.js";

export function HomeHero({
  balanceMsats, inEscrowMsats, readyToCollectCount, needsYou, alsoGoingOn,
  pubkey, profileNames, kind0Enabled, onchainObservations, onOpenTrade, quoteCurrency,
  children,
}: {
  balanceMsats: number;
  /** activeCommittedMsats — the same figure as the status bar's in-trade pill. */
  inEscrowMsats: number;
  readyToCollectCount: number;
  /** selectNeedsYouTrades output (urgency-ranked). */
  needsYou: EscrowState[];
  /** Live trades that do not need this person right now. */
  alsoGoingOn: EscrowState[];
  pubkey: string;
  profileNames?: NostrProfileNameMap;
  kind0Enabled?: boolean;
  onchainObservations?: ReadonlyMap<string, OnchainObservation>;
  onOpenTrade: (id: string) => void;
  quoteCurrency?: string | null;
  /** Rendered in the second column on wide screens (the standing dashboard). */
  children?: ReactNode;
}) {
  const { t } = useT();
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const price = useBitcoinPrice();
  const rates = useFiatRates();
  const currency = normalizeFiatCurrency(quoteCurrency) ?? "USD";
  const fiat = balanceMsats > 0
    ? estimateFiatForMsats({ amountMsats: balanceMsats, currency, usdPerBtc: price.usd, usdFiatRates: rates.rates })
    : null;

  return (
    <div className="chama-home">
      <div className="chama-home-main">
        {/* v7 Figma pass: the wallet leads, big and uncarded; then exactly
            one "needs you" card, with the rest one tap away. The h1 stays
            for screen readers (the tab is still called Home). */}
        <h1 className="chama-sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", margin: 0 }}>
          {t("dash.homeTitle")}
        </h1>

        <section data-home-wallet style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 4 }}>
          <Label icon={<WalletGlyph />}>{t("dash.inWallet")}</Label>
          <Sats msats={balanceMsats} size="calc(var(--chama-fs-amount) * 1.25)" />
          {fiat != null && (
            <div style={{ fontSize: T.fs.fiat, color: T.ink2, fontFamily: T.sans }}>
              {t("dash.fiatApprox", { amount: formatFiatAmount(fiat, currency) })}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, padding: "0 12px", borderRadius: 999, background: T.surface, border: `1px solid ${T.line}` }}>
              <Label icon={<LockGlyph size={15} />}>{t("dash.inEscrowForYou")}</Label>
              <Sats msats={inEscrowMsats} size={T.fs.secondary} weight={700} />
            </span>
            {readyToCollectCount > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, padding: "0 12px", borderRadius: 999, background: T.attnBg, border: `1px solid ${T.attn}` }}>
                <Label icon={<CollectGlyph />} color={T.attnInk}>{t("dash.readyTrades", { count: readyToCollectCount })}</Label>
              </span>
            )}
          </div>
        </section>

        <AttentionQueue
          profileNames={profileNames} kind0Enabled={kind0Enabled}
          ranked={showAllNeeds ? needsYou : needsYou.slice(0, 1)}
          onchainObservations={onchainObservations}
          pubkey={pubkey}
          onOpenTrade={onOpenTrade}
        />
        {needsYou.length > 1 && (
          <button type="button" aria-expanded={showAllNeeds} onClick={() => setShowAllNeeds(v => !v)} style={{
            alignSelf: "flex-start", minHeight: T.size.touch, marginTop: -12, padding: 0, background: "none", border: "none",
            color: T.ink, fontFamily: T.sans, fontSize: T.fs.body, fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer",
          }}>
            {showAllNeeds ? t("dash.showFewerNeeds") : t("dash.moreNeedYou", { count: needsYou.length - 1 })}
          </button>
        )}

        {alsoGoingOn.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 style={{ margin: 0, fontFamily: T.sans, fontSize: T.fs.title2, fontWeight: 700, color: T.ink }}>
              {t("dash.alsoGoingOn")}
            </h2>
            <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.rCard, overflow: "hidden" }}>
              {alsoGoingOn.map((e, i) => (
                <button key={e.id} type="button" onClick={() => onOpenTrade(e.id)} style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  minHeight: T.size.touch, padding: 14, textAlign: "left",
                  background: "none", border: "none", cursor: "pointer",
                  borderTop: i === 0 ? "none" : `1px solid ${T.line}`, color: T.ink,
                }}>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontFamily: T.sans, fontSize: T.fs.headline, fontWeight: 600, overflowWrap: "anywhere" }}>
                      {e.title || e.description}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Badge status={e.status} />
                      <Sats msats={e.amountMsats} size={T.fs.secondary} weight={600} color={T.ink2} />
                    </span>
                  </span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.ink3} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      {children && <div className="chama-home-side">{children}</div>}
    </div>
  );
}

/** ₿ + sats in DM Sans tabular figures. Wraps rather than truncates. */
export function Sats({ msats, size, weight = 700, color = T.ink }: {
  msats: number; size: string; weight?: number; color?: string;
}) {
  return (
    <span style={{
      fontFamily: T.sans, fontSize: size, fontWeight: weight, color,
      fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em",
      lineHeight: 1.15, overflowWrap: "anywhere",
    }}>
      ₿ {fmtSats(msats)}
    </span>
  );
}

function Label({ icon, children, color = T.ink2 }: { icon: ReactNode; children: ReactNode; color?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, color,
      fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 500,
    }}>
      {icon}{children}
    </div>
  );
}

function WalletGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M3 7l12-4v4" />
      <circle cx="16.5" cy="14" r="1.2" />
    </svg>
  );
}

function CollectGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}

/** Home's layout: one column, two from 1360px (sidebar + both columns fit). */
export function homeCss(): string {
  return `
  .chama-home{display:flex;flex-direction:column;gap:24px;padding:16px 16px 24px;max-width:1080px;margin:0 auto}
  .chama-home-main{max-width:560px;width:100%;margin:0 auto}
  .chama-home-main{display:flex;flex-direction:column;gap:24px;min-width:0}
  .chama-home-side{min-width:0}
  @media (min-width:1360px){
    .chama-home-main{margin:0}
    .chama-home{display:grid;grid-template-columns:minmax(0,520px) minmax(0,1fr);align-items:start;gap:32px;max-width:1240px;padding:28px 32px 48px}
  }`;
}
