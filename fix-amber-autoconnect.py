#!/usr/bin/env python3
"""Fix: add Amber auto-connect useEffect before the main render"""
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

print("\n═══ Fix Amber auto-connect ═══\n")

patch("src/ui/App.tsx",
    """  // ── Connected → main app ──""",
    """  // ── Amber callback auto-connect ──
  useEffect(() => {
    const url = new URL(window.location.href);
    const amberType = url.searchParams.get("amber_type");
    const amberEvent = url.searchParams.get("event");

    if (amberType === "get_public_key" && amberEvent) {
      // Returning from Amber with pubkey — save and auto-connect
      localStorage.setItem("chama_amber_pubkey", amberEvent);
      url.searchParams.delete("amber_type");
      url.searchParams.delete("event");
      window.history.replaceState({}, "", url.toString());
      (window as any).__chama_prefer_amber = true;
      actions.connect();
    } else if (
      !state.connected && !state.loading &&
      localStorage.getItem("chama_amber_pubkey") &&
      /android/i.test(navigator?.userAgent || "")
    ) {
      // Returning Android user with cached Amber pubkey — auto-connect
      (window as any).__chama_prefer_amber = true;
      actions.connect();
    }
  }, []);

  // ── Connected → main app ──""")

print("\nRun: npm test && npm run build && deploy")
