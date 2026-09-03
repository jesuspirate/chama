import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
const TOGGLE_CSS = `
@keyframes chamaPricePop {
  0%   { transform: scale(.86); }
  55%  { transform: scale(1.1); }
  100% { transform: scale(1); }
}
.chama-price-btn { transition: transform .14s cubic-bezier(.34,1.56,.64,1), box-shadow .2s ease; }
.chama-price-btn:active { transform: scale(.98); }
.chama-price-swap { transition: color .3s ease, opacity .3s ease; }
.chama-price-rocker-knob { transition: transform .24s cubic-bezier(.34,1.56,.64,1), background .2s ease, box-shadow .2s ease; }
.chama-price-pop { animation: chamaPricePop .3s cubic-bezier(.34,1.56,.64,1); transform-origin: center; }
@media (prefers-reduced-motion: reduce) { .chama-price-pop { animation: none; } }
`;
const ToggleStyle = () => <style>{TOGGLE_CSS}</style>;

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
  amountMode,
  onAmountModeChange,
  quoteCurrency,
}: {
  compact?: boolean;
  hero?: boolean;
  amountMode?: AmountDisplayMode;
  onAmountModeChange?: (mode: AmountDisplayMode) => void;
  quoteCurrency?: string | null;
}) {
  const { t } = useT();
  const price = useBitcoinPrice();
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
          textTransform: "uppercase",
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
    fontFamily: T.mono,
    fontSize: compact ? 8 : 9,
    fontWeight: 800,
    whiteSpace: "nowrap" as const,
    lineHeight: 1,
  };

  if (amountMode && onAmountModeChange) {
    const nextMode = nextAmountDisplayMode(amountMode);
    if (hero) {
      return (
        <>
        <ToggleStyle />
        <button
          type="button"
          className="chama-price-btn"
          title={t("browse.tapToSwitch", { title, mode: nextMode })}
          onClick={() => onAmountModeChange(nextMode)}
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "13px 16px",
            borderRadius: T.r,
            border: `1px solid ${stale ? T.borderHi : T.green + "55"}`,
            background: stale
              ? `linear-gradient(135deg, ${T.surface}, ${T.card})`
              : `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
            color: T.text,
            textAlign: "left",
            cursor: "pointer",
            boxShadow: stale ? "none" : `0 0 26px ${T.green}12`,
          }}
        >
          {/* One clean exchange line. The values remain plain; the physical
              rocker in the middle is the only control-shaped object. */}
          <div style={{
            display: "grid", gridTemplateColumns: "minmax(98px,.72fr) 64px minmax(0,1.35fr)",
            alignItems: "center", gap: 12,
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8, minWidth: 0,
              color: stale ? T.muted : T.green,
              fontFamily: T.mono, fontSize: 22, fontWeight: 950,
              letterSpacing: 0.2, whiteSpace: "nowrap",
            }}>
              <span aria-hidden="true" style={{
                width: 9, height: 9, borderRadius: "50%",
                background: stale ? T.muted : T.green,
                boxShadow: stale ? "none" : `0 0 12px ${T.green}99`,
              }} />
              1 BTC
            </div>
            <span
              className="chama-price-swap"
              aria-hidden="true"
              style={{
                position: "relative", width: 64, height: 34, borderRadius: 11,
                display: "block", overflow: "hidden",
                border: `1px solid ${T.borderHi}`,
                background: `linear-gradient(90deg, ${T.accentDim}, ${T.greenDim})`,
                boxShadow: `inset 0 3px 7px ${T.bg}cc, 0 1px 0 ${T.text}16`,
              }}
            >
              <span
                className="chama-price-rocker-knob"
                style={{
                  position: "absolute", zIndex: 0, left: 3, top: 3,
                  width: 28, height: 26, borderRadius: 8,
                  transform: amountMode === "fiat" ? "translateX(28px)" : "translateX(0)",
                  background: amountMode === "fiat"
                    ? `linear-gradient(180deg, ${T.green}dd, ${T.green}88)`
                    : `linear-gradient(180deg, ${T.accent}dd, ${T.accent}88)`,
                  boxShadow: `0 4px 8px ${T.bg}cc, inset 0 1px 0 ${T.text}66`,
                }}
              />
              <span
                key={amountMode}
                className="chama-price-pop"
                style={{
                  position: "absolute", zIndex: 1, inset: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: T.text, lineHeight: 0,
                  textShadow: `0 1px 4px ${T.bg}`,
                }}
              >
                <svg
                  width="24"
                  height="16"
                  viewBox="0 0 24 16"
                  fill="none"
                  aria-hidden="true"
                  style={{ display: "block", overflow: "visible", filter: `drop-shadow(0 1px 2px ${T.bg})` }}
                >
                  <path d="M3 5h15M15 2l3 3-3 3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M21 11H6M9 8l-3 3 3 3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </span>
            <div style={{
              display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 8,
              minWidth: 0,
            }}>
              <span style={{
                flexShrink: 0, color: price.usd ? T.text : T.muted,
                fontFamily: T.mono, fontSize: 20, fontWeight: 950,
              }}>{priceTicker}</span>
              <FitText text={priceDigits} max={50} min={23} align="right" style={{
                color: price.usd ? T.text : T.muted,
                fontFamily: T.mono,
                fontWeight: 950,
                lineHeight: .94,
                letterSpacing: -1.5,
              }} />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{
              color: amountMode === "fiat" ? T.green : T.accent,
              fontFamily: T.mono, fontSize: 9, fontWeight: 900,
              textTransform: "uppercase", letterSpacing: .7,
            }}>
              Browse in {amountMode === "fiat" ? displayCurrency : "sats"}
            </span>
            <span style={{
              minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: T.muted, fontFamily: T.mono, fontSize: 8, fontWeight: 800,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}>{sourceLabel}</span>
          </div>
        </button>
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
          border: `1px solid ${stale ? T.borderHi : T.green + "55"}`,
          background: stale
            ? `linear-gradient(135deg, ${T.surface}, ${T.card})`
            : `linear-gradient(135deg, ${T.greenDim}, ${T.surface} 48%, ${T.accentDim})`,
          color: T.text,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: stale ? T.muted : T.green,
            fontFamily: T.mono,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: 1.1,
            textTransform: "uppercase",
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
              fontFamily: T.mono,
              fontWeight: 950,
              lineHeight: 1,
              letterSpacing: 0,
            }}
          />
        </div>
        <div style={{
          flexShrink: 0,
          color: T.muted,
          fontFamily: T.mono,
          fontSize: 9,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          textAlign: "right",
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
