import { T, STATUS } from "../theme.js";
import { useT } from "../../i18n/index.js";

// v7 redesign: sentence-case DM Sans pill (no letter-spaced caps). The colour
// is never the only signal — every state carries its word, In escrow also a
// lock, and states that need the person keep the pulsing dot.
//   fg set          → solid fill (In escrow = ink, Ready to collect = attention)
//   bg transparent  → outlined (Cancelled)
//   otherwise       → tinted fill
export function Badge({ status }: { status: string }) {
  const { t } = useT();
  const s = STATUS[status] || STATUS.CREATED;
  const outlined = s.bg === "transparent";
  const solid = !!s.fg;
  const showDot = !solid && !outlined && s.mode !== "resolved";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 999,
      background: s.bg,
      color: s.fg ?? s.c,
      border: outlined ? `1px solid ${T.line}` : "1px solid transparent",
      fontSize: T.fs.secondary, fontWeight: 600, lineHeight: 1.3,
      fontFamily: T.sans, whiteSpace: "nowrap",
    }}>
      {s.icon === "lock" && <LockGlyph />}
      {showDot && (
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: s.c, flexShrink: 0,
          animation: s.mode === "active" ? "pulse 2s ease-in-out infinite" : "none",
        }} />
      )}
      {t(s.l)}
    </span>
  );
}

export function LockGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
