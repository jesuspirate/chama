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
    // User rejected the signing prompt (nos2x returns {error: {message: "denied"}})
    if (!signed || (signed as any).error || !signed.sig) {
      throw new Error("Signing cancelled — you can try again");
    }
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
// AMBER SIGNER — Android NIP-55 via nostrsigner: URL scheme
// ══════════════════════════════════════════════════════════════════════════

/**
 * Uses Amber (NIP-55) for signing on Android.
 * 
 * For web apps, Amber uses the nostrsigner: URL scheme with callback URLs.
 * Each operation redirects to Amber, user approves, Amber redirects back
 * with the result as a URL parameter.
 * 
 * Flow:
 *   1. App navigates to nostrsigner:?type=get_public_key&callbackUrl=...
 *   2. Amber opens, user approves
 *   3. Amber redirects to callbackUrl?event=<result>
 *   4. App reads the result from the URL
 *
 * Limitation: each signing operation is a redirect round-trip.
 * For better UX, consider NIP-46 (Nostr Connect) which Amber also supports.
 */
export class AmberSigner implements Signer {
  private pubkey: string | null = null;
  private pendingResolve: ((value: string) => void) | null = null;
  private callbackBase: string;

  constructor() {
    this.callbackBase = window.location.origin + window.location.pathname;
    // Check if we're returning from Amber with a result
    this.handleAmberCallback();
  }

  /** Check if this is an Android device (Amber only works on Android) */
  static isAndroid(): boolean {
    if (typeof navigator === "undefined") return false;
    return /android/i.test(navigator.userAgent);
  }

  /** Check URL params for Amber callback results */
  private handleAmberCallback(): void {
    const url = new URL(window.location.href);
    const event = url.searchParams.get("event");
    const amberType = url.searchParams.get("amber_type");

    if (event && amberType) {
      // Clean the URL
      url.searchParams.delete("event");
      url.searchParams.delete("amber_type");
      window.history.replaceState({}, "", url.toString());

      // Store the result
      if (amberType === "get_public_key") {
        this.pubkey = event;
        // Also persist for subsequent page loads
        localStorage.setItem("chama_amber_pubkey", event);
      }

      // Resolve any pending promise
      if (this.pendingResolve) {
        this.pendingResolve(event);
        this.pendingResolve = null;
      }
    }

    // Restore cached pubkey
    if (!this.pubkey) {
      this.pubkey = localStorage.getItem("chama_amber_pubkey");
    }
  }

  /** Redirect to Amber with a nostrsigner: URL */
  private redirectToAmber(params: Record<string, string>): Promise<string> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;

      const amberType = params.type || "unknown";
      const callbackUrl = encodeURIComponent(
        this.callbackBase + "?amber_type=" + amberType + "&event="
      );

      let uri = "nostrsigner:";
      if (params.content) {
        uri += params.content;
      }

      const queryParts = [];
      for (const [key, value] of Object.entries(params)) {
        if (key !== "content") {
          queryParts.push(`${key}=${encodeURIComponent(value)}`);
        }
      }
      queryParts.push(`callbackUrl=${callbackUrl}`);
      queryParts.push("compressionType=none");
      queryParts.push("returnType=signature");

      uri += "?" + queryParts.join("&");

      window.location.href = uri;
    });
  }

  async getPublicKey(): Promise<string> {
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
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
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
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    return this.redirectToAmber({
      type: "nip44_encrypt",
      content: plaintext,
      pubkey: recipientPubkey,
      current_user: this.pubkey || "",
    });
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    return this.redirectToAmber({
      type: "nip44_decrypt",
      content: ciphertext,
      pubkey: senderPubkey,
      current_user: this.pubkey || "",
    });
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
export function detectSigner(preferAmber?: boolean): Signer {
  if (typeof window === "undefined") {
    throw new Error("No browser environment — use LocalSigner for CLI/testing");
  }

  // If explicitly requesting Amber (mobile user tapped "Connect with Amber")
  if (preferAmber && AmberSigner.isAndroid()) {
    return new AmberSigner();
  }

  // Check if returning from Amber callback
  const url = new URL(window.location.href);
  if (url.searchParams.has("amber_type")) {
    return new AmberSigner();
  }

  // Check if we have a cached Amber pubkey (user previously connected via Amber)
  if (localStorage.getItem("chama_amber_pubkey") && AmberSigner.isAndroid()) {
    return new AmberSigner();
  }

  if (FediSigner.isAvailable()) {
    return new FediSigner();
  }

  if ((window as any).nostr) {
    return new NIP07Signer();
  }

  throw new Error("No Nostr signer available — install a NIP-07 extension, use Amber on Android, or open in Fedi");
}
