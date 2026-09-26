import { useEffect, useState } from "react";
import { ESCROW_NETWORK } from "../../bond-multisig/onchain-escrow.js";
import { defaultEsploraBase, esploraFetcher } from "../../bond-multisig/fund-watcher.js";
import { translate, getCurrentLang } from "../../i18n/index.js";

/** A live estimate for the current two-transaction payout path (162+111 vB).
 * The funder's own wallet send fee is separate and depends on its inputs. */
export function useOnchainFeeRate(): { rate: number | null; error: boolean } {
  const [rate, setRate] = useState<number | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await esploraFetcher(defaultEsploraBase(ESCROW_NETWORK), { network: ESCROW_NETWORK })("/v1/fees/recommended");
        const value = data?.hourFee ?? data?.halfHourFee ?? data?.economyFee;
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("No current fee estimate");
        if (alive) { setRate(Math.ceil(value)); setError(false); }
      } catch { if (alive) { setRate(null); setError(true); } }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { rate, error };
}

export function OnchainFeeCheckout({ amountSats, rate }: { amountSats: number; rate: number | null }) {
  const t = (key: string, vars?: Record<string, number | string>) => translate(getCurrentLang(), key, vars);
  const fee = rate === null ? null : Math.ceil(rate * (162 + 111));
  const percent = fee === null || amountSats <= 0 ? null : fee / amountSats * 100;
  return <div style={{ marginTop: 10, padding: 12, borderRadius: 12, border: "1px solid #7775", fontSize: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between" }}><span>{t("onchain.feeTrade")}</span><strong>{amountSats.toLocaleString()} sats</strong></div>
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}><span>{t("onchain.feeNetwork")}</span><strong>{fee === null ? t("onchain.feeUnavailable") : `~${fee.toLocaleString()} sats (${rate} sat/vB)`}</strong></div>
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, color: percent !== null && percent >= 5 ? "#e35d5d" : undefined }}><span>{t("onchain.feePercent")}</span><strong>{percent === null ? "—" : `~${percent.toFixed(1)}%`}</strong></div>
    <small>{t("onchain.feeSendSeparate")}</small>
  </div>;
}
