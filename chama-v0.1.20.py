#!/usr/bin/env python3
"""
Chama v0.1.20 — Expiry countdown timer (Safety Feature #3)

Adds a visible countdown timer to the trade detail view showing
how much time remains before the trade expires. All participants
can see exactly how long they have to act.

- Green when > 1 hour remaining
- Amber when < 1 hour
- Red when < 10 minutes
- Pulses when < 5 minutes
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

print("\n═══ Chama v0.1.20 — Expiry countdown timer ═══\n")

# ── 1. Add CountdownTimer component before TradeDetail ──
print("1. Add CountdownTimer component...")

patch("src/ui/App.tsx",
    """// ══════════════════════════════════════════════════════════════════════════
// TRADE DETAIL
// ══════════════════════════════════════════════════════════════════════════""",
    """// ══════════════════════════════════════════════════════════════════════════
// COUNTDOWN TIMER
// ══════════════════════════════════════════════════════════════════════════

function CountdownTimer({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  const remaining = expiresAt - now;
  if (remaining <= 0) {
    return (
      <div style={{
        padding: "10px 16px", borderRadius: T.rs,
        background: T.redDim, border: `1px solid ${T.red}44`,
        textAlign: "center", fontFamily: T.mono, fontSize: 12,
        color: T.red, fontWeight: 700,
      }}>
        EXPIRED
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

  const urgent = remaining < 300;  // < 5 min
  const warning = remaining < 600; // < 10 min
  const caution = remaining < 3600; // < 1 hour

  const color = warning ? T.red : caution ? T.amber : T.green;
  const bg = warning ? T.redDim : caution ? T.amberDim : T.greenDim;

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: 8, padding: "8px 16px", borderRadius: T.rs,
      background: bg, border: `1px solid ${color}44`,
      fontFamily: T.mono, fontSize: 11,
      animation: urgent ? "pulse 1s ease-in-out infinite" : "none",
    }}>
      <span style={{ color: T.muted, fontSize: 9, letterSpacing: 1 }}>EXPIRES IN</span>
      <span style={{ color, fontWeight: 700, fontSize: 13 }}>{timeStr}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TRADE DETAIL
// ══════════════════════════════════════════════════════════════════════════""")

# ── 2. Add countdown to trade detail view — after header, before participants ──
print("2. Add countdown to trade detail view...")

patch("src/ui/App.tsx",
    """      {/* Participants */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>PARTICIPANTS</div>""",
    """      {/* Countdown timer — visible in all non-terminal states */}
      {state.expiresAt && state.status !== "COMPLETED" && state.status !== "CANCELLED" && state.status !== "EXPIRED" && (
        <div style={{ marginBottom: 16 }}>
          <CountdownTimer expiresAt={state.expiresAt} />
        </div>
      )}

      {/* Participants */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 16 }}>PARTICIPANTS</div>""")

# ── 3. Also show countdown on trade cards in the list view ──
print("3. Add compact countdown to trade cards...")

patch("src/ui/App.tsx",
    """      {/* Escrow ID — tap to copy */}""",
    """      {/* Compact countdown on card */}
      {state.expiresAt && state.status !== "COMPLETED" && state.status !== "CANCELLED" && state.status !== "EXPIRED" && (() => {
        const rem = state.expiresAt - Math.floor(Date.now() / 1000);
        if (rem <= 0) return <div style={{ fontSize: 9, color: T.red, fontFamily: T.mono, textAlign: "center", marginTop: 8 }}>EXPIRED</div>;
        const h = Math.floor(rem / 3600);
        const m = Math.floor((rem % 3600) / 60);
        const color = rem < 600 ? T.red : rem < 3600 ? T.amber : T.muted;
        return (
          <div style={{ fontSize: 9, color, fontFamily: T.mono, textAlign: "center", marginTop: 8 }}>
            {h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`}
          </div>
        );
      })()}

      {/* Escrow ID — tap to copy */}""")

# ── 4. Version bump ──
print("4. Version bump...")
patch("src/ui/App.tsx", "v0.1.19", "v0.1.20")
patch("package.json", '"version": "0.1.19"', '"version": "0.1.20"')

print("\n═══ Done! ═══")
print("\nRun:")
print("  cd ~/chama && npm test && npm run build")
print("")
print("What's new:")
print("  ✓ Live countdown timer on trade detail (ticks every second)")
print("  ✓ Compact time remaining on trade cards in list view")
print("  ✓ Color coding: green > 1hr, amber < 1hr, red < 10min")
print("  ✓ Pulses when < 5 minutes remaining")
print("  ✓ Shows EXPIRED when time runs out")
print("")
print("  git add -A && git commit -m 'v0.1.20 — expiry countdown timer (safety feature #3)' && git push")
print("  npm run build && scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/")
print("")
