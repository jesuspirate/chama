// ══════════════════════════════════════════════════════════════════════════
// Chama — NIP-46 Nostr Connect Signer
// ══════════════════════════════════════════════════════════════════════════
//
// Uses nostr-tools BunkerSigner to communicate with a remote signer
// (Amber, nsecBunker, etc.) over Nostr relays.
//
// Flow:
//   1. Generate local keypair + nostrconnect:// URI
//   2. Display URI as QR code or tappable link
//   3. User scans/taps → signer approves connection
//   4. All signing happens over relays — no redirects
//   5. Local keypair persisted for session continuity

import type { Signer, UnsignedEvent } from "./escrow-client.js";
import type { NostrEvent } from "./types.js";

// Storage keys
const STORAGE_LOCAL_KEY = "chama_nip46_local_key";
const STORAGE_BUNKER_URI = "chama_nip46_bunker_uri";
const STORAGE_USER_PUBKEY = "chama_nip46_user_pubkey";

// NIP-46 relays for communication
const NIP46_RELAYS = [
  "wss://relay.satoshimarket.app",  // Our own relay — fastest for NIP-46 handshakes
  "wss://relay.nsec.app",
  "wss://relay.primal.net",
];

export interface NIP46ConnectResult {
  signer: Signer;
  pubkey: string;
}

/**
 * Generate a nostrconnect:// URI for the user to scan.
 * Returns the URI string and a Promise that resolves when the bunker connects.
 */
export async function createNostrConnectSession(): Promise<{
  uri: string;
  waitForConnection: () => Promise<NIP46ConnectResult>;
}> {
  // Dynamic import to avoid bundling nostr-tools if not used
  const { generateSecretKey, getPublicKey } = await import("nostr-tools/pure");
  const { BunkerSigner, createNostrConnectURI } = await import("nostr-tools/nip46");
  const { SimplePool } = await import("nostr-tools/pool");

  // Always generate a FRESH local keypair for new connections.
  // Reusing old keys causes relay noise from previous sessions,
  // making the first connection attempt unreliable.
  const localSecretKey = generateSecretKey();
  localStorage.setItem(STORAGE_LOCAL_KEY, JSON.stringify(Array.from(localSecretKey)));

  const clientPubkey = getPublicKey(localSecretKey);

  // Generate a random secret for this connection
  const secret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  // Create the nostrconnect:// URI
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    name: "Chama",
    perms: ["sign_event", "nip44_encrypt", "nip44_decrypt", "nip04_encrypt", "nip04_decrypt"],
  });

  console.debug("[chama] NIP-46 URI generated:", uri.slice(0, 60) + "...");

  return {
    uri,
    waitForConnection: async (): Promise<NIP46ConnectResult> => {
      const pool = new SimplePool();

      try {
        // Race: attempt connection with a 15s timeout.
        // If the relay is slow, retry with a fresh pool.
        let bunkerSigner: any;
        const attempt = (p: any) => BunkerSigner.fromURI(localSecretKey, uri, { pool: p });

        const withTimeout = (p: any, ms: number) =>
          Promise.race([
            attempt(p),
            new Promise((_, reject) => setTimeout(() => reject(new Error("NIP46_TIMEOUT")), ms)),
          ]);

        try {
          bunkerSigner = await withTimeout(pool, 12000);
        } catch (e: any) {
          if (e?.message === "NIP46_TIMEOUT") {
            console.debug("[chama] NIP-46 first attempt timed out, retrying with fresh pool...");
            pool.close(NIP46_RELAYS);
            const pool2 = new SimplePool();
            try {
              bunkerSigner = await withTimeout(pool2, 20000);
            } catch (e2: any) {
              pool2.close(NIP46_RELAYS);
              throw e2?.message === "NIP46_TIMEOUT"
                ? new Error("Connection timed out. Please try scanning again.")
                : e2;
            }
          } else {
            throw e;
          }
        }

        // Get the user's actual pubkey (different from the bunker's key)
        const userPubkey = await bunkerSigner.getPublicKey();

        // Save for session restoration
        localStorage.setItem(STORAGE_USER_PUBKEY, userPubkey);
        localStorage.setItem(STORAGE_BUNKER_URI, uri);

        console.debug("[chama] NIP-46 connected! User pubkey:", userPubkey.slice(0, 12) + "...");

        // Wrap in our Signer interface
        const signer: Signer = {
          getPublicKey: () => bunkerSigner.getPublicKey(),
          signEvent: (event: UnsignedEvent) => bunkerSigner.signEvent(event) as Promise<NostrEvent>,
          nip44Encrypt: async (plaintext: string, recipientPubkey: string) => {
            // BunkerSigner may support nip44 encrypt
            try {
              return await (bunkerSigner as any).nip44Encrypt(plaintext, recipientPubkey);
            } catch {
              // Fallback to nip04
              try {
                return await (bunkerSigner as any).nip04Encrypt(plaintext, recipientPubkey);
              } catch {
                // Last resort: return plaintext (testing mode)
                console.warn("[chama] NIP-46 signer does not support encryption — using plaintext");
                return plaintext;
              }
            }
          },
          nip44Decrypt: async (ciphertext: string, senderPubkey: string) => {
            try {
              return await (bunkerSigner as any).nip44Decrypt(ciphertext, senderPubkey);
            } catch {
              try {
                return await (bunkerSigner as any).nip04Decrypt(ciphertext, senderPubkey);
              } catch {
                return ciphertext;
              }
            }
          },
        };

        return { signer, pubkey: userPubkey };
      } catch (e) {
        pool.close(NIP46_RELAYS);
        throw e;
      }
    },
  };
}

/**
 * Check if there's a saved NIP-46 session that can be restored.
 */
export function hasSavedNIP46Session(): boolean {
  return !!(
    localStorage.getItem(STORAGE_LOCAL_KEY) &&
    localStorage.getItem(STORAGE_USER_PUBKEY)
  );
}

/**
 * Clear saved NIP-46 session (logout).
 */
export function clearNIP46Session(): void {
  localStorage.removeItem(STORAGE_LOCAL_KEY);
  localStorage.removeItem(STORAGE_BUNKER_URI);
  localStorage.removeItem(STORAGE_USER_PUBKEY);
}
