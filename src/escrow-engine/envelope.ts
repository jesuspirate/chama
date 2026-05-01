// ══════════════════════════════════════════════════════════════════════════
// Chama — 3-recipient NIP-44 envelope helpers (PR 4)
// ══════════════════════════════════════════════════════════════════════════
//
// The escrow protocol has multiple places where one piece of cleartext
// needs to be readable by exactly three pubkeys (buyer, seller, arbiter)
// and no one else. SSS shares in LockPayload already use this pattern
// via LockShareEntry.encryptedFor — each share is NIP-44 encrypted
// separately to each recipient, mapped by their pubkey.
//
// PR 4 generalizes that pattern. The handle reveal moves from a
// single-recipient outer-wrap (broken for non-locker in PROD) to a
// per-recipient envelope mirroring share distribution. CHAT messages
// can reuse this same helper in v1.5 when 3-recipient chat encryption
// becomes a thing.
//
// Shape:
//   { encryptedFor: { <pubkey>: <NIP-44 ciphertext>, ... } }
//
// Encryption: locker (sender) encrypts cleartext to each recipient
// pubkey via NIP-44. The shared secret per recipient is derived from
// ECDH(locker_priv, recipient_pub).
//
// Decryption: any recipient looks up their pubkey in encryptedFor,
// then NIP-44 decrypts using the locker's pubkey as the sender. Their
// signer derives ECDH(my_priv, locker_pub), the same shared secret the
// locker used to encrypt — so it works.

import type { HandleEnvelope } from "./types.js";

export type EncryptFn = (plaintext: string, recipientPubkey: string) => Promise<string>;
export type DecryptFn = (ciphertext: string, senderPubkey: string) => Promise<string>;

/** Encrypt the same cleartext separately to each recipient. The order
 *  of recipientPubkeys is preserved in iteration; duplicates collapse
 *  to a single entry (encryptedFor is keyed by pubkey).
 *
 *  Returns the envelope shape ready to drop into a LockPayload (or any
 *  future event that needs the same fanout). An empty recipients list
 *  is allowed and yields { encryptedFor: {} } — the caller can decide
 *  whether that's an error condition for their use case. */
export async function createEnvelope(
  cleartext: string,
  recipientPubkeys: string[],
  encrypt: EncryptFn,
): Promise<HandleEnvelope> {
  const encryptedFor: Record<string, string> = {};
  for (const pk of recipientPubkeys) {
    if (!pk) continue;
    if (encryptedFor[pk] !== undefined) continue;
    encryptedFor[pk] = await encrypt(cleartext, pk);
  }
  return { encryptedFor };
}

/** Look up the viewer's entry in the envelope and decrypt it. Returns
 *  null when:
 *   - The envelope has no entry for myPubkey (not a recipient)
 *   - The decrypt callback throws (wrong sender, malformed ciphertext,
 *     or NIP-44 auth failure)
 *
 *  Never throws — callers that need to distinguish "not a recipient"
 *  from "decrypt failed" can inspect the envelope directly. The null
 *  return makes the common path (just-want-cleartext-or-nothing) clean. */
export async function decryptFromEnvelope(
  envelope: HandleEnvelope,
  myPubkey: string,
  senderPubkey: string,
  decrypt: DecryptFn,
): Promise<string | null> {
  const ciphertext = envelope.encryptedFor[myPubkey];
  if (!ciphertext) return null;
  try {
    return await decrypt(ciphertext, senderPubkey);
  } catch {
    return null;
  }
}

/** True when the envelope has an entry for the given pubkey. Cheap
 *  check that doesn't require a signer — useful for "is this LOCK
 *  for me?" kinds of decisions in render code. */
export function envelopeHasRecipient(
  envelope: HandleEnvelope,
  pubkey: string,
): boolean {
  return envelope.encryptedFor[pubkey] !== undefined;
}
