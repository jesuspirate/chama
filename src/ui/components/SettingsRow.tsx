import type { ButtonHTMLAttributes } from "react";
import { T } from "../theme.js";

export function SettingsRow({ label, hint, onClick, danger, ...buttonProps }: {
  label: string; hint: string | null; onClick: () => void; danger?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick">) {
  return (
    <button
      {...buttonProps}
      type="button"
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "14px 16px",
        background: "none", border: "none", borderBottom: `1px solid ${T.border}`,
        color: danger ? T.red : T.text,
        cursor: "pointer", textAlign: "left" as const,
        fontFamily: T.sans,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <span style={{ color: T.muted, fontSize: 16 }}>›</span>
    </button>
  );
}
