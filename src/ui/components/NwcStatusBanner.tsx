// ══════════════════════════════════════════════════════════════════════════
// Chama — NwcStatusBanner (v1.2.4)
// ══════════════════════════════════════════════════════════════════════════
//
// Compact banner that lives above the Fund / Claim action buttons in
// TradeDetail. Two states:
//
//   • Has a saved NWC connection:
//       "⚡ NWC: <wallet label> • Change"
//     The "Change" link opens the Settings NWC manager (via the
//     `onManage` callback). The active connection is the most-
//     recently-used one, mirroring the implicit pick the Fund / Claim
//     handlers make when going direct.
//
//   • No saved NWC connection:
//       "⚡ One-tap funding with Lightning Wallet Connect"
//     A paste field + Save button lets the user drop in an NWC
//     connection string right from the trade page — no detour through
//     Settings. Once saved, the banner flips to the "Has" state on
//     the next render.
//
// The banner is purely a UX surface. The trade page reads
// `listSavedNwcConnections()` independently to drive the Fund / Claim
// button labels and dispatch paths; this component only owns the
// banner's own state.

import { useState } from "react";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { isNwcConnectionString } from "../../payments/nwc.js";
import {
  addOrTouchSavedNwcConnection,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";

export interface NwcStatusBannerProps {
  /** Most-recently-used saved NWC connection, or null when none. The
   *  parent reads listSavedNwcConnections() and passes the head of
   *  the list (sorted by lastUsedAt desc). */
  activeConnection: SavedNwcConnection | null;
  /** Called after a successful paste-and-save so the parent can
   *  re-fetch its connection list and re-render. */
  onSaved?: () => void;
  /** Called when the user taps "Change" on the active-connection
   *  pill. Parent opens the Settings NWC manager. */
  onManage?: () => void;
}

export function NwcStatusBanner({
  activeConnection,
  onSaved,
  onManage,
}: NwcStatusBannerProps) {
  const { t } = useT();
  const [nwcInput, setNwcInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const ready = isNwcConnectionString(nwcInput);

  const handleSave = () => {
    setError(null);
    try {
      addOrTouchSavedNwcConnection(nwcInput);
      setNwcInput("");
      onSaved?.();
    } catch (e: any) {
      setError(e?.message || t("fund.nwcSaveFailed"));
    }
  };

  // ── Has-connection state ───────────────────────────────────────────────

  if (activeConnection) {
    return (
      <div
        className="nwc-status-banner nwc-status-banner-saved"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "7px 10px",
          marginBottom: 12,
          borderRadius: T.r,
          background: T.accentDim,
          border: `1px solid ${T.accent}66`,
          animation: "slideInDown 0.25s ease",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          minWidth: 0, flex: 1,
        }}>
          <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>⚡</span>
          <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 9, color: T.accent, fontFamily: T.mono, fontWeight: 800 }}>NWC ·</span>
            <span style={{
              fontSize: 12, color: T.text, fontFamily: T.mono,
              fontWeight: 600,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {activeConnection.label}
            </span>
          </div>
        </div>
        {onManage && (
          <button
            onClick={onManage}
            style={{
              background: "none",
              border: `1px solid ${T.accent}55`,
              borderRadius: T.rs,
              padding: "6px 10px",
              color: T.accent,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 700,
              cursor: "pointer",
              flexShrink: 0,
              letterSpacing: 0.5,
            }}
          >
            {t("fund.change")}
          </button>
        )}
      </div>
    );
  }

  // ── No-connection state (paste-to-connect) ─────────────────────────────

  return (
    <div
      className="nwc-status-banner nwc-status-banner-empty"
      style={{
        padding: expanded ? "10px 12px" : 0,
        marginBottom: 12,
        borderRadius: T.r,
        background: T.surface,
        border: `1px dashed ${T.border}`,
        animation: "slideInDown 0.25s ease",
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        style={{
          width: "100%", padding: "8px 10px", background: "none", border: "none",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700, cursor: "pointer",
        }}
      >
        <span>⚡ NWC · {t("fund.nwcOneTapTitle")}</span>
        <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && <>
      <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.4, marginBottom: 8 }}>
        {t("fund.nwcOneTapBody")}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={nwcInput}
          onChange={(e) => { setNwcInput(e.target.value); setError(null); }}
          placeholder="nostr+walletconnect://…"
          style={{
            ...inputStyle,
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            padding: "8px 10px",
          }}
        />
        <button
          onClick={handleSave}
          disabled={!ready}
          style={{
            padding: "8px 14px",
            borderRadius: T.rs,
            background: ready ? T.accent : T.card,
            border: `1px solid ${ready ? T.accent : T.border}`,
            color: ready ? "#000" : T.muted,
            fontFamily: T.mono,
            fontSize: 11,
            fontWeight: 800,
            cursor: ready ? "pointer" : "not-allowed",
            flexShrink: 0,
          }}
        >
          {t("fund.save")}
        </button>
      </div>
      {error && (
        <div style={{
          marginTop: 8, padding: "6px 10px",
          background: T.redDim, border: `1px solid ${T.red}33`,
          borderRadius: T.rs, color: T.red,
          fontSize: 10, fontFamily: T.mono,
        }}>
          {error}
        </div>
      )}
      </>}
    </div>
  );
}
