import type { CSSProperties } from "react";
import { T, fmtSats } from "../theme.js";

export function BitcoinAmount({
  msats,
  sats,
  label,
  size = 24,
  color = T.accent,
  glyphColor = T.muted,
  gap = 6,
  glyphScale = 1,
  className,
  style,
}: {
  msats?: number;
  sats?: number;
  label?: string;
  /** px, or a type token such as T.fs.amount (scales with the phone scale). */
  size?: number | string;
  color?: string;
  glyphColor?: string;
  gap?: number;
  glyphScale?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const displayLabel = label ?? (msats !== undefined
    ? fmtSats(msats)
    : Math.floor(sats ?? 0).toLocaleString());
  const effectiveGlyphScale = Math.min(glyphScale, 1);

  return (
    <span
      className={className ? `bitcoin-amount ${className}` : "bitcoin-amount"}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap,
        color,
        // v7 redesign: amounts are DM Sans with tabular figures (mono is for
        // keys only); callers may still override via `style`.
        fontFamily: T.sans,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1,
        ...style,
      }}
    >
      <span
        className="bitcoin-amount-glyph"
        aria-hidden="true"
        style={{
          fontSize: typeof size === "number" ? Math.ceil(size * effectiveGlyphScale) : `calc(${size} * ${effectiveGlyphScale})`,
          color: glyphColor,
          lineHeight: 1,
          transform: "translateY(-1px)",
        }}
      >
        ₿
      </span>
      <span className="bitcoin-amount-number" style={{ fontSize: size, lineHeight: 1 }}>{displayLabel}</span>
    </span>
  );
}
