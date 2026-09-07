import { useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { profileNameFor } from "../nostr-profiles.js";

// Identity bar — shows the user's npub + relay status. Function name kept
// for back-compat; the "Wallet" framing is dead per PHILOSOPHY.md §2.1.
// Sign out lives in Me → Settings (single source of truth, v0.1.85).
export function WalletBar({ pubkey, connectedRelays, relayStatuses }: {
  pubkey: string;
  connectedRelays: number;
  relayStatuses: Map<string, string>;
}) {
  const { t } = useT();
  const [showRelays, setShowRelays] = useState(false);
  const networkLabel = connectedRelays > 0 ? t("fund.online") : t("fund.offline");
  return (
    <>
      <div
        onClick={() => setShowRelays(!showRelays)}
        title={t(
          connectedRelays !== 1 ? "fund.networkConnectionsMany" : "fund.networkConnectionsOne",
          { count: connectedRelays },
        )}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", background: T.surface,
          borderBottom: `1px solid ${T.border}`,
          fontFamily: T.mono, cursor: "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: connectedRelays > 0 ? T.green : T.red,
            boxShadow: `0 0 8px ${connectedRelays > 0 ? T.green : T.red}66`,
          }} />
          <span style={{ fontSize: 10, color: T.muted }}>
            {networkLabel}
          </span>
          <span style={{ color: T.border }}>·</span>
          {/* v6.3.2: the trade name lives HERE, next to the hex, once — the
              one strip every main surface shares. Canvas/Create stay clean. */}
          <span style={{ fontSize: 10, color: T.text, fontWeight: 700 }}>
            {profileNameFor(undefined, pubkey, false)}
          </span>
          <span style={{ fontSize: 10, color: T.muted }}>
            {pubkey.slice(0, 8)}…{pubkey.slice(-4)}
          </span>
        </div>
        <span style={{ fontSize: 10, color: T.muted }}>{showRelays ? "▲" : "▼"}</span>
      </div>

      {showRelays && (
        <div style={{
          padding: "8px 16px", background: T.surface,
          borderBottom: `1px solid ${T.border}`,
        }}>
          {[...relayStatuses.entries()].map(([url, status]) => (
            <div key={url} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "4px 0", fontSize: 10, fontFamily: T.mono,
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%",
                background: status === "connected" ? T.green : status === "connecting" ? T.amber : T.red,
              }} />
              <span style={{ color: T.muted }}>{url.replace("wss://", "")}</span>
              <span style={{ color: status === "connected" ? T.green : T.muted, marginLeft: "auto" }}>
                {status}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
