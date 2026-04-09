import { useState, useEffect } from "react";
import { useEscrow, type FedimintState } from "../hooks/useEscrow.js";
import { type EscrowState, Role, Outcome, EscrowStatus } from "../escrow-engine/types.js";
import { canVote, getWinner, getSummary } from "../escrow-engine/state-machine.js";

// ══════════════════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ══════════════════════════════════════════════════════════════════════════

const T = {
  bg: "#0a0a0f", surface: "#111118", card: "#16161f",
  border: "#1e1e2e", borderHi: "#2a2a3e",
  text: "#e8e6e0", muted: "#6b6980",
  accent: "#f7931a", accentDim: "#f7931a33",
  green: "#22c55e", greenDim: "#22c55e22",
  red: "#ef4444", redDim: "#ef444422",
  purple: "#a78bfa", purpleDim: "#a78bfa22",
  teal: "#2dd4bf", tealDim: "#2dd4bf22",
  amber: "#fbbf24", amberDim: "#fbbf2422",
  r: 12, rs: 8,
  mono: "'JetBrains Mono','SF Mono','Fira Code',monospace",
  sans: "'DM Sans',-apple-system,sans-serif",
};

const STATUS = {
  CREATED:   { c: T.muted,  bg: T.surface,   l: "Created" },
  FUNDED:    { c: T.teal,   bg: T.tealDim,   l: "Funded" },
  LOCKED:    { c: T.accent, bg: T.accentDim, l: "Locked" },
  APPROVED:  { c: T.green,  bg: T.greenDim,  l: "Approved" },
  CLAIMED:   { c: T.amber,  bg: T.amberDim,  l: "Claimed" },
  COMPLETED: { c: T.green,  bg: T.greenDim,  l: "Complete" },
  EXPIRED:   { c: T.red,    bg: T.redDim,    l: "Expired" },
  CANCELLED: { c: T.muted,  bg: T.surface,   l: "Cancelled" },
} as Record<string, { c: string; bg: string; l: string }>;

const ROLE_COLOR = { buyer: T.accent, seller: T.teal, arbiter: T.purple };
const ROLE_ICON  = { buyer: "B", seller: "S", arbiter: "A" };
const CAT_ICON = { "p2p-trade": "⚡", "bill-pay": "🧾", marketplace: "🏪", lending: "🤝" } as Record<string, string>;

const fmtSats = (ms: number) => Math.floor(ms / 1000).toLocaleString();

// ══════════════════════════════════════════════════════════════════════════
// MICRO COMPONENTS
// ══════════════════════════════════════════════════════════════════════════

function Badge({ status }: { status: string }) {
  const s = STATUS[status] || STATUS.CREATED;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20,
      background: s.bg, color: s.c,
      fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
      textTransform: "uppercase", fontFamily: T.mono,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%", background: s.c,
        boxShadow: `0 0 8px ${s.c}66`,
        animation: status === "LOCKED" ? "pulse 2s ease-in-out infinite" : "none",
      }} />
      {s.l}
    </span>
  );
}

