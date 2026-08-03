import { useEffect, useMemo, useRef, useState } from "react";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { COUNTRY_CURRENCY } from "../../communities/country-currency.js";
import { formatFiatAmount } from "../amount-display.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";

type ConverterTab = "convert" | "plan";
type ConvertFrom = "sats" | "fiat";

const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "KES", "TZS", "NGN", "ZAR", "CAD", "AUD", "BRL", "ARS", "MXN"];
const WORLD_FIAT_CURRENCIES = new Set<string>(Object.values(COUNTRY_CURRENCY));

export function BitcoinConverter({ communitySlug }: { communitySlug?: string | null }) {
  const { t } = useT();
  const price = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const homeCurrency = defaultCurrencyForCommunity(communitySlug);
  const [tab, setTab] = useState<ConverterTab>("convert");
  const [currency, setCurrency] = useState(homeCurrency);
  const [from, setFrom] = useState<ConvertFrom>("fiat");
  const [amount, setAmount] = useState("100");
  const [futurePrice, setFuturePrice] = useState("");
  const [futureSats, setFutureSats] = useState("1000000");
  const [goalFiat, setGoalFiat] = useState("10000");
  const seededFuturePrice = useRef(false);

  useEffect(() => setCurrency(homeCurrency), [homeCurrency]);
  useEffect(() => {
    if (seededFuturePrice.current || !price.usd) return;
    seededFuturePrice.current = true;
    setFuturePrice(String(Math.round(price.usd * 2 / 1000) * 1000));
  }, [price.usd]);

  const currencies = useMemo(() => {
    const available = new Set(Object.keys(fiatRates.rates).filter(code => WORLD_FIAT_CURRENCIES.has(code)));
    available.add("USD");
    available.add(homeCurrency);
    return [homeCurrency, ...COMMON_CURRENCIES, ...available]
      .filter((item, index, all) => available.has(item) && all.indexOf(item) === index)
      .sort((a, b) => a === homeCurrency ? -1 : b === homeCurrency ? 1 : a.localeCompare(b));
  }, [fiatRates.rates, homeCurrency]);

  const rate = currency === "USD" ? 1 : fiatRates.rates[currency];
  const fiatPerBtc = price.usd && rate ? price.usd * rate : null;
  const numericAmount = positiveNumber(amount);
  const converted = fiatPerBtc && numericAmount
    ? from === "fiat"
      ? { sats: Math.round(numericAmount / fiatPerBtc * 100_000_000), fiat: numericAmount }
      : { sats: Math.round(numericAmount), fiat: numericAmount / 100_000_000 * fiatPerBtc }
    : null;

  const scenarioPriceUsd = positiveNumber(futurePrice);
  const scenarioSats = positiveNumber(futureSats);
  const scenarioFiat = scenarioPriceUsd && scenarioSats && rate
    ? scenarioSats / 100_000_000 * scenarioPriceUsd * rate
    : null;
  const goal = positiveNumber(goalFiat);
  const goalSats = goal && scenarioPriceUsd && rate
    ? Math.ceil(goal / (scenarioPriceUsd * rate) * 100_000_000)
    : null;
  const currentGoalCost = goalSats && fiatPerBtc
    ? goalSats / 100_000_000 * fiatPerBtc
    : null;

  const quoteReady = !!fiatPerBtc;
  const quoteStatus = price.source === "live" && (currency === "USD" || fiatRates.source === "live")
    ? t("bond.converterLive")
    : quoteReady ? t("bond.converterCached") : t("bond.converterWaiting");

  return (
    <section style={{ background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, padding: 18, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 1 }}>{t("bond.converterHeading")}</div>
          <div style={{ color: T.text, fontFamily: T.sans, fontSize: 18, fontWeight: 900, marginTop: 3 }}>{t("bond.converterTitle")}</div>
        </div>
        <select aria-label={t("bond.converterCurrency")} value={currency} onChange={(event) => setCurrency(event.target.value)} style={{ ...inputStyle, width: "auto", minWidth: 82, padding: "8px 10px", fontFamily: T.mono, fontWeight: 800 }}>
          {currencies.map(code => <option key={code} value={code}>{code}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: 3, borderRadius: T.rs, background: T.surface, marginBottom: 16 }}>
        <TabButton active={tab === "convert"} onClick={() => setTab("convert")}>{t("bond.converterConvert")}</TabButton>
        <TabButton active={tab === "plan"} onClick={() => setTab("plan")}>{t("bond.converterPlan")}</TabButton>
      </div>

      {tab === "convert" ? (
        <div>
          <FieldLabel>{from === "fiat" ? currency : t("bond.converterSats")}</FieldLabel>
          <div style={{ display: "flex", gap: 8 }}>
            <input inputMode="decimal" value={amount} onChange={(event) => setAmount(cleanNumber(event.target.value))} placeholder="0" style={{ ...inputStyle, minWidth: 0, fontSize: 20, fontFamily: T.mono, fontWeight: 800 }} />
            <button type="button" onClick={() => { setFrom(old => old === "fiat" ? "sats" : "fiat"); setAmount(converted ? String(from === "fiat" ? converted.sats : trimFiat(converted.fiat)) : ""); }} aria-label={t("bond.converterSwap")} style={{ width: 48, flex: "0 0 48px", borderRadius: T.rs, border: `1px solid ${T.accent}55`, background: T.accentDim, color: T.accent, fontSize: 20, cursor: "pointer" }}>⇅</button>
          </div>
          <div style={{ marginTop: 12, padding: "14px 16px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}` }}>
            <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, letterSpacing: .7 }}>{t("bond.converterEstimate")}</div>
            <div style={{ color: converted ? T.text : T.muted, fontFamily: T.sans, fontSize: 24, fontWeight: 900, marginTop: 5 }}>
              {converted ? (from === "fiat" ? `${converted.sats.toLocaleString()} sats` : formatFiatAmount(converted.fiat, currency)) : "—"}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 14 }}>{t("bond.converterPlanIntro")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <LabeledInput label={t("bond.converterFuturePrice")} suffix="USD/BTC" value={futurePrice} onChange={setFuturePrice} />
            <LabeledInput label={t("bond.converterYourSats")} suffix="sats" value={futureSats} onChange={setFutureSats} />
          </div>
          <ResultLine label={t("bond.converterFutureWorth")} value={scenarioFiat ? formatFiatAmount(scenarioFiat, currency) : "—"} accent />
          <div style={{ height: 1, background: T.border, margin: "16px 0" }} />
          <LabeledInput label={t("bond.converterGoal")} suffix={currency} value={goalFiat} onChange={setGoalFiat} />
          <ResultLine label={t("bond.converterSatsNeeded")} value={goalSats ? `${goalSats.toLocaleString()} sats` : "—"} accent />
          {currentGoalCost && (
            <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10.5, lineHeight: 1.5, marginTop: 8 }}>
              {t("bond.converterTodayCost", { amount: formatFiatAmount(currentGoalCost, currency) })}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 7, alignItems: "center", color: quoteReady ? T.muted : T.amber, fontFamily: T.mono, fontSize: 9.5, lineHeight: 1.45, marginTop: 14 }}>
        <span style={{ width: 6, height: 6, flex: "0 0 6px", borderRadius: 99, background: quoteReady ? T.green : T.amber }} />
        {quoteStatus} · {t("bond.converterDisclaimer")}
      </div>
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return <button type="button" onClick={onClick} style={{ border: 0, borderRadius: 6, padding: "9px 12px", cursor: "pointer", background: active ? T.card : "transparent", color: active ? T.text : T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 800, boxShadow: active ? `0 0 0 1px ${T.border}` : "none" }}>{children}</button>;
}

