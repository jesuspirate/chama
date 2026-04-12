#!/usr/bin/env python3
"""
Fix Amber redirect loop.

Problem: getPublicKey() redirects to Amber, page reloads, Promise is gone.
The connect() function never completes.

Solution: 
  1. AmberSigner.getPublicKey() checks localStorage FIRST — if cached, return immediately
  2. On page load, App checks for amber_type URL param and auto-connects
  3. The AmberSigner handles the callback before anything else
  4. Rename "Connect with Amber" → "Connect with Signer"
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

print("\n═══ Fix Amber redirect + auto-connect ═══\n")

# ── 1. Rewrite AmberSigner.getPublicKey to not redirect if cached ──
print("1. Fix AmberSigner.getPublicKey — return cached pubkey immediately...")

patch("src/escrow-engine/signers.ts",
    """  async getPublicKey(): Promise<string> {
    if (this.pubkey) return this.pubkey;

    const result = await this.redirectToAmber({
      type: "get_public_key",
    });

    this.pubkey = result;
    return result;
  }""",
    """  async getPublicKey(): Promise<string> {
    // Return cached pubkey immediately — no redirect needed
    if (this.pubkey) return this.pubkey;

    // Check localStorage (set by previous Amber callback)
    const cached = localStorage.getItem("chama_amber_pubkey");
    if (cached) {
      this.pubkey = cached;
      return cached;
    }

    // No cached pubkey — need to redirect to Amber.
    // This will cause a page reload, so we don't await the Promise.
    // The callback handler will pick up the result on next page load.
    this.redirectToAmber({ type: "get_public_key" });

    // This Promise will never resolve (page is about to reload).
    // Return a never-resolving Promise to prevent further execution.
    return new Promise(() => {});
  }""")

# ── 2. Fix signEvent to handle Amber's returnType ──
print("2. Fix signEvent for Amber return format...")

patch("src/escrow-engine/signers.ts",
    """  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    const eventJson = JSON.stringify(event);
    const result = await this.redirectToAmber({
      type: "sign_event",
      content: eventJson,
      current_user: this.pubkey || "",
    });

    // Amber returns the signed event JSON or just the signature
    try {
      const parsed = JSON.parse(result);
      return parsed as NostrEvent;
    } catch {
      // If it's just a signature, we need to construct the full event
      // This shouldn't happen with returnType=event but handle it
      return { ...event, pubkey: this.pubkey || "", id: "", sig: result } as NostrEvent;
    }
  }""",
    """  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    const eventJson = JSON.stringify(event);

    // For signing, we need a round-trip to Amber.
    // Store the pending event so we can reconstruct after redirect.
    localStorage.setItem("chama_amber_pending_event", eventJson);

    this.redirectToAmber({
      type: "sign_event",
      content: eventJson,
      current_user: this.pubkey || "",
    });

    // Page will reload — return never-resolving Promise
    return new Promise(() => {});
  }""")

# ── 3. Add auto-connect on page load when returning from Amber ──
print("3. Add auto-connect on Amber callback detection...")

# In App.tsx main component, add useEffect to detect Amber callback
patch("src/ui/App.tsx",
    """  // ── Render ──""",
    """  // ── Auto-connect on Amber callback ──
  useEffect(() => {
    const url = new URL(window.location.href);
    const amberType = url.searchParams.get("amber_type");
    const event = url.searchParams.get("event");

    if (amberType === "get_public_key" && event) {
      // Amber returned with a pubkey — save it and auto-connect
      localStorage.setItem("chama_amber_pubkey", event);
      // Clean URL
      url.searchParams.delete("amber_type");
      url.searchParams.delete("event");
      window.history.replaceState({}, "", url.toString());
      // Set Amber preference and connect
      (window as any).__chama_prefer_amber = true;
      actions.connect();
    } else if (localStorage.getItem("chama_amber_pubkey") && /android/i.test(navigator?.userAgent || "")) {
      // Returning user with cached Amber pubkey — auto-connect
      (window as any).__chama_prefer_amber = true;
      if (!state.connected && !state.loading) {
        actions.connect();
      }
    }
  }, []);

  // ── Render ──""")

# ── 4. Rename button label ──
print("4. Rename 'Connect with Amber' → 'Connect with Signer'...")

patch("src/ui/App.tsx",
    '{loading ? "Connecting…" : "🟣 Connect with Amber"}',
    '{loading ? "Connecting…" : "🔐 Connect with Signer"}')

print("\nRun: npm test && npm run build")
print("Then test on your GrapheneOS phone!")
print("  1. Open chama.satoshimarket.app")
print("  2. Tap 'Connect with Signer'")
print("  3. Amber opens → approve")
print("  4. Redirects back → should auto-connect (no more loop!)")
