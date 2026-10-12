import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";
import { COUNTRY_CURRENCY } from "../../communities/country-currency.js";
import { formatFiatAmount } from "../amount-display.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { caretAfter, formatRaw, meaningfulBefore, parseTyped, separatorsFor, type Separators } from "../grouped-number.js";

// v7 redesign (Jet, 2026-10-06): the plain conversion is the star — one big
// field you type into, one big answer, a clear swap — and digits are grouped
// as you type ("1,250,000 sats"). "Plan ahead" became one plain question
// behind a disclosure: what would these sats be worth at another price?

type ConvertFrom = "sats" | "fiat";

const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "KES", "TZS", "NGN", "ZAR", "CAD", "AUD", "BRL", "ARS", "MXN"];
const WORLD_FIAT_CURRENCIES = new Set<string>(Object.values(COUNTRY_CURRENCY));
const WHAT_IF_MULTIPLES = [2, 5, 10] as const;

export function BitcoinConverter({ communitySlug, variant = "card" }: {
  communitySlug?: string | null;
  /** "sheet" drops the card chrome when the converter already sits in a sheet
   *  whose title says "Converter". */
  variant?: "card" | "sheet";
}) {
  const { t, lang } = useT();
  const sep = useMemo(() => separatorsFor(lang), [lang]);
  const price = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const homeCurrency = defaultCurrencyForCommunity(communitySlug);
  const [currency, setCurrency] = useState(homeCurrency);
  const [from, setFrom] = useState<ConvertFrom>("fiat");
  const [amount, setAmount] = useState("100");
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const [futurePrice, setFuturePrice] = useState("");
  const seededFuturePrice = useRef(false);

  useEffect(() => setCurrency(homeCurrency), [homeCurrency]);

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
  useEffect(() => {
    if (seededFuturePrice.current || !fiatPerBtc) return;
    seededFuturePrice.current = true;
    setFuturePrice(String(roundPrice(fiatPerBtc * 2)));
  }, [fiatPerBtc]);

  const changeCurrency = (nextCurrency: string) => {
    const oldRate = currency === "USD" ? 1 : fiatRates.rates[currency];
    const nextRate = nextCurrency === "USD" ? 1 : fiatRates.rates[nextCurrency];
    const enteredFuturePrice = positiveNumber(futurePrice);
    setCurrency(nextCurrency);
    if (enteredFuturePrice && oldRate && nextRate) {
      setFuturePrice(trimFiat(enteredFuturePrice / oldRate * nextRate));
    } else {
      seededFuturePrice.current = false;
      setFuturePrice("");
    }
  };

  const numericAmount = positiveNumber(amount);
  const converted = fiatPerBtc && numericAmount
    ? from === "fiat"
      ? { sats: Math.round(numericAmount / fiatPerBtc * 100_000_000), fiat: numericAmount }
      : { sats: Math.round(numericAmount), fiat: numericAmount / 100_000_000 * fiatPerBtc }
    : null;
  const swap = () => {
    setFrom(old => old === "fiat" ? "sats" : "fiat");
    setAmount(converted ? (from === "fiat" ? String(converted.sats) : trimFiat(converted.fiat)) : "");
  };

  const scenarioPrice = positiveNumber(futurePrice);
  const scenarioFiat = scenarioPrice && converted ? converted.sats / 100_000_000 * scenarioPrice : null;

  const quoteReady = !!fiatPerBtc;
  const quoteStatus = price.source === "live" && (currency === "USD" || fiatRates.source === "live")
    ? t("bond.converterLive")
    : quoteReady ? t("bond.converterCached") : t("bond.converterWaiting");
  const sats = (n: number) => `${formatRaw(String(n), sep)} sats`;
  const unitFrom = from === "fiat" ? currency : "sats";

  const label: CSSProperties = { color: T.ink2, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600 };
  const big: CSSProperties = { fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: T.fs.amount, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 };
  const shell: CSSProperties = variant === "sheet"
    ? {}
    : { background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, padding: 18, marginBottom: 14 };

  return (
    <section data-converter style={{ ...shell, fontFamily: T.sans }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 12 }}>
        <label htmlFor="chama-converter-currency" style={label}>{t("bond.converterCurrencyShort")}</label>
        <select id="chama-converter-currency" value={currency} onChange={(event) => changeCurrency(event.target.value)}
          style={{ ...inputStyle, width: "auto", minWidth: 96, minHeight: T.size.touch, padding: "0 12px", fontFamily: T.sans, fontSize: T.fs.body, fontWeight: 700 }}>
          {currencies.map(code => <option key={code} value={code}>{code}</option>)}
        </select>
      </div>

      {/* The question: what you type. */}
      <div style={{ padding: "14px 16px", borderRadius: T.rCard, background: T.surface, border: `1px solid ${T.line}` }}>
        <label htmlFor="chama-converter-amount" style={label}>{t("bond.converterYouType", { unit: unitFrom })}</label>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
          <GroupedInput id="chama-converter-amount" data-converter-input value={amount} onChange={setAmount}
            sep={sep} maxDecimals={from === "fiat" ? 2 : 0}
            style={{ ...big, flex: 1, minWidth: 0, width: "100%", padding: 0, border: 0, outline: "none", background: "transparent", color: T.ink }} />
          <span style={{ color: T.ink2, fontSize: T.fs.fiat, fontWeight: 700, flex: "0 0 auto" }}>{unitFrom}</span>
        </div>
      </div>

      {/* The swap sits on the seam between question and answer. */}
      <div style={{ display: "flex", justifyContent: "center", margin: "-8px 0", position: "relative", zIndex: 1 }}>
        <button type="button" onClick={swap} aria-label={t("bond.converterSwap")}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: T.size.touch, padding: "0 18px", borderRadius: 999, border: `1px solid ${T.line}`, background: T.raised, color: T.ink, fontFamily: T.sans, fontSize: T.fs.button, fontWeight: 700, cursor: "pointer" }}>
          <span aria-hidden="true" style={{ fontSize: "1.2em", lineHeight: 1 }}>⇅</span>
          {t("bond.converterSwapShort")}
        </button>
      </div>

      {/* The answer. */}
      <div style={{ padding: "14px 16px", borderRadius: T.rCard, background: T.surface, border: `1px solid ${T.line}` }}>
        <div style={label}>{t("bond.converterThatIs")}</div>
        <div aria-live="polite" style={{ ...big, color: converted ? T.ink : T.ink3, marginTop: 6, overflowWrap: "anywhere" }}>
          {converted ? (from === "fiat" ? sats(converted.sats) : formatFiatAmount(converted.fiat, currency)) : "—"}
        </div>
      </div>

      {fiatPerBtc && (
        <div style={{ color: T.ink2, fontSize: T.fs.secondary, lineHeight: 1.5, marginTop: 12, fontVariantNumeric: "tabular-nums" }}>
          {t("bond.converterRate", { price: formatFiatAmount(Math.round(fiatPerBtc), currency) })}
        </div>
      )}

      {/* What if: one plain question, folded away until asked. */}
      <div style={{ marginTop: 14, borderTop: `1px solid ${T.line}`, paddingTop: 6 }}>
        <button type="button" aria-expanded={whatIfOpen} aria-controls="chama-converter-whatif" onClick={() => setWhatIfOpen(open => !open)}
          style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: T.size.touch, padding: 0, border: 0, background: "transparent", color: T.ink, fontFamily: T.sans, fontSize: T.fs.body, fontWeight: 700, cursor: "pointer", textAlign: "left" }}>
          {t("bond.converterWhatIf")}
          <span aria-hidden="true" style={{ color: T.ink2, transform: whatIfOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>⌄</span>
        </button>
        {whatIfOpen && (
          <div id="chama-converter-whatif" style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 4 }}>
            <label htmlFor="chama-converter-whatif-price" style={label}>{t("bond.converterIfPrice")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <GroupedInput id="chama-converter-whatif-price" value={futurePrice} onChange={setFuturePrice} sep={sep} maxDecimals={0}
                style={{ ...inputStyle, flex: 1, minWidth: 0, minHeight: T.size.touch, fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: T.fs.fiat, fontWeight: 700 }} />
              <span style={{ color: T.ink2, fontSize: T.fs.body, fontWeight: 700 }}>{currency}</span>
            </div>
            {fiatPerBtc && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {WHAT_IF_MULTIPLES.map(m => {
                  const value = String(roundPrice(fiatPerBtc * m));
                  const active = futurePrice === value;
                  return (
                    <button key={m} type="button" aria-pressed={active} onClick={() => setFuturePrice(value)}
                      style={{ minHeight: T.size.touch, padding: "0 14px", borderRadius: 999, border: `1px solid ${active ? T.ink : T.line}`, background: active ? T.accentDim : "transparent", color: T.ink, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer" }}>
                      {t("bond.converterTimesToday", { n: m })}
                    </button>
                  );
                })}
              </div>
            )}
            <div aria-live="polite" style={{ padding: "12px 14px", borderRadius: T.rs, background: T.posBg }}>
              {converted && scenarioFiat ? (
                <>
                  <div style={{ color: T.ink, fontSize: T.fs.body, lineHeight: 1.4 }}>{t("bond.converterWouldBe", { sats: sats(converted.sats) })}</div>
                  <div style={{ color: T.pos, fontSize: T.fs.title2, fontWeight: 700, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{formatFiatAmount(scenarioFiat, currency)}</div>
                </>
              ) : (
                <div style={{ color: T.ink2, fontSize: T.fs.body }}>{t("bond.converterEnterFirst")}</div>
              )}
            </div>
            <div style={{ color: T.ink2, fontSize: T.fs.secondary }}>{t("bond.converterNotPrediction")}</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", color: quoteReady ? T.ink2 : T.attnInk, fontSize: T.fs.secondary, lineHeight: 1.45, marginTop: 12 }}>
        <span style={{ width: 6, height: 6, flex: "0 0 6px", borderRadius: 99, background: quoteReady ? T.pos : T.attn }} />
        {quoteStatus} · {t("bond.converterDisclaimer")}
      </div>
    </section>
  );
}

/** A text field that keeps the raw value canonical ("1250000.5") while
 *  showing it grouped in the viewer's separators, caret held in place. */
function GroupedInput({ id, value, onChange, sep, maxDecimals, style, ...rest }: {
  id: string;
  value: string;
  onChange: (raw: string) => void;
  sep: Separators;
  maxDecimals: number;
  style: CSSProperties;
  "data-converter-input"?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [, rerender] = useState(0);
  const shown = formatRaw(value, sep);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pendingCaret.current === null) return;
    const at = caretAfter(shown, pendingCaret.current, sep);
    pendingCaret.current = null;
    if (document.activeElement === el) el.setSelectionRange(at, at);
  });
  return (
    <input ref={ref} id={id} {...rest} value={shown} placeholder="0" autoComplete="off"
      inputMode={maxDecimals > 0 ? "decimal" : "numeric"}
      onKeyDown={(event) => {
        // Deleting across a separator deletes the digit beside it.
        const el = event.currentTarget;
        const at = el.selectionStart ?? 0;
        if (at !== el.selectionEnd) return;
        if (event.key === "Backspace" && at > 0 && el.value[at - 1] === sep.group) el.setSelectionRange(at - 1, at - 1);
        if (event.key === "Delete" && el.value[at] === sep.group) el.setSelectionRange(at + 1, at + 1);
      }}
      onChange={(event) => {
        const el = event.target;
        pendingCaret.current = meaningfulBefore(el.value, el.selectionStart ?? el.value.length, sep);
        onChange(parseTyped(el.value, sep, maxDecimals));
        rerender(n => n + 1);
      }}
      style={style} />
  );
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** A round, readable what-if price: 2 significant figures ("170,000"). */
function roundPrice(value: number): number {
  if (value <= 0) return 0;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1);
  return Math.round(value / step) * step;
}

function trimFiat(value: number): string {
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 2 });
}
