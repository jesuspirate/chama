import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { OverlaySheet } from "./OverlaySheet.js";
import { BitcoinConverter } from "./BitcoinConverter.js";
import { formatUsdBtcPrice, formatUsdBtcPriceFull } from "../../markets/bitcoin-price.js";
import { T } from "../theme.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import {
  estimateFiatForMsats,
  formatFiatAmount,
  nextAmountDisplayMode,
  normalizeFiatCurrency,
  type AmountDisplayMode,
} from "../amount-display.js";
import { useT } from "../../i18n/index.js";

// Scoped interaction/animation CSS — inline styles can't do :active/@keyframes.
// The WHOLE hero rectangle is the button (pressable anywhere): it springs down
// on press (tactile), and the "sats ⇄ fiat" toggle line POPS each time you
// switch (the "animate on action" feel, driven by a React key so it's reliable
// on touch — :active alone felt stale on mobile). Honors prefers-reduced-motion.
const toggleCss = () => `
@keyframes chamaPricePop {
  0%   { transform: scale(.86); }
  55%  { transform: scale(1.1); }
  100% { transform: scale(1); }
}
.chama-price-btn { transition: transform .14s cubic-bezier(.34,1.56,.64,1), box-shadow .2s ease; }
.chama-price-btn:active { transform: scale(.98); }
.chama-sr-focusable { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; padding: 0; }
.chama-sr-focusable:focus-visible { position: absolute; left: 8px; top: 8px; width: auto; height: auto; clip: auto; padding: 6px 10px; border-radius: 999px; background: ${T.ink}; color: ${T.onInk}; z-index: 2; }
.chama-price-swap { transition: opacity .3s ease; }
.chama-price-rocker-knob { transition: transform .24s cubic-bezier(.34,1.56,.64,1); }
.chama-price-pop { animation: chamaPricePop .3s cubic-bezier(.34,1.56,.64,1); transform-origin: center; }
@media (prefers-reduced-motion: reduce) { .chama-price-pop { animation: none; } }
`;
const ToggleStyle = () => <style>{toggleCss()}</style>;

/** Big price number that SHRINKS to fit its width (content-responsive), so a
 *  high-denomination currency (IDR/VND-scale) never overflows or clips on a
 *  narrow device. Measures scrollWidth vs the container and steps the font-size
 *  down to `min`; re-fits on width change (rotation) via ResizeObserver. */
function FitText({ text, max, min, align = "left", style }: {
  text: string; max: number; min: number; align?: "left" | "right"; style?: CSSProperties;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState(max);
  useLayoutEffect(() => {
    const box = boxRef.current, span = spanRef.current;
    if (!box || !span) return;
    const fit = () => {
      let s = max;
      span.style.fontSize = `${s}px`;
      while (s > min && span.scrollWidth > box.clientWidth) {
        s -= 1;
        span.style.fontSize = `${s}px`;
      }
      setPx(s);
    };
    fit();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => fit());
      ro.observe(box);
    }
    return () => ro?.disconnect();
  }, [text, max, min]);
  return (
    <div ref={boxRef} style={{ width: "100%", minWidth: 0, overflow: "hidden", textAlign: align }}>
      <span ref={spanRef} style={{ ...style, fontSize: `${px}px`, whiteSpace: "nowrap", display: "inline-block" }}>
        {text}
      </span>
    </div>
  );
}

