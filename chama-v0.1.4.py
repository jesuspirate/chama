#!/usr/bin/env python3
"""
Chama v0.1.4 — Fix trade discovery (CREATE/JOIN use plaintext content)

Trade terms (description, amount, category) are PUBLIC — anyone browsing
the marketplace needs to see them. Only sensitive events (LOCK with SSS
shares, VOTE, CLAIM, CHAT) get NIP-44 encrypted.

This matches how SatoshiMarket works: listings are public, escrow internals
are private.
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

print("\n═══ Chama v0.1.4 — Fix trade discovery ═══\n")

# ── 1. CREATE event: plaintext content (not encrypted) ──
print("1. CREATE uses plaintext content (trade terms are public)...")

patch("src/escrow-engine/escrow-client.ts",
    """    // For CREATE, we encrypt to ourselves (content is public to participants
    // who join — they'll get re-encrypted copies via the JOIN handshake)
    const content = await this.signer.nip44Encrypt(JSON.stringify(payload), pubkey);""",
    """    // CREATE content is PLAINTEXT — trade terms are public (marketplace discovery).
    // Only LOCK/VOTE/CLAIM/CHAT events get NIP-44 encrypted.
    const content = JSON.stringify(payload);""")

# ── 2. JOIN event: plaintext content ──
print("2. JOIN uses plaintext content...")

patch("src/escrow-engine/escrow-client.ts",
    """    // Encrypt to the initiator (they need to know who joined)
    const initiatorPk = state.initiator.pubkey;
    const content = await this.signer.nip44Encrypt(JSON.stringify(payload), initiatorPk);""",
    """    // JOIN content is PLAINTEXT — who joined is public info.
    const content = JSON.stringify(payload);""")

# ── 3. loadEscrow: try plaintext first, then NIP-44 decrypt ──
print("3. loadEscrow: try plaintext JSON first, fallback to NIP-44...")

patch("src/escrow-engine/escrow-client.ts",
    """    // Parse and decrypt all events
    const parsed: ParsedEscrowEvent[] = [];
    for (const raw of rawEvents) {
      try {
        const decrypted = await this.signer.nip44Decrypt(raw.content, raw.pubkey);
        const result = parseEscrowEvent(raw, decrypted, true);
        if (result.ok) parsed.push(result.event);
      } catch (e) {
        // Some events might not be decryptable (encrypted to other participants)
        // That's fine — we skip them and work with what we can read
        console.warn(`[escrow] Could not decrypt event ${raw.id}: ${e}`);
      }
    }""",
    """    // Parse all events — try plaintext JSON first, then NIP-44 decrypt.
    // CREATE and JOIN are plaintext; LOCK/VOTE/CLAIM/CHAT are encrypted.
    const parsed: ParsedEscrowEvent[] = [];
    for (const raw of rawEvents) {
      let content: string | null = null;

      // Try 1: plaintext JSON (CREATE, JOIN, CANCEL, COMPLETE, RESOLVE)
      try {
        const test = JSON.parse(raw.content);
        if (test && typeof test.type === "string" && test.type.startsWith("escrow:")) {
          content = raw.content;
        }
      } catch {
        // Not valid JSON — likely NIP-44 encrypted
      }

      // Try 2: NIP-44 decrypt (LOCK, VOTE, CLAIM, CHAT)
      if (!content) {
        try {
          content = await this.signer.nip44Decrypt(raw.content, raw.pubkey);
        } catch {
          // Can't decrypt — encrypted to another participant, skip
          console.warn(`[escrow] Skipping undecryptable event ${raw.id.slice(0, 8)}…`);
          continue;
        }
      }

      const result = parseEscrowEvent(raw, content, true);
      if (result.ok) parsed.push(result.event);
    }""")

# ── 4. handleIncomingEvent: same plaintext-first logic ──
print("4. handleIncomingEvent: plaintext-first fallback...")

patch("src/escrow-engine/escrow-client.ts",
    """    // Try to decrypt
    let decrypted: string;
    try {
      decrypted = await this.signer.nip44Decrypt(event.content, event.pubkey);
    } catch {
      // Can't decrypt — might be encrypted to another participant
      return;
    }""",
    """    // Try plaintext JSON first (CREATE, JOIN), then NIP-44 decrypt (LOCK, VOTE, etc.)
    let decrypted: string | null = null;
    try {
      const test = JSON.parse(event.content);
      if (test && typeof test.type === "string" && test.type.startsWith("escrow:")) {
        decrypted = event.content;
      }
    } catch {
      // Not plaintext JSON — try NIP-44
    }
    if (!decrypted) {
      try {
        decrypted = await this.signer.nip44Decrypt(event.content, event.pubkey);
      } catch {
        // Can't decrypt — encrypted to another participant, ignore
        return;
      }
    }""")

# ── 5. Version bump ──
print("5. Version bump...")
patch("src/ui/App.tsx", "v0.1.3", "v0.1.4")
patch("package.json", '"version": "0.1.3"', '"version": "0.1.4"')

print("\n═══ Done! ═══")
print("\nRun:")
print("  cd ~/chama && npm test && npm run dev")
print("")
print("Now test again with two browsers:")
print("  Browser A: create a NEW trade (old ones were encrypted, won't work)")
print("  Browser B: paste the escrow ID → Load → should see the trade!")
print("  Browser B: tap 'Join as Buyer' → nos2x signs → state updates!")
print("")
print("  rm chama-v0.1.3.py chama-v0.1.4.py")
print("  git add -A && git commit -m 'v0.1.4 — fix trade discovery + plaintext CREATE/JOIN' && git push")
print("")
