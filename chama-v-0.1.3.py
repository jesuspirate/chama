#!/usr/bin/env python3
"""
Chama v0.1.3 — Load trade by ID + JOIN flow
  - Add "Load trade" input on main screen
  - Add JOIN buttons in trade detail (buyer/arbiter slots)
  - Wire onJoin to real EscrowClient.joinEscrow()
  - Show escrow ID on trade cards for easy copying
"""
import os

BASE = os.path.expanduser("~/chama")

def patch(path, old, new):
    full = os.path.join(BASE, path)
    content = open(full).read()
    if old not in content:
        print(f"  ⚠️  Pattern not found in {path}")
        print(f"      Looking for: {old[:80]}...")
        return False
    content = content.replace(old, new, 1)
    open(full, 'w').write(content)
    print(f"  ✅ {path}")
    return True

print("\n═══ Chama v0.1.3 — Load trade + JOIN flow ═══\n")

# ── 1. Add onJoin prop to TradeDetail + JOIN buttons ──
print("1. Add JOIN buttons to TradeDetail...")

patch("src/ui/App.tsx",
    """function TradeDetail({ state, pubkey, onBack, onVote, onClaim }: {
  state: EscrowState; pubkey: string;
  onBack: () => void;
  onVote: (outcome: Outcome) => void;
  onClaim: () => void;
}) {
  const [voting, setVoting] = useState(false);""",
    """function TradeDetail({ state, pubkey, onBack, onVote, onClaim, onJoin }: {
  state: EscrowState; pubkey: string;
  onBack: () => void;
  onVote: (outcome: Outcome) => void;
  onClaim: () => void;
  onJoin: (role: Role) => void;
}) {
  const [voting, setVoting] = useState(false);
  const [joining, setJoining] = useState(false);""")

# ── 2. Add JOIN buttons after participants section ──
print("2. Add JOIN buttons after participants...")

patch("src/ui/App.tsx",
    """      {/* Vote tally */}
      {(state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED ||""",
    """      {/* JOIN buttons — show when user is not a participant and slots are open */}
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

      {/* FUNDED — waiting for lock */}
      {state.status === EscrowStatus.FUNDED && myRole && (
        <div style={{
          background: T.tealDim, border: `1px solid ${T.teal}44`,
          borderRadius: T.r, padding: "14px 20px", marginBottom: 16,
          textAlign: "center", fontFamily: T.mono, fontSize: 12, color: T.teal,
        }}>
          All 3 participants joined! Ready to lock ecash.
        </div>
      )}

      {/* Vote tally */}
      {(state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED ||""")

# ── 3. Add escrow ID display + copy on trade cards ──
print("3. Add escrow ID to trade cards...")

patch("src/ui/App.tsx",
    """      <div style={{ display: "flex", gap: 12, marginTop: 12, justifyContent: "center" }}>
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
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TRADE DETAIL""",
    """      <div style={{ display: "flex", gap: 12, marginTop: 12, justifyContent: "center" }}>
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
        onClick={() => { navigator.clipboard?.writeText(state.id); }}
        style={{
          marginTop: 10, textAlign: "center", cursor: "pointer",
          fontSize: 9, color: T.muted, fontFamily: T.mono,
          padding: "4px 8px", borderRadius: 4,
          background: T.surface, transition: "color 0.2s",
        }}
        title="Tap to copy escrow ID"
      >
        {state.id} — tap to copy
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TRADE DETAIL""")

# ── 4. Add "Load trade" input to main screen ──
print("4. Add Load Trade input to main screen...")

patch("src/ui/App.tsx",
    """          {escrowList.length === 0 ? (
            <div style={{
              textAlign: "center", padding: "48px 16px",
              color: T.muted, fontFamily: T.mono, fontSize: 12,
            }}>
              No trades yet. Create one or load by escrow ID.
            </div>""",
    """          {/* Load trade by ID */}
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
            </div>""")

# ── 5. Add LoadTradeInput component ──
print("5. Add LoadTradeInput component...")

patch("src/ui/App.tsx",
    """// ══════════════════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════════════════""",
    """// ══════════════════════════════════════════════════════════════════════════
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
// ══════════════════════════════════════════════════════════════════════════""")

# ── 6. Wire onJoin in the main App ──
print("6. Wire onJoin handler in main App...")

patch("src/ui/App.tsx",
    """            onClaim={() => selected.lock.notesHash && actions.claim(selectedId!, selected.lock.notesHash).then(
              () => setToast({ message: "Claimed! Ecash redeemed.", type: "success" }),
              (e: any) => setToast({ message: e.message, type: "error" })
            )}
          />""",
    """            onClaim={() => selected.lock.notesHash && actions.claim(selectedId!, selected.lock.notesHash).then(
              () => setToast({ message: "Claimed! Ecash redeemed.", type: "success" }),
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
          />""")

# ── 7. Version bump ──
print("7. Version bump...")
patch("src/ui/App.tsx", "v0.1.2", "v0.1.3")

# ── 8. Update package.json version ──
print("8. Update package.json version...")
patch("package.json", '"version": "0.1.0"', '"version": "0.1.3"')

print("\n═══ Done! ═══")
print("\nRun:")
print("  cd ~/chama && npm test && npm run dev")
print("")
print("Then test the JOIN flow:")
print("  1. Browser A: create a trade → copy the escrow ID from the card")
print("  2. Browser B (incognito + different nos2x key): paste the ID → Load → Join as Buyer")
print("  3. Watch Browser A update in real-time when Browser B joins!")
print("")
print("  git add -A && git commit -m 'v0.1.3 — load trade + JOIN flow' && git push")
print("")
