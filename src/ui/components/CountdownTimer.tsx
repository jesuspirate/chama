import { useState, useEffect } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

export function isCountdownDeadline(expiresAt: number, now: number): boolean {
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - now <= 365 * 86400;
}

export function CountdownTimer({
  expiresAt,
  label,
}: {
  expiresAt: number;
  label?: string;
}) {
  const { t } = useT();
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  const valid = isCountdownDeadline(expiresAt, now);
  useEffect(() => {
    if (!valid) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [valid]);

  if (!valid) return null;
  const remaining = expiresAt - now;
  if (remaining <= 0) {
    // v0.1.66.29: only the outer guard's skip-list keeps this from
    // showing on resolved trades. As a safety net, call it "Deadline
    // passed" rather than "EXPIRED" — the word EXPIRED is reserved
    // for the actual EscrowStatus.EXPIRED terminal state.
    return (
      <div style={{
        padding: "10px 16px", borderRadius: T.rs,
        background: T.redDim, border: `1px solid ${T.red}44`,
        textAlign: "center", fontFamily: T.mono, fontSize: 12,
        color: T.red, fontWeight: 700,
        width: "fit-content",
        maxWidth: "100%",
        margin: "0 auto",
      }}>
        {t("card.deadlinePassed")}
      </div>
    );
  }

  const hours = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;
  const timeStr = hours > 0
    ? `${hours}h ${mins.toString().padStart(2, "0")}m ${secs.toString().padStart(2, "0")}s`
    : mins > 0
    ? `${mins}m ${secs.toString().padStart(2, "0")}s`
    : `${secs}s`;

  const warning = remaining < 600;
  const caution = remaining < 3600;

  const color = warning ? T.red : caution ? T.amber : T.green;

  return (
    <div style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      gap: 8, padding: "8px 16px", borderRadius: T.rs,
      background: T.surface, border: `1px solid ${color}44`,
      fontFamily: T.mono, fontSize: 11,
      width: "fit-content",
      maxWidth: "100%",
    }}>
      <span style={{ color: T.muted, fontSize: 9, letterSpacing: 1 }}>{label ?? t("card.expiresIn")}</span>
      <span style={{ color, fontWeight: 700, fontSize: 13 }}>{timeStr}</span>
    </div>
  );
}
