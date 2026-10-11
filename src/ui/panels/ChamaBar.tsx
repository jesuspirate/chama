import { createPortal } from "react-dom";
import { ChamaLoader } from '../components/ChamaLoader.js';
// ══════════════════════════════════════════════════════════════════════════
// Chama — ChamaBar (v0.3.0 Phase 5; renamed from FedimintBar)
// ══════════════════════════════════════════════════════════════════════════
//
// Top-bar status surface. Renames the v0.2.0 FedimintBar to match the
// Federation→Chama language sweep, and drops the legacy onFund prop —
// the listing-tap → AtomicFundingModal flow (Phase 2) is now the only
// production funding path. FundWalletModal lives behind Settings →
// Advanced → Sandbox for power-user testing.
//
// State-aware right-side label per the Phase 5 brief:
//   - in-trade  : "N active trade(s) · X sats in escrow" (accent pill)
//   - stranded  : "Recover N sats →" (amber pill, tappable)
//   - ready     : "Chama: ready" (muted neutral)
//
// The label decision lives in decisions.decideChamaBarLabel as a pure
// helper — testable without React. The "stranded" tap opens the
// RecoveryPayoutModal directly via onTapStranded; same flow as the
// banner's primary CTA, just reachable from anywhere in the app.

import { type FedimintState } from "../../hooks/useEscrow.js";
import {
  CURATED_PRESETS,
} from "../../fedimint/federation-config.js";
import { getCommunityBySlug, type Community } from "../../communities/registry.js";
import type { ChamaBarLabel } from "../decisions.js";
import type React from "react";
import { T, ON_ATTN } from "../theme.js";
import { LockGlyph } from "../components/Badge.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";

export function ChamaBar({
  fedimint,
  federationTarget,
  chamaLabel,
  onTapStranded,
  onTapInTrade,
  onInit,
  showReconnect,
  communitySlug,
}: {
  federationTarget?: HTMLElement | null;
  fedimint: FedimintState;
  /** Pre-computed by the shell via decideChamaBarLabel. The bar is a
   *  pure renderer — it does not introspect escrow state directly. */
  chamaLabel: ChamaBarLabel;
  /** Fired when the user taps the stranded label. The shell opens
   *  RecoveryPayoutModal — same flow as the recovery banner's primary
   *  CTA. No-op for the in-trade and ready labels (those aren't
   *  tappable). */
  onTapStranded: () => void;
  /** Open whatever the in-trade pill is talking about. */
  onTapInTrade?: () => void;
  /** Fires for the v0.2.0 not-joined Reconnect AND for the v0.3.1
   *  Phase 3 "⚠ Chama unreachable" Reconnect (same dispatch — both
   *  call initFedimint() with no args, which uses the stored custom
   *  invite or BP fallback). Single source of truth for the
   *  Reconnect CTA — no parallel surface in TradeDetail per the
   *  Phase 3 directive. */
  onInit: () => void;
  /** Whether to surface the Reconnect CTA when not joined. True for
   *  returning users; false for first-time users (community pills are
   *  the join surface). */
  showReconnect: boolean;
  /** Selected Chama identity from Browse/onboarding. Prefer this label
   *  over the raw federation ID so Afribit/Bitsacco and other community
   *  routes read like the user's chosen Chama, not the lower-level
   *  fallback federation. */
  communitySlug?: string | null;
}) {
  const { t } = useT();
  let displayName: string;
  const community = communitySlug ? getCommunityBySlug(communitySlug) : null;
  if (!fedimint.joined) {
    displayName = community
      ? communityChamaBarLabel(community)
      : fedimint.busy ? t("common.connecting") : t("recovery.barChooseChama");
  } else {
    const matched = fedimint.federationId
      ? CURATED_PRESETS.find((p) => p.federationId === fedimint.federationId)
      : null;
    if (community) {
      displayName = communityChamaBarLabel(community);
    } else if (matched) {
      displayName = matched.name;
    } else if (fedimint.federationId) {
      displayName = t("recovery.barExternalRoute");
    } else {
      displayName = fedimint.federationName;
    }
  }

  const healthFailed = fedimint.joined && fedimint.lastHealthOk === false;
  const dotColor = healthFailed
    ? T.amber
    : fedimint.joined ? T.green : fedimint.busy ? T.amber : T.muted;
  const dotGlow = !healthFailed && fedimint.joined ? `0 0 8px ${T.green}66` : "none";

  const federationRow = (
      <div className="chama-federation-row" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div
          title={healthFailed ? t("recovery.barUnreachableTitle") : undefined}
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: dotColor,
            boxShadow: dotGlow,
            animation: fedimint.busy ? "pulse 1.2s infinite" : "none",
            flexShrink: 0,
          }}
        />
        <span style={{
          fontSize: T.fs.secondary, color: T.ink2, fontWeight: 500,
          overflowWrap: "anywhere",
        }}>
          {displayName}
        </span>
      </div>
  );

  return (
    <div className="chama-status-row" style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12, padding: "10px 16px", background: T.bg,
      borderBottom: `1px solid ${T.line}`, fontFamily: T.sans,
    }}>
      {federationTarget ? createPortal(federationRow, federationTarget) : federationRow}

      {/* Right side — state-aware label or Reconnect when not joined.
          v0.3.1 Phase 3: when joined AND bootProbeState === "failed",
          chamaLabel.kind === "unreachable" and the pill becomes a
          Reconnect tappable surface (same dispatch as the not-joined
          Reconnect — both fire onInit). The pill IS the Reconnect
          CTA; no parallel "Reconnect" button is added elsewhere in
          the app per the Phase 3 directive. */}
      {fedimint.joined || chamaLabel.kind !== "ready" ? (
        <ChamaBarLabelPill
          label={chamaLabel}
          onTapStranded={onTapStranded}
          onTapInTrade={onTapInTrade}
          onTapUnreachable={onInit}
        />
      ) : fedimint.busy ? (
        <span style={capsule("quiet", false)}>
          <CapsuleDot color={T.attn} />
          {t("common.connecting")}
        </span>
      ) : showReconnect && (
        <button type="button" onClick={onInit} style={capsule("neutral", true)}>
          {t("recovery.barReconnect")}
        </button>
      )}
    </div>
  );
}

