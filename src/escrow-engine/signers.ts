// ══════════════════════════════════════════════════════════════════════════
// Chama — Signer Implementations
// ══════════════════════════════════════════════════════════════════════════
//
// Three implementations of the Signer interface:
//   1. NIP07Signer — browser extension (nos2x, Alby, nostr-keyx)
//   2. FediSigner  — Fedi Mini-App runtime (window.nostr from fediInternal)
//   3. LocalSigner — local keypair for testing and CLI tools
//
// The EscrowClient doesn't care which one you use.

import type { Signer, UnsignedEvent } from "./escrow-client.js";
import type { NostrEvent } from "./types.js";

// ══════════════════════════════════════════════════════════════════════════
// NIP-07 SIGNER — Browser extension (nos2x, Alby, etc.)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Uses window.nostr (NIP-07) for signing and encryption.
 * Works with nos2x, Alby, nostr-keyx, and any NIP-07 extension.
 * Also works with Fedi's NIP-07 provider when running as a Mini-App.
 */
export class NIP07Signer implements Signer {
  private getNostr(): any {
    if (typeof window === "undefined" || !(window as any).nostr) {
      throw new Error("NIP-07 extension not found — install nos2x, Alby, or similar");
    }
    return (window as any).nostr;
  }

  async getPublicKey(): Promise<string> {
    return this.getNostr().getPublicKey();
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    const nostr = this.getNostr();
    // NIP-07 signEvent expects the full event template and returns it signed
    const signed = await nostr.signEvent(event);
    return signed as NostrEvent;
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    const nostr = this.getNostr();
    // NIP-44 encrypt via extension
    if (nostr.nip44?.encrypt) {
      return nostr.nip44.encrypt(recipientPubkey, plaintext);
    }
    // Fallback to NIP-04 if NIP-44 not supported
    if (nostr.nip04?.encrypt) {
      return nostr.nip04.encrypt(recipientPubkey, plaintext);
    }
    throw new Error("Extension does not support NIP-44 or NIP-04 encryption");
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    const nostr = this.getNostr();
    if (nostr.nip44?.decrypt) {
      return nostr.nip44.decrypt(senderPubkey, ciphertext);
    }
    if (nostr.nip04?.decrypt) {
      return nostr.nip04.decrypt(senderPubkey, ciphertext);
    }
    throw new Error("Extension does not support NIP-44 or NIP-04 decryption");
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FEDI SIGNER — Fedi Mini-App Runtime
// ══════════════════════════════════════════════════════════════════════════

/**
 * Uses Fedi's window.nostr (NIP-07 compatible) and fediInternal APIs.
 * Automatically detects Fedi runtime.
 *
 * Fedi provides:
 *   - window.nostr.getPublicKey()
 *   - window.nostr.signEvent()
 *   - window.nostr.nip44.encrypt/decrypt (NIP-44 preferred by Fedi)
 *   - fediInternal for ecash operations (not used here — that's layer #3)
 */
export class FediSigner implements Signer {
  private getNostr(): any {
    if (typeof window === "undefined" || !(window as any).nostr) {
      throw new Error("Fedi runtime not detected — are you running inside Fedi?");
    }
    return (window as any).nostr;
  }

  static isAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      !!(window as any).nostr &&
      !!(window as any).fediInternal
    );
  }

  async getPublicKey(): Promise<string> {
    return this.getNostr().getPublicKey();
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return this.getNostr().signEvent(event) as Promise<NostrEvent>;
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    const nostr = this.getNostr();
    // Fedi's recommendation: NIP-44 for all encryption
    if (nostr.nip44?.encrypt) {
      return nostr.nip44.encrypt(recipientPubkey, plaintext);
    }
    throw new Error("Fedi NIP-44 encryption not available");
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    const nostr = this.getNostr();
    if (nostr.nip44?.decrypt) {
      return nostr.nip44.decrypt(senderPubkey, ciphertext);
    }
    throw new Error("Fedi NIP-44 decryption not available");
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOCAL SIGNER — For testing and CLI tools
// ══════════════════════════════════════════════════════════════════════════

/**
 * Uses a local keypair for signing. NIP-44 encryption is stubbed
 * with a simple reversible encoding (NOT cryptographically secure).
 *
 * DO NOT use in production — this is for testing only.
 *
 * For real local signing, you'd import nostr-tools:
 *   import { getPublicKey, finalizeEvent } from "nostr-tools/pure"
 *   import { encrypt, decrypt } from "nostr-tools/nip44"
 */
export class LocalSigner implements Signer {
  private privkeyHex: string;
  private pubkeyHex: string;

  /** Crypto functions — injected to avoid hard dependency on nostr-tools */
  private crypto: {
    getPublicKey: (privkey: Uint8Array) => string;
    finalizeEvent: (event: UnsignedEvent, privkey: Uint8Array) => NostrEvent;
    nip44Encrypt?: (plaintext: string, privkey: Uint8Array, recipientPubkey: string) => string;
    nip44Decrypt?: (ciphertext: string, privkey: Uint8Array, senderPubkey: string) => string;
  };

  constructor(
    privkeyHex: string,
    crypto: LocalSigner["crypto"]
  ) {
    this.privkeyHex = privkeyHex;
    this.crypto = crypto;

    const privBytes = new Uint8Array(32);
    for (let i = 0; i < 64; i += 2) {
      privBytes[i / 2] = parseInt(privkeyHex.substring(i, i + 2), 16);
    }
    this.pubkeyHex = crypto.getPublicKey(privBytes);
  }

  private get privBytes(): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 64; i += 2) {
      bytes[i / 2] = parseInt(this.privkeyHex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  async getPublicKey(): Promise<string> {
    return this.pubkeyHex;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return this.crypto.finalizeEvent(event, this.privBytes);
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (this.crypto.nip44Encrypt) {
      return this.crypto.nip44Encrypt(plaintext, this.privBytes, recipientPubkey);
    }
    // Stub: base64 encode (NOT SECURE — testing only)
    return btoa(plaintext);
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (this.crypto.nip44Decrypt) {
      return this.crypto.nip44Decrypt(ciphertext, this.privBytes, senderPubkey);
    }
    // Stub: base64 decode
    return atob(ciphertext);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// AUTO-DETECT — Pick the right signer for the environment
// ══════════════════════════════════════════════════════════════════════════

/**
 * Automatically detect and return the appropriate signer:
 *   1. If running inside Fedi → FediSigner
 *   2. If window.nostr exists → NIP07Signer
 *   3. Otherwise → throw (caller must provide a LocalSigner)
 */
export function detectSigner(): Signer {
  if (typeof window === "undefined") {
    throw new Error("No browser environment — use LocalSigner for CLI/testing");
  }

  if (FediSigner.isAvailable()) {
    return new FediSigner();
  }

  if ((window as any).nostr) {
    return new NIP07Signer();
  }

  throw new Error("No Nostr signer available — install a NIP-07 extension or use Fedi");
}
