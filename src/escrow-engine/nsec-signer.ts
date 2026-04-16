// ══════════════════════════════════════════════════════════════════════════
// Chama — nsec Signer (local key, real crypto)
// ══════════════════════════════════════════════════════════════════════════
//
// Uses nostr-tools for actual cryptographic signing.
// The nsec never leaves the browser — stored in memory only.

import type { Signer, UnsignedEvent } from "./escrow-client.js";
import type { NostrEvent } from "./types.js";

export class NsecSigner implements Signer {
  private secretKey: Uint8Array;
  private _pubkey: string | null = null;

  constructor(nsecOrHex: string) {
    // Will be initialized async in init()
    this.secretKey = new Uint8Array(32);
    this._nsecOrHex = nsecOrHex;
  }

  private _nsecOrHex: string;
  private _initialized = false;

  private async init(): Promise<void> {
    if (this._initialized) return;

    const { nip19 } = await import("nostr-tools");
    const { getPublicKey } = await import("nostr-tools/pure");

    let hex: string;
    if (this._nsecOrHex.startsWith("nsec1")) {
      const decoded = nip19.decode(this._nsecOrHex);
      if (decoded.type !== "nsec") throw new Error("Invalid nsec");
      hex = Array.from(decoded.data as Uint8Array).map(b => b.toString(16).padStart(2, "0")).join("");
    } else {
      hex = this._nsecOrHex;
    }

    this.secretKey = new Uint8Array(32);
    for (let i = 0; i < 64; i += 2) {
      this.secretKey[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }

    this._pubkey = getPublicKey(this.secretKey);
    this._initialized = true;
  }

  async getPublicKey(): Promise<string> {
    await this.init();
    return this._pubkey!;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    await this.init();
    const { finalizeEvent } = await import("nostr-tools/pure");
    return finalizeEvent(event, this.secretKey) as unknown as NostrEvent;
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    await this.init();
    const { nip44 } = await import("nostr-tools");
    const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, recipientPubkey);
    return nip44.v2.encrypt(plaintext, conversationKey);
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    await this.init();
    const { nip44 } = await import("nostr-tools");
    const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, senderPubkey);
    return nip44.v2.decrypt(ciphertext, conversationKey);
  }
}