export function BitcoinPricePill({
  compact = false,
  hero = false,
  slim = false,
  amountMode,
  onAmountModeChange,
  quoteCurrency,
  converterCommunity,
}: {
  compact?: boolean;
  hero?: boolean;
  /** Phone-sized hero: same gradient, same rocker, ONE line — drops the
   *  sub-labels and the "1 BTC" column so the digits stay big at 375px.
   *  Only meaningful together with `hero`. */
  slim?: boolean;
  amountMode?: AmountDisplayMode;
  onAmountModeChange?: (mode: AmountDisplayMode) => void;
  quoteCurrency?: string | null;
  /** Community for the converter sheet's home currency. */
  converterCommunity?: string | null;
}) {
  const { t } = useT();
  const price = useBitcoinPrice();
  // v7 redesign (Jet): the price bar opens the converter as a sheet — a goodie
  // reachable from every screen that shows the bar. The switch toggles mode.
  const [converterOpen, setConverterOpen] = useState(false);
  const converterSheet = converterOpen ? (
    <OverlaySheet title={t("bond.converterHeading")} onClose={() => setConverterOpen(false)}>
      <BitcoinConverter communitySlug={converterCommunity} variant="sheet" />
    </OverlaySheet>
  ) : null;
  const fiatRates = useFiatRates();
  const normalizedQuoteCurrency = normalizeFiatCurrency(quoteCurrency) ?? "USD";
  const localBtcPrice = normalizedQuoteCurrency === "USD"
    ? price.usd ?? null
    : estimateFiatForMsats({
        amountMsats: 100_000_000_000,
        currency: normalizedQuoteCurrency,
        usdPerBtc: price.usd,
        usdFiatRates: fiatRates.rates,
      });
  const displayCurrency = localBtcPrice ? normalizedQuoteCurrency : "USD";
  const displayAmount = localBtcPrice ?? price.usd ?? null;
  const displayIsUsd = displayCurrency === "USD";
  const label = displayAmount
    ? `${displayIsUsd ? formatUsdBtcPrice(displayAmount) : formatFiatAmount(displayAmount, displayCurrency)} BTC`
    : t("browse.btcPriceLoading");
  const fullLabel = displayAmount
    ? (displayIsUsd ? formatUsdBtcPriceFull(displayAmount) : formatFiatAmount(displayAmount, displayCurrency))
    : t("browse.btcPriceLoading");
  // Split price into ticker (left) + digits (right) for the hero's two-column
  // layout. A BTC price is huge, so drop decimals entirely — cents are noise.
  const priceTicker = displayAmount != null ? displayCurrency : "";
  const priceDigits = displayAmount != null
    ? Math.round(displayAmount).toLocaleString()
    : t("browse.priceLoadingShort");
  const stale = price.source !== "live";
  const title = price.updatedAt
    ? `BTC/${displayCurrency} ${new Date(price.updatedAt).toLocaleTimeString()}`
    : t("browse.loadingBtcPair", { currency: displayCurrency });
  const providerCount = price.source === "live" ? price.providers?.length ?? 0 : 0;
  const btcSourceLabel = price.source === "live"
    ? providerCount > 1
      ? t("browse.medianOfSources", { count: providerCount })
      : t("browse.liveSource")
    : price.source === "cache"
      ? t("browse.cachedQuote")
      : t("browse.waitingForSources");
  const sourceLabel = displayCurrency !== "USD" && displayAmount
    ? t("browse.sourceWithFx", {
        source: btcSourceLabel,
        fx: fiatRates.source === "live" ? t("browse.fxLive") : fiatRates.source === "cache" ? t("browse.fxCached") : t("browse.fxWaiting"),
      })
    : btcSourceLabel;
  const content = (
    <>
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: stale ? T.muted : T.green,
          boxShadow: stale ? "none" : `0 0 7px ${T.green}66`,
        }}
      />
      <span>{label}</span>
      {amountMode && (
        <span style={{
          marginLeft: 1,
          padding: compact ? "2px 4px" : "2px 5px",
          borderRadius: 999,
          background: amountMode === "fiat" ? T.green + "18" : T.accentDim,
          border: `1px solid ${amountMode === "fiat" ? T.green + "44" : T.accent + "44"}`,
          color: amountMode === "fiat" ? T.green : T.accent,
        }}>
          {amountMode}
        </span>
      )}
    </>
  );

  const pillStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: compact ? "4px 7px" : "4px 10px",
    borderRadius: 6,
    background: T.surface,
    border: `1px solid ${stale ? T.border : T.green + "55"}`,
    color: stale ? T.muted : T.green,
    fontFamily: T.sans, fontVariantNumeric: "tabular-nums",
    fontSize: compact ? 8 : 9,
    fontWeight: 700,
    whiteSpace: "nowrap" as const,
    lineHeight: 1,
  };

  if (amountMode && onAmountModeChange) {
    const nextMode = nextAmountDisplayMode(amountMode);
    if (hero && slim) {
      // The phone hero: one line, price as the biggest thing on it.
      return (
        <>
        <ToggleStyle />
        <div
          className="chama-price-btn"
          role="group"
          aria-label={title}
          onClick={() => setConverterOpen(true)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 12px",
            borderRadius: T.r,
            border: `1px solid ${T.green}55`,
            background: `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
            color: T.text,
            cursor: "pointer",
            boxShadow: `0 0 26px ${T.green}12`,
          }}
        >
          <span aria-hidden="true" style={{
            flexShrink: 0, width: 8, height: 8, borderRadius: "50%",
            background: stale ? T.muted : T.green,
            boxShadow: stale ? "none" : `0 0 10px ${T.green}99`,
          }} />
          <span style={{
            flexShrink: 0, color: stale ? T.muted : T.green,
            fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap",
          }}>1 BTC</span>
          <button type="button" className="chama-sr-focusable" onClick={e => { e.stopPropagation(); setConverterOpen(true); }}>{t("browse.openConverter")}</button>
            <PriceSwitch mode={amountMode} currency={displayCurrency} size={"slim"} onToggle={() => onAmountModeChange(nextMode)} />
          <span style={{
            display: "flex", alignItems: "baseline", justifyContent: "flex-end",
            gap: 6, minWidth: 0, flex: 1,
          }}>
            <span style={{
              flexShrink: 0, color: price.usd ? T.text : T.muted,
              fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: 13, fontWeight: 700,
            }}>{priceTicker}</span>
            <FitText text={priceDigits} max={30} min={18} align="right" style={{
              color: price.usd ? T.text : T.muted,
              fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, lineHeight: .94,
            }} />
          </span>
        </div>
        {converterSheet}
        </>
      );
    }
    if (hero) {
      return (
        <>
        <ToggleStyle />
        <div
          className="chama-price-btn"
          role="group"
          aria-label={title}
          onClick={() => setConverterOpen(true)}
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "13px 16px",
            borderRadius: T.r,
            border: `1px solid ${T.green}55`,
            background: `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
            color: T.text,
            textAlign: "left",
            cursor: "pointer",
            boxShadow: `0 0 26px ${T.green}12`,
          }}
        >
          {/* One clean exchange line. The values remain plain; the physical
              rocker in the middle is the only control-shaped object. */}
          <div style={{
            display: "grid", gridTemplateColumns: "minmax(98px,.72fr) 84px minmax(0,1.35fr)",
            alignItems: "center", gap: 12,
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8, minWidth: 0,
              color: stale ? T.muted : T.green,
              fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: 22, fontWeight: 700, whiteSpace: "nowrap",
            }}>
              <span aria-hidden="true" style={{
                width: 9, height: 9, borderRadius: "50%",
                background: stale ? T.muted : T.green,
                boxShadow: stale ? "none" : `0 0 12px ${T.green}99`,
              }} />
              1 BTC
            </div>
            <button type="button" className="chama-sr-focusable" onClick={e => { e.stopPropagation(); setConverterOpen(true); }}>{t("browse.openConverter")}</button>
            <PriceSwitch mode={amountMode} currency={displayCurrency} size={"full"} onToggle={() => onAmountModeChange(nextMode)} />
            <div style={{
              display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 8,
              minWidth: 0,
            }}>
              <span style={{
                flexShrink: 0, color: price.usd ? T.text : T.muted,
                fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: 20, fontWeight: 700,
              }}>{priceTicker}</span>
              <FitText text={priceDigits} max={50} min={23} align="right" style={{
                color: price.usd ? T.text : T.muted,
                fontFamily: T.sans, fontVariantNumeric: "tabular-nums",
                fontWeight: 700,
                lineHeight: .94,
              }} />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{
              color: amountMode === "fiat" ? T.green : T.accent,
              fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: T.fs.secondary, fontWeight: 900,
            }}>
              {t("browse.browseIn", { unit: amountMode === "fiat" ? displayCurrency : "sats" })}
            </span>
            <span style={{
              minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: T.muted, fontFamily: T.sans, fontVariantNumeric: "tabular-nums", fontSize: T.fs.secondary, fontWeight: 800,
            }}>{sourceLabel}</span>
          </div>
        </div>
        {converterSheet}
        </>
      );
    }

    return (
      <>
        <ToggleStyle />
        <button
          type="button"
          className="chama-price-btn"
          title={t("browse.tapToSwitch", { title, mode: nextMode })}
          onClick={() => onAmountModeChange(nextMode)}
          style={{
            ...pillStyle,
            cursor: "pointer",
          }}
        >
          {content}
        </button>
      </>
    );
  }

  if (hero) {
    return (
      <div
        title={title}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 16px",
          borderRadius: T.r,
          border: `1px solid ${T.green}55`,
          background: `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
          color: T.text,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: stale ? T.muted : T.green,
            fontFamily: T.sans, fontVariantNumeric: "tabular-nums",
            fontSize: T.fs.secondary,
            fontWeight: 900,
            marginBottom: 5,
          }}>
            BTC/{displayCurrency}
          </div>
          <FitText
            text={fullLabel}
            max={30}
            min={15}
            style={{
              color: price.usd ? T.text : T.muted,
              fontFamily: T.sans, fontVariantNumeric: "tabular-nums",
              fontWeight: 700,
              lineHeight: 1,
            }}
          />
        </div>
        <div style={{
          flexShrink: 1,
          minWidth: 0,
          maxWidth: "45%",
          color: T.muted,
          fontFamily: T.sans, fontVariantNumeric: "tabular-nums",
          fontSize: T.fs.secondary,
          fontWeight: 600,
          textAlign: "right",
          lineHeight: 1.25,
        }}>
          {sourceLabel}
        </div>
      </div>
    );
  }

  return (
    <span
      title={title}
      style={pillStyle}
    >
      {content}
    </span>
  );
}

/**
 * v7 redesign (Jet): the price toggle as an unmistakable switch — a visible
 * track labelled at both ends (₿ · local currency) and a thumb that is the
 * orange Bitcoin coin in sats mode and the green currency thumb in fiat mode.
 */
function PriceSwitch({ mode, currency, size, onToggle }: {
  mode: AmountDisplayMode; currency: string; size: "slim" | "full"; onToggle: () => void;
}) {
  const { t } = useT();
  const fiat = mode === "fiat";
  // The fiat end shows the currency's symbol ($, KSh…) — the price beside the
  // switch already spells the code, so "USD USD" never stacks up.
  let symbol = currency.slice(0, 3);
  try {
    symbol = new Intl.NumberFormat(undefined, { style: "currency", currency }).formatToParts(0)
      .find(part => part.type === "currency")?.value ?? symbol;
  } catch { /* unknown code: keep the code */ }
  symbol = symbol.slice(0, 3);
  const w = size === "full" ? 84 : 66;
  const h = size === "full" ? 38 : 30;
  const thumb = h - 6;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={fiat}
      aria-label={t("browse.browseIn", { unit: fiat ? currency : "sats" })}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      style={{
        position: "relative", flexShrink: 0, width: w, height: h, padding: 0,
        borderRadius: 999, border: `1px solid ${T.line}`, background: T.raised,
        cursor: "pointer", fontFamily: T.sans,
      }}
    >
      <span aria-hidden="true" style={{ position: "absolute", left: 9, top: 0, bottom: 0, display: "flex", alignItems: "center", fontSize: 13, fontWeight: 700, color: T.ink2 }}>₿</span>
      <span aria-hidden="true" style={{ position: "absolute", right: 7, top: 0, bottom: 0, display: "flex", alignItems: "center", fontSize: 12, fontWeight: 700, color: T.ink2 }}>{symbol}</span>
      <span
        aria-hidden="true"
        className="chama-price-rocker-knob"
        style={{
          position: "absolute", top: 2, left: 2, width: thumb, height: thumb, borderRadius: "50%",
          transform: fiat ? `translateX(${w - thumb - 6}px)` : "translateX(0)",
          display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
          background: fiat ? T.green : "transparent",
          boxShadow: "0 2px 5px rgba(0,0,0,0.3)",
          color: "#FFFFFF", fontSize: 10, fontWeight: 800,
        }}
      >
        {fiat
          ? symbol
          : <img src="/icons/bitcoin-mark-64.png" alt="" width={thumb} height={thumb} style={{ display: "block" }} />}
      </span>
    </button>
  );
}
