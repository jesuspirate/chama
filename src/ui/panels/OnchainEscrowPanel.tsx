// ══════════════════════════════════════════════════════════════════════════
// Chama — the on-chain escrow surface (Tier 2.1 UI)
// ══════════════════════════════════════════════════════════════════════════
//
// Everything this panel renders is decided in `onchain-escrow-view.ts`, so the
// honesty rules are tested rather than trusted to whoever edits this file last.
//
// Three things it will not do, each corresponding to a way people lose money:
//
//   • It never shows an address it did not recompute locally. Funding is
//     irreversible; a wire-supplied address is a payment to whoever tampered.
//   • It never says "not ready" without naming what is missing.
//   • It never renders an enabled Sign button without a PASSED checklist. The
//     checklist is the security of settlement — a 2-of-2 guarantees two
//     signatures, never what they authorise.

import { useT } from "../../i18n/index.js";
import type { OnchainEscrowView } from "../../escrow-engine/onchain-escrow-view.js";
import { mayEnableSignButton } from "../../escrow-engine/onchain-escrow-view.js";
import type { SettlementCheck } from "../../bond-multisig/onchain-escrow-settle.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { CopyButton } from "../components/CopyButton.js";
import { T } from "../theme.js";
import { MAINNET, SIGNET } from "../../bond-multisig/multisig.js";
import { esploraTransactionUrl } from "../../bond-multisig/esplora-config.js";
import { openExternalUrl } from "../open-url.js";

