// ══════════════════════════════════════════════════════════════════════════
// Chama — Recovery banner (v0.3.0 Phase 4 — failure-mode framing)
// ══════════════════════════════════════════════════════════════════════════
//
// Per Pillar 2.1 Option B: unexplained balance > 0 is a failure state.
// ecash exists only during LOCK→CLAIM. v0.3.0 retunes
// this banner from "Continue your trade · withdraw N sats" (v0.2.0)
// to a failure-mode framing that names the state correctly: the user's
// last trade didn't finish cleanly, sats are stranded on their local
// Chama, and recovering them is a structural repair — not a routine
// "withdraw" operation.
//
// Trigger contract: balance is large enough for an outbound Lightning
// payout and no active escrow, funding flow, or claim sweep explains it
// (see decisions.shouldShowRecoveryBanner). Phase 3's three-way claim
// failure split (claim-failed / claim-pending / payout-failed) makes
// the banner more meaningful, not less — payout-failed is the common
// path here.
//
// Counterparty resolution: identifyStrandedEcashSource walks the local
// replay to find the most recent CLAIM event the user signed. Generic
// fallback when no CLAIM is found.

import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { displayCounterpartyName, type StrandedEcashSource } from "../decisions.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { Role } from "../../escrow-engine/types.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";

