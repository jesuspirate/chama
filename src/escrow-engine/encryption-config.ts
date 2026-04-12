// ══════════════════════════════════════════════════════════════════════════
// Chama Encryption Configuration
// ══════════════════════════════════════════════════════════════════════════
//
// Controls which event kinds are NIP-44 encrypted.
// During testing/development, all events are plaintext for debugging.
// In production, sensitive events (LOCK, VOTE, CLAIM) are encrypted.

export interface EncryptionConfig {
  /** Master switch — when false, everything is plaintext */
  enabled: boolean;
  /** Encrypt LOCK events (contains SSS shares) */
  encryptLock: boolean;
  /** Encrypt VOTE events (vote outcome is private) */
  encryptVote: boolean;
  /** Encrypt CLAIM events (contains share verification) */
  encryptClaim: boolean;
  /** Encrypt RESOLVE events */
  encryptResolve: boolean;
}

/** Development config — everything plaintext for easy debugging */
export const DEV_ENCRYPTION: EncryptionConfig = {
  enabled: false,
  encryptLock: false,
  encryptVote: false,
  encryptClaim: false,
  encryptResolve: false,
};

/** Production config — sensitive events encrypted */
export const PROD_ENCRYPTION: EncryptionConfig = {
  enabled: true,
  encryptLock: true,
  encryptVote: true,
  encryptClaim: true,
  encryptResolve: true,
};

/** Current active config — toggle this for production */
export const ENCRYPTION_CONFIG: EncryptionConfig = DEV_ENCRYPTION;

/**
 * Helper: encrypt content if the config says so, otherwise return plaintext JSON.
 * In production, content is NIP-44 encrypted to the recipient pubkey.
 * The signer handles the actual encryption via nos2x/Alby.
 */
export async function maybeEncrypt(
  payload: unknown,
  recipientPubkey: string,
  encrypt: (plaintext: string, pubkey: string) => Promise<string>,
  shouldEncrypt: boolean,
): Promise<string> {
  const json = JSON.stringify(payload);
  if (!shouldEncrypt || !ENCRYPTION_CONFIG.enabled) {
    return json;
  }
  return encrypt(json, recipientPubkey);
}
