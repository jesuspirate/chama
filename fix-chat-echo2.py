#!/usr/bin/env python3
"""Fix sender chat echo + late-joiner state reconstruction"""
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

print("\n═══ Fix chat echo + late-joiner ═══\n")

# ── Fix 1: Add published event IDs to the seen set ──
# The relay manager deduplicates incoming events by ID.
# But when WE publish an event, the ID isn't in the seen set,
# so when the relay echoes it back, it passes dedup and gets
# processed again. Fix: mark our own published events as seen.
print("1. Mark published events as seen (prevents relay echo)...")

patch("src/escrow-engine/relay-manager.ts",
    """  async publish(event: NostrEvent): Promise<{ accepted: number; rejected: number; errors: string[] }> {
    const connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);

    if (connected.length === 0) {
      throw new Error("No connected relays — cannot publish");
    }""",
    """  async publish(event: NostrEvent): Promise<{ accepted: number; rejected: number; errors: string[] }> {
    const connected = [...this.relays.values()].filter(r => r.status === RelayStatus.CONNECTED);

    if (connected.length === 0) {
      throw new Error("No connected relays — cannot publish");
    }

    // Mark as seen BEFORE publishing — prevents the relay echo from
    // being processed as a new event when it comes back to us.
    this.seenEventIds.add(event.id);""")

# ── Fix 2: Late-joiner state — ensure loadEscrow triggers state update ──
# When someone loads a trade that's already past FUNDED, the state
# should reflect the actual current state from the relay events.
# The issue was that after loadEscrow, the UI wasn't getting the
# updated state. Let's make sure onStateUpdate fires after load.
print("2. Force UI update after loadEscrow...")

patch("src/escrow-engine/escrow-client.ts",
    """    this.states.set(escrowId, result.state);
    this.rawEvents.set(escrowId, rawEvents);

    // Start watching for live updates
    this.watchEscrow(escrowId);

    return result.state;
  }""",
    """    this.states.set(escrowId, result.state);
    this.rawEvents.set(escrowId, rawEvents);

    // Notify UI of the reconstructed state
    this.callbacks.onStateUpdate?.(escrowId, result.state);

    // Start watching for live updates
    this.watchEscrow(escrowId);

    return result.state;
  }""")

print("\nRun:")
print("  npm test && npm run build")
print("  rm fix-*.py chama-v*.py")
print("  git add -A && git commit -m 'v0.1.21b — fix chat echo + late-joiner state' && git push")
print("  scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/")
