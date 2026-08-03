import { useCallback, useEffect, useRef, useState } from "react";
import type { OnchainPayout } from "../../bond-multisig/onchain-payout-wallet.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { esploraTransactionUrl } from "../../bond-multisig/esplora-config.js";
import { openExternalUrl } from "../open-url.js";
import type { BtcNetwork } from "../../bond-multisig/multisig.js";

type ScanResult = { payouts: OnchainPayout[]; balanceSats: bigint };

/** Money-critical surface for the otherwise invisible per-trade BIP86 output.
 * It is deliberately colocated with the completed trade: recovery remains
 * possible even if an aggregate dashboard changes or a later trade is newer. */
export function OnchainPayoutRecoveryCard({
  escrowId,
  credited,
  embedded = false,
  scan,
  sweep,
}: {
  escrowId: string;
  /** This payout was already swept successfully on this device. */
  credited: boolean;
  /** Render as part of the surrounding action card instead of a nested card. */
  embedded?: boolean;
  scan: () => Promise<ScanResult>;
  sweep: (escrowId: string, destination: string) => Promise<{
    txid: string; sentSats: bigint; feeSats: bigint;
  }>;
}) {
  const { t } = useT();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    txid: string; sentSats: bigint; feeSats: bigint; network: BtcNetwork;
  } | null>(null);
  const scanInFlightRef = useRef(false);
  const payout = result?.payouts.find(item => item.escrowId === escrowId) ?? null;

  const refresh = useCallback(async () => {
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    setLoading(true);
    setMessage(null);
    try {
      setResult(await scan());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      scanInFlightRef.current = false;
      setLoading(false);
    }
  }, [scan]);

  useEffect(() => {
    if (!credited) void refresh();
  }, [credited, escrowId, refresh]);

  // COMPLETE can arrive a few seconds before the explorer reports the newly
  // confirmed winner output. The first version scanned once, hid on zero, and
  // never tried again until the user backed out and reopened the trade. Poll
  // only while the output is absent; stop immediately once it is spendable.
  useEffect(() => {
    if (credited || sent || (payout && payout.balanceSats > 0n)) return;
    const retry = () => { void refresh(); };
    const timer = window.setInterval(retry, 3_000);
    window.addEventListener("focus", retry);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", retry);
    };
  }, [credited, payout, refresh, sent]);

  if (credited && !sent) return null;

  return (
    <div style={{
      marginTop: 12,
      padding: embedded ? "12px 0 0" : "13px 14px",
      borderRadius: embedded ? 0 : T.rs,
      background: embedded ? "transparent" : `${T.green}0e`,
      border: embedded ? "none" : `1px solid ${T.green}44`,
      borderTop: embedded ? `1px solid ${T.green}44` : undefined,
      fontFamily: T.sans,
    }}>
      <div style={{ color: T.green, fontSize: 12.5, fontWeight: 800, marginBottom: 7 }}>
        {t("onchain.payoutTitle")}
      </div>
      {loading || (!payout && !message && !sent) ? (
        <div style={{ color: T.muted, fontSize: 12 }}>{t("onchain.payoutChecking")}</div>
      ) : payout && payout.balanceSats > 0n ? (
        <>
          <div style={{ color: T.text, fontSize: 14, fontWeight: 800, marginBottom: 4 }}>
            <BitcoinAmount sats={Number(payout.balanceSats)} size={15} gap={3} /> {t("onchain.payoutSpendable")}
          </div>
          <div style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.5, marginBottom: 9 }}>
            {result && result.payouts.filter(item => item.balanceSats > 0n).length > 1
              ? <>{t("onchain.payoutAggregateBefore")}{" "}
                  <BitcoinAmount sats={Number(result.balanceSats)} size={12} gap={3} />.</>
              : t("onchain.payoutRecoveredBody")}
          </div>
          <input
            value={destination}
            onChange={event => setDestination(event.target.value)}
            placeholder={t("onchain.payoutDestination")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{
              boxSizing: "border-box", width: "100%", padding: "10px 11px",
              borderRadius: T.rs, border: `1px solid ${T.border}`, background: T.surface,
              color: T.text, fontFamily: T.mono, fontSize: 11.5, marginBottom: 8,
            }}
          />
          <button
            type="button"
            disabled={busy || !destination.trim()}
            onClick={() => {
              setBusy(true);
              setMessage(null);
              setSent(null);
              void sweep(escrowId, destination.trim()).then(async ({ txid, sentSats, feeSats }) => {
                const network = payout.network;
                setDestination("");
                // Broadcast success is authoritative. Show it immediately;
                // a follow-up explorer refresh must not replace a real txid
                // with a scary error merely because the explorer is lagging.
                setSent({ txid, sentSats, feeSats, network });
                setLoading(true);
                try {
                  setResult(await scan());
                } catch { /* the sent transaction link remains the source of truth */ }
                finally { setLoading(false); }
              }).catch(error => setMessage(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
            style={{
              width: "100%", padding: "11px 13px", borderRadius: T.rs,
              border: `1px solid ${busy || !destination.trim() ? T.border : T.green}`,
              background: busy || !destination.trim() ? T.surface : `${T.green}1c`,
              color: busy || !destination.trim() ? T.muted : T.green,
              fontWeight: 800, cursor: busy || !destination.trim() ? "not-allowed" : "pointer",
            }}
          >{busy ? t("onchain.payoutSending") : t("onchain.payoutSend")}</button>
        </>
      ) : null}
      {message && (
        <div style={{ marginTop: 8, color: T.muted, fontSize: 11, lineHeight: 1.5, wordBreak: "break-word" }}>
          {message}
        </div>
      )}
      {sent && (
        <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.5 }}>
          <div style={{ color: T.text }}>
            {t("onchain.payoutSent", {
              amount: sent.sentSats.toString(),
              fee: sent.feeSats.toString(),
            })}
          </div>
          <a
            href={esploraTransactionUrl(sent.network, sent.txid)}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault();
              void openExternalUrl(esploraTransactionUrl(sent.network, sent.txid));
            }}
            style={{
              display: "inline-block", marginTop: 6, color: T.muted,
              fontSize: 10.5, textDecoration: "underline",
            }}
          >
            {t("onchain.viewOnChain")} ↗
          </a>
        </div>
      )}
    </div>
  );
}
