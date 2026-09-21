import { T } from "../theme.js";

/**
 * Lowercase Manrope wordmark with a drawn orange dot in the text flow.
 * The dot scales at 30% of the type size (minimum 5px), sits on its baseline,
 * and uses the same light/dark accent inks as the landing's --dot token.
 * Keeping it inside the text span avoids flex gaps and font-dependent glyphs.
 */
export function Wordmark({ size = 24, markSize = 28, showMark = true }: { size?: number; markSize?: number; showMark?: boolean }) {
  const dot = Math.max(5, Math.round(size * 0.30));
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.round(size * 0.25),
        fontFamily: T.display,
        fontWeight: 800,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: size * -0.054,
        color: T.text,
      }}
    >
      {showMark && <img
        src="/icons/chama-woven-trust-mark-transparent-64.png"
        alt="Chama"
        width={markSize}
        height={markSize}
        style={{ display: "block", flexShrink: 0, objectFit: "contain" }}
      />}
      <span>
        chama
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: T.accent,
            verticalAlign: "baseline",
            marginLeft: Math.round(size * 0.10),
          }}
        />
      </span>
    </span>
  );
}
