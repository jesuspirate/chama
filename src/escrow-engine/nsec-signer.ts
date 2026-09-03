// ══════════════════════════════════════════════════════════════════════════
// Chama — nsec Signer (local key, real crypto)
// ══════════════════════════════════════════════════════════════════════════
//
// Uses nostr-tools for actual cryptographic signing.
// The nsec never leaves the browser — stored in memory only.

import type { Signer, UnsignedEvent } from "./escrow-client.js";
import type { NostrEvent } from "./types.js";

export type RecoveryKeyKind = "nsec" | "hex";

export type RecoveryKeyValidation =
  | { ok: true; kind: RecoveryKeyKind; secretKey: Uint8Array; normalized: string }
  | { ok: false; error: string };

const HEX_SECRET_RE = /^[0-9a-fA-F]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateRecoveryKeyInput(input: string): Promise<RecoveryKeyValidation> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter your Chama recovery key." };
  }

  const { nip19 } = await import("nostr-tools");

  if (trimmed.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array) || decoded.data.length !== 32) {
        return { ok: false, error: "That recovery key is not a valid nsec." };
      }
      return {
        ok: true,
        kind: "nsec",
        secretKey: decoded.data,
        normalized: trimmed,
      };
    } catch {
      return { ok: false, error: "That recovery key is not a valid nsec." };
    }
  }

  if (!HEX_SECRET_RE.test(trimmed)) {
    return {
      ok: false,
      error: "Paste an nsec recovery key or a 64-character hex private key.",
    };
  }

  const secretKey = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    secretKey[i / 2] = parseInt(trimmed.substring(i, i + 2), 16);
  }

  return {
    ok: true,
    kind: "hex",
    secretKey,
    normalized: bytesToHex(secretKey),
  };
}

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

    const { getPublicKey } = await import("nostr-tools/pure");

    const validated = await validateRecoveryKeyInput(this._nsecOrHex);
    if (!validated.ok) {
      throw new Error(validated.error);
    }

    this.secretKey = validated.secretKey;
    this._pubkey = getPublicKey(this.secretKey);
    this._initialized = true;
  }

  async getPublicKey(): Promise<string> {
    await this.init();
    return this._pubkey!;
  }

  /** Explicit recovery escape hatch for Me → Advanced. The key remains
   * memory-only until the user deliberately asks to reveal/copy it. */
  async exportRecoveryKey(): Promise<string> {
    await this.init();
    return this._nsecOrHex.trim();
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

  /** A6 background push: the NIP-44 conversation key shared with `pubkey`.
   *  Symmetric ECDH — the trade counterparty derives the identical key, the VPS
   *  cannot. Never leaves the process; used only to seed opaque watch-tags. */
  async conversationKey(pubkey: string): Promise<Uint8Array> {
    await this.init();
    const { nip44 } = await import("nostr-tools");
    return nip44.v2.utils.getConversationKey(this.secretKey, pubkey);
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    await this.init();
    const { nip44 } = await import("nostr-tools");
    const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, senderPubkey);
    return nip44.v2.decrypt(ciphertext, conversationKey);
  }

  // kind:4 DMs only — a kind:4 MUST carry NIP-04 ciphertext or external
  // clients render blank. Escrow payloads stay on nip44Encrypt.
  async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    await this.init();
    const { nip04 } = await import("nostr-tools");
    return nip04.encrypt(this.secretKey, recipientPubkey, plaintext);
  }
}
