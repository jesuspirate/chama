import { T } from "../theme.js";

/**
 * The Chama logotype, matched to the landing page's `.brand` rule
 * (landing/story.css): the woven-trust mark, the lowercase wordmark in
 * Manrope 800 with tight tracking, and the orange dot riding the baseline.
 *
 * Proportions follow the landing's own compact treatment (cinema.css, the
 * ≤600px nav): 28px mark, 24px type, -1.3px tracking, an 8px dot nudged
 * -3px left and 4px up. The app is a phone-width surface, so that is the
 * variant that belongs here rather than the 31px desktop one.
 *
 * The dot takes T.accent rather than the landing's fixed #c65b17: light mode
 * resolves to #c47308, within a hair of the landing's ink, while dark mode
 * gets the full #f7931a it needs to carry on #0a0a0f.
 */
export function Wordmark({ size = 24, markSize = 28 }: { size?: number; markSize?: number }) {
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
      <img
        src="/icons/chama-woven-trust-mark-transparent-64.png"
        alt="Chama"
        width={markSize}
        height={markSize}
        style={{ display: "block", flexShrink: 0, objectFit: "contain" }}
      />
      <span>chama</span>
      <span
        aria-hidden="true"
        style={{
          fontSize: Math.max(6, Math.round(size / 3)),
          color: T.accent,
          alignSelf: "flex-end",
          marginLeft: -Math.round(size / 8),
          marginBottom: Math.round(size / 6),
        }}
      >
        ●
      </span>
    </span>
  );
}