function communityChamaBarLabel(community: Community): string {
  return community.pickerLabel
    ?? community.disambiguator
    ?? community.displayName;
}

// v7 redesign: the status capsule. One pill, top of every screen, tap acts.
// Attention states (unreachable, needs you) are a solid attention fill with
// dark text; recovery is an attention tint; in-trade is neutral with a lock
// (escrow is normal and safe); syncing / checking / ready are quiet.
function capsule(kind: "attn" | "attn-tint" | "neutral" | "quiet", tappable: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 8,
    minHeight: tappable ? T.size.touch : 36, padding: "4px 14px 4px 10px",
    borderRadius: 999, fontFamily: T.sans, fontSize: T.fs.secondary,
    fontWeight: 600, lineHeight: 1.25, textAlign: "left",
    cursor: tappable ? "pointer" : "default", border: "1px solid transparent",
  };
  if (kind === "attn") return { ...base, background: T.attn, color: ON_ATTN };
  if (kind === "attn-tint") return { ...base, background: T.attnBg, color: T.attnInk, borderColor: T.attn };
  if (kind === "neutral") return { ...base, background: T.surface, color: T.ink, borderColor: T.line };
  return { ...base, background: T.surface, color: T.ink2, fontWeight: 500 };
}

function CapsuleDot({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />;
}

function ChamaBarLabelPill({
  label, onTapStranded, onTapUnreachable, onTapInTrade,
}: {
  label: ChamaBarLabel;
  onTapStranded: () => void;
  /** The in-trade pill states an amount; until now it was inert, so
   *  "what IS that 2,000 sats?" had no answer (Jet, 2026-09-20). Tapping it
   *  opens the trade — or the live list when several are running. */
  onTapInTrade?: () => void;
  /** v0.3.1 Phase 3: tap handler for the "⚠ Chama unreachable"
   *  variant. Wired to initFedimint() at the parent (same dispatch
   *  as the not-joined Reconnect button). */
  onTapUnreachable: () => void;
}) {
  const { t } = useT();
  if (label.kind === "needs-you") return <button type="button" onClick={onTapInTrade}
    aria-label={`${t("recovery.barNeedsYou")}: ${label.count}`}
    style={capsule("attn", true)}>
    <span aria-hidden="true" style={{
      minWidth: 22, height: 22, padding: "0 6px", borderRadius: 11, boxSizing: "border-box",
      background: ON_ATTN, color: T.attn, fontSize: 13, fontWeight: 700,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    }}>{label.count}</span>
    <span>{t("recovery.barNeedsYou")}</span>
  </button>;
  if (label.kind === "syncing") return <ChamaLoader size={18} label={t("me.syncing")} />;
  if (label.kind === "checking") {
    return (
      <span style={capsule("quiet", false)}>
        <CapsuleDot color={T.ink3} />
        {t("recovery.barCheckingTrades")}
      </span>
    );
  }
  if (label.kind === "unreachable") {
    // v0.3.1 Phase 3: federation joined but unreachable (boot probe
    // failed). Single Reconnect surface across the app — TradeDetail
    // gates Fund/Claim buttons against the same bootProbeState flag
    // but does NOT render its own Reconnect button; users come here.
    return (
      <button type="button" onClick={onTapUnreachable} style={capsule("attn", true)}>
        {t("recovery.barUnreachableCta")}
      </button>
    );
  }
  if (label.kind === "ready") {
    return (
      <span style={capsule("quiet", false)}>
        <CapsuleDot color={T.pos} />
        {t("recovery.barReady")}
      </span>
    );
  }
  if (label.kind === "in-trade") {
    // v0.6.5 plural-aware copy: multiple concurrent trades are allowed,
    // so the pill aggregates count + total in-escrow sats.
    const tradeCopy = label.activeTradeCount === 1
      ? t("recovery.activeTradeOne")
      : t("recovery.activeTradeMany", { count: label.activeTradeCount.toLocaleString() });
    return (
      <button
        type="button"
        onClick={onTapInTrade}
        disabled={!onTapInTrade}
        style={capsule("neutral", !!onTapInTrade)}
      >
        <LockGlyph size={15} />
        <span>{t("recovery.barInTradeBefore", { trades: tradeCopy })} <BitcoinAmount sats={label.sats} size={15} gap={3} glyphScale={1.1} color="inherit" glyphColor="inherit" style={{ fontFamily: T.sans, fontWeight: 600 }} /> {t("recovery.barInTradeAfter")}</span>
      </button>
    );
  }
  // stranded — tappable, attention tint, points at recovery
  return (
    <button type="button" onClick={onTapStranded} style={capsule("attn-tint", true)}>
      <BitcoinAmount sats={label.sats} size={15} gap={3} glyphScale={1.1} color="inherit" glyphColor="inherit" style={{ fontFamily: T.sans, fontWeight: 600 }} /> {t("recovery.barRecoverCta")}
    </button>
  );
}
