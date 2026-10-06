import { T } from "../theme.js";

/**
 * v7 redesign (Jet): the globe is back as a light inline drawing — a sphere in
 * the theme's ink with meridians, parallels and a few brand-orange community
 * dots. No image, no WebGL, no animation loop; well under 5 KB.
 */
export function InkGlobe({ size = 140 }: { size?: number }) {
  const r = 46;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-hidden="true" style={{ display: "block" }}>
      <circle cx="50" cy="50" r={r} fill={T.ink} />
      <g fill="none" stroke={T.bg} strokeOpacity="0.28" strokeWidth="0.8">
        <ellipse cx="50" cy="50" rx={r} ry="15" />
        <ellipse cx="50" cy="50" rx={r} ry="31" />
        <line x1="4" y1="50" x2="96" y2="50" />
        <ellipse cx="50" cy="50" rx="15" ry={r} />
        <ellipse cx="50" cy="50" rx="31" ry={r} />
        <line x1="50" y1="4" x2="50" y2="96" />
      </g>
      <g fill={T.brand}>
        <circle cx="38" cy="38" r="2.4" />
        <circle cx="63" cy="44" r="2.4" />
        <circle cx="55" cy="63" r="2.4" />
        <circle cx="30" cy="60" r="2" />
        <circle cx="72" cy="30" r="2" />
      </g>
      <circle cx="50" cy="50" r={r} fill="none" stroke={T.line} strokeWidth="0.8" />
    </svg>
  );
}
