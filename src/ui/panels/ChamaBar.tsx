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
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";

export function ChamaBar({
  fedimint,
  chamaLabel,
  onTapStranded,
  onInit,
  showReconnect,
  communitySlug,
}: {
  fedimint: FedimintState;
  /** Pre-computed by the shell via decideChamaBarLabel. The bar is a
   *  pure renderer — it does not introspect escrow state directly. */
  chamaLabel: ChamaBarLabel;
  /** Fired when the user taps the stranded label. The shell opens
   *  RecoveryPayoutModal — same flow as the recovery banner's primary
   *  CTA. No-op for the in-trade and ready labels (those aren't
   *  tappable). */
  onTapStranded: () => void;
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

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 16px", background: T.surface,
      borderBottom: `1px solid ${T.border}`, fontFamily: T.mono,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
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
          fontSize: 10, color: T.muted,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {displayName}
        </span>
      </div>

      {/* Right side — state-aware label or Reconnect when not joined.
          v0.3.1 Phase 3: when joined AND bootProbeState === "failed",
          chamaLabel.kind === "unreachable" and the pill becomes a
          Reconnect tappable surface (same dispatch as the not-joined
          Reconnect — both fire onInit). The pill IS the Reconnect
          CTA; no parallel "Reconnect" button is added elsewhere in
          the app per the Phase 3 directive. */}
      {fedimint.joined ? (
        <ChamaBarLabelPill
          label={chamaLabel}
          onTapStranded={onTapStranded}
          onTapUnreachable={onInit}
        />
      ) : !fedimint.busy && showReconnect && (
        <button onClick={onInit} style={{
          padding: "6px 16px", borderRadius: 20,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
          cursor: "pointer",
        }}>
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

function ChamaBarLabelPill({
  label, onTapStranded, onTapUnreachable,
}: {
  label: ChamaBarLabel;
  onTapStranded: () => void;
  /** v0.3.1 Phase 3: tap handler for the "⚠ Chama unreachable"
   *  variant. Wired to initFedimint() at the parent (same dispatch
   *  as the not-joined Reconnect button). */
  onTapUnreachable: () => void;
}) {
  const { t } = useT();
  if (label.kind === "checking") {
    return (
      <span style={{
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 0.3, whiteSpace: "nowrap",
      }}>
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
      <button
        onClick={onTapUnreachable}
        style={{
          padding: "5px 12px", borderRadius: 20,
          background: T.amberDim, border: `1px solid ${T.amber}66`,
          color: T.amber, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
          letterSpacing: 0.3, whiteSpace: "nowrap", cursor: "pointer",
        }}
      >
        {t("recovery.barUnreachableCta")}
      </button>
    );
  }
  if (label.kind === "ready") {
    return (
      <span style={{
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 0.3,
      }}>
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
      <span style={{
        padding: "5px 12px", borderRadius: 20,
        background: T.accentDim, border: `1px solid ${T.accent}66`,
        color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
        letterSpacing: 0.3, whiteSpace: "nowrap",
      }}>
        {t("recovery.barInTradeBefore", { trades: tradeCopy })} <BitcoinAmount sats={label.sats} size={10} gap={3} glyphScale={1.2} color="inherit" glyphColor="inherit" /> {t("recovery.barInTradeAfter")}
      </span>
    );
  }
  // stranded — tappable, amber, points at recovery
  return (
    <button
      onClick={onTapStranded}
      style={{
        padding: "5px 12px", borderRadius: 20,
        background: T.amberDim, border: `1px solid ${T.amber}66`,
        color: T.amber, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
        letterSpacing: 0.3, whiteSpace: "nowrap", cursor: "pointer",
      }}
    >
      {t("recovery.barRecoverCta")} <BitcoinAmount sats={label.sats} size={10} gap={3} glyphScale={1.2} color="inherit" glyphColor="inherit" /> →
    </button>
  );
}
