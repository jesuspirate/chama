// ══════════════════════════════════════════════════════════════════════════
// Chama — leftover sats still on their way out (Home)
// ══════════════════════════════════════════════════════════════════════════
//
// Home lists every place Chama holds sats. The cards in HeldSats cover the
// wallet balance, stranded claims, the pending ecash export, lock recovery
// and kept wallets; this adds the rest from readHeldLeftovers(): a claim
// still redeeming, Fedi ecash going back, a reclaimed bond (at its key or
// confirming), and an on-chain payout not yet sent. Each card says who holds
// the sats and until when, with at most one way out. A place Chama couldn't
// read says "couldn't check", never nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import type { HeldLeftover, HeldLeftovers as HeldLeftoversData } from "../../payments/held-leftovers.js";

/** Re-read on this cadence while Home is open (explorer reads included). */
const REFRESH_MS = 5 * 60_000;

export type LeftoversRead =
  | { status: "loading" }
  | { status: "ok"; data: HeldLeftoversData }
  /** The whole read failed: show "couldn't check", never nothing. */
  | { status: "failed" };

export function useHeldLeftovers(read: (() => Promise<HeldLeftoversData>) | undefined, revision = 0) {
  const [result, setResult] = useState<LeftoversRead>({ status: "loading" });
  const seq = useRef(0);
  const refresh = useCallback(() => {
    if (!read) return;
    const mine = ++seq.current;
    read().then(
      data => { if (seq.current === mine) setResult({ status: "ok", data }); },
      error => {
        console.error("[chama] reading leftover sats failed:", error);
        if (seq.current === mine) setResult({ status: "failed" });
      },
    );
  }, [read]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { clearInterval(timer); seq.current++; };
  }, [revision, refresh]);
  return { result: read ? result : { status: "loading" as const }, refresh };
}

/** True when the leftovers section has something to show. */
export function leftoversShowSomething(result: LeftoversRead): boolean {
  if (result.status === "failed") return true;
  if (result.status !== "ok") return false;
  return result.data.entries.length > 0 || result.data.unchecked.length > 0;
}

function sats(entry: HeldLeftover): number {
  return "amountMsats" in entry ? Math.floor(entry.amountMsats / 1000) : Number(entry.amountSats);
}

const cardStyle = {
  background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 16, marginBottom: 16,
} as const;
const titleStyle = { fontFamily: T.sans, fontSize: T.fs.body, fontWeight: 700, color: T.ink, marginBottom: 6 } as const;
const bodyStyle = { fontFamily: T.sans, fontSize: T.fs.secondary, color: T.text, lineHeight: 1.5 } as const;
const buttonStyle = {
  marginTop: 12, minHeight: T.size.touch, padding: "10px 14px", borderRadius: T.rs,
  background: T.surface, border: `1px solid ${T.border}`, color: T.text,
  fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
} as const;

export function HeldLeftovers({ result, onOpenTrade, onOpenBond, onCheckAgain }: {
  result: LeftoversRead;
  onOpenTrade: (escrowId: string) => void;
  /** The bond screen, where a reclaimed bond is sent out. */
  onOpenBond?: () => void;
  onCheckAgain: () => void;
}) {
  const { t } = useT();
  if (result.status === "loading") return null;
  if (result.status === "failed") {
    return (
      <div data-held-leftovers-unchecked="all" style={{ ...cardStyle, border: `1px solid ${T.amber}55` }}>
        <div style={bodyStyle}>{t("dash.leftover.uncheckedAll")}</div>
        <button type="button" onClick={onCheckAgain} style={buttonStyle}>{t("dash.leftover.checkAgain")}</button>
      </div>
    );
  }
  const { entries, unchecked } = result.data;
  // One line per place that couldn't be read (several on-chain trades can
  // fail; the reader names the place, not each trade).
  const uncheckedSources = [...new Set(unchecked.map(u => u.source))];
  return (
    <>
      {entries.map(entry => {
        let title: string, body: string, extra: string | null = null;
        let action: { label: string; run: () => void } | null = null;
        switch (entry.kind) {
          case "claim-retrying":
            title = t("dash.leftover.claimRetryingTitle"); body = t("dash.leftover.claimRetryingBody");
            action = { label: t("dash.leftover.openTrade"), run: () => onOpenTrade(entry.escrowId) };
            break;
          case "fedi-funding-returning":
            title = t("dash.leftover.fediReturningTitle");
            body = t(entry.until === "automatic-retry" ? "dash.leftover.fediReturningBodyNow" : "dash.leftover.fediReturningBodyNext");
            action = { label: t("dash.leftover.openTrade"), run: () => onOpenTrade(entry.escrowId) };
            break;
          case "bond-key-waiting":
            title = t("dash.leftover.bondKeyTitle"); body = t("dash.leftover.bondKeyBody");
            if (onOpenBond) action = { label: t("dash.leftover.bondKeyCta"), run: onOpenBond };
            break;
          case "bond-credit-confirming":
            title = t("dash.leftover.bondCreditTitle"); body = t("dash.leftover.bondCreditBody");
            break;
          case "onchain-payout":
            title = t("dash.leftover.onchainPayoutTitle"); body = t("dash.leftover.onchainPayoutBody");
            if (entry.unconfirmed) extra = t("dash.leftover.onchainPayoutUnconfirmed");
            action = { label: t("dash.leftover.onchainPayoutCta"), run: () => onOpenTrade(entry.escrowId) };
            break;
        }
        return (
          <div key={entry.id} data-held-leftover={entry.kind} data-holder={entry.holder} data-until={entry.until} style={cardStyle}>
            <div style={titleStyle}>{title}</div>
            <div style={{ marginBottom: 8 }}>
              <BitcoinAmount sats={sats(entry)} size={T.fs.title2} gap={4} glyphScale={1.18} color={T.ink} glyphColor={T.muted} />
            </div>
            <div style={bodyStyle}>{body}</div>
            {extra && <div style={{ ...bodyStyle, color: T.muted, marginTop: 6 }}>{extra}</div>}
            {action && <button type="button" onClick={action.run} style={buttonStyle}>{action.label}</button>}
          </div>
        );
      })}
      {uncheckedSources.length > 0 && (
        <div data-held-leftovers-unchecked={uncheckedSources.join(",")} style={{ ...cardStyle, border: `1px solid ${T.amber}55` }}>
          {uncheckedSources.map(source => (
            <div key={source} style={{ ...bodyStyle, marginBottom: 6 }}>{t(`dash.leftover.unchecked.${source}`)}</div>
          ))}
          <button type="button" onClick={onCheckAgain} style={buttonStyle}>{t("dash.leftover.checkAgain")}</button>
        </div>
      )}
    </>
  );
}