export function RecoveryBanner({
  balanceMsats,
  source,
  fetchKind0Enabled,
  onRecover,
  genericResidue = false,
  fundsReturned = false,
  fundingTrade = null,
}: {
  balanceMsats: number;
  source: StrandedEcashSource | null;
  fetchKind0Enabled: boolean;
  /** Open the RecoveryPayoutModal. v0.3.0 renames from onWithdraw to
   *  onRecover to match the failure-mode framing — this is structural
   *  repair, not a routine wallet withdrawal. */
  onRecover: () => void;
  /** Stranded-payout recovery (attribution honesty): true when a
   *  most-recent-CLAIM source EXISTS but its amount can't explain the
   *  balance (strandedSourceExplainsBalance failed — the sweep mixes
   *  residue from more than one trade). The shell passes source=null in
   *  that case; this flag swaps the "didn't finish cleanly" headline for
   *  honest residue copy so we never blame a single trade for an
   *  aggregate balance. */
  genericResidue?: boolean;
  /** Re-absorb story-loss fix: the balance is the user's OWN funding for a
   *  lock that didn't complete, re-absorbed back to the wallet — NOT a
   *  failed trade needing attention. Swaps the pulsing amber alarm for a
   *  calm "↩ funds returned" framing. The sats are safe and recoverable;
   *  the user can sweep them out or just leave them. Takes precedence over
   *  the failure framings (the shell only sets it with source=null). */
  fundsReturned?: boolean;
  /** The trade whose funding came back, for the funds-returned identity card.
   *  Named from the funding trace's OWN escrowId (the actually-funded trade),
   *  NOT the claim-history walk — so it can't mis-attribute the balance to an
   *  unrelated old trade. `description` fills in once the escrow loads; the id
   *  + amount are always honest. Only rendered in fundsReturned mode. */
  fundingTrade?: { escrowId: string; description: string; amountMsats: number } | null;
}) {
  const { t } = useT();
  const totalSats = Math.floor(balanceMsats / 1000);
  const recoverableSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const counterpartyName = source
    ? displayCounterpartyName({
        npub: source.counterpartyPubkey,
        fetchKind0Enabled,
        kind0Name: null, // v0.2.1 wires the fetcher
      })
    : t("recovery.unknownCounterparty");

  const headline = fundsReturned
    ? t("recovery.headlineFundsReturned")
    : source
      ? t("recovery.headlineTradeWith", { name: counterpartyName })
      : genericResidue
        ? t("recovery.headlineLeftoverSats")
        : t("recovery.headlineLastTrade");

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        // fundsReturned is a CALM recovery (your own money came back), not a
        // failure to repair — soft surface + accent border, no amber alarm.
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        {/* v0.3.0: failure-mode small-caps header. "Continue your trade"
            (v0.2.0) reframed to "Trade needs attention" because Pillar
            2.1 Option B treats stranded balance as a failure to repair,
            not a normal step. fundsReturned overrides this to a calm,
            non-pulsing "↩ funds returned" — the sats came back, nothing
            is wrong. */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 10, fontWeight: 700,
          color: T.muted, fontFamily: T.mono,
          letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12,
        }}>
          {!fundsReturned && (
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: T.muted,
            }} />
          )}
          {fundsReturned ? t("recovery.fundsReturnedTag") : t("recovery.tradeNeedsAttention")}
        </div>

        <div style={{
          fontSize: 16, fontWeight: 700, color: T.text, fontFamily: T.sans,
          lineHeight: 1.4, marginBottom: 12,
        }}>
          {headline}
        </div>

        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          lineHeight: 1.55, marginBottom: 16,
        }}>
          {fundsReturned ? (
            <>{t("recovery.fundsReturnedBody1")}{" "}
            <BitcoinAmount sats={totalSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
            {t("recovery.fundsReturnedBody2")}{" "}
            <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
            {t("recovery.fundsReturnedBody3")}
            {reserveSats > 0 && (
              <>{" "}{t("recovery.fundsReturnedReserveBefore")}{" "}
                <BitcoinAmount sats={reserveSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
                {t("recovery.fundsReturnedReserveAfter")}</>
            )}
            {t("recovery.fundsReturnedBody4")}</>
          ) : (
            <>
              <BitcoinAmount sats={totalSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
              {t("recovery.strandedBody1")}{" "}
              <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
              {t("recovery.strandedBody2")}
              {reserveSats > 0 && (
                <>
                  {t("recovery.strandedReserveBefore")}{" "}
                  <BitcoinAmount sats={reserveSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
                  {t("recovery.strandedReserveAfter")}
                </>
              )}
              .
            </>
          )}
        </div>

        {/* Funds-returned identity card — names the FUNDED trade (from the
            funding trace's own escrowId), so it can't mis-attribute like the
            claim-history walk. No "role" line: the framing is simply "you
            funded this and it came back". */}
        {fundsReturned && fundingTrade && (
          <div style={{
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: T.rs, padding: 14, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 9, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              {t("recovery.fundedTradeLabel")}
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 11, color: T.muted,
              wordBreak: "break-all" as const, marginBottom: fundingTrade.description ? 6 : 0,
            }}>
              {fundingTrade.escrowId}
            </div>
            {fundingTrade.description && (
              <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, marginBottom: 6 }}>
                {fundingTrade.description}
              </div>
            )}
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
              {t("recovery.youFunded")}{" "}
              <span style={{ color: T.accent, fontWeight: 700 }}>
                <BitcoinAmount msats={fundingTrade.amountMsats} size={12} gap={4} glyphScale={1.18} />
              </span>
            </div>
          </div>
        )}

        {/* Trade identity card — when we have source. Generic copy
            without this card when the local replay yielded no CLAIM. */}
        {source && (
          <div style={{
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.rs, padding: 14, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 9, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              {t("recovery.tradeLabel")}
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 11, color: T.muted,
              wordBreak: "break-all" as const, marginBottom: 6,
            }}>
              {source.escrowId}
            </div>
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans, marginBottom: 6,
            }}>
              {source.description}
            </div>
            <div style={{
              fontSize: 12, color: T.muted, fontFamily: T.mono,
            }}>
              {t("recovery.yourRole")} <span style={{ color: T.text }}>
                {source.role === Role.BUYER ? t("recovery.roleBuyer")
                  : source.role === Role.SELLER ? t("recovery.roleSeller")
                  : t("recovery.roleArbiter")}
              </span>
              {" · "}
              <span style={{ color: T.accent, fontWeight: 700 }}>
                <BitcoinAmount msats={source.amountMsats} size={12} gap={4} glyphScale={1.18} />
              </span>
            </div>
          </div>
        )}

        <button
          onClick={onRecover}
          style={{
            width: "100%", padding: "14px",
            background: `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
            border: "none", borderRadius: T.rs,
            color: T.bg, fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            cursor: "pointer", letterSpacing: 0.5,
          }}
        >
          {t("recovery.recoverCta")} <BitcoinAmount sats={recoverableSats} size={14} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /> →
        </button>

        <div style={{
          textAlign: "center", marginTop: 10,
          fontSize: 9, color: T.muted, fontFamily: T.mono,
        }}>
          {t("recovery.satsLandFooter")}
        </div>
      </div>

      {/* Bottom paragraph — half-opacity per the spec. v0.6.5: with the
          one-trade gate retired, the old "Browse opens once recovered"
          framing is misleading — Browse is always open. Reframe to
          name the actual repair: unexplained sats out of OPFS. */}
      <div style={{
        textAlign: "center", padding: "8px 16px",
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        opacity: 0.5, lineHeight: 1.5,
      }}>
        {t("recovery.keepUsingFooter")}
      </div>
    </div>
  );
}
