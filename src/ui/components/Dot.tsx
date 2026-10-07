import { RoleAvatar } from "./RoleAvatar.js";
import { T, ROLE_COLOR } from "../theme.js";

export function Dot({ role, pk, isYou, voted, outcome, autoAssigned, displayName, onClick }: {
  role: string; pk: string | null; isYou: boolean; voted: boolean; outcome?: string;
  /** v3.1.1: when provided (and the slot is filled), the circle becomes a
   *  button that reveals this participant's reputation. */
  onClick?: () => void;
  /** v0.6.5: when true, `pk` is a pool-derived preview (same arbiter
   *  LOCK will pick) rather than a confirmed JOIN. Renders solid so the
   *  Trinity Ring reads as "two of three filled" instead of stranding
   *  the slot empty for trades whose communities have a recruited
   *  arbiter pool, but uses an "auto" label so it remains
   *  visually distinguishable from a JOINed participant. The shared role
   *  ring stays full strength; the Auto label identifies the preview. */
  autoAssigned?: boolean;
  displayName?: string | null;
}) {
  const c = ROLE_COLOR[role as keyof typeof ROLE_COLOR] || T.muted;
  const filled = !!pk;
  const label = isYou
    ? (displayName ? `You · ${displayName}` : "You")
    : pk
      ? displayName
        ? (autoAssigned ? `Auto · ${displayName}` : displayName)
        : (autoAssigned ? "Auto · " + pk.slice(0, 4) + "…" : pk.slice(0, 6) + "…")
      : "Empty";
  const clickable = !!onClick && filled;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <div
        onClick={clickable ? onClick : undefined}
        role={clickable ? "button" : undefined}
        aria-label={clickable ? "See reputation" : undefined}
        title={clickable ? "See reputation" : undefined}
        style={{
        width: 36, height: 36, borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 13, fontWeight: 700,
        color: filled ? c : T.muted,
        fontFamily: T.mono, position: "relative",
        cursor: clickable ? "pointer" : "default",
      }}>
        <RoleAvatar role={role} pubkey={pk} size={36} />
        {voted && (
          <div style={{
            position: "absolute", bottom: -2, right: -2,
            width: 14, height: 14, borderRadius: "50%",
            background: outcome === "release" ? T.green : T.amber,
            border: `2px solid ${T.card}`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8,
          }}>
            {outcome === "release" ? "✓" : "↩"}
          </div>
        )}
      </div>
      <span style={{
        fontSize: T.fs.secondary,
        color: isYou ? c : T.muted,
        fontFamily: T.sans,
        fontWeight: isYou ? 700 : 400,
        fontStyle: autoAssigned ? "italic" : "normal",
        maxWidth: 104,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {label}
      </span>
    </div>
  );
}