function Dot({ role, pk, isYou, voted, outcome }: {
  role: string; pk: string | null; isYou: boolean; voted: boolean; outcome?: string;
}) {
  const c = ROLE_COLOR[role as keyof typeof ROLE_COLOR] || T.muted;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: pk ? `${c}22` : T.surface,
        border: `1.5px ${pk ? "solid" : "dashed"} ${pk ? c : T.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 13, fontWeight: 700, color: pk ? c : T.muted,
        fontFamily: T.mono, position: "relative",
      }}>
        {ROLE_ICON[role as keyof typeof ROLE_ICON] || "?"}
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
      <span style={{ fontSize: 9, color: isYou ? c : T.muted, fontFamily: T.mono, fontWeight: isYou ? 700 : 400 }}>
        {isYou ? "You" : pk ? pk.slice(0, 6) + "…" : "Empty"}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 14px",
  background: T.surface, border: `1px solid ${T.border}`,
  borderRadius: T.rs, color: T.text,
  fontFamily: T.sans, fontSize: 14, outline: "none", boxSizing: "border-box",
};

// ══════════════════════════════════════════════════════════════════════════
// CONNECT SCREEN
// ══════════════════════════════════════════════════════════════════════════

function ConnectScreen({ onConnect, loading, error }: {
  onConnect: () => void; loading: boolean; error: string | null;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100vh", padding: 32,
      textAlign: "center", gap: 24,
    }}>
      <div style={{ fontSize: 48, lineHeight: 1 }}>₿</div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, fontFamily: T.mono, letterSpacing: -1, marginBottom: 8 }}>
          Chama
        </div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, letterSpacing: 2, textTransform: "uppercase" }}>
          Nostr · Fedimint · SSS Escrow
        </div>
      </div>

      <div style={{
        maxWidth: 320, fontSize: 13, color: T.muted, lineHeight: 1.7,
        fontFamily: T.sans,
      }}>
        Non-custodial P2P trading powered by Nostr relays, Fedimint ecash, and 2-of-3 Shamir Secret Sharing. No server. No custodian.
      </div>

      {error && (
        <div style={{
          padding: "10px 16px", borderRadius: T.rs,
          background: T.redDim, border: `1px solid ${T.red}33`,
          color: T.red, fontSize: 12, fontFamily: T.mono,
          maxWidth: 360, wordBreak: "break-word",
        }}>
          {error}
        </div>
      )}

      <button
        onClick={onConnect}
        disabled={loading}
        style={{
          padding: "16px 48px", borderRadius: T.r,
          background: loading ? T.surface : T.accent,
          border: "none", color: loading ? T.muted : T.bg,
          fontFamily: T.mono, fontSize: 14, fontWeight: 700,
          cursor: loading ? "default" : "pointer",
          letterSpacing: 0.5, transition: "all 0.2s",
          minWidth: 220,
        }}
      >
        {loading ? "Connecting…" : "⚡ Connect with Nostr"}
      </button>

      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.8 }}>
        Requires a NIP-07 signer (nos2x, Alby, Amber)<br />
        or Fedi Mini-App runtime
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// WALLET BAR
// ══════════════════════════════════════════════════════════════════════════

function WalletBar({ pubkey, connectedRelays, relayStatuses }: {
  pubkey: string; connectedRelays: number; relayStatuses: Map<string, string>;
}) {
  const [showRelays, setShowRelays] = useState(false);
  return (
    <>
      <div
        onClick={() => setShowRelays(!showRelays)}
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
            {connectedRelays} relay{connectedRelays !== 1 ? "s" : ""}
          </span>
          <span style={{ color: T.border }}>·</span>
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

// ══════════════════════════════════════════════════════════════════════════
// TRADE CARD
// ══════════════════════════════════════════════════════════════════════════

function TradeCard({ state, pubkey, onSelect }: {
  state: EscrowState; pubkey: string; onSelect: () => void;
}) {
  const myRole = state.participants.buyer === pubkey ? "buyer"
    : state.participants.seller === pubkey ? "seller"
    : state.participants.arbiter === pubkey ? "arbiter" : null;

  return (
    <div onClick={onSelect} style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, cursor: "pointer",
      transition: "border-color 0.2s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 14, opacity: 0.6 }}>{CAT_ICON[state.category] || "📦"}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans, lineHeight: 1.3 }}>
              {state.description}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.accent, fontFamily: T.mono }}>
              {fmtSats(state.amountMsats)} sats
            </span>
            {state.fiatAmount && (
              <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
                {state.fiatCurrency} {state.fiatAmount.toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <Badge status={state.status} />
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 12, justifyContent: "center" }}>
        {([Role.BUYER, Role.SELLER, Role.ARBITER] as Role[]).map(role => (
          <Dot
            key={role}
            role={role}
            pk={state.participants[role]}
            isYou={myRole === role}
            voted={!!state.votes[role]}
            outcome={state.votes[role]}
          />
        ))}
      </div>

      {/* Escrow ID — tap to copy */}
      <div
       onClick={() => {
  	const id = state.id;
  	if (navigator.clipboard?.writeText) {
    	  navigator.clipboard.writeText(id).catch(() => {});
  	}
  	// Fallback: select from a temporary input
  	const el = document.createElement("input");
  	el.value = id;
  	document.body.appendChild(el);
  	el.select();
  	document.execCommand("copy");
  	document.body.removeChild(el);
  	// Brief visual feedback instead of alert
        const t = document.querySelector('[title="Tap to copy escrow ID"]');
        if (t) { (t as any).style.color = "#22c55e"; setTimeout(() => { (t as any).style.color = ""; }, 800); }
       }}
        title="Tap to copy escrow ID"
      >
        {state.id} — tap to copy
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TRADE DETAIL
// ══════════════════════════════════════════════════════════════════════════

function TradeDetail({ state, pubkey, onBack, onVote, onClaim, onJoin, onLock }: {
  state: EscrowState; pubkey: string;
  onBack: () => void;
  onVote: (outcome: Outcome) => void;
  onClaim: () => void;
  onJoin: (role: Role) => void;
  onLock: () => Promise<void>;
}) {
  const [voting, setVoting] = useState(false);
  const [joining, setJoining] = useState(false);
  const [locking, setLocking] = useState(false);
  const s = STATUS[state.status] || STATUS.CREATED;
  const myRole = state.participants.buyer === pubkey ? Role.BUYER
    : state.participants.seller === pubkey ? Role.SELLER
    : state.participants.arbiter === pubkey ? Role.ARBITER : null;
  const voteCheck = myRole ? canVote(state, pubkey) : { canVote: false };
  const winner = getWinner(state);
  const iAmWinner = winner?.pubkey === pubkey;

  const handleVote = async (outcome: Outcome) => {
    setVoting(true);
    try { onVote(outcome); } finally { setTimeout(() => setVoting(false), 1000); }
  };

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <button onClick={onBack} style={{
        background: "none", border: "none", color: T.muted,
        fontFamily: T.mono, fontSize: 12, cursor: "pointer",
        padding: "4px 0", marginBottom: 16,
      }}>
        ← Back
      </button>

      {/* Header card */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${s.c},${s.c}00)` }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <Badge status={state.status} />
          <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>{state.id}</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, color: T.text, fontFamily: T.sans, marginBottom: 12, lineHeight: 1.4 }}>
          {state.description}
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 2 }}>AMOUNT</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.accent, fontFamily: T.mono }}>
              {fmtSats(state.amountMsats)} <span style={{ fontSize: 11, color: T.muted }}>sats</span>
            </div>
          </div>
          {state.fiatAmount && (
            <div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 2 }}>FIAT</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.mono }}>
                {state.fiatCurrency} {state.fiatAmount!.toLocaleString()}
              </div>
            </div>
          )}
          {myRole && (
            <div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 2 }}>YOUR ROLE</div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: T.mono, color: ROLE_COLOR[myRole], textTransform: "capitalize" }}>
                {myRole}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Participants */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>PARTICIPANTS</div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          {([Role.BUYER, Role.SELLER, Role.ARBITER] as Role[]).map(role => (
            <Dot key={role} role={role} pk={state.participants[role]} isYou={myRole === role}
              voted={!!state.votes[role]} outcome={state.votes[role]} />
          ))}
        </div>
      </div>

      {/* JOIN buttons — show when user is not a participant and slots are open */}
      {!myRole && state.status === EscrowStatus.CREATED && (
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
            JOIN THIS TRADE
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {!state.participants.buyer && (
              <button disabled={joining} onClick={async () => {
                setJoining(true);
                try { await onJoin(Role.BUYER); } finally { setJoining(false); }
              }} style={{
                flex: 1, padding: "14px", borderRadius: T.rs,
                background: T.accentDim, border: `1px solid ${T.accent}44`,
                color: T.accent, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                cursor: joining ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {joining ? "Joining..." : "Join as Buyer"}
              </button>
            )}
            {!state.participants.arbiter && (
              <button disabled={joining} onClick={async () => {
                setJoining(true);
                try { await onJoin(Role.ARBITER); } finally { setJoining(false); }
              }} style={{
                flex: 1, padding: "14px", borderRadius: T.rs,
                background: T.purpleDim, border: `1px solid ${T.purple}44`,
                color: T.purple, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                cursor: joining ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {joining ? "Joining..." : "Join as Arbiter"}
              </button>
            )}
          </div>
          {!state.participants.seller && (
            <button disabled={joining} onClick={async () => {
              setJoining(true);
              try { await onJoin(Role.SELLER); } finally { setJoining(false); }
            }} style={{
              width: "100%", marginTop: 10, padding: "14px", borderRadius: T.rs,
              background: T.tealDim, border: `1px solid ${T.teal}44`,
              color: T.teal, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
              cursor: joining ? "default" : "pointer", transition: "all 0.2s",
            }}>
              {joining ? "Joining..." : "Join as Seller"}
            </button>
          )}
        </div>
      )}

      {/* FUNDED — lock ecash */}
      {state.status === EscrowStatus.FUNDED && myRole && (
        <div style={{
          background: T.card, border: `1px solid ${T.teal}44`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
        }}>
          <div style={{
            textAlign: "center", fontFamily: T.mono, fontSize: 12,
            color: T.teal, marginBottom: 14,
          }}>
            All 3 participants joined! Ready to lock ecash.
          </div>
          <button
            disabled={locking}
            onClick={async () => {
              setLocking(true);
              try { await onLock(); } finally { setLocking(false); }
            }}
            style={{
              width: "100%", padding: "16px", borderRadius: T.rs,
              background: locking ? T.surface : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
              border: "none", color: locking ? T.muted : T.bg,
              fontFamily: T.mono, fontSize: 14, fontWeight: 800,
              cursor: locking ? "default" : "pointer",
              letterSpacing: 0.5, transition: "all 0.2s",
            }}
          >
            {locking ? "Locking..." : "\u26a1 Lock " + fmtSats(state.amountMsats) + " sats"}
          </button>
          <div style={{
            textAlign: "center", marginTop: 8,
            fontSize: 9, color: T.muted, fontFamily: T.mono,
          }}>
            Real 2-of-3 Shamir split · ecash spent from your Fedimint wallet
          </div>
        </div>
      )}

      {/* Vote tally */}
      {(state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED ||
        state.status === EscrowStatus.CLAIMED || state.status === EscrowStatus.COMPLETED) && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>VOTES</div>
          <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: T.green, fontFamily: T.mono, lineHeight: 1 }}>
                {Object.values(state.votes).filter(v => v === Outcome.RELEASE).length}
              </div>
              <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginTop: 4 }}>RELEASE</div>
            </div>
            <div style={{ width: 1, background: T.border }} />
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: T.amber, fontFamily: T.mono, lineHeight: 1 }}>
                {Object.values(state.votes).filter(v => v === Outcome.REFUND).length}
              </div>
              <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginTop: 4 }}>REFUND</div>
            </div>
            {state.resolvedOutcome && (
              <>
                <div style={{ width: 1, background: T.border }} />
                <div style={{ textAlign: "center", flex: 1.2 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, fontFamily: T.mono, color: state.resolvedOutcome === Outcome.RELEASE ? T.green : T.amber }}>
                    {state.resolvedOutcome.toUpperCase()} ✓
                  </div>
                  <div style={{ fontSize: 9, color: T.muted, marginTop: 4, fontFamily: T.mono }}>RESOLVED</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Vote buttons */}
      {voteCheck.canVote && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <button disabled={voting} onClick={() => handleVote(Outcome.RELEASE)} style={{
            flex: 1, padding: "16px", borderRadius: T.rs,
            background: voting ? T.surface : T.greenDim,
            border: `1px solid ${T.green}44`, color: T.green,
            fontFamily: T.mono, fontSize: 14, fontWeight: 700,
            cursor: voting ? "default" : "pointer", transition: "all 0.2s",
          }}>
            ✓ Release
          </button>
          <button disabled={voting} onClick={() => handleVote(Outcome.REFUND)} style={{
            flex: 1, padding: "16px", borderRadius: T.rs,
            background: voting ? T.surface : T.amberDim,
            border: `1px solid ${T.amber}44`, color: T.amber,
            fontFamily: T.mono, fontSize: 14, fontWeight: 700,
            cursor: voting ? "default" : "pointer", transition: "all 0.2s",
          }}>
            ↩ Refund
          </button>
        </div>
      )}

      {/* Claim button */}
      {state.status === EscrowStatus.APPROVED && iAmWinner && (
        <button onClick={onClaim} style={{
          width: "100%", padding: "18px", borderRadius: T.rs,
          background: `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
          border: "none", color: T.bg,
          fontFamily: T.mono, fontSize: 15, fontWeight: 800,
          cursor: "pointer", letterSpacing: 1,
          marginBottom: 16,
          animation: "pulse 2s ease-in-out infinite",
        }}>
          ⚡ CLAIM YOUR SATS
        </button>
      )}

      {/* Event chain */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>
          NOSTR EVENT CHAIN
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          {state.eventChain.length} events · {state.chatMessages.length} chat messages
        </div>
        {state.eventChain.map((evt, i) => (
          <div key={evt.raw.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.green }} />
            <span style={{ fontSize: 11, fontFamily: T.mono, color: T.muted }}>
              kind:{evt.kind} — {evt.payload.type.replace("escrow:", "")}
            </span>
            <span style={{ fontSize: 9, fontFamily: T.mono, color: T.border, marginLeft: "auto" }}>
              {evt.raw.id.slice(0, 8)}…
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// CREATE FORM
// ══════════════════════════════════════════════════════════════════════════

function CreateForm({ onCreate, onClose }: {
  onCreate: (params: any) => void; onClose: () => void;
}) {
  const [cat, setCat] = useState("p2p-trade");
  const [desc, setDesc] = useState("");
  const [sats, setSats] = useState("");
  const [fiat, setFiat] = useState("");
  const [cur, setCur] = useState("USD");
  const [mint, setMint] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const cats = [
    { id: "p2p-trade", l: "P2P Trade", i: "⚡" },
    { id: "bill-pay", l: "Bill Pay", i: "🧾" },
    { id: "marketplace", l: "Marketplace", i: "🏪" },
    { id: "lending", l: "Lending", i: "🤝" },
  ];

  const handleSubmit = async () => {
    if (!desc || !sats || !mint) return;
    setSubmitting(true);
    try {
      await onCreate({
        description: desc,
        amountMsats: parseInt(sats) * 1000,
        fiatAmount: fiat ? parseFloat(fiat) : undefined,
        fiatCurrency: fiat ? cur : undefined,
        category: cat,
        mintUrl: mint,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>New trade</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.muted, fontSize: 20, cursor: "pointer" }}>×</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {cats.map(c => (
          <button key={c.id} onClick={() => setCat(c.id)} style={{
            padding: "8px 14px", borderRadius: 20,
            background: cat === c.id ? T.accentDim : T.surface,
            border: `1px solid ${cat === c.id ? T.accent + "66" : T.border}`,
            color: cat === c.id ? T.accent : T.muted,
            fontFamily: T.mono, fontSize: 12, fontWeight: 600,
            cursor: "pointer", transition: "all 0.2s",
          }}>
            {c.i} {c.l}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>DESCRIPTION</div>
        <input value={desc} onChange={e => setDesc(e.target.value)}
          placeholder={cat === "bill-pay" ? "Pay my electricity bill" : "What are you trading?"}
          style={inputStyle} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>AMOUNT (SATS)</div>
          <input type="number" value={sats} onChange={e => setSats(e.target.value)} placeholder="100000" style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FIAT</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={cur} onChange={e => setCur(e.target.value)}
              style={{ ...inputStyle, width: 70, padding: "12px 6px", fontSize: 12, color: T.text, background: T.surface }}>
              {["USD","EUR","GBP","NGN","KES","TZS","XOF","BRL"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" value={fiat} onChange={e => setFiat(e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FEDERATION INVITE CODE</div>
        <input value={mint} onChange={e => setMint(e.target.value)} placeholder="fed11qgq..." style={inputStyle} />
      </div>

      <button onClick={handleSubmit} disabled={!desc || !sats || !mint || submitting} style={{
        width: "100%", padding: "16px",
        background: desc && sats && mint && !submitting ? T.accent : T.surface,
        border: "none", borderRadius: T.rs,
        color: desc && sats && mint && !submitting ? T.bg : T.muted,
        fontFamily: T.mono, fontSize: 14, fontWeight: 700,
        cursor: desc && sats && mint && !submitting ? "pointer" : "default",
        letterSpacing: 0.5, transition: "all 0.2s",
      }}>
        {submitting ? "Publishing…" : "₿ PUBLISH TO RELAYS"}
      </button>
      <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: T.muted, fontFamily: T.mono }}>
        kind:38100 CREATE · NIP-44 encrypted · multi-relay
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LOAD TRADE INPUT
// ══════════════════════════════════════════════════════════════════════════

function LoadTradeInput({ onLoad }: { onLoad: (id: string) => void }) {
  const [id, setId] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLoad = async () => {
    if (!id.trim()) return;
    setLoading(true);
    try { await onLoad(id.trim()); } finally { setLoading(false); setId(""); }
  };

  return (
    <div style={{
      display: "flex", gap: 8, marginBottom: 16,
      padding: 12, background: T.surface,
      borderRadius: T.r, border: `1px solid ${T.border}`,
    }}>
      <input
        value={id}
        onChange={e => setId(e.target.value)}
        onKeyDown={e => e.key === "Enter" && handleLoad()}
        placeholder="Paste escrow ID to join a trade..."
        style={{
          flex: 1, padding: "8px 12px",
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: T.rs, color: T.text,
          fontFamily: T.mono, fontSize: 11, outline: "none",
        }}
      />
      <button
        onClick={handleLoad}
        disabled={!id.trim() || loading}
        style={{
          padding: "8px 16px", borderRadius: T.rs,
          background: id.trim() && !loading ? T.tealDim : T.card,
          border: `1px solid ${id.trim() && !loading ? T.teal + "44" : T.border}`,
          color: id.trim() && !loading ? T.teal : T.muted,
          fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: id.trim() && !loading ? "pointer" : "default",
          transition: "all 0.2s", whiteSpace: "nowrap",
        }}
      >
        {loading ? "Loading..." : "Load"}
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════════════════

function Toast({ message, type, onDone }: { message: string; type: "success" | "error" | "info"; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  const colors = { success: T.green, error: T.red, info: T.accent };
  const bgs = { success: T.greenDim, error: T.redDim, info: T.accentDim };
  return (
    <div style={{
      position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
      padding: "10px 20px", borderRadius: T.rs,
      background: bgs[type], border: `1px solid ${colors[type]}44`,
      color: colors[type], fontFamily: T.mono, fontSize: 12, fontWeight: 600,
      zIndex: 9999, animation: "fadeIn 0.3s ease",
      maxWidth: "90vw", textAlign: "center", wordBreak: "break-word",
    }}>
      {type === "success" ? "\u2713 " : type === "error" ? "\u2717 " : "\u26a1 "}{message}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// FEDIMINT BAR — compact balance + fund button
// ══════════════════════════════════════════════════════════════════════════

function FedimintBar({ fedimint, onFund, onInit }: {
  fedimint: FedimintState; onFund: () => void; onInit: () => void;
}) {
  const sats = Math.floor(fedimint.balanceMsats / 1000);
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 16px", background: T.surface,
      borderBottom: `1px solid ${T.border}`, fontFamily: T.mono,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: fedimint.joined ? T.green : fedimint.busy ? T.amber : T.muted,
          boxShadow: fedimint.joined ? `0 0 8px ${T.green}66` : "none",
          animation: fedimint.busy ? "pulse 1.2s infinite" : "none",
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 10, color: T.muted,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {fedimint.joined ? fedimint.federationName : fedimint.busy ? "Joining…" : "No federation"}
        </span>
        {fedimint.joined && (
          <>
            <span style={{ color: T.border }}>·</span>
            <span style={{ fontSize: 11, color: T.accent, fontWeight: 700 }}>
              {sats.toLocaleString()} sats
            </span>
          </>
        )}
      </div>
      {fedimint.joined ? (
        <button onClick={onFund} style={{
          padding: "4px 12px", borderRadius: 12,
          background: T.accentDim, border: `1px solid ${T.accent}44`,
          color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
          cursor: "pointer",
        }}>
          + Fund
        </button>
      ) : !fedimint.busy && fedimint.initialized && (
        <button onClick={onInit} style={{
          padding: "4px 12px", borderRadius: 12,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
          cursor: "pointer",
        }}>
          Retry
        </button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// FEDERATION JOIN PANEL — onboarding for non-joined users
// ══════════════════════════════════════════════════════════════════════════

function FederationJoinPanel({
  fedimint, showAdvanced, onToggleAdvanced,
  customInviteInput, onCustomInviteChange, onJoinDefault, onJoinCustom,
}: {
  fedimint: FedimintState;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  customInviteInput: string;
  onCustomInviteChange: (v: string) => void;
  onJoinDefault: () => void;
  onJoinCustom: () => void;
}) {
  return (
    <div style={{
      margin: 16, padding: 20,
      background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 10 }}>
        FEDIMINT WALLET
      </div>
      <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 14 }}>
        Chama locks ecash into 2-of-3 Shamir shares. To trade, join a federation that mints the ecash.
      </div>
      <div style={{
        padding: 12, marginBottom: 12, borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.text, fontFamily: T.sans, marginBottom: 4 }}>
          Bitcoin Life Federation
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 10 }}>
          Default for new users. Already using Fedi? Your balance stays in Fedi — Chama just needs a federation to mint into for the lock.
        </div>
        <button
          disabled={fedimint.busy}
          onClick={onJoinDefault}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: fedimint.busy ? T.surface : T.accent,
            border: `1px solid ${T.accent}`,
            color: fedimint.busy ? T.muted : "#000",
            fontFamily: T.mono, fontSize: 12, fontWeight: 800,
            cursor: fedimint.busy ? "not-allowed" : "pointer",
          }}
        >
          {fedimint.busy ? "Loading WASM…" : "Join Bitcoin Life Federation"}
        </button>
      </div>

      <button
        onClick={onToggleAdvanced}
        style={{
          background: "none", border: "none", color: T.muted,
          fontFamily: T.mono, fontSize: 10, cursor: "pointer", padding: 0,
        }}
      >
        {showAdvanced ? "▲" : "▼"} Advanced — use a custom federation
      </button>

      {showAdvanced && (
        <div style={{ marginTop: 12 }}>
          <input
            type="text"
            placeholder="fed1…"
            value={customInviteInput}
            onChange={(e) => onCustomInviteChange(e.target.value)}
            style={{ ...inputStyle, marginBottom: 8 }}
          />
          <button
            disabled={fedimint.busy || !customInviteInput.trim()}
            onClick={onJoinCustom}
            style={{
              width: "100%", padding: "8px 16px", borderRadius: T.rs,
              background: T.surface, border: `1px solid ${T.border}`,
              color: customInviteInput.trim() ? T.text : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              cursor: fedimint.busy || !customInviteInput.trim() ? "not-allowed" : "pointer",
            }}
          >
            Join custom federation
          </button>
        </div>
      )}

      {fedimint.error && (
        <div style={{
          marginTop: 12, padding: 10, borderRadius: T.rs,
          background: T.redDim, border: `1px solid ${T.red}44`,
          color: T.red, fontFamily: T.mono, fontSize: 10,
        }}>
          {fedimint.error}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// FUND WALLET MODAL — Lightning invoice to top up
// ══════════════════════════════════════════════════════════════════════════

function FundWalletModal({ onClose, onCreateInvoice }: {
  onClose: () => void;
  onCreateInvoice: (amountSats: number, description: string) => Promise<string>;
}) {
  const [amountSats, setAmountSats] = useState("10000");
  const [description, setDescription] = useState("Chama top-up");
  const [invoice, setInvoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleGenerate = async () => {
    const n = parseInt(amountSats, 10);
    if (!n || n <= 0) { setErr("Enter a valid sats amount"); return; }
    setBusy(true); setErr(null);
    try {
      const bolt11 = await onCreateInvoice(n, description || "Chama top-up");
      setInvoice(bolt11);
    } catch (e: any) {
      setErr(e.message || "Failed to create invoice");
    } finally {
      setBusy(false);
    }
  };

  const copyInvoice = () => {
    if (!invoice) return;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(invoice).catch(() => {});
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "#000a", zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
          padding: 24, maxWidth: 420, width: "100%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
            Fund wallet
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        {!invoice ? (
          <>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>
              AMOUNT (SATS)
            </div>
            <input
              type="number"
              value={amountSats}
              onChange={(e) => setAmountSats(e.target.value)}
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>
              DESCRIPTION
            </div>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ ...inputStyle, marginBottom: 16 }}
            />
            <button
              disabled={busy}
              onClick={handleGenerate}
              style={{
                width: "100%", padding: "12px 16px", borderRadius: T.rs,
                background: busy ? T.surface : T.accent, border: `1px solid ${T.accent}`,
                color: busy ? T.muted : "#000",
                fontFamily: T.mono, fontSize: 12, fontWeight: 800,
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "Generating…" : "Generate Lightning invoice"}
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 8, letterSpacing: 1 }}>
              PAY THIS INVOICE FROM ANY LIGHTNING WALLET
            </div>
            <div style={{
              padding: 12, marginBottom: 12, borderRadius: T.rs,
              background: T.surface, border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 9, color: T.text,
              wordBreak: "break-all", maxHeight: 140, overflowY: "auto",
            }}>
              {invoice}
            </div>
            <button
              onClick={copyInvoice}
              style={{
                width: "100%", padding: "10px 16px", borderRadius: T.rs,
                background: T.accentDim, border: `1px solid ${T.accent}44`,
                color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: "pointer", marginBottom: 8,
              }}
            >
              Copy invoice
            </button>
            <button
              onClick={onClose}
              style={{
                width: "100%", padding: "10px 16px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Done
            </button>
          </>
        )}

        {err && (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 10,
          }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════

export default function App() {
  const [{ connected, pubkey, escrows, relayStatuses, connectedRelays, error, loading, fedimint }, actions] = useEscrow({
    relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"],
    defaultPlatformFeeBps: 50,
  });

  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [showFundModal, setShowFundModal] = useState(false);
  const [showAdvancedFederation, setShowAdvancedFederation] = useState(false);
  const [customInviteInput, setCustomInviteInput] = useState("");

  const escrowList = [...escrows.values()].sort((a, b) => b.createdAt - a.createdAt);
  const selected = selectedId ? escrows.get(selectedId) : null;

  const handleCreate = async (params: any) => {
    try {
      setToast({ message: "Signing event with NIP-07...", type: "info" });
      const { escrowId, state } = await actions.createEscrow(params);
      setToast({ message: `Trade published! ${escrowId}`, type: "success" });
      setView("detail");
      setSelectedId(escrowId);
    } catch (e: any) {
      console.error("[chama] Create failed:", e);
      setToast({ message: e.message || "Failed to create trade", type: "error" });
      throw e;
    }
  };

  // ── Not connected → show connect screen ──
  if (!connected) {
    return (
      <div style={{ background: T.bg, color: T.text, minHeight: "100vh", fontFamily: T.sans }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800;900&display=swap');
          @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
          @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
          *{box-sizing:border-box;margin:0;padding:0}
          input::placeholder{color:${T.muted}88}
          input:focus,select:focus{border-color:${T.accent}66!important}
        `}</style>
        <ConnectScreen onConnect={actions.connect} loading={loading} error={error} />
      </div>
    );
  }

  // ── Connected → main app ──
  return (
    <div style={{ background: T.bg, color: T.text, minHeight: "100vh", fontFamily: T.sans, maxWidth: 520, margin: "0 auto" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800;900&display=swap');
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        *{box-sizing:border-box;margin:0;padding:0}
        input::placeholder{color:${T.muted}88}
        input:focus,select:focus{border-color:${T.accent}66!important}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${T.border};border-radius:4px}
      `}</style>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}

      {/* Header */}
      <div style={{
        padding: "16px 16px 12px", borderBottom: `1px solid ${T.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>₿</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: T.mono, letterSpacing: -0.5 }}>Chama</div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1.5, textTransform: "uppercase" }}>
              Nostr · Fedimint · SSS
            </div>
          </div>
        </div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, padding: "4px 10px", borderRadius: 6, background: T.surface, border: `1px solid ${T.border}` }}>
          v0.1.9
        </div>
      </div>

      {/* Wallet bar */}
      <WalletBar pubkey={pubkey!} connectedRelays={connectedRelays} relayStatuses={relayStatuses} />

      {/* Fedimint wallet bar */}
      <FedimintBar
        fedimint={fedimint}
        onFund={() => setShowFundModal(true)}
        onInit={() => actions.initFedimint().catch(
          (e: any) => setToast({ message: e.message || "Federation join failed", type: "error" })
        )}
      />

      {/* Federation onboarding panel (only if not joined) */}
      {!fedimint.joined && (
        <FederationJoinPanel
          fedimint={fedimint}
          showAdvanced={showAdvancedFederation}
          onToggleAdvanced={() => setShowAdvancedFederation(!showAdvancedFederation)}
          customInviteInput={customInviteInput}
          onCustomInviteChange={setCustomInviteInput}
          onJoinDefault={async () => {
            try {
              setToast({ message: "Joining Bitcoin Life Federation (WASM warming up)...", type: "info" });
              await actions.initFedimint();
              setToast({ message: "Joined! You can now fund and trade.", type: "success" });
            } catch (e: any) {
              setToast({ message: e.message || "Join failed", type: "error" });
            }
          }}
          onJoinCustom={async () => {
            const invite = customInviteInput.trim();
            if (!invite.startsWith("fed1")) {
              setToast({ message: "Invite must start with fed1...", type: "error" });
              return;
            }
            try {
              actions.setCustomInvite(invite);
              setToast({ message: "Joining custom federation...", type: "info" });
              await actions.initFedimint(invite);
              setToast({ message: "Joined custom federation!", type: "success" });
            } catch (e: any) {
              setToast({ message: e.message || "Join failed", type: "error" });
            }
          }}
        />
      )}

      {/* Fund wallet modal */}
      {showFundModal && (
        <FundWalletModal
          onClose={() => setShowFundModal(false)}
          onCreateInvoice={(amountSats, desc) =>
            actions.createFundingInvoice(amountSats * 1000, desc)
          }
        />
      )}

      {/* Content */}
      {view === "detail" && selected ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <TradeDetail
            state={selected}
            pubkey={pubkey!}
            onBack={() => { setView("list"); setSelectedId(null); }}
            onVote={(outcome) => actions.vote(selectedId!, outcome).then(
              () => setToast({ message: `Voted ${outcome}!`, type: "success" }),
              (e: any) => setToast({ message: e.message, type: "error" })
            )}
            onClaim={() => actions.claimAndRedeem(selectedId!).then(
              () => setToast({ message: "Claimed! Ecash redeemed to your wallet.", type: "success" }),
              (e: any) => setToast({ message: e.message, type: "error" })
            )}
            onJoin={async (role) => {
              try {
                setToast({ message: `Joining as ${role}...`, type: "info" });
                await actions.joinEscrow(selectedId!, role);
                setToast({ message: `Joined as ${role}!`, type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || "Failed to join", type: "error" });
              }
            }}
            onLock={async () => {
              if (!fedimint.joined) {
                setToast({ message: "Join a federation first (scroll up).", type: "error" });
                return;
              }
              try {
                setToast({ message: "Spending ecash & splitting shares...", type: "info" });
                await actions.lockAndPublish(selectedId!);
                setToast({ message: "Locked! Vote buttons are live.", type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || "Lock failed", type: "error" });
              }
            }}
          />
        </div>
      ) : view === "create" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <CreateForm
            onCreate={handleCreate}
            onClose={() => setView("list")}
          />
        </div>
      ) : (
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <span style={{ fontSize: 14, fontWeight: 600, fontFamily: T.sans }}>
              My trades <span style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>{escrowList.length}</span>
            </span>
            <button onClick={() => setView("create")} style={{
              padding: "8px 16px", borderRadius: 20,
              background: T.accentDim, border: `1px solid ${T.accent}44`,
              color: T.accent, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}>
              + New trade
            </button>
          </div>

          {/* Load trade by ID */}
          <LoadTradeInput onLoad={async (id) => {
            try {
              setToast({ message: "Loading from relays...", type: "info" });
              const state = await actions.loadEscrow(id);
              if (state) {
                setToast({ message: "Trade loaded!", type: "success" });
                setSelectedId(id);
                setView("detail");
              } else {
                setToast({ message: "Trade not found on relays", type: "error" });
              }
            } catch (e: any) {
              setToast({ message: e.message || "Failed to load", type: "error" });
            }
          }} />

          {escrowList.length === 0 ? (
            <div style={{
              textAlign: "center", padding: "48px 16px",
              color: T.muted, fontFamily: T.mono, fontSize: 12,
            }}>
              No trades yet. Create one or load by escrow ID.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {escrowList.map((s, i) => (
                <div key={s.id} style={{ animation: `fadeIn 0.4s ease ${i * 0.08}s both` }}>
                  <TradeCard state={s} pubkey={pubkey!} onSelect={() => { setSelectedId(s.id); setView("detail"); }} />
                </div>
              ))}
            </div>
          )}

          <div style={{
            marginTop: 24, padding: 16, background: T.surface,
            borderRadius: T.r, border: `1px solid ${T.border}`, textAlign: "center",
          }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.8 }}>
              Events: kinds 38100–38108 · 2-of-3 SSS<br />
              NIP-44 encrypted · state from relay replay<br />
              Non-custodial · no server in the path
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
