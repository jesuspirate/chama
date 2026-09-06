import type { CSSProperties, ReactNode } from "react";
import { activeResolvedTheme } from "../theme.js";

export type ChamaVerticalIconId =
  | "p2p-trade"
  | "bill-pay"
  | "marketplace"
  | "work"
  | "chip-in"
  | "stack"
  | "chama";

const ASSET_NAMES: Partial<Record<ChamaVerticalIconId, string>> = {
  "bill-pay": "bill-pay",
  marketplace: "store",
  work: "work",
  stack: "stack",
};

export function VerticalIcon({
  vertical,
  size = 32,
  fallback = "•",
  style,
}: {
  vertical: string;
  size?: number;
  fallback?: ReactNode;
  style?: CSSProperties;
}) {
  const theme = activeResolvedTheme();
  const common: CSSProperties = {
    display: "inline-grid",
    placeItems: "center",
    width: size,
    height: size,
    flex: "0 0 auto",
    lineHeight: 1,
    ...style,
  };

  if (vertical === "p2p-trade") {
    return (
      <span style={{ ...common, position: "relative" }} aria-hidden="true">
        <svg viewBox="0 0 240 180" width={size} height={size} style={{ display: "block", overflow: "visible" }}>
          <path fill="currentColor" d="M28 24h122V8l62 38-62 38V68H28V24Zm184 132H90v16l-62-38 62-38v16h122v44Z" />
          <circle fill={theme === "dark" ? "#14110d" : "#eee8dc"} cx="120" cy="90" r="39" />
        </svg>
        <img
          src="/icons/bitcoin-mark-64.png"
          alt=""
          width={Math.round(size * 0.38)}
          height={Math.round(size * 0.38)}
          style={{ position: "absolute", inset: 0, margin: "auto", display: "block" }}
        />
      </span>
    );
  }

  if (vertical === "chip-in") {
    const ink = theme === "dark" ? "#eee3d0" : "#13120f";
    const paper = theme === "dark" ? "#14110d" : "#eee8dc";
    return (
      <span style={common} aria-hidden="true">
        <svg viewBox="0 0 240 180" width={size} height={size} style={{ display: "block", overflow: "visible" }}>
          <path fill="none" stroke={ink} strokeWidth="6" strokeLinecap="round" d="M120 43v15M73 90h15M167 90h-15M120 122v15" />
          <circle fill={ink} cx="120" cy="23" r="20" />
          <circle fill={ink} cx="53" cy="90" r="20" />
          <circle fill={ink} cx="187" cy="90" r="20" />
          <circle fill={ink} cx="120" cy="157" r="20" />
          <path fill="none" stroke={paper} strokeWidth="6" strokeLinecap="round" d="M53 84v12M47 90h12M120 14v18M111 23h18M120 144v26M107 157h26M187 73v34M170 90h34" />
          <circle fill="#f2e8d6" stroke={ink} strokeWidth="8" cx="120" cy="90" r="32" />
          <path fill="#13120f" d="M100 113c2-15 9-23 20-23s18 8 20 23h-40Z" />
          <circle fill="#f7931a" cx="120" cy="79" r="9" />
        </svg>
      </span>
    );
  }

  if (vertical === "chama") {
    // The Chama circle — three people around one shared pot. Same ink/paper
    // palette as the other bespoke marks; the orange dot is the pooled sats.
    // "Lock together; if the circle doesn't fill, everyone gets theirs back."
    const ink = theme === "dark" ? "#eee3d0" : "#13120f";
    return (
      <span style={common} aria-hidden="true">
        <svg viewBox="0 0 240 180" width={size} height={size} style={{ display: "block", overflow: "visible" }}>
          <circle fill={ink} cx="120" cy="26" r="20" />
          <circle fill={ink} cx="50" cy="142" r="20" />
          <circle fill={ink} cx="190" cy="142" r="20" />
          <path fill="none" stroke={ink} strokeWidth="9" strokeLinecap="round"
            d="M120 50v16M66 130l26-18M174 130l-26-18" />
          <circle fill="#f2e8d6" stroke={ink} strokeWidth="8" cx="120" cy="98" r="32" />
          <circle fill="#f7931a" cx="120" cy="98" r="11" />
        </svg>
      </span>
    );
  }

  if (vertical === "local-money") {
    // Two-tone banknote for the "Local money" asset — same ink/paper palette as
    // the other bespoke marks. Reads unambiguously as fiat cash at 40px, where
    // the Exchange arrows read as "swap" rather than "local money".
    const ink = theme === "dark" ? "#eee3d0" : "#13120f";
    const paper = theme === "dark" ? "#14110d" : "#eee8dc";
    return (
      <span style={common} aria-hidden="true">
        <svg viewBox="0 0 240 180" width={size} height={size} style={{ display: "block", overflow: "visible" }}>
          <rect x="20" y="44" width="200" height="92" rx="18" fill={ink} />
          <rect x="36" y="60" width="168" height="60" rx="9" fill="none" stroke={paper} strokeWidth="6" />
          <circle cx="120" cy="90" r="22" fill={paper} />
          <circle cx="120" cy="90" r="10" fill={ink} />
          <circle cx="64" cy="90" r="7" fill={paper} />
          <circle cx="176" cy="90" r="7" fill={paper} />
        </svg>
      </span>
    );
  }

  const asset = ASSET_NAMES[vertical as ChamaVerticalIconId];
  if (asset) {
    return (
      <span style={common} aria-hidden="true">
        <img
          src={`/icons/verticals/${asset}-${theme}.svg`}
          alt=""
          width={size}
          height={size}
          decoding="async"
          style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }}
        />
      </span>
    );
  }

  return <span style={common} aria-hidden="true">{fallback}</span>;
}
