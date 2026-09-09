import { T, fmtSats } from "../theme.js";
import { useT } from "../../i18n/index.js";

/** Geometry only: all counts and amounts come from the circle selectors. */
export function CircleSeatRing({ filled, total, potMsats, targetMsats }: { filled: number; total: number; potMsats: number; targetMsats: number }) {
  const { t } = useT();
  const count = Math.min(total, 40);
  const ratio = Math.min(1, filled / Math.max(1, total));
  return <svg viewBox="0 0 300 300" role="img" aria-label={t("circle.seats", { filled, total })} style={{ display: "block", width: "min(100%, 310px, 36vh)", margin: "0 auto", overflow: "visible" }}>
    <circle cx="150" cy="150" r="108" fill="none" stroke={T.borderHi} strokeWidth="6" />
    <circle cx="150" cy="150" r="108" fill="none" stroke={T.accent} strokeWidth="6" strokeLinecap="round" pathLength="100" strokeDasharray={`${ratio * 100} 100`} transform="rotate(-90 150 150)" />
    {Array.from({ length: count }, (_, i) => {
      const a = i * 2 * Math.PI / count - Math.PI / 2;
      const x = 150 + 108 * Math.cos(a), y = 150 + 108 * Math.sin(a);
      const on = i / count < ratio;
      const r = count > 16 ? 6 : count > 9 ? 11 : 21;
      return <g key={i}><circle cx={x} cy={y} r={r} fill={on ? T.accent : T.card} stroke={on ? T.accent : T.muted} strokeWidth="2" strokeDasharray={on ? undefined : "5 4"} />
        {on && count <= 16 && <path d={`M${x-r*.4} ${y} l${r*.28} ${r*.28} ${r*.55} ${-r*.62}`} fill="none" stroke={T.bg} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}</g>;
    })}
    <circle cx="150" cy="150" r="54" fill={T.bg} stroke={T.borderHi} strokeWidth="1.5" />
    <text x="150" y="146" textAnchor="middle" fill={T.text} fontFamily={T.sans} fontSize="25" fontWeight="800">{fmtSats(potMsats)}</text>
    <text x="150" y="169" textAnchor="middle" fill={T.muted} fontFamily={T.mono} fontSize="11">{t("circle.ofSats", { amount: fmtSats(targetMsats) })}</text>
  </svg>;
}