export function OnchainEscrowPanel({
  view,
  network,
  settlementCheck,
  signing,
  signedByViewer,
  onSign,
  onCheckFunding,
  checking,
  fundingNote,
  onPublishKey,
  publishing,
}: {
  view: OnchainEscrowView;
  /** Shown plainly. A signet address on a mainnet trade must be obvious. */
  network: "mainnet" | "signet";
  /** Result of `verifySettlementPsbt`. Null while nothing is pending. */
  settlementCheck?: SettlementCheck | null;
  signing?: boolean;
  signedByViewer?: boolean;
  onSign?: () => void;
  /** Re-read the chain and LOCK if the deposit has confirmed. Shown to the
   *  funder — without it they have an address and no way to say "I've sent it",
   *  which is where this panel previously dead-ended. */
  onCheckFunding?: () => void;
  checking?: boolean;
  /** Result of the last check, in the user's words. */
  fundingNote?: string | null;
  /** ⭐ Publish the viewer's own escrow key. Shown ONLY to the arbiter this
   *  trade is waiting on — the address needs all three keys, and an arbiter who
   *  is never asked will never guess that the trade is stalled on them. */
  onPublishKey?: () => void;
  publishing?: boolean;
}) {
  const { t } = useT();
  const btcNetwork = network === "signet" ? SIGNET : MAINNET;

  return (
    <div style={{
      padding: "12px 14px", marginBottom: 12, borderRadius: T.rs,
      background: `${T.accent}0e`, border: `1px solid ${T.accent}40`,
      fontFamily: T.sans,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
        fontSize: 12.5, fontWeight: 800, color: T.accent,
      }}>
        <span aria-hidden="true">⛓</span>
        <span>{t("onchain.title")}</span>
        {network === "signet" && (
          <span style={{
            marginLeft: "auto", padding: "2px 7px", borderRadius: 999,
            background: `${T.amber}22`, border: `1px solid ${T.amber}55`,
            color: T.amber, fontFamily: T.mono, fontSize: 9.5, fontWeight: 800,
          }}>{t("onchain.signetBadge")}</span>
        )}
      </div>

      {view.stage === "awaiting-keys" && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.55 }}>
          {/* ⭐ The arbiter sees what they must DO, not what everyone is waiting
              for. Showing them "waiting for the arbiter" is how this trade sat
              stalled with no visible cause: the one person who could unblock it
              was reading it as someone else's turn. */}
          {view.viewerMustPublishKey ? (
            <>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 5 }}>
                {t("onchain.yourKeyNeededTitle")}
              </div>
              <div style={{ marginBottom: 4 }}>{t("onchain.yourKeyNeededBody")}</div>
              {onPublishKey && (
                <button
                  type="button"
                  onClick={onPublishKey}
                  disabled={publishing}
                  style={{
                    marginTop: 10, width: "100%", padding: "12px 14px", borderRadius: T.rs,
                    background: publishing ? T.surface : `${T.accent}1f`,
                    border: `1px solid ${publishing ? T.border : T.accent}`,
                    color: publishing ? T.muted : T.accent,
                    fontFamily: T.sans, fontSize: 14, fontWeight: 800,
                    cursor: publishing ? "default" : "pointer",
                  }}
                >{publishing ? t("onchain.publishing") : t("onchain.publishMyKey")}</button>
              )}
            </>
          ) : (
            <>
              {/* Naming the blocker is the whole point — "not ready" alone makes a
                  user either wait forever or fund something they shouldn't. */}
              {view.blockers.map((b) => (
                <div key={b} style={{ marginBottom: 4 }}>• {t(`onchain.blocker.${b}`)}</div>
              ))}
              <div style={{ marginTop: 6, fontSize: 11, opacity: 0.85 }}>
                {t("onchain.awaitingKeysWhy")}
              </div>
            </>
          )}
          {fundingNote && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: T.rs,
              background: `${T.amber}10`, border: `1px solid ${T.amber}33`,
              color: T.amber, fontSize: 11.5, lineHeight: 1.5,
            }}>{fundingNote}</div>
          )}
        </div>
      )}

      {view.stage === "awaiting-funding" && view.address && (
        <>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.55, marginBottom: 8 }}>
            {view.viewerFunds ? t("onchain.fundBody") : t("onchain.awaitFundingBody")}
          </div>
          <div style={{
            padding: "9px 11px", borderRadius: T.rs, background: T.surface,
            border: `1px solid ${T.border}`, marginBottom: 8,
          }}>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              {t("onchain.addressLabel")}
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 11.5, color: T.text,
              wordBreak: "break-all", lineHeight: 1.45, marginBottom: 6,
            }}>{view.address}</div>
            <CopyButton value={view.address} label={t("onchain.copyAddress")} />
          </div>
          {view.expectedSats !== null && (
            <div style={{ fontSize: 12, color: T.text, marginBottom: 6 }}>
              {t("onchain.sendExactly")}{" "}
              <BitcoinAmount sats={Number(view.expectedSats)} size={13} gap={3} />
            </div>
          )}
          {/* The address is derived, so anyone can check it. Saying so is what
              makes "don't trust an address from a wire" actionable rather than
              a slogan. */}
          <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.5 }}>
            {t("onchain.recomputedNote")}
          </div>
          {fundingNote && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: T.rs,
              background: `${T.amber}10`, border: `1px solid ${T.amber}33`,
              color: T.amber, fontSize: 11.5, lineHeight: 1.5,
            }}>{fundingNote}</div>
          )}
          {view.viewerFunds && onCheckFunding && (
            <button
              type="button"
              onClick={onCheckFunding}
              disabled={checking}
              style={{
                marginTop: 10, width: "100%", padding: "12px 14px", borderRadius: T.rs,
                background: checking ? T.surface : `${T.accent}1f`,
                border: `1px solid ${checking ? T.border : T.accent}`,
                color: checking ? T.muted : T.accent,
                fontFamily: T.sans, fontSize: 14, fontWeight: 800,
                cursor: checking ? "default" : "pointer",
              }}
            >{checking ? t("onchain.checking") : t("onchain.iveSentIt")}</button>
          )}
        </>
      )}

      {(view.stage === "locked" || view.stage === "settling" || view.stage === "done") && (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.55 }}>
          <div style={{ color: T.text, marginBottom: 6 }}>
            {view.stage === "done" ? t("onchain.doneBody")
              : view.stage === "settling" ? t("onchain.settlingBody")
                : t("onchain.lockedBody")}
          </div>
          {view.fundingTxid && (
            <a
              href={esploraTransactionUrl(btcNetwork, view.fundingTxid)}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => {
                event.preventDefault();
                void openExternalUrl(esploraTransactionUrl(btcNetwork, view.fundingTxid!));
              }}
              style={{ color: T.muted, fontSize: 10.5, textDecoration: "underline" }}
            >{t("onchain.viewOnChain")} ↗</a>
          )}
        </div>
      )}

      {/* The appeal window. Stated as a countdown, because "arbitration is
          unavailable" without a when reads as breakage. */}
      {view.appealWindow && !view.appealWindow.open && (
        <div style={{
          marginTop: 10, padding: "9px 11px", borderRadius: T.rs,
          background: `${T.amber}12`, border: `1px solid ${T.amber}44`,
          color: T.amber, fontSize: 11.5, lineHeight: 1.5,
        }}>
          {t("onchain.appealWindow", { blocks: view.appealWindow.blocksRemaining })}
        </div>
      )}

      {/* ⚠ Both sides have agreed, but no settlement transaction has reached
          this client yet. Saying so plainly beats an idle screen: the winner is
          otherwise left staring at "settling" with no idea whether they are
          waiting on the network, the counterparty, or a bug. */}
      {view.canSettle && !settlementCheck && (
        <div style={{
          marginTop: 10, padding: "9px 11px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontSize: 11.5, lineHeight: 1.55,
        }}>
          {t("onchain.awaitingSettlement")}
        </div>
      )}

      {/* ⭐ SETTLEMENT. The checklist result is shown BEFORE any sign
          affordance, and the button is gated on it passing. A UI that let
          someone sign first would have discarded the only thing standing
          between them and a PSBT that pays an attacker. */}
      {view.canSettle && settlementCheck && (
        <div style={{ marginTop: 10 }}>
          {settlementCheck.ok ? (
            <div style={{
              padding: "9px 11px", borderRadius: T.rs, marginBottom: 8,
              background: `${T.green}12`, border: `1px solid ${T.green}44`,
              color: T.green, fontSize: 11.5, lineHeight: 1.5,
            }}>✓ {t("onchain.checkPassed")}</div>
          ) : (
            <div style={{
              padding: "9px 11px", borderRadius: T.rs, marginBottom: 8,
              background: `${T.red}12`, border: `1px solid ${T.red}44`,
              color: T.red, fontSize: 11.5, lineHeight: 1.55,
            }}>
              <strong>⚠ {t("onchain.checkFailed")}</strong>
              {settlementCheck.failures.map((f, i) => (
                <div key={i} style={{ marginTop: 4, fontFamily: T.mono, fontSize: 10.5 }}>• {f}</div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onSign}
            disabled={!mayEnableSignButton(settlementCheck) || signing || signedByViewer}
            style={{
              width: "100%", padding: "12px 14px", borderRadius: T.rs,
              background: mayEnableSignButton(settlementCheck) && !signing && !signedByViewer ? `${T.accent}1f` : T.surface,
              border: `1px solid ${mayEnableSignButton(settlementCheck) && !signing && !signedByViewer ? T.accent : T.border}`,
              color: mayEnableSignButton(settlementCheck) && !signing && !signedByViewer ? T.accent : T.muted,
              fontFamily: T.sans, fontSize: 14, fontWeight: 800,
              cursor: mayEnableSignButton(settlementCheck) && !signing && !signedByViewer ? "pointer" : "not-allowed",
            }}
          >
            {signing ? t("onchain.signing")
              : signedByViewer ? t("onchain.signedWaiting")
                : t("onchain.signSettlement")}
          </button>
        </div>
      )}
    </div>
  );
}
