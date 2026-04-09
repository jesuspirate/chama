#!/usr/bin/env python3
"""
Chama v0.1.8 — Swallow duplicate JOIN errors on reload

When a user refreshes the page on a trade they already joined, the
engine correctly rejects the new JOIN attempt with
"Cannot JOIN in state funded" (or "Pubkey is already a participant"
if they hit it before the state advanced). Pre-v0.1.8 the hook was
propagating that error as a red toast and the UI briefly rendered
JOIN buttons for a trade already past OPEN.

This patch mirrors the try/catch pattern already used by voteAction,
claimAction, and simulatedLockAction in v0.1.7: catch, match the
known engine error substrings, log a debug line, and return the
current client state instead of throwing. Unknown errors still
propagate so real failures aren't hidden.

The matched substrings are pulled from the engine source
(src/escrow-engine/state-machine.ts handleJoin + escrow-client.ts
applyLocally wrapping):
  - "Cannot JOIN"            — state-machine INVALID_STATE err
  - "already a participant"  — state-machine ALREADY_JOINED err
  - "TERMINAL"               — catch-all for terminal-state rejects
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

print("\n═══ Chama v0.1.8 — Swallow duplicate JOIN errors ═══\n")

# ── 1. Wrap joinEscrow action with error swallowing ──
print("1. Wrap joinEscrow with try/catch for duplicate errors...")

patch("src/hooks/useEscrow.ts",
    """  const joinEscrow = useCallback(async (escrowId: string, role: Role) => {
    const client = requireClient();
    const result = await client.joinEscrow(escrowId, role);
    saveEscrowId(escrowId);
    vibrate([30, 20, 30]);
    return result;
  }, []);""",
    """  const joinEscrow = useCallback(async (escrowId: string, role: Role) => {
    const client = requireClient();
    try {
      const result = await client.joinEscrow(escrowId, role);
      saveEscrowId(escrowId);
      vibrate([30, 20, 30]);
      return result;
    } catch (e: any) {
      // Swallow known duplicate/stale errors — they fire when a user reloads
      // a trade they already joined and the state has advanced past OPEN.
      // Engine strings: "Cannot JOIN in state <x>" and
      // "Pubkey is already a participant".
      const msg = e?.message || "";
      if (msg.includes("Cannot JOIN") || msg.includes("already a participant") ||
          msg.includes("TERMINAL")) {
        console.debug("[chama] Join suppressed:", msg);
        saveEscrowId(escrowId);
        return client.getState(escrowId)!;
      }
      throw e;
    }
  }, []);""")

# ── 2. Version bump ──
print("2. Version bump...")
patch("src/ui/App.tsx", "v0.1.7", "v0.1.8")
patch("package.json", '"version": "0.1.7"', '"version": "0.1.8"')

print("\n═══ Done! ═══")
print("\nRun:")
print("  cd ~/chama && npm test && npm run dev")
print("")
print("What's fixed:")
print("  ✓ Reloading a trade you already joined no longer throws a red toast")
print("  ✓ joinEscrow now matches the voteAction/claimAction/lockAction pattern")
print("")
print("Test: join a trade → refresh the page → should load silently,")
print("      no JOIN buttons, no error toast.")
print("")
print("  git add -A && git commit -m 'v0.1.8 — swallow duplicate JOIN errors on reload' && git push")
print("")