function FieldLabel({ children }: { children: string }) {
  return <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: .7, marginBottom: 6, textTransform: "uppercase" }}>{children}</div>;
}

function LabeledInput({ label, suffix, value, onChange }: { label: string; suffix: string; value: string; onChange: (value: string) => void }) {
  return <label style={{ display: "block" }}><FieldLabel>{label}</FieldLabel><div style={{ position: "relative" }}><input inputMode="decimal" value={value} onChange={(event) => onChange(cleanNumber(event.target.value))} placeholder="0" style={{ ...inputStyle, paddingRight: Math.max(54, suffix.length * 7 + 18), fontFamily: T.mono, fontWeight: 700 }} /><span style={{ position: "absolute", right: 11, top: "50%", transform: "translateY(-50%)", color: T.muted, fontFamily: T.mono, fontSize: 9, pointerEvents: "none" }}>{suffix}</span></div></label>;
}

function ResultLine({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginTop: 12 }}><span style={{ color: T.muted, fontFamily: T.sans, fontSize: 12 }}>{label}</span><span style={{ color: accent ? T.green : T.text, fontFamily: T.mono, fontSize: 15, fontWeight: 800, textAlign: "right" }}>{value}</span></div>;
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanNumber(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

function trimFiat(value: number): string {
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 2 });
}
